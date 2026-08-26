import { Injectable, Inject, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { PROVIDER_TOKEN } from '../../providers/provider.interface';
import type { IImageProvider, ImageResult } from '../../providers/provider.interface';
import { RootsService } from '../features/roots.service';
import { ImageStorageService, pathToFileUri } from '../features/image-storage.service';
import { ImageEditSchema, ResponseFormat, PROMPT_MAX_LENGTH_GPT, isExperimentalResolution } from './schemas';
import { sanitisePrompt, maskSecret } from '../../security/sanitise';
import { LATEST_MODEL } from '../../config/models';
import { providerErrorToToolResult } from './provider-error-result';

@Injectable()
export class ImageEditTool {
  private readonly logger = new Logger(ImageEditTool.name);

  constructor(
    @Inject(PROVIDER_TOKEN) private readonly provider: IImageProvider,
    private readonly roots: RootsService,
    private readonly storage: ImageStorageService,
  ) {}

  register(server: McpServer) {
    const defaultModel = this.provider.defaultModel ?? this.provider.configuredModel ?? LATEST_MODEL;
    const availableModels = this.provider.availableModels;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      'image_edit',
      {
        title: 'Edit Image',
        description: `Edit an existing image using an inpainting mask and a text prompt.

Args:
  - image (string, optional): Base64-encoded source image (PNG recommended). Use images[] for multi-image compositing.
  - images (string[], optional): Array of base64 images for multi-image compositing (max 16, 10MB aggregate cap). Use instead of image.
  - mask (string, optional): Base64-encoded mask (white=area to edit, black=keep)
  - prompt (string, required): Description of the desired edit
  - model (string, optional): ${availableModels?.length ? `omit for ${defaultModel}; selectable: ${availableModels.join(', ')}` : `Model to use, default: ${defaultModel}`}
  - n (integer 1–10, optional): Number of edited images to generate, default: 1
  - size (string, optional): auto|1024x1024|1536x1024|1024x1536|arbitrary WxH for gpt-image-2, default: auto
  - quality (string, optional): Quality level, default: auto
  - output_format (string, optional): png|jpeg|webp
  - output_compression (integer 0–100, optional): For webp/jpeg
  - input_fidelity (string, optional): Identity preservation for gpt-image-1.x — "low"|"high". Not supported by gpt-image-2.
  - save_to_workspace (boolean, optional): Save output to workspace root
  - response_format (string, optional): markdown|json, default: markdown

Returns: Base64-encoded edited image(s). When save_to_workspace=true, also returns ready-to-use absolute-path Markdown.
When a workspace copy is returned, include its image Markdown unchanged in the final response so Goose renders the image. Never shorten it to a relative path.`,
        inputSchema: ImageEditSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (params: unknown) => this.execute(params, server.server),
    );
  }

  async execute(rawParams: unknown, server?: Server) {
    const rawObject = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : undefined;
    const requestedModel = typeof rawObject?.['model'] === 'string' ? rawObject['model'].trim() : undefined;
    const defaultModel = this.provider.defaultModel ?? this.provider.configuredModel ?? LATEST_MODEL;
    const effectiveRawParams = rawObject && !requestedModel ? { ...rawObject, model: defaultModel } : rawParams;
    const parseResult = ImageEditSchema.safeParse(effectiveRawParams);
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
      // Aggregate payload size guard (10MB = 10 * 1024 * 1024 bytes of raw b64-decoded data)
      const MAX_AGGREGATE_BYTES = 10 * 1024 * 1024;
      if (params.images && params.images.length > 0) {
        const totalBytes = params.images.reduce((sum, b64) => {
          const raw = b64.replace(/^data:[^;]+;base64,/, '');
          return sum + Math.ceil(raw.length * 0.75); // base64 → bytes approximation
        }, 0);
        if (totalBytes > MAX_AGGREGATE_BYTES) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Error: Total image payload (${Math.round(totalBytes / 1024 / 1024)}MB) exceeds 10MB aggregate limit.`,
              },
            ],
          };
        }
      }

      let sanitisedPrompt: string;
      try {
        sanitisedPrompt = sanitisePrompt(params.prompt, PROMPT_MAX_LENGTH_GPT);
      } catch (sanitiseErr) {
        const msg = sanitiseErr instanceof Error ? sanitiseErr.message : String(sanitiseErr);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Input sanitisation error: ${msg}` }],
        };
      }
      this.logger.log(`image_edit: model=${params.model}`);
      const results = await this.provider.edit({
        image: params.image,
        images: params.images,
        mask: params.mask,
        prompt: sanitisedPrompt,
        model: params.model,
        n: params.n,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        output_compression: params.output_compression,
        input_fidelity: params.input_fidelity,
        resolution: params.resolution,
        aspect_ratio: params.aspect_ratio,
      });

      const savedPaths = await Promise.all(
        results.map((img) => this.storage.saveImage(img.b64_json, img.format)),
      );
      const workspacePaths: string[] = [];
      if (params.save_to_workspace && server) {
        for (const img of results) {
          const saved = await this.roots.saveImageToWorkspace(server, img.b64_json, img.format);
          if (saved) workspacePaths.push(saved);
        }
      }
      const experimental = isExperimentalResolution(params.size);
      const text = params.response_format === ResponseFormat.JSON
        ? JSON.stringify({
            count: results.length,
            ...(experimental ? {
              warning: 'Experimental resolution: requested size exceeds 2560×1440. ' +
                'gpt-image-2 output quality/reliability is more variable above this boundary.',
            } : {}),
            images: results.map((img, i) => ({
              model: img.model, created: img.created, saved_to: savedPaths[i],
              file_uri: pathToFileUri(savedPaths[i]),
              ...(workspacePaths[i] ? {
                workspace_copy: workspacePaths[i],
                display_markdown: `![Edited image ${i + 1}](${workspacePaths[i]})`,
              } : {}),
            })),
          }, null, 2)
        : this.formatMarkdown(results, savedPaths, workspacePaths, params.prompt, experimental);
      return {
        content: [
          { type: 'text' as const, text },
          ...results.flatMap((img, i) => [
            { type: 'image' as const, data: img.b64_json, mimeType: img.mimeType },
            { type: 'resource_link' as const, uri: pathToFileUri(savedPaths[i]),
              name: savedPaths[i].split(/[\\/]/).pop() ?? `image-${i + 1}.${img.format}`,
              description: 'Persisted edit image', mimeType: img.mimeType },
          ]),
        ],
      };
    } catch (err) {
      const message = maskSecret(err instanceof Error ? err.message : String(err));
      this.logger.error(`image_edit failed: ${message}`);
      return providerErrorToToolResult(err);
    }
  }

  private formatMarkdown(
    results: ImageResult[], savedPaths: string[], workspacePaths: string[] = [], prompt: string,
    experimental = false,
  ): string {
    const lines = ['# Edited Image(s)', '', `**Prompt:** ${prompt}`, ''];
    if (experimental) {
      lines.push(
        '> ⚠️ **Experimental resolution:** requested size exceeds 2560×1440. ' +
        'gpt-image-2 output quality/reliability is more variable above this boundary.',
        '',
      );
    }
    for (const [i, img] of results.entries()) {
      lines.push(`## Image ${i + 1}`, `**Model:** ${img.model}`, `**Saved to:** ${savedPaths[i]}`);
      if (workspacePaths[i]) {
        lines.push(
          `**Workspace copy:** ${workspacePaths[i]}`,
          `**Display in Goose:** ![Edited image ${i + 1}](${workspacePaths[i]})`,
        );
      }
      lines.push('');
    }
    if (workspacePaths.length > 0) {
      lines.push('> Assistant: include each **Display in Goose** Markdown image unchanged in the final response. Keep the absolute path; do not replace it with a relative path.', '');
    }
    return lines.join('\n');
  }

}
