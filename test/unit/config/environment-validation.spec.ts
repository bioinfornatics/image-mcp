import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateEnvironment } from '../../../src/config/environment-validation';

const valid = {
  IMAGE_PROVIDER: 'openai',
  IMAGE_API_KEY: 'sk-fake-validation',
  IMAGE_MCP_TRANSPORT: 'stdio',
};
describe('NestJS 12 custom Joi validation bridge', () => {
  it('preserves defaults, coercion and unrelated environment variables', () => {
    const result = validateEnvironment({
      ...valid,
      IMAGE_PORT: '3200',
      IMAGE_USE_SAMPLING: 'false',
      PATH: '/usr/bin',
    });
    expect(result.IMAGE_PORT).toBe(3200);
    expect(result.IMAGE_USE_SAMPLING).toBe(false);
    expect(result.IMAGE_MAX_REQUESTS_PER_MINUTE).toBe(60);
    expect(result.PATH).toBe('/usr/bin');
  });
  it('reports multiple invalid fields rather than aborting on the first error', () => {
    expect(() =>
      validateEnvironment({ ...valid, IMAGE_PORT: '0', IMAGE_LOG_LEVEL: 'invalid' }),
    ).toThrow(/Config validation error:.*IMAGE_PORT.*IMAGE_LOG_LEVEL/);
  });
  it('continues to fail closed on missing HTTP authentication', () => {
    expect(() => validateEnvironment({ ...valid, IMAGE_MCP_TRANSPORT: 'http' })).toThrow(
      /IMAGE_MCP_API_KEY is required/,
    );
  });
  it('does not expose the provider key in validation errors', () => {
    try {
      validateEnvironment({ ...valid, IMAGE_PORT: '-1' });
      throw new Error('Expected invalid config to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(valid.IMAGE_API_KEY);
    }
  });
  it('uses the custom validator, not the incompatible Standard Schema option', () => {
    const module = readFileSync(resolve(import.meta.dir, '../../../src/app.module.ts'), 'utf8');
    expect(module).toContain('validate: validateEnvironment');
    expect(module).not.toContain('validationSchema:');
  });
});
