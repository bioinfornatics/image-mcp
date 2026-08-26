import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RootsService } from '../../../../src/mcp/features/roots.service';

describe('relative workspace output paths', () => {
  let root: string; let server: any;
  beforeEach(async () => { process.env['IMAGE_MCP_TRANSPORT'] = 'stdio'; root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-path-')); server = { listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }) }; });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));
  it('writes the exact confined relative path without overwriting', async () => {
    const service = new RootsService();
    const first = await service.saveImageToWorkspace(server, Buffer.from('one').toString('base64'), 'png', 'bench/lane-a.png');
    expect(first).toBe(path.join(root, 'generated', 'bench', 'lane-a.png'));
    expect(await fs.readFile(first!, 'utf8')).toBe('one');
    expect(await service.saveImageToWorkspace(server, Buffer.from('two').toString('base64'), 'png', 'bench/lane-a.png')).toBeNull();
  });
  it('rejects traversal and absolute paths', async () => {
    const service = new RootsService();
    expect(await service.saveImageToWorkspace(server, 'eA==', 'png', '../escape.png')).toBeNull();
    expect(await service.saveImageToWorkspace(server, 'eA==', 'png', path.join(root, 'escape.png'))).toBeNull();
  });
});

describe('workspace publication security', () => {
  it('fails closed in HTTP mode without an allowlist', async () => {
    const oldTransport = process.env['IMAGE_MCP_TRANSPORT']; const oldRoots = process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS']; process.env['IMAGE_MCP_TRANSPORT'] = 'http'; delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-http-'));
    try { const server = { listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }) }; expect(await new RootsService().saveImageToWorkspace(server as any, 'eA==')).toBeNull(); expect(await fs.readdir(root)).toEqual([]); } finally { if (oldTransport === undefined) delete process.env['IMAGE_MCP_TRANSPORT']; else process.env['IMAGE_MCP_TRANSPORT'] = oldTransport; if (oldRoots === undefined) delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS']; else process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] = oldRoots; await fs.rm(root, { recursive: true, force: true }); }
  });
  it('atomically publishes one complete winner, never overwrites, and cleans temporary files', async () => {
    const oldTransport = process.env['IMAGE_MCP_TRANSPORT']; process.env['IMAGE_MCP_TRANSPORT'] = 'stdio'; const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-atomic-')); const server = { listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }) };
    try { const service = new RootsService(); const results = await Promise.all(Array.from({ length: 12 }, (_, i) => service.saveImageToWorkspace(server as any, Buffer.from('payload-' + i).toString('base64'), 'png', 'race.png'))); expect(results.filter(Boolean)).toHaveLength(1); expect((await fs.readFile(path.join(root, 'generated', 'race.png'), 'utf8')).startsWith('payload-')).toBe(true); expect((await fs.readdir(path.join(root, 'generated'))).filter((name) => name.includes('.image-mcp-'))).toEqual([]); } finally { if (oldTransport === undefined) delete process.env['IMAGE_MCP_TRANSPORT']; else process.env['IMAGE_MCP_TRANSPORT'] = oldTransport; await fs.rm(root, { recursive: true, force: true }); }
  });
  it('rejects a symlinked nested output directory without writing outside', async () => {
    const oldTransport = process.env['IMAGE_MCP_TRANSPORT']; process.env['IMAGE_MCP_TRANSPORT'] = 'stdio'; const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-link-')); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'image-out-'));
    try { await fs.mkdir(path.join(root, 'generated')); await fs.symlink(outside, path.join(root, 'generated', 'nested'), process.platform === 'win32' ? 'junction' : 'dir'); const server = { listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }) }; expect(await new RootsService().saveImageToWorkspace(server as any, 'eA==', 'png', 'nested/x.png')).toBeNull(); expect(await fs.readdir(outside)).toEqual([]); } finally { if (oldTransport === undefined) delete process.env['IMAGE_MCP_TRANSPORT']; else process.env['IMAGE_MCP_TRANSPORT'] = oldTransport; await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
  });
});
