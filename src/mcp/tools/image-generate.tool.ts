import { Injectable, Inject, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { PROVIDER_TOKEN } from '../../providers/provider.interface';
import { ImageProviderError } from '../../providers/provider.interface';
import type { IImageProvider, ImageResult } from '../../providers/provider.interface';
import { ElicitationService } from '../features/elicitation.service';
import { SamplingService } from '../features/sampling.service';
import { WORKSPACE_OUTPUT_PATH_DESCRIPTION } from '../features/workspace-destination';
import { RootsService } from '../features/roots.service';
import { ImageStorageService, pathToFileUri } from '../features/image-storage.service';
import { ImageGenerateSchema, ResponseFormat, PROMPT_MAX_LENGTH_GPT, resolveModeration, isExperimentalResolution } from './schemas';
import { sanitisePrompt, maskSecret } from '../../security/sanitise';
import { LATEST_MODEL } from '../../config/models';
import { providerErrorToToolResult } from './provider-error-result';
import { imageGenerationCounter, imageModelFallbackCounter, imageStageDuration, imageModelMetricLabel } from '../../health/metrics.controller';
import { aggregateImageUsage, estimatePublicCost, newRequestId, promptHash } from '../../telemetry/image-observability';

@Injectable()
export class ImageGenerateTool {
  private readonly logger = new Logger(ImageGenerateTool.name);

  constructor(
    @Inject(PROVIDER_TOKEN) private readonly provider: IImageProvider,
    private readonly elicitation: ElicitationService,
    private readonly sampling: SamplingService,
    private readonly roots: RootsService,
    private readonly storage: ImageStorageService,
  ) {}

  register(server: McpServer) {
    const configuredModel = this.provider.configuredModel;
    const defaultModel = this.provider.defaultModel ?? configuredModel ?? LATEST_MODEL;
    const availableModels = this.provider.availableModels;
    const modelContract = availableModels?.length
      ? `Default model: ${defaultModel}. Selectable deployed models: ${availableModels.join(', ')}. Omit model to use ${defaultModel}.`
      : configuredModel
        ? `Active configured model/deployment: ${configuredModel}. This server uses that fixed deployment; omit model (recommended) or pass exactly ${configuredModel}.`
        : 'Supported models: gpt-image-2 (default/recommended), gpt-image-1.5, gpt-image-1-mini, gpt-image-1. dall-e-2 is available for variations only; dall-e-3 was retired 2026-03-04.';
    const parameterContract = defaultModel.toLowerCase() === 'mai-image-2.5'
      ? 'MAI-Image-2.5 constraints: quality is not supported (omit it or use auto); size defaults to 1024x1024 and must have both edges >= 768 with at most 1,048,576 total pixels; output is PNG.'
      : 'GPT image constraints apply according to the selected model.';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      'image_generate',
      {
        title: 'Generate Image',
        description: `Generate one or more images using the active configured image provider.

${modelContract}
${parameterContract}

Args:
  - prompt (string, required): Text description, max 32 000 chars for GPT models
  - model (string, optional): ${availableModels?.length ? `omit for ${defaultModel}; selectable: ${availableModels.join(', ')}` : configuredModel ? `fixed configured deployment; omit model or use ${configuredModel}` : `Model identifier, default: ${defaultModel}`}
  - n (integer 1–10, optional): Number of images, default: 1
  - size (string, optional): auto|1024x1024|1536x1024|1024x1536|..., default: auto
  - quality (string, optional): ${availableModels?.length ? 'model-dependent; MAI: omit/use auto; GPT: auto|high|medium|low' : configuredModel?.toLowerCase() === 'mai-image-2.5' ? 'not supported; omit or use auto' : 'auto|high|medium|low, default: auto'}
  - background (string, optional): auto|transparent|opaque (GPT models only)
  - output_format (string, optional): png|jpeg|webp (GPT models only)
  - output_compression (integer 0–100, optional): for webp/jpeg
  - moderation (string, optional): auto|low (GPT models only)
  - save_to_workspace (boolean, optional): create additional copies below <workspace>/generated, default: false
  - workspace_output_path (string, optional): ${WORKSPACE_OUTPUT_PATH_DESCRIPTION}
  - disable_prompt_enhancement (boolean, optional): disable sampling for deterministic benchmarks
  - skip_elicitation (boolean, optional): suppress interactive quality/size form, default: false
  - response_format (string, optional): markdown|json, default: markdown

Returns: Base64-encoded image(s) with metadata. If save_to_workspace=true, also returns the absolute workspace path and ready-to-use Markdown.
When a workspace copy is returned, include its absolute-path image Markdown unchanged in the final response so Goose renders the image. Never shorten it to a relative path.

Error cases: invalid model name, prompt too long, n>10, provider auth failure.`,
        inputSchema: ImageGenerateSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      // Pass the inner Server (not McpServer) so feature services can call
      // elicitInput() / createMessage() / listRoots() which live on Server, not McpServer.
      async (params: unknown) => this.execute(params, server.server),
    );
  }

  async execute(rawParams: unknown, server?: Server) {
    const startedAt = performance.now();
    const requestId = newRequestId();
    const timings: Record<string, number> = {};
    const timed = async <T>(stage: string, model: string, operation: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try { return await operation(); } finally {
        timings[stage] = Math.round((performance.now() - start) * 1000) / 1000;
        imageStageDuration.observe({ stage, model: imageModelMetricLabel(model), provider: this.provider.name }, timings[stage] / 1000);
      }
    };
    const configuredModel = this.provider.configuredModel;
    const defaultModel = this.provider.defaultModel ?? configuredModel ?? LATEST_MODEL;
    const availableModels = this.provider.availableModels;
    const rawObject = rawParams && typeof rawParams === 'object'
      ? rawParams as Record<string, unknown>
      : undefined;
    const requestedModel = typeof rawObject?.['model'] === 'string'
      ? rawObject['model'].trim()
      : undefined;
    if (!availableModels?.length && configuredModel && requestedModel && requestedModel.toLowerCase() !== configuredModel.toLowerCase()) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `Validation error: requested model "${requestedModel}" cannot be used because the configured deployment is "${configuredModel}". Omit "model" to use the configured deployment, or pass "${configuredModel}" exactly.`,
        }],
      };
    }
    const effectiveRawParams = rawObject && !requestedModel
      ? { ...rawObject, model: defaultModel }
      : rawParams;
    const validationStart = performance.now();
    const parseResult = ImageGenerateSchema.safeParse(effectiveRawParams);
    timings['validation'] = Math.round((performance.now() - validationStart) * 1000) / 1000;
    imageStageDuration.observe({ stage: 'validation', model: imageModelMetricLabel(requestedModel || defaultModel), provider: this.provider.name }, timings['validation'] / 1000);
    if (!parseResult.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Validation error: ${parseResult.error.issues.map((i) => i.message).join('; ')}`,
          },
        ],
      };
    }

    const params = { ...parseResult.data, model: parseResult.data.model ?? defaultModel };

    try {
      const workspaceDestinations = params.workspace_output_path !== undefined
        ? await this.roots.prepareWorkspaceOutputs(server, params.workspace_output_path, params.output_format ?? 'png', params.n)
        : undefined;
      // US-018: Sanitise prompt (strips null bytes, trims, enforces max length)
      let prompt: string;
      let inputPrompt = '';
      let enhancementState: 'applied' | 'disabled' | 'unavailable' = params.disable_prompt_enhancement ? 'disabled' : 'unavailable';
      try {
        prompt = sanitisePrompt(params.prompt, PROMPT_MAX_LENGTH_GPT);
        inputPrompt = prompt;
      } catch (sanitiseErr) {
        const msg = sanitiseErr instanceof Error ? sanitiseErr.message : String(sanitiseErr);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Input error: ${msg}` }],
        };
      }

      // Guard: if sanitised prompt is empty, reject
      if (!prompt) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Validation error: prompt is required and cannot be empty' }],
        };
      }

      this.logger.log(`image_generate: model=${params.model} n=${params.n}`);

      // M4: Elicitation — request missing params from user BEFORE sampling.
      // Ordering rationale: elicitation determines quality/size intent first so that
      // the sampling step can incorporate those choices into the enhanced prompt.
      // skip_elicitation=true lets automated callers bypass the interactive form.
      if (server && !params.skip_elicitation) {
        const elicited = await timed('elicitation', params.model, () => this.elicitation.requestImageParams(server, {
          hasQuality: params.quality !== 'auto' && params.quality !== undefined,
          hasSize: params.size !== 'auto' && params.size !== undefined,
          model: params.model,
        }));
        if (elicited) {
          if (typeof elicited['quality'] === 'string') {
            params.quality = elicited['quality'] as typeof params.quality;
          }
          if (typeof elicited['size'] === 'string') {
            params.size = elicited['size'] as typeof params.size;
          }
        }
      } else { timings['elicitation'] = 0; }

      // M4: Sampling — enhance prompt via client LLM AFTER elicitation.
      // Quality/size context is now resolved, so the LLM can produce a
      // prompt optimised for the actual output dimensions and fidelity.
      if (server && !params.disable_prompt_enhancement) {
        prompt = await timed('enhancement', params.model, () => this.sampling.enhancePrompt(server, prompt, {
          model:          params.model,
          quality:        params.quality,
          size:           params.size,
          output_format:  params.output_format,
          background:     params.background,
          n:              params.n,
        }));
        enhancementState = 'applied';
      } else {
        timings['enhancement'] = 0;
      }

      const request = {
        prompt,
        model: params.model,
        n: params.n,
        size: params.size,
        quality: params.quality,
        background: params.background,
        output_format: params.output_format,
        output_compression: params.output_compression,
        moderation: resolveModeration(params.moderation),
        resolution: params.resolution,
        aspect_ratio: params.aspect_ratio,
      };
      let fallbackUsed = false;
      let fallbackReason: string | undefined;
      let results: ImageResult[];
      try {
        results = await timed('provider', params.model, () => this.provider.generate(request));
      } catch (error) {
        if (error instanceof ImageProviderError &&
            error.code === 'CONTENT_SAFETY_BLOCK' && error.stage === 'output' &&
            params.fallback_model && params.fallback_model !== params.model) {
          fallbackUsed = true;
          fallbackReason = error.code;
          imageModelFallbackCounter.inc({
            from_model: imageModelMetricLabel(params.model),
            to_model: imageModelMetricLabel(params.fallback_model),
            reason: error.code,
          });
          results = await timed('provider_fallback', params.fallback_model, () => this.provider.generate({ ...request, model: params.fallback_model! }));
        } else {
          throw error;
        }
      }

      imageGenerationCounter.inc({
        model: imageModelMetricLabel(results[0]?.model ?? params.model),
        provider: this.provider.name,
        status: fallbackUsed ? 'success_fallback' : 'success',
      });

      const savedPaths = await timed('storage', params.model, () => Promise.all(
        results.map((img) => this.storage.saveImage(img.b64_json, img.format)),
      ));

      const workspacePaths: Array<string | undefined> = new Array(results.length);
      if (params.save_to_workspace && server) {
        const copyStart = performance.now();
        for (const [index, img] of results.entries()) {
          if (workspaceDestinations && !workspaceDestinations[index]) throw new Error('workspace_output_path: provider returned more outputs than requested n.');
          const saved = workspaceDestinations
            ? await this.roots.saveImageToDestination(workspaceDestinations[index], img.b64_json, img.format)
            : await this.roots.saveImageToWorkspace(server, img.b64_json, img.format);
          workspacePaths[index] = saved ?? undefined;
        }
        timings['workspace_copy'] = Math.round((performance.now() - copyStart) * 1000) / 1000;
        imageStageDuration.observe({ stage: 'workspace_copy', model: imageModelMetricLabel(params.model), provider: this.provider.name }, timings['workspace_copy'] / 1000);
      } else { timings['workspace_copy'] = 0; }

      const experimental = isExperimentalResolution(params.size);
      const fallback = fallbackUsed
        ? { requestedModel: params.model, reason: fallbackReason! }
        : undefined;
      timings['total'] = Math.round((performance.now() - startedAt) * 1000) / 1000;
      imageStageDuration.observe({ stage: 'total', model: imageModelMetricLabel(results[0]?.model ?? params.model), provider: this.provider.name }, timings['total'] / 1000);
      const provenance = results[0]?.provenance ?? { configured_deployment: configuredModel, requested_model: requestedModel,
        resolved_deployment: results[0]?.model, effective_model: results[0]?.model ?? params.model };
      const metadata = { request_id: results[0]?.requestId ?? requestId, timings_ms: timings, enhancement_state: enhancementState,
        input_prompt_sha256: promptHash(inputPrompt), effective_prompt_sha256: promptHash(prompt), provenance,
        usage: aggregateImageUsage(results.map((result) => result.usage)),
        estimated_cost: estimatePublicCost(results[0]?.model ?? params.model, aggregateImageUsage(results.map((result) => result.usage))) };
      const text = params.response_format === ResponseFormat.JSON
        ? this.formatJson(results, params.model, savedPaths, workspacePaths, experimental, fallback, metadata)
        : this.formatMarkdown(results, prompt, savedPaths, workspacePaths, experimental, fallback);
      return {
        content: [
          { type: 'text' as const, text },
          ...results.flatMap((img, i) => [
            { type: 'image' as const, data: img.b64_json, mimeType: img.mimeType },
            {
              type: 'resource_link' as const,
              uri: pathToFileUri(savedPaths[i]),
              name: savedPaths[i].split(/[\\/]/).pop() ?? `image-${i + 1}.${img.format}`,
              description: 'Persisted generated image',
              mimeType: img.mimeType,
            },
          ]),
        ],
      };
    } catch (err) {
      const message = maskSecret(err instanceof Error ? err.message : String(err));
      this.logger.error(`image_generate failed: ${message}`);
      return providerErrorToToolResult(err);
    }
  }

  private formatMarkdown(
    results: ImageResult[],
    prompt: string,
    savedPaths: string[],
    workspacePaths: Array<string | undefined> = [],
    experimental = false,
    fallback?: { requestedModel: string; reason: string },
  ): string {
    const lines = ['# Generated Image(s)', '', `**Prompt:** ${prompt}`, ''];
    if (fallback) {
      lines.push(
        `> ℹ️ Explicit fallback used: requested ${fallback.requestedModel}, effective ${results[0]?.model ?? 'unknown'} (${fallback.reason}).`,
        '',
      );
    }
    if (experimental) {
      lines.push(
        '> ⚠️ **Experimental resolution:** requested size exceeds 2560×1440. ' +
        'gpt-image-2 output quality/reliability is more variable above this boundary.',
        '',
      );
    }
    for (const [i, img] of results.entries()) {
      lines.push(`## Image ${i + 1}`, `**Model:** ${img.model}`);
      if (img.revised_prompt) lines.push(`**Revised prompt:** ${img.revised_prompt}`);
      lines.push(`**Saved to:** ${savedPaths[i]}`);
      if (workspacePaths[i]) {
        lines.push(
          `**Workspace copy:** ${workspacePaths[i]}`,
          `**Display in Goose:** ![Generated image ${i + 1}](${workspacePaths[i]})`,
        );
      }
      lines.push('');
    }
    if (workspacePaths.some(Boolean)) {
      lines.push('> Assistant: include each **Display in Goose** Markdown image unchanged in the final response. Keep the absolute path; do not replace it with a relative path.', '');
    }
    return lines.join('\n');
  }

  private formatJson(
    results: ImageResult[],
    model: string,
    savedPaths: string[],
    workspacePaths: Array<string | undefined> = [],
    experimental = false,
    fallback?: { requestedModel: string; reason: string },
    metadata?: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      ...metadata,
      model: results[0]?.model ?? model,
      requested_model: fallback?.requestedModel ?? model,
      effective_model: results[0]?.model ?? model,
      fallback_used: !!fallback,
      ...(fallback ? { fallback_reason: fallback.reason } : {}),
      count: results.length,
      ...(experimental ? {
        warning: 'Experimental resolution: requested size exceeds 2560×1440. ' +
          'gpt-image-2 output quality/reliability is more variable above this boundary.',
      } : {}),
      images: results.map((img, i) => ({
        index: i,
        saved_to: savedPaths[i],
        file_uri: pathToFileUri(savedPaths[i]),
        revised_prompt: img.revised_prompt,
        created: img.created,
        ...(workspacePaths[i] ? {
          workspace_copy: workspacePaths[i],
          display_markdown: `![Generated image ${i + 1}](${workspacePaths[i]})`,
        } : {}),
      })),
    }, null, 2);
  }

}
