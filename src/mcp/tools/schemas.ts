import { z } from 'zod';
import { LATEST_MODEL, OPENAI_MODELS, AZURE_MODELS } from '../../config/models';
import { MAI_MODEL_NAME, MAI_MIN_EDGE, MAI_MAX_PIXELS } from '../../providers/mai-image.constants';
import { isMaiModel } from '../../providers/model-capabilities';

export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

export const PROMPT_MAX_LENGTH_GPT = 32_000;
export const PROMPT_MAX_LENGTH_DALLE2 = 1_000; // dall-e-2: variations endpoint only

// ---------------------------------------------------------------------------
// gpt-image-2 arbitrary resolution support
// ---------------------------------------------------------------------------

export const FIXED_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
export type FixedSize = typeof FIXED_SIZES[number];

/**
 * Validates a WxH string against gpt-image-2's 4 constraints.
 * Throws a descriptive Error if any constraint is violated.
 * Silent (no-op) for 'auto' and fixed-size presets.
 */
export function validateArbitrarySize(size: string): void {
  if (!size || size === 'auto' || FIXED_SIZES.includes(size as FixedSize)) return;

  const [w, h] = size.split('x').map(Number);

  if (w % 16 !== 0) {
    throw new Error(`Width ${w} is not a multiple of 16. Both edges must be multiples of 16.`);
  }
  if (h % 16 !== 0) {
    throw new Error(`Height ${h} is not a multiple of 16. Both edges must be multiples of 16.`);
  }
  if (w >= 3840) {
    throw new Error(`Width ${w} must be less than 3840 (max edge for gpt-image-2).`);
  }
  if (h >= 3840) {
    throw new Error(`Height ${h} must be less than 3840 (max edge for gpt-image-2).`);
  }

  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const ratio = long / short;
  if (ratio > 3) {
    throw new Error(`Aspect ratio ${ratio.toFixed(2)}:1 exceeds the maximum of 3:1 for gpt-image-2.`);
  }

  const pixels = w * h;
  if (pixels < 655_360) {
    throw new Error(`Image too small: ${pixels} pixels (minimum 655,360 for gpt-image-2).`);
  }
  if (pixels > 8_294_400) {
    throw new Error(`Image too large: ${pixels} pixels (maximum 8,294,400 for gpt-image-2).`);
  }
}

/**
 * Returns true when the size string is a WxH value (not 'auto' or a named preset).
 * Used to detect when gpt-image-2 is receiving a custom dimension.
 */
export function isArbitraryResolution(size: string | undefined): boolean {
  if (!size || size === 'auto') return false;
  return /^\d+x\d+$/.test(size) && !FIXED_SIZES.includes(size as FixedSize);
}

/**
 * Returns true when a valid gpt-image-2 arbitrary size exceeds the 2560×1440
 * reliability boundary documented in the OpenAI guide.
 * Above this threshold, output quality is more variable ("experimental").
 */
export function isExperimentalResolution(size: string | undefined): boolean {
  if (!size || !isArbitraryResolution(size)) return false;
  const [w, h] = size.split('x').map(Number);
  return (w * h) > 2560 * 1440; // 3,686,400 pixels
}

/**
 * Zod superRefine callback enforcing gpt-image-2 arbitrary WxH resolution rules
 * while preserving the fixed allowlist for 'auto' + presets. Shared between
 * ImageGenerateSchema and ImageEditSchema so both tools accept identical size
 * grammar and error messages.
 */
function validateSizeField(val: string | undefined, ctx: z.RefinementCtx): void {
  if (!val || val === 'auto') return; // auto: always valid
  if (FIXED_SIZES.includes(val as FixedSize)) return; // preset: always valid
  // Must match WxH format
  if (!/^\d+x\d+$/.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid size "${val}". Must be 'auto', a preset (1024x1024, 1536x1024, 1024x1536), or a WxH string (e.g. "2048x1152").`,
    });
    return;
  }
  // Apply 4 constraints
  try {
    validateArbitrarySize(val);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
}

/**
 * Model-aware size validation for Microsoft MAI Image (MAI-Image-2.5).
 *
 * MAI Image is routed through a dedicated, non-OpenAI-compatible adapter
 * (`MaiImageProvider`) with a *different* size contract than the generic
 * gpt-image-* presets: width/height must each be >= `MAI_MIN_EDGE` (768) and
 * total pixels must be <= `MAI_MAX_PIXELS` (1,048,576 — i.e. up to
 * 1024x1024). Critically, the generic `1536x1024` preset (1,572,864 pixels)
 * — valid for gpt-image-2/1.x — EXCEEDS the MAI Image pixel budget and would
 * previously only fail at network-call time inside `MaiImageProvider`.
 *
 * This function rejects any MAI-incompatible size *before* the network call,
 * at schema-validation time, with an actionable error that lists MAI's
 * concrete constraints and suggests the safe `1024x1024` default — rather
 * than weakening `MaiImageProvider`'s own validation (which remains the
 * final authority and is unchanged).
 */
function validateModelSizeCompat(
  data: { model?: string; size?: string },
  ctx: z.RefinementCtx,
): void {
  const model = (data.model ?? LATEST_MODEL).trim();
  if (!isMaiModel(model)) {
    validateSizeField(data.size, ctx);
    return;
  }

  const size = data.size;
  if (!size || size === 'auto') return; // provider defaults 'auto' to the always-valid 1024x1024

  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return; // malformed strings are already rejected by validateSizeField

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const withinBounds = width >= MAI_MIN_EDGE && height >= MAI_MIN_EDGE && pixels <= MAI_MAX_PIXELS;
  if (withinBounds) return;

  const reason =
    width < MAI_MIN_EDGE || height < MAI_MIN_EDGE
      ? `both edges must be >= ${MAI_MIN_EDGE} (got ${width}x${height})`
      : `total pixels must be <= ${MAI_MAX_PIXELS.toLocaleString()} (got ${pixels.toLocaleString()} for ${width}x${height})`;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['size'],
    message:
      `${MAI_MODEL_NAME} does not support size "${size}": ${reason}. ` +
      `Valid ${MAI_MODEL_NAME} sizes: any WxH where both edges are >= ${MAI_MIN_EDGE} and total pixels are ` +
      `<= ${MAI_MAX_PIXELS.toLocaleString()} (e.g. 768x768, 896x896, 1024x1024). ` +
      `Use "1024x1024" (the recommended MAI Image default) instead of "${size}".`,
  });
}

export const ImageGenerateSchema = z.object({
  prompt: z
    .string()
    .min(1, 'Prompt is required')
    .max(PROMPT_MAX_LENGTH_GPT, `Prompt exceeds maximum length of ${PROMPT_MAX_LENGTH_GPT} characters`)
    .describe('Text description of the image to generate (max 32 000 chars for GPT image models)'),
  model: z
    .string()
    .optional()
    .describe(
      'Model to use. If omitted, the active provider default is used. ' +
      `OpenAI: ${OPENAI_MODELS.filter(m => !m.startsWith('dall-e')).join(', ')} (+ dall-e-2 for variations only). ` +
      `Azure: ${AZURE_MODELS.join(', ')}.`,
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(1)
    .describe('Number of images to generate (1–10; gpt-image-* models support up to 10)'),
  size: z
    .string()
    .optional()
    .default('auto')
    .describe(
      'Image dimensions. Accepts presets (auto, 1024x1024, 1536x1024, 1024x1536) or arbitrary WxH for gpt-image-2 ' +
      '(e.g. "2048x1152"). Both edges must be multiples of 16, max edge < 3840, ratio ≤ 3:1, pixels 655360–8294400.',
    ),
  quality: z
    .enum(['auto', 'high', 'medium', 'low'])
    .optional()
    .default('auto')
    .describe('Image quality level'),
  background: z
    .enum(['auto', 'transparent', 'opaque'])
    .optional()
    .describe('Background transparency (GPT image models only)'),
  output_format: z
    .enum(['png', 'jpeg', 'webp'])
    .optional()
    .describe('Output image format (GPT image models only)'),
  output_compression: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Compression level 0–100 for webp/jpeg (GPT image models only)'),
  resolution: z.enum(['512', '1K', '2K', '4K']).optional()
    .describe('OpenRouter resolution tier'),
  aspect_ratio: z.string().optional()
    .describe('OpenRouter aspect ratio, for example 1:1 or 16:9'),
  moderation: z
    .enum(['auto', 'low'])
    .optional()
    .describe('Content moderation level (GPT image models only)'),
  fallback_model: z
    .literal('gpt-image-2')
    .optional()
    .describe(
      'Explicit opt-in fallback used only after a retryable provider output-safety block. ' +
      'The fallback is transparent in the result and still applies gpt-image-2 safety controls.',
    ),
  save_to_workspace: z
    .boolean()
    .optional()
    .default(false)
    .describe('Save generated image(s) to MCP workspace root directory'),
  workspace_output_path: z.string().optional().describe(
    'Safe relative output path below the MCP workspace root. Existing files and symlink components are rejected.',
  ),
  disable_prompt_enhancement: z.boolean().optional().default(false).describe(
    'Disable client sampling prompt enhancement for deterministic benchmarks.',
  ),
  skip_elicitation: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Set to true to suppress the interactive quality/size form and use defaults immediately. ' +
      'Useful for automated pipelines or when passing quality="auto" is intentional.',
    ),
  response_format: z
    .nativeEnum(ResponseFormat)
    .optional()
    .default(ResponseFormat.MARKDOWN)
    .describe('Output format: markdown (default) or json'),
}).superRefine(validateModelSizeCompat);

export const ImageEditSchema = z
  .object({
    image: z
      .string()
      .optional()
      .describe(
        'Base64-encoded source image (PNG recommended, max 4 MB). Use images[] for multi-image compositing.',
      ),
    images: z
      .array(z.string().min(1))
      .min(1, 'At least one image is required in images[]')
      .max(16, 'Maximum 16 images for multi-image compositing')
      .optional()
      .describe(
        'Array of base64-encoded images for multi-image compositing (e.g. virtual try-on). ' +
          'Use instead of image for compositing. Max 16 images, max 10MB aggregate ' +
          '(the 10MB aggregate cap applies regardless of image count).',
      ),
    mask: z
      .string()
      .optional()
      .describe('Base64-encoded mask image (white=edit area, black=keep)'),
    prompt: z
      .string()
      .min(1)
      .max(PROMPT_MAX_LENGTH_GPT)
      .describe('Description of the desired edit'),
    model: z
      .string()
      .optional()
      .describe('Model to use for editing. If omitted, the active provider default is used.'),
    n: z.number().int().min(1).max(10).optional().default(1),
    size: z
      .string()
      .optional()
      .default('auto')
      .describe(
        'Image dimensions. Accepts presets (auto, 1024x1024, 1536x1024, 1024x1536) or arbitrary WxH for gpt-image-2 ' +
        '(e.g. "2048x1152"). Both edges must be multiples of 16, max edge < 3840, ratio ≤ 3:1, pixels 655360–8294400.',
      ),
    quality: z.enum(['auto', 'high', 'medium', 'low']).optional().default('auto'),
    output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    resolution: z.enum(['512', '1K', '2K', '4K']).optional()
      .describe('OpenRouter resolution tier'),
    aspect_ratio: z.string().optional()
      .describe('OpenRouter aspect ratio, for example 1:1 or 16:9'),
    input_fidelity: z
      .enum(['low', 'high'])
      .optional()
      .describe(
        'Identity preservation fidelity for gpt-image-1.x models (not supported by gpt-image-2). ' +
          '"high" preserves face, body shape, pose, hair. "low" allows more creative variation.',
      ),
    save_to_workspace: z.boolean().optional().default(false),
    response_format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN),
  })
  .superRefine(validateModelSizeCompat)
  .refine(
    (d) =>
      !!(d.image) !== !!(d.images && d.images.length > 0) ||
      (!!d.image === false && !!d.images === false),
    { message: 'Provide either "image" (single) or "images" (array), not both.' },
  )
  .refine((d) => !!(d.image) || !!(d.images && d.images.length > 0), {
    message: 'Either "image" or "images" must be provided.',
  });

export const ImageVariationSchema = z.object({
  image: z
    .string()
    .min(1)
    .describe('Base64-encoded source image for variation (dall-e-2 only, must be square PNG)'),
  n: z.number().int().min(1).max(10).optional().default(1),
  size: z.enum(['256x256', '512x512', '1024x1024']).optional().default('1024x1024'),
  save_to_workspace: z.boolean().optional().default(false),
  response_format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN),
});

export const ProviderValidateSchema = z.object({
  provider: z.enum(['openai', 'azure', 'openrouter']).describe('The provider to validate'),
});

/**
 * Resolves the moderation level, enforcing 'auto' unless IMAGE_ALLOW_LOW_MODERATION=true.
 * Moderation='low' bypasses OpenAI safety filters and requires explicit opt-in.
 */
export function resolveModeration(
  requested: 'auto' | 'low' | undefined,
): 'auto' | 'low' {
  if (requested === 'low' && process.env['IMAGE_ALLOW_LOW_MODERATION'] !== 'true') {
    return 'auto'; // silently downgrade — moderation=low requires explicit opt-in
  }
  return requested ?? 'auto';
}

export type ImageGenerateInput = z.infer<typeof ImageGenerateSchema>;
export type ImageEditInput = z.infer<typeof ImageEditSchema>;
export type ImageVariationInput = z.infer<typeof ImageVariationSchema>;
export type ProviderValidateInput = z.infer<typeof ProviderValidateSchema>;
