/**
 * Shared constants for Microsoft MAI Image (MAI-Image-2.5).
 *
 * Extracted from `mai-image.provider.ts` into their own module so that
 * lightweight consumers (Zod schemas, the Elicitation service, etc.) can
 * depend on just the constants without pulling in the full provider
 * implementation (which itself imports `image-media`, `sanitise`, and the
 * Azure deployment catalog types). Keeping this module free of any other
 * imports also avoids any risk of a circular import between
 * `mai-image.provider.ts` and its consumers.
 */

/** The confirmed, public-preview MAI Image model name. */
export const MAI_MODEL_NAME = 'MAI-Image-2.5';
export const MAI_FLASH_MODEL_NAME = 'MAI-Image-2.5-Flash';

/** Minimum width/height, per Microsoft's confirmed MAI Image contract. */
export const MAI_MIN_EDGE = 768;

/** Maximum total pixels (width * height), per Microsoft's confirmed MAI Image contract (1024x1024). */
export const MAI_MAX_PIXELS = 1_048_576;
