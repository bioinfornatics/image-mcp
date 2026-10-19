import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '../../..');
const SCRIPT = join(ROOT, 'bin/verify-npm-consumer.mjs');
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function failingNpm(stage: string) {
  const directory = mkdtempSync(join(tmpdir(), 'image-mcp-consumer-stub-'));
  temporaryDirectories.push(directory);
  const npm = join(directory, 'npm');
  writeFileSync(
    npm,
    [
      '#!/bin/sh',
      'case "$1" in',
      'pack)',
      stage === 'pack'
        ? '  exit 17 ;;'
        : '  printf \'[{"filename":"test.tgz","files":[{"path":"dist/main.js"},{"path":"package.json"}]}]\\n\' ;;',
      'install)',
      stage === 'install' ? '  exit 19 ;;' : '  exit 0 ;;',
      'audit) exit 23 ;;',
      '*) exit 29 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(npm, 0o700);
  return spawnSync('node', [SCRIPT], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: directory + ':' + process.env.PATH, HOME: process.env.HOME },
  });
}

describe('clean npm consumer gate', () => {
  for (const [stage, code] of [
    ['pack', 17],
    ['install', 19],
    ['audit', 23],
  ] as const) {
    it('propagates the failing ' + stage + ' command from a foreign cwd', () => {
      const result = failingNpm(stage);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(code);
    });
  }
  it('packs a fresh build and installs without copying workspace overrides or lockfiles', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain("'pack'");
    expect(script).not.toContain('--ignore-scripts');
    expect(script).toContain("'--omit=dev'");
    expect(script).toContain("'--engine-strict'");
    expect(script).toContain("'--audit-level=high'");
    expect(script).toContain('private: true');
    expect(script).toContain('--userconfig=');
    expect(script).not.toContain('copyFile');
    expect(script).not.toContain('overrides:');
    expect(script).not.toContain('bun.lock');
  });
  it('checks the installed CLI and MCP through npx, without real provider credentials', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain("'npx'");
    expect(script).toContain("'--version'");
    expect(script).toContain('smoke-mcp-consumer.mjs');
    const smoke = readFileSync(join(ROOT, 'bin/smoke-mcp-consumer.mjs'), 'utf8');
    expect(smoke).toContain('sk-fake-consumer-smoke-key');
    expect(smoke).toContain('initialize');
    expect(smoke).toContain('tools/list');
    expect(smoke).toContain('provider_list');
    expect(smoke).not.toContain('image_generate');
  });
});

describe('coordinated NestJS migration and CI wiring', () => {
  it('keeps the Nest runtime and testing packages on the approved compatible major', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    for (const name of ['common', 'core', 'platform-fastify']) {
      expect(manifest.dependencies['@nestjs/' + name]).toBe('12.1.3');
    }
    expect(manifest.devDependencies['@nestjs/testing']).toBe('12.1.3');
    expect(manifest.dependencies['@nestjs/config']).toBe('12.0.1');
    expect(manifest.dependencies['@nestjs/terminus']).toBe('12.1.0');
    expect(manifest.engines.node).toBe('>=22');
  });
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  it('runs a dedicated consumer artifact check', () => {
    expect(workflow).toContain('\n  npm-consumer:');
    expect(workflow).toContain('node bin/verify-npm-consumer.mjs');
    expect(workflow).toContain("node: ['22', '24']");
  });
  for (const job of ['docker', 'publish-gpr', 'publish-npm']) {
    it(job + ' requires the clean consumer gate', () => {
      const block = workflow.split('\n  ' + job + ':')[1]?.split(/\n  [a-z][a-z-]*:/)[0];
      expect(block).toMatch(/needs: \[[^\]\n]*\bnpm-consumer\b[^\]\n]*\]/);
    });
  }
});
