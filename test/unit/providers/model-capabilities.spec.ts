import { describe, expect, it } from 'bun:test';
import { getImageModelCapabilities, isMaiModel } from '../../../src/providers/model-capabilities';

describe('image model capability registry', () => {
  it('keeps unknown Flash capabilities disabled', () => {
    expect(getImageModelCapabilities('MAI-Image-2.5-Flash')).toEqual(expect.objectContaining({
      family: 'MAI-Image-2.5-Flash', generation: 'supported', editing: 'unknown',
      variation: 'unknown', quality: 'unknown', endpoint: 'mai-v1',
    }));
    expect(isMaiModel('mai-image-2.5-flash')).toBe(true);
  });
  it('does not infer unknown models', () => expect(getImageModelCapabilities('MAI-future')).toBeUndefined());
});
