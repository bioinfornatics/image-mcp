import OpenAI from 'openai';
import { Logger } from '@nestjs/common';
import type {
  IImageProvider,
  GenerateParams,
  EditParams,
  VariationParams,
  ImageResult,
  ValidationResult,
} from './provider.interface';
import type { ProviderStrategy } from './strategies/provider.strategy';
import { maskSecret } from '../security/sanitise';
import { decodeImageData, imageFile } from './image-media';
import { normalizeImageUsage } from '../telemetry/image-observability';

/**
 * Single provider implementation for all OpenAI-compatible APIs.
 *
 * Both OpenAI and Azure use the same `openai` npm SDK under the hood —
 * Azure is just `new OpenAI({ baseURL: endpoint + '/openai/v1' })`.
 * The ProviderStrategy captures the handful of decisions that differ
 * (model resolution, extra params, error messages, variation support).
 *
 * To add a new OpenAI-compatible provider (Groq, Together, Mistral…):
 *   1. Write a new ProviderStrategy implementation
 *   2. Add a branch in providers.module.ts
 *   3. Zero changes here
 */
export class OpenAICompatibleProvider implements IImageProvider {
  private readonly logger: Logger;

  constructor(
    private readonly client: OpenAI,
    private readonly strategy: ProviderStrategy,
  ) {
    this.logger = new Logger(`OpenAICompatibleProvider[${strategy.name}]`);
  }

  get name(): 'openai' | 'azure' | 'openrouter' | 'together' | 'custom' {
    return this.strategy.name;
  }

  // ─── generate ────────────────────────────────────────────────────────────

  async generate(params: GenerateParams): Promise<ImageResult[]> {
    const model = this.strategy.resolveModelAsync
      ? await this.strategy.resolveModelAsync(params)
      : this.strategy.resolveModel(params);
    this.logger.log(`${this.strategy.logPrefix} generate model=${model} n=${params.n ?? 1}`);
    try {
      const extras = await this.strategy.buildGenerateExtras(params, model);
      const response = await this.client.images.generate({
        prompt: params.prompt,
        model,
        n: params.n,
        size: params.size as Parameters<OpenAI['images']['generate']>[0]['size'],
        quality: params.quality as Parameters<OpenAI['images']['generate']>[0]['quality'],
        ...extras,
      } as Parameters<OpenAI['images']['generate']>[0]);

      return this.mapResponse(response, model);
    } catch (err) {
      this.logger.error(`${this.strategy.logPrefix} generate failed: ${maskSecret(String(err))}`);
      throw this.strategy.normalizeError(err);
    }
  }

  // ─── edit ─────────────────────────────────────────────────────────────────

  async edit(params: EditParams): Promise<ImageResult[]> {
    const model = this.strategy.resolveModelAsync
      ? await this.strategy.resolveModelAsync(params)
      : this.strategy.resolveModel(params);
    this.logger.log(`${this.strategy.logPrefix} edit model=${model} images=${params.images?.length ?? 1}`);
    try {
      let imageInput: File | File[];
      if (params.images && params.images.length > 0) {
        // Multi-image compositing
        imageInput = await Promise.all(
          params.images.map((b64, i) => Promise.resolve(imageFile(b64, `image${i}`))),
        );
      } else if (params.image) {
        imageInput = imageFile(params.image, 'image');
      } else {
        throw new Error('Either image or images must be provided to edit()');
      }

      const maskFile = params.mask ? imageFile(params.mask, 'mask') : undefined;
      const extras = await this.strategy.buildEditExtras(params);

      const response = await this.client.images.edit({
        image: imageInput,
        ...(maskFile ? { mask: maskFile } : {}),
        prompt: params.prompt,
        model,
        n: params.n,
        size: params.size as Parameters<OpenAI['images']['edit']>[0]['size'],
        ...extras,
      } as Parameters<OpenAI['images']['edit']>[0]);

      return this.mapResponse(response, model);
    } catch (err) {
      this.logger.error(`${this.strategy.logPrefix} edit failed: ${maskSecret(String(err))}`);
      throw this.strategy.normalizeError(err);
    }
  }

  // ─── variation ────────────────────────────────────────────────────────────

  async variation(params: VariationParams): Promise<ImageResult[]> {
    if (!this.strategy.supportsVariation) {
      throw new Error(
        `image_variation is not supported by the ${this.strategy.name} provider. Use image_generate instead.`,
      );
    }
    this.logger.log(`variation n=${params.n ?? 1}`);
    try {
      const inputFile = imageFile(params.image, 'image');
      const response = await this.client.images.createVariation({
        image: inputFile,
        n: params.n,
        size: params.size as Parameters<OpenAI['images']['createVariation']>[0]['size'],
        response_format: 'b64_json',
      });
      return this.mapResponse(response, 'dall-e-2');
    } catch (err) {
      this.logger.error(`variation failed: ${maskSecret(String(err))}`);
      throw this.strategy.normalizeError(err);
    }
  }

  // ─── validate ─────────────────────────────────────────────────────────────

  async validate(): Promise<ValidationResult> {
    try {
      if (this.strategy.validate) return await this.strategy.validate(this.client);
      await this.client.models.list();
      return { valid: true, provider: this.strategy.name };
    } catch (err) {
      return {
        valid: false,
        provider: this.strategy.name,
        error: maskSecret(String(err)),
      };
    }
  }

  // ─── shared utilities ─────────────────────────────────────────────────────

  private mapResponse(
    response: { data?: Array<{ b64_json?: string | null; url?: string | null; revised_prompt?: string | null }>; created?: number; usage?: unknown },
    model: string,
  ): ImageResult[] {
    if (!response.data?.length) throw new Error('Image provider returned no image data.');
    const usage = normalizeImageUsage(response.usage, this.strategy.name + '_response');
    return response.data.map((img) => {
      if (!img.b64_json) {
        throw new Error(img.url
          ? 'Image provider returned a URL instead of inline image data; URL downloads are disabled.'
          : 'Image provider returned an empty image payload.');
      }
      const decoded = decodeImageData(img.b64_json);
      return {
        b64_json: decoded.bytes.toString('base64'),
        format: decoded.format,
        mimeType: decoded.mimeType,
        revised_prompt: img.revised_prompt ?? undefined,
        model,
        created: response.created ?? Date.now(),
        usage,
      };
    });
  }
}
