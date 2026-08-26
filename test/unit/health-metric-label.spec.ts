import { describe, expect, it } from 'bun:test';
import { imageModelMetricLabel } from '../../src/health/metrics.controller';
describe('Prometheus model labels', () => {
  it('uses a bounded allowlist and never emits deployment/request names', () => {
    expect(imageModelMetricLabel('gpt-image-2')).toBe('gpt-image-2');
    expect(imageModelMetricLabel('MAI-Image-2.5-Flash')).toBe('mai-image-2.5-flash');
    expect(imageModelMetricLabel('customer-secret-deployment')).toBe('other');
    expect(imageModelMetricLabel(undefined)).toBe('unknown');
  });
});
