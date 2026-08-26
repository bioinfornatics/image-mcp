/**
 * Single source of truth for model identifiers.
 *
 * When OpenAI / Azure releases a new generation, update LATEST_MODEL here — nowhere else.
 * Every default in schemas, config, strategies, and tool descriptions derives from this value.
 *
 * Model timeline (as of April 23, 2026):
 *  - gpt-image-2      : Released 2026-04-21. Flagship. Arbitrary resolution up to 4K.
 *  - gpt-image-1.5    : Released 2025-12-16. Fixed resolutions. Limited Access on Azure.
 *  - gpt-image-1-mini : Released 2025-10-06. Cost/throughput optimised. Limited Access on Azure.
 *  - gpt-image-1      : Released 2025-04-15. Previous gen. Limited Access on Azure.
 *  - dall-e-3         : RETIRED 2026-03-04 — no longer available for new deployments.
 *  - dall-e-2         : Superseded — variations endpoint only (OpenAI direct API).
 */

/** The current flagship model — used as the default when no model is explicitly supplied. */
export const LATEST_MODEL = 'gpt-image-2' as const;

/** Full model catalogue for the OpenAI direct API provider. */
export const OPENAI_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'gpt-image-1',
  'dall-e-2',           // variations only
  // dall-e-3 retired 2026-03-04 — removed
] as const;

/**
 * Azure OpenAI model catalogue.
 * Access tiers as of 2026-04-23:
 *  - gpt-image-2  : Public Preview (no application needed)
 *  - gpt-image-1* : Limited Access Preview (apply at https://aka.ms/oai/gptimage1access)
 *  - dall-e-3     : RETIRED 2026-03-04
 *  - dall-e-2     : Superseded, not listed in Azure docs
 */
export const AZURE_MODELS = [
  'gpt-image-2',          // Public Preview
  'gpt-image-1.5',        // Limited Access
  'gpt-image-1-mini',     // Limited Access
  'gpt-image-1',          // Limited Access
  'MAI-Image-2.5',        // Public Preview — Microsoft MAI Image, served via dedicated /mai/v1 endpoint
  'MAI-Image-2.5-Flash',  // Microsoft MAI low-latency family; discovered deployments route through /mai/v1
] as const;

export const OPENROUTER_IMAGE_MODELS = [
  'google/gemini-3.1-flash-image',
  'microsoft/mai-image-2.5',
] as const;

export const OPENROUTER_DEFAULT_MODEL = OPENROUTER_IMAGE_MODELS[0];

export type ModelName = (typeof OPENAI_MODELS)[number] | (typeof AZURE_MODELS)[number] |
  (typeof OPENROUTER_IMAGE_MODELS)[number];
