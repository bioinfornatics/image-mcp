#!/usr/bin/env node
// Audit what npm consumers actually install, not the repository's patched tree.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(join(tmpdir(), 'image-mcp-npm-consumer-'));
const consumer = join(workspace, 'consumer');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(consumer);
const npmrc = join(workspace, 'empty.npmrc');
const globalNpmrc = join(workspace, 'empty-global.npmrc');
writeFileSync(npmrc, '');
writeFileSync(globalNpmrc, '');
// Do not inherit credentials, NODE_OPTIONS, provider secrets or npm settings.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() };
const npmOptions = [
  '--registry=https://registry.npmjs.org/',
  '--userconfig=' + npmrc,
  '--globalconfig=' + globalNpmrc,
];

function command(executable, args, cwd, capture = false) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    const error = new Error(executable + ' ' + args[0] + ' failed');
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result.stdout;
}

try {
  // npm pack runs prepack: build the archive from the current source.
  const [packed] = JSON.parse(
    command('npm', ['pack', '--json', '--pack-destination', workspace, ...npmOptions], root, true),
  );
  if (!packed?.files?.some((file) => file.path === 'dist/main.js')) {
    throw new Error('Packed artifact lacks the compiled CLI');
  }
  const forbidden = packed.files.filter((file) =>
    /(^|\/)(\.env(?:\..*)?|\.npmrc|src|test|node_modules|coverage|\.git)(\/|$)/.test(file.path),
  );
  if (forbidden.length) throw new Error('Unexpected private/development paths in the npm archive');
  console.log(
    'Packed ' + manifest.name + '@' + manifest.version + ': ' + packed.files.length + ' files',
  );
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'image-mcp-consumer-check', version: '1.0.0', private: true }),
  );
  command(
    'npm',
    [
      'install',
      join(workspace, packed.filename),
      '--omit=dev',
      '--engine-strict',
      '--no-fund',
      '--no-audit',
      ...npmOptions,
    ],
    consumer,
  );
  command('npm', ['audit', '--omit=dev', '--audit-level=high', ...npmOptions], consumer);
  // npm ls fails on invalid peers as well as showing every nested runtime version.
  command(
    'npm',
    [
      'ls',
      '--all',
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/config',
      '@nestjs/platform-fastify',
      '@nestjs/terminus',
      'fastify',
      'lodash',
      ...npmOptions,
    ],
    consumer,
  );
  const version = command(
    'npx',
    ['--no', ...npmOptions, '--', 'image-mcp', '--version'],
    consumer,
    true,
  );
  if (version.trim() !== 'image-mcp ' + manifest.version)
    throw new Error('Installed CLI version mismatch');
  console.log(version.trim());
  command(
    process.execPath,
    [join(root, 'bin/smoke-mcp-consumer.mjs'), consumer, manifest.version, npmrc, globalNpmrc],
    consumer,
  );
  console.log('Clean npm consumer audit, CLI and MCP checks passed');
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
