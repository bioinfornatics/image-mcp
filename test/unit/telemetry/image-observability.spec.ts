import { afterEach, describe, expect, it } from 'bun:test';
import { aggregateImageUsage, estimatePublicCost, normalizeImageUsage, promptHash } from '../../../src/telemetry/image-observability';
const price = (overrides: Record<string, unknown> = {}) => ({ model: 'MAI-Image-2.5-Flash', region: 'westus', deployment_tier: 'global', currency: 'USD', token_category: 'image_tokens', pricing_unit: 'per_million_units', price_per_million_units: 10, source_url: 'https://azure.microsoft.com/pricing', retrieved_at: '2026-08-20', effective_at: '2026-08-01', version: '2026-08-v1', ...overrides });
afterEach(() => { for (const key of ['IMAGE_PUBLIC_PRICING_JSON','IMAGE_PRICING_REGION','IMAGE_PRICING_DEPLOYMENT_TIER','IMAGE_PRICING_MAX_AGE_DAYS']) delete process.env[key]; });
describe('image observability security policy', () => {
  it('accepts only finite non-negative recognized counters', () => {
    expect(normalizeImageUsage({ input_tokens: 12, output_tokens: -1, image_tokens: Infinity, total_tokens: NaN, unknown: 9 }, 'azure_response')).toEqual({ input_tokens: 12, output_tokens: null, image_tokens: null, total_tokens: null, billable_units: null, usage_source: 'azure_response' });
    expect(normalizeImageUsage({ unknown: 9 }, 'azure_response').usage_source).toBe('unavailable');
    expect(normalizeImageUsage({ image_tokens: -1 }, 'azure_response').usage_source).toBe('unavailable');
  });
  it('aggregates distinct multi-image usage and de-duplicates shared request usage', () => {
    const shared = normalizeImageUsage({ image_tokens: 2 }, 'azure_response');
    expect(aggregateImageUsage([shared, shared]).image_tokens).toBe(2);
    expect(aggregateImageUsage([shared, normalizeImageUsage({ image_tokens: 3 }, 'azure_response')])).toEqual(expect.objectContaining({ image_tokens: 5, usage_source: 'aggregated_provider_responses' }));
  });
  it.each([{ currency: 'usd' }, { source_url: 'http://azure.example/pricing' }, { retrieved_at: 'not-date' }, { version: '' }, { region: '' }, { deployment_tier: 'arbitrary' }, { pricing_unit: 'per_image' }, { price_per_million_units: Infinity }, { extra: true }])('rejects malformed pricing entry %#', (bad) => {
    process.env['IMAGE_PUBLIC_PRICING_JSON'] = JSON.stringify([price(bad)]);
    expect(estimatePublicCost('MAI-Image-2.5-Flash', normalizeImageUsage({ image_tokens: 2 }, 'azure_response'), new Date('2026-08-26T00:00:00Z')).status).toBe('unavailable');
  });
  it('enforces staleness and rounds the aggregate once to eight decimals', () => {
    process.env['IMAGE_PUBLIC_PRICING_JSON'] = JSON.stringify([price({ price_per_million_units: 1.23456789 })]);
    const usage = aggregateImageUsage([normalizeImageUsage({ image_tokens: 1 }, 'x'), normalizeImageUsage({ image_tokens: 2 }, 'x')]);
    expect(estimatePublicCost('MAI-Image-2.5-Flash', usage, new Date('2026-08-26T00:00:00Z')).estimated_cost).toBe(0.0000037);
    process.env['IMAGE_PRICING_MAX_AGE_DAYS'] = '2';
    expect(estimatePublicCost('MAI-Image-2.5-Flash', usage, new Date('2026-08-26T00:00:00Z')).status).toBe('unavailable');
  });
  it('selects authoritative over fallback and supports explicit fallback', () => {
    const fallback = price({ source_kind: 'fallback', price_per_million_units: 20, version: 'fallback' });
    process.env['IMAGE_PUBLIC_PRICING_JSON'] = JSON.stringify([fallback, price()]);
    const usage = normalizeImageUsage({ image_tokens: 1000 }, 'x');
    expect(estimatePublicCost('MAI-Image-2.5-Flash', usage, new Date('2026-08-26T00:00:00Z'))).toEqual(expect.objectContaining({ estimated_cost: 0.01, estimation_confidence: 'configured_public_price' }));
    process.env['IMAGE_PUBLIC_PRICING_JSON'] = JSON.stringify([fallback]);
    expect(estimatePublicCost('MAI-Image-2.5-Flash', usage, new Date('2026-08-26T00:00:00Z')).estimation_confidence).toBe('fallback_public_price');
  });
  it('returns unavailable, never zero, for malformed, unknown, missing, or mismatched inputs', () => {
    const usage = normalizeImageUsage({}, 'azure_response'); expect(estimatePublicCost('gpt-image-2', usage).estimated_cost).toBeNull();
    process.env['IMAGE_PUBLIC_PRICING_JSON'] = '{'; expect(estimatePublicCost('gpt-image-2', usage).estimated_cost).toBeNull();
  });
  it('hashes prompts deterministically', () => expect(promptHash('same')).toBe(promptHash('same')));
});
