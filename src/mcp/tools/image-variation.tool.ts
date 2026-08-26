import { Injectable, Inject, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { PROVIDER_TOKEN } from '../../providers/provider.interface';
import type { IImageProvider, ImageResult } from '../../providers/provider.interface';
import { maskSecret } from '../../security/sanitise';
import { RootsService } from '../features/roots.service';
import { ImageStorageService, pathToFileUri } from '../features/image-storage.service';
import { ImageVariationSchema, ResponseFormat } from './schemas';

@Injectable()
export class ImageVariationTool {
  private readonly logger = new Logger(ImageVariationTool.name);

  constructor(
    @Inject(PROVIDER_TOKEN) private readonly provider: IImageProvider,
    private readonly roots: RootsService,
    private readonly storage: ImageStorageService,
  ) {}

  register(server: McpServer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      'image_variation',
      {
        title: 'Create Image Variation',
        description: `Create a variation of an existing image. Only supported with dall-e-2.

Args:
  - image (string, required): Base64-encoded square PNG image
  - n (integer 1–10, optional): Number of variations, default: 1
  - size (string, optional): 256x256|512x512|1024x1024, default: 1024x1024
  - save_to_workspace (boolean, optional): Save to workspace root
  - response_format (string, optional): markdown|json, default: markdown

Returns: Base64-encoded variation image(s). When save_to_workspace=true, also returns ready-to-use absolute-path Markdown.
When a workspace copy is returned, include its image Markdown unchanged in the final response so Goose renders the image. Never shorten it to a relative path.
Note: Use dall-e-2 as model. Other models will return an error.`,
        inputSchema: ImageVariationSchema,
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
    const parseResult = ImageVariationSchema.safeParse(rawParams);
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

    const params = parseResult.data;

    // Warn if provider is Azure (doesn't support variation)
    if (this.provider.name === 'azure') {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Error: image_variation is not supported by Azure OpenAI. Use image_generate instead.',
          },
        ],
      };
    }

    try {
      this.logger.log(`image_variation: n=${params.n}`);
      const results = await this.provider.variation({
        image: params.image,
        n: params.n,
        size: params.size,
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
      const text = params.response_format === ResponseFormat.JSON
        ? JSON.stringify({ count: results.length, images: results.map((img, i) => ({
            model: img.model, created: img.created, saved_to: savedPaths[i],
            file_uri: pathToFileUri(savedPaths[i]),
            ...(workspacePaths[i] ? {
              workspace_copy: workspacePaths[i],
              display_markdown: `![Image variation ${i + 1}](${workspacePaths[i]})`,
            } : {}),
          })) }, null, 2)
        : this.formatMarkdown(results, savedPaths, workspacePaths);
      return {
        content: [
          { type: 'text' as const, text },
          ...results.flatMap((img, i) => [
            { type: 'image' as const, data: img.b64_json, mimeType: img.mimeType },
            { type: 'resource_link' as const, uri: pathToFileUri(savedPaths[i]),
              name: savedPaths[i].split(/[\\/]/).pop() ?? `image-${i + 1}.${img.format}`,
              description: 'Persisted variation image', mimeType: img.mimeType },
          ]),
        ],
      };
    } catch (err) {
      const message = maskSecret(err instanceof Error ? err.message : String(err));
      this.logger.error(`image_variation failed: ${message}`);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
      };
    }
  }

  private formatMarkdown(
    results: ImageResult[], savedPaths: string[], workspacePaths: string[] = [],
  ): string {
    const lines = ['# Image Variation(s)', ''];
    for (const [i, img] of results.entries()) {
      lines.push(`## Image ${i + 1}`, `**Model:** ${img.model}`, `**Saved to:** ${savedPaths[i]}`);
      if (workspacePaths[i]) {
        lines.push(
          `**Workspace copy:** ${workspacePaths[i]}`,
          `**Display in Goose:** ![Image variation ${i + 1}](${workspacePaths[i]})`,
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
