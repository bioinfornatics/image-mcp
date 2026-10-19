import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import fastify from 'fastify';

describe('HTTP proxy trust security', () => {
  it('disables unconditional hop-count trust in the production adapter', () => {
    const bootstrap = readFileSync(resolve(import.meta.dir, '../../../src/main.ts'), 'utf8');
    expect(bootstrap).toContain('trustProxy: false');
    expect(bootstrap).not.toContain('trustProxy: 1');
  });

  it('ignores forged forwarded addresses from an untrusted direct client', async () => {
    const server = fastify({ trustProxy: false });
    server.get('/', (request) => ({ ip: request.ip }));
    try {
      const response = await server.inject({
        method: 'GET', url: '/', remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.1, 192.0.2.1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: '127.0.0.1' });
    } finally {
      await server.close();
    }
  });
});
