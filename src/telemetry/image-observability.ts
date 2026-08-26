import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';

const COUNTERS = ['input_tokens', 'output_tokens', 'image_tokens', 'total_tokens', 'billable_units'] as const;
export interface NormalizedImageUsage { input_tokens: number | null; output_tokens: number | null; image_tokens: number | null; total_tokens: number | null; billable_units: number | null; usage_source: string; }
const unavailableUsage = (): NormalizedImageUsage => ({ input_tokens: null, output_tokens: null, image_tokens: null, total_tokens: null, billable_units: null, usage_source: 'unavailable' });

export function normalizeImageUsage(value: unknown, source: string): NormalizedImageUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableUsage();
  const raw = value as Record<string, unknown>; const normalized = unavailableUsage(); let recognized = false;
  for (const key of COUNTERS) { const candidate = raw[key]; if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) { normalized[key] = candidate; recognized = true; } }
  normalized.usage_source = recognized ? source : 'unavailable'; return normalized;
}

/** Aggregate distinct response usage. Shared request-level objects attached to each image count once. */
export function aggregateImageUsage(usages: readonly (NormalizedImageUsage | undefined)[]): NormalizedImageUsage {
  const distinct = [...new Set(usages.filter((usage): usage is NormalizedImageUsage => !!usage && usage.usage_source !== 'unavailable'))];
  if (!distinct.length) return unavailableUsage(); const result = unavailableUsage();
  for (const key of COUNTERS) { const values = distinct.map((usage) => usage[key]); if (values.some((value) => value !== null)) result[key] = values.reduce<number>((sum, value) => sum + (value ?? 0), 0); }
  result.usage_source = distinct.length === 1 ? distinct[0].usage_source : 'aggregated_provider_responses'; return result;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(value); }, 'must be a valid ISO calendar date');
const publicPriceSchema = z.object({
  model: z.string().trim().min(1).max(128), region: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  deployment_tier: z.enum(['global', 'data-zone', 'regional', 'fallback']), currency: z.string().regex(/^[A-Z]{3}$/),
  token_category: z.enum(COUNTERS), pricing_unit: z.literal('per_million_units'), price_per_million_units: z.number().finite().nonnegative(),
  source_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS'),
  retrieved_at: isoDate, effective_at: isoDate.optional(), version: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  source_kind: z.enum(['authoritative', 'fallback']).default('authoritative'),
}).strict();
export type PublicPriceEntry = z.infer<typeof publicPriceSchema>;
export interface EstimatedCost { status: 'estimated' | 'unavailable'; estimated_cost: number | null; currency: string | null; pricing_source_url: string | null; pricing_retrieved_at: string | null; pricing_effective_at: string | null; pricing_region: string | null; deployment_tier: string | null; pricing_version: string | null; formula: string | null; estimation_confidence: 'configured_public_price' | 'fallback_public_price' | 'unavailable'; reason?: string; }
const unavailableCost = (reason: string): EstimatedCost => ({ status: 'unavailable', estimated_cost: null, currency: null, pricing_source_url: null, pricing_retrieved_at: null, pricing_effective_at: null, pricing_region: null, deployment_tier: null, pricing_version: null, formula: null, estimation_confidence: 'unavailable', reason });
function loadPrices(): PublicPriceEntry[] | undefined { const raw = process.env['IMAGE_PUBLIC_PRICING_JSON']; if (!raw) return undefined; try { const parsed = z.array(publicPriceSchema).min(1).safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : undefined; } catch { return undefined; } }

export function estimatePublicCost(model: string, usage: NormalizedImageUsage, now = new Date()): EstimatedCost {
  const entries = loadPrices(); if (!entries) return unavailableCost('No valid public pricing table is configured.');
  const region = process.env['IMAGE_PRICING_REGION']?.trim().toLowerCase(); const tier = process.env['IMAGE_PRICING_DEPLOYMENT_TIER']?.trim().toLowerCase();
  const candidates = entries.filter((entry) => entry.model.toLowerCase() === model.toLowerCase() && (!region || entry.region.toLowerCase() === region) && (!tier || entry.deployment_tier === tier) && usage[entry.token_category] !== null)
    .sort((a, b) => Number(a.source_kind === 'fallback') - Number(b.source_kind === 'fallback') || b.retrieved_at.localeCompare(a.retrieved_at));
  const entry = candidates[0]; if (!entry) return unavailableCost('No configured public price matches the effective model, region, tier, and returned usage.');
  const maxAgeDays = Number(process.env['IMAGE_PRICING_MAX_AGE_DAYS'] ?? '90'); if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) return unavailableCost('The pricing stale policy is invalid.');
  const ageDays = (now.valueOf() - new Date(entry.retrieved_at + 'T00:00:00Z').valueOf()) / 86_400_000; if (ageDays < 0 || ageDays > maxAgeDays) return unavailableCost('The matching public price is stale or future-dated.');
  const units = usage[entry.token_category]!; const rawCost = units * entry.price_per_million_units / 1_000_000; if (!Number.isFinite(rawCost)) return unavailableCost('The cost calculation is not finite.');
  const estimated = Math.round((rawCost + Number.EPSILON) * 1e8) / 1e8;
  return { status: 'estimated', estimated_cost: estimated, currency: entry.currency, pricing_source_url: entry.source_url, pricing_retrieved_at: entry.retrieved_at, pricing_effective_at: entry.effective_at ?? null, pricing_region: entry.region, deployment_tier: entry.deployment_tier, pricing_version: entry.version, formula: units + ' ' + entry.token_category + ' ' + entry.pricing_unit + ' / 1000000 * ' + entry.price_per_million_units + '; rounded half-up to 8 decimal places', estimation_confidence: entry.source_kind === 'fallback' ? 'fallback_public_price' : 'configured_public_price' };
}
export const promptHash = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');
export const newRequestId = (): string => randomUUID();
