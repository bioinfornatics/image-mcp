export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface ImageModelCapabilities {
  readonly family: string;
  readonly publisher: string;
  readonly generation: CapabilityState;
  readonly editing: CapabilityState;
  readonly variation: CapabilityState;
  readonly sizeContract: 'mai-pixel-budget' | 'gpt-image' | 'unknown';
  readonly quality: CapabilityState;
  readonly outputFormats: readonly ('png' | 'jpeg' | 'webp')[];
  readonly endpoint: 'mai-v1' | 'openai-v1';
  readonly evidence: 'confirmed' | 'assumed';
}

/** One conservative source of truth for validation and Azure routing. Unknown Flash features stay disabled. */
export const IMAGE_MODEL_CAPABILITIES: Readonly<Record<string, ImageModelCapabilities>> = {
  'mai-image-2.5': {
    family: 'MAI-Image-2.5', publisher: 'Microsoft', generation: 'supported', editing: 'supported',
    variation: 'unsupported', sizeContract: 'mai-pixel-budget', quality: 'unsupported',
    outputFormats: ['png'], endpoint: 'mai-v1', evidence: 'confirmed',
  },
  'mai-image-2.5-flash': {
    family: 'MAI-Image-2.5-Flash', publisher: 'Microsoft', generation: 'supported', editing: 'unknown',
    variation: 'unknown', sizeContract: 'mai-pixel-budget', quality: 'unknown',
    outputFormats: ['png'], endpoint: 'mai-v1', evidence: 'assumed',
  },
  'gpt-image-2': {
    family: 'gpt-image-2', publisher: 'OpenAI', generation: 'supported', editing: 'supported',
    variation: 'unsupported', sizeContract: 'gpt-image', quality: 'supported',
    outputFormats: ['png', 'jpeg', 'webp'], endpoint: 'openai-v1', evidence: 'confirmed',
  },
};

export function getImageModelCapabilities(model: string | undefined): ImageModelCapabilities | undefined {
  return model ? IMAGE_MODEL_CAPABILITIES[model.trim().toLowerCase()] : undefined;
}

export function isMaiModel(model: string | undefined): boolean {
  return getImageModelCapabilities(model)?.endpoint === 'mai-v1';
}
