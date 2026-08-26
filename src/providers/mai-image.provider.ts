/**
 * Microsoft MAI Image (MAI-Image-2.5) adapter.
 *
 * Confirmed contract (Microsoft Learn, MAI Image on Azure AI Foundry):
 * MAI Image models are served through a dedicated *managed* endpoint, not the
 * generic OpenAI-compatible `/openai/...` surface used by gpt-image-* on
 * Azure:
 *
 *   POST {endpoint}/mai/v1/images/generations
 *   POST {endpoint}/mai/v1/images/edits
 *
 * Request body is JSON: `{ model: <exact deployment name>, prompt, width,
 * height }` (image editing additionally sends the source image). There is
 * no `size` string and no `quality` parameter documented — output is always
 * PNG. Constraints (confirmed): width and height must each be >= 768, and
 * total pixels (width * height) must be <= 1,048,576 (i.e. up to 1024x1024).
 * One dimension may exceed 1024 as long as the total stays within budget.
 *
 * `quality` is intentionally rejected (not silently dropped): Microsoft's
 * docs do not document `quality=low` (or any quality level) for MAI Image,
 * so forwarding an unsupported parameter silently would risk masking a
 * caller mistake. This mirrors the project's general policy of failing
 * fast on undocumented capabilities rather than guessing.
 */
import type {
  IImageProvider,
  GenerateParams,
  EditParams,
  VariationParams,
  ImageResult,
  ValidationResult,
} from './provider.interface';
import { ImageProviderError, type ProviderErrorStage } from './provider.interface';
import type { AzureAuthHeaderProvider } from './azure-deployment-catalog';
import { decodeImageData, imageMimeType } from './image-media';
import { maskSecret } from '../security/sanitise';
import { MAI_MODEL_NAME, MAI_MIN_EDGE, MAI_MAX_PIXELS } from './mai-image.constants';
import { normalizeImageUsage } from '../telemetry/image-observability';

export { MAI_MODEL_NAME, MAI_MIN_EDGE, MAI_MAX_PIXELS };

export interface MaiImageProviderOptions {
  /** Base resource endpoint, e.g. `https://<hub>.services.ai.azure.com` (no trailing slash required). */
  endpoint: string;
  /** Exact, customer-chosen deployment name sent verbatim as the JSON `model` field. */
  deployment: string;
  /** Resolves a fresh auth header for each request (api-key or Bearer token). */
  authHeader: AzureAuthHeaderProvider;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Parses and validates a `size` string (e.g. "1024x1024") against the
 * MAI Image width/height contract. Defaults to 1024x1024 when `size` is
 * absent or `"auto"` (MAI Image has no documented "auto" sizing, so the
 * flagship 1024x1024 resolution is used as the safe default).
 */
export function parseMaiSize(size: string | undefined): { width: number; height: number } {
  const value = size && size !== 'auto' ? size : '1024x1024';
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid size "${size}" for ${MAI_MODEL_NAME}: expected a WxH string (e.g. "1024x1024").`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < MAI_MIN_EDGE || height < MAI_MIN_EDGE) {
    throw new Error(
      `${MAI_MODEL_NAME} requires width and height >= ${MAI_MIN_EDGE} (got ${width}x${height}).`,
    );
  }
  const pixels = width * height;
  if (pixels > MAI_MAX_PIXELS) {
    throw new Error(
      `${MAI_MODEL_NAME} requires total pixels <= ${MAI_MAX_PIXELS} (got ${pixels} for ${width}x${height}).`,
    );
  }
  return { width, height };
}

/** Rejects `quality` outright — Microsoft's MAI Image docs do not document any quality parameter (e.g. `quality=low`). */
function rejectUnsupportedQuality(quality: string | undefined): void {
  if (quality && quality !== 'auto') {
    throw new Error(
      `${MAI_MODEL_NAME} does not support a "quality" parameter: Microsoft's MAI Image documentation does not ` +
        `document any quality level (including "${quality}"). Omit "quality" (or leave it "auto") for this model.`,
    );
  }
}

interface MaiImageApiResponse {
  data?: Array<{ b64_json?: string; image?: string }>;
  created?: number;
  usage?: unknown;
}

interface MaiImageApiError {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function safetyStage(message: string): ProviderErrorStage {
  if (/\b(response|output|generated (?:image|content|candidate))\b/i.test(message)) return 'output';
  if (/\b(prompt|input)\b/i.test(message)) return 'prompt';
  return 'unknown';
}

function safetyLabel(message: string): string | undefined {
  const match = /label\s+['"]([^'"]+)['"]/i.exec(message);
  return match?.[1];
}

function safeRequestId(response: Response): string | undefined {
  return response.headers?.get('x-request-id')
    ?? response.headers?.get('apim-request-id')
    ?? response.headers?.get('x-ms-request-id')
    ?? undefined;
}

export class MaiImageProvider implements IImageProvider {
  readonly name = 'azure' as const;

  get configuredModel(): string {
    return this.deployment;
  }

  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly authHeader: AzureAuthHeaderProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MaiImageProviderOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.deployment = options.deployment;
    this.authHeader = options.authHeader;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(params: GenerateParams): Promise<ImageResult[]> {
    rejectUnsupportedQuality(params.quality);
    const { width, height } = parseMaiSize(params.size);
    const body: Record<string, unknown> = { model: this.deployment, prompt: params.prompt, width, height };
    if (params.n && params.n > 1) body['n'] = params.n;
    return this.request('/mai/v1/images/generations', body);
  }

  async edit(params: EditParams): Promise<ImageResult[]> {
    rejectUnsupportedQuality(params.quality);
    const { width, height } = parseMaiSize(params.size);
    const image = params.image ?? params.images?.[0];
    if (!image) {
      throw new Error(`${MAI_MODEL_NAME} image editing requires an "image" (or images[0]) input.`);
    }
    const body: Record<string, unknown> = { model: this.deployment, prompt: params.prompt, width, height, image };
    if (params.n && params.n > 1) body['n'] = params.n;
    return this.request('/mai/v1/images/edits', body);
  }

  async variation(_params: VariationParams): Promise<ImageResult[]> {
    throw new Error(`image_variation is not supported by ${MAI_MODEL_NAME}. Use image_generate or image_edit instead.`);
  }

  async validate(): Promise<ValidationResult> {
    if (!this.deployment.trim()) {
      return { valid: false, provider: this.name, error: `${MAI_MODEL_NAME} deployment is missing.` };
    }
    // Microsoft does not document a model-listing endpoint for the managed
    // /mai/v1 surface; we can only confirm configuration shape here, not
    // live reachability (unlike the OpenAI-compatible AzureStrategy.validate()).
    return { valid: true, provider: this.name, deployment: this.deployment };
  }

  private async request(path: string, body: Record<string, unknown>): Promise<ImageResult[]> {
    let response: Response;
    try {
      const header = await this.authHeader();
      response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: { [header.name]: header.value, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `${MAI_MODEL_NAME} request failed: ${maskSecret(err instanceof Error ? err.message : String(err))}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let errorCode = '';
      let errorMessage = '';
      try {
        const payload = JSON.parse(text) as MaiImageApiError;
        errorCode = typeof payload.error?.code === 'string' ? payload.error.code : '';
        errorMessage = typeof payload.error?.message === 'string' ? payload.error.message : '';
      } catch {
        // Non-JSON provider errors use the generic status mapping below.
      }
      const stage = safetyStage(errorMessage);
      const label = safetyLabel(errorMessage);
      if (response.status === 400 &&
          (errorCode === 'content_safety_violation' || label !== undefined)) {
        const stageText = stage === 'output'
          ? 'The provider explicitly reported that a generated response/candidate was blocked.'
          : stage === 'prompt'
            ? 'The provider explicitly reported that the input prompt was blocked.'
            : 'The provider did not identify whether filtering occurred on the prompt or generated output.';
        throw new ImageProviderError({
          code: 'CONTENT_SAFETY_BLOCK',
          message:
            `${MAI_MODEL_NAME} did not create an image because its provider-side content filtering blocked the request. ` +
            `${stageText} This result does not establish that the input prompt itself was unsafe. ` +
            'A different image model can legitimately produce a different result because model-level filters and generated candidates differ. ' +
            'Retry once with an equivalent concrete description, then use another approved deployed model or contact Azure Support if the block persists.',
          provider: this.name,
          model: this.deployment,
          retryable: true,
          stage,
          status: response.status,
          providerCode: errorCode || undefined,
          label,
          requestId: safeRequestId(response),
        });
      }
      const category =
        response.status === 401
          ? 'Authentication failed'
          : response.status === 403
            ? 'Access denied'
            : response.status === 404
              ? 'Deployment not found'
              : response.status === 429
                ? 'Rate limit exceeded'
                : 'Request failed';
      throw new Error(`${MAI_MODEL_NAME} ${category} (HTTP ${response.status}): ${maskSecret(text)}`);
    }

    const json = (await response.json()) as MaiImageApiResponse;
    const entries = json.data ?? [];
    if (entries.length === 0) throw new Error(`${MAI_MODEL_NAME} returned no image data.`);
    const created = json.created ?? Math.floor(Date.now() / 1000);
    const requestId = safeRequestId(response);
    const usage = normalizeImageUsage(json.usage, 'azure_response');
    return entries.map((entry) => {
      const b64 = entry.b64_json ?? entry.image;
      if (!b64) throw new Error(`${MAI_MODEL_NAME} returned an empty image payload.`);
      const decoded = decodeImageData(b64);
      if (decoded.format !== 'png') {
        throw new Error(`${MAI_MODEL_NAME} output must be PNG; received ${decoded.format}.`);
      }
      return {
        b64_json: decoded.bytes.toString('base64'),
        format: decoded.format,
        mimeType: imageMimeType(decoded.format),
        model: this.deployment,
        created,
        requestId,
        usage,
      };
    });
  }
}
