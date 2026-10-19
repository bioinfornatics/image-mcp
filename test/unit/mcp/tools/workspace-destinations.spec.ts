import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Server } from '@modelcontextprotocol/server';
import type { IImageProvider } from '../../../../src/providers/provider.interface';
import { RootsService } from '../../../../src/mcp/features/roots.service';
import { ImageStorageService } from '../../../../src/mcp/features/image-storage.service';
import { ElicitationService } from '../../../../src/mcp/features/elicitation.service';
import { SamplingService } from '../../../../src/mcp/features/sampling.service';
import { ImageGenerateTool } from '../../../../src/mcp/tools/image-generate.tool';
import { ImageEditTool } from '../../../../src/mcp/tools/image-edit.tool';

const B64 = Buffer.from('mock image').toString('base64');
const image = { b64_json: B64, format: 'png' as const, mimeType: 'image/png' as const, model: 'gpt-image-2', created: 1 };

for (const operation of ['generate', 'edit'] as const) {
  describe(operation + ' workspace destinations (mock provider, real filesystem)', () => {
    let tmp: string;
    let roots: RootsService;
    let server: Server;
    let callProvider: ReturnType<typeof jest.fn>;
    let saveAutomatic: ReturnType<typeof jest.fn>;
    let execute: (params: Record<string, unknown>, connection?: Server) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;

    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'image-destination-'));
      const transport = process.env['IMAGE_MCP_TRANSPORT'];
      const allowed = process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'];
      process.env['IMAGE_MCP_TRANSPORT'] = 'stdio';
      delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'];
      roots = new RootsService();
      if (transport === undefined) delete process.env['IMAGE_MCP_TRANSPORT']; else process.env['IMAGE_MCP_TRANSPORT'] = transport;
      if (allowed === undefined) delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS']; else process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] = allowed;
      server = { listRoots: jest.fn().mockResolvedValue({ roots: [{ uri: pathToFileURL(tmp).href }] }) } as unknown as Server;
      callProvider = jest.fn().mockResolvedValue([image]);
      const provider = { name: 'mock', [operation]: callProvider } as unknown as IImageProvider;
      saveAutomatic = jest.fn().mockResolvedValue(path.join(tmp, 'automatic.png'));
      const storage = { saveImage: saveAutomatic } as unknown as ImageStorageService;
      const tool = operation === 'generate'
        ? new ImageGenerateTool(provider, { requestImageParams: jest.fn().mockResolvedValue(null) } as unknown as ElicitationService,
          { enhancePrompt: jest.fn().mockImplementation(async (_server, prompt) => prompt) } as unknown as SamplingService, roots, storage)
        : new ImageEditTool(provider, roots, storage);
      execute = (params, connection) => tool.execute({ image: B64, prompt: 'test', skip_elicitation: true, disable_prompt_enhancement: true, response_format: 'json', ...params }, connection);
    });

    afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

    it('uses the exact same generated-relative path for either tool', async () => {
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'design/target.png' }, server);
      expect(result.isError).not.toBe(true);
      const output = JSON.parse(result.content[0].text!);
      expect(output.images[0].workspace_copy).toBe(path.join(tmp, 'generated/design/target.png'));
      expect(await fs.readFile(output.images[0].workspace_copy, 'utf8')).toBe('mock image');
      expect(callProvider).toHaveBeenCalledTimes(1);
      expect(saveAutomatic).toHaveBeenCalledTimes(1);
    });

    it('uses shared -1/-2 suffixes before the extension for requested n', async () => {
      callProvider.mockResolvedValue([image, image]);
      const result = await execute({ n: 2, save_to_workspace: true, workspace_output_path: 'design/target.png' }, server);
      expect(result.isError).not.toBe(true);
      const output = JSON.parse(result.content[0].text!);
      expect(output.images.map((entry: { workspace_copy: string }) => entry.workspace_copy)).toEqual([
        path.join(tmp, 'generated/design/target-1.png'), path.join(tmp, 'generated/design/target-2.png'),
      ]);
    });

    it('retains requested n suffixes even when the provider returns fewer images', async () => {
      const result = await execute({ n: 2, save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).not.toBe(true);
      const output = JSON.parse(result.content[0].text!);
      expect(output.images).toHaveLength(1);
      expect(output.images[0].workspace_copy).toBe(path.join(tmp, 'generated/target-1.png'));
    });

    for (const format of ['jpeg', 'webp'] as const) {
      it('accepts an explicit extension matching output_format: ' + format, async () => {
        callProvider.mockResolvedValue([{ ...image, format, mimeType: 'image/' + format }]);
        const result = await execute({ output_format: format, save_to_workspace: true, workspace_output_path: 'target.' + format }, server);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text!).images[0].workspace_copy).toBe(path.join(tmp, 'generated/target.' + format));
      });
    }

    it('preserves automatic-only storage without an explicit path or connection', async () => {
      const result = await execute({ save_to_workspace: true });
      expect(result.isError).not.toBe(true);
      expect(saveAutomatic).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result.content[0].text!).images[0].workspace_copy).toBeUndefined();
    });

    it('preserves random-name workspace copies without an explicit path', async () => {
      const result = await execute({ save_to_workspace: true }, server);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text!).images[0].workspace_copy).toMatch(/generated[/\\]img_.*\.png$/);
    });

    it('keeps output indexes stable when a default workspace copy is unavailable', async () => {
      callProvider.mockResolvedValue([image, image]);
      jest.spyOn(roots, 'saveImageToWorkspace').mockResolvedValueOnce(null).mockResolvedValueOnce(path.join(tmp, 'second.png'));
      const result = await execute({ n: 2, save_to_workspace: true }, server);
      const output = JSON.parse(result.content[0].text!);
      expect(output.images[0].workspace_copy).toBeUndefined();
      expect(output.images[1].workspace_copy).toBe(path.join(tmp, 'second.png'));
    });

    for (const invalid of ['', '.', '../target.png', '/target.png', 'generated/target.png', 'generated/generated/target.png', 'Generated/target.png', 'a//target.png', './target.png', 'a/../target.png', 'a/./target.png', 'target.png/', 'a\\target.png', 'C:target.png', 'C:/target.png', '//server/target.png', 'target.png:stream', 'target.webp', 'target', 'target.png\0', 'a./target.png', 'CON/target.png']) {
      it('rejects unsafe or mismatched path before provider: ' + JSON.stringify(invalid), async () => {
        const result = await execute({ save_to_workspace: true, workspace_output_path: invalid }, server);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('workspace_output_path');
        expect(callProvider).not.toHaveBeenCalled();
        expect(saveAutomatic).not.toHaveBeenCalled();
      });
    }

    it('requires save_to_workspace for explicit paths', async () => {
      const result = await execute({ workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('save_to_workspace');
      expect(callProvider).not.toHaveBeenCalled();
    });

    it('requires a connection for explicit paths', async () => {
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' });
      expect(result.isError).toBe(true);
      expect(callProvider).not.toHaveBeenCalled();
    });

    for (const unavailable of ['empty', 'throws', 'missing', 'http', 'outside-allowlist', 'non-file']) {
      it('fails closed before provider when root is ' + unavailable, async () => {
        if (unavailable === 'empty') server = { listRoots: jest.fn().mockResolvedValue({ roots: [] }) } as unknown as Server;
        if (unavailable === 'throws') server = { listRoots: jest.fn().mockRejectedValue(new Error('no roots')) } as unknown as Server;
        if (unavailable === 'missing') await fs.rm(tmp, { recursive: true, force: true });
        if (unavailable === 'non-file') server = { listRoots: jest.fn().mockResolvedValue({ roots: [{ uri: 'https://example.invalid/root' }] }) } as unknown as Server;
        if (unavailable === 'http' || unavailable === 'outside-allowlist') {
          const transport = process.env['IMAGE_MCP_TRANSPORT'];
          const allowed = process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'];
          process.env['IMAGE_MCP_TRANSPORT'] = unavailable === 'http' ? 'http' : 'stdio';
          if (unavailable === 'http') delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS']; else process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] = path.join(tmp, 'not-allowed');
          Object.assign(roots, new RootsService());
          if (transport === undefined) delete process.env['IMAGE_MCP_TRANSPORT']; else process.env['IMAGE_MCP_TRANSPORT'] = transport;
          if (allowed === undefined) delete process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS']; else process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] = allowed;
        }
        const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' }, server);
        expect(result.isError).toBe(true);
        expect(callProvider).not.toHaveBeenCalled();
      });
    }

    for (const occupied of ['file', 'directory', 'symlink', 'dangling-symlink', 'parent-symlink', 'generated-symlink']) {
      it('rejects occupied/linked paths before provider: ' + occupied, async () => {
        await fs.mkdir(path.join(tmp, 'generated'));
        const dest = path.join(tmp, 'generated/target.png');
        if (occupied === 'file') await fs.writeFile(dest, 'existing');
        if (occupied === 'directory') await fs.mkdir(dest);
        if (occupied === 'symlink' || occupied === 'dangling-symlink') await fs.symlink(occupied === 'symlink' ? tmp : path.join(tmp, 'missing'), dest);
        if (occupied === 'parent-symlink') await fs.symlink(tmp, path.join(tmp, 'generated/sub'));
        if (occupied === 'generated-symlink') { await fs.rmdir(path.join(tmp, 'generated')); await fs.symlink(tmp, path.join(tmp, 'generated')); }
        const result = await execute({ save_to_workspace: true, workspace_output_path: occupied === 'parent-symlink' ? 'sub/target.png' : 'target.png' }, server);
        expect(result.isError).toBe(true);
        expect(callProvider).not.toHaveBeenCalled();
      });
    }

    it('preflights every n destination, including a later occupied output', async () => {
      await fs.mkdir(path.join(tmp, 'generated'));
      await fs.writeFile(path.join(tmp, 'generated/target-2.png'), 'existing');
      const result = await execute({ n: 2, save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(callProvider).not.toHaveBeenCalled();
    });

    it('does not fall back to another root when the accepted destination is occupied', async () => {
      await fs.mkdir(path.join(tmp, 'generated'));
      await fs.writeFile(path.join(tmp, 'generated/target.png'), 'existing');
      await fs.mkdir(path.join(tmp, 'other'));
      server = { listRoots: jest.fn().mockResolvedValue({ roots: [{ uri: pathToFileURL(tmp).href }, { uri: pathToFileURL(path.join(tmp, 'other')).href }] }) } as unknown as Server;
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(callProvider).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(tmp, 'other'))).toEqual([]);
    });

    it('rechecks a collision created during the provider call without overwriting', async () => {
      callProvider.mockImplementation(async () => { await fs.writeFile(path.join(tmp, 'generated/target.png'), 'racing writer'); return [image]; });
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(callProvider).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(tmp, 'generated/target.png'), 'utf8')).toBe('racing writer');
      expect(await fs.readdir(path.join(tmp, 'generated'))).toEqual(['target.png']);
    });

    it('rejects a parent symlink introduced during the provider call', async () => {
      await fs.mkdir(path.join(tmp, 'outside'));
      callProvider.mockImplementation(async () => {
        await fs.rmdir(path.join(tmp, 'generated/sub'));
        await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'generated/sub'));
        return [image];
      });
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'sub/target.png' }, server);
      expect(result.isError).toBe(true);
      expect(callProvider).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(path.join(tmp, 'outside'))).toEqual([]);
    });

    it('never switches roots after a provider-time collision', async () => {
      await fs.mkdir(path.join(tmp, 'other'));
      const listRoots = jest.fn().mockResolvedValue({ roots: [{ uri: pathToFileURL(tmp).href }, { uri: pathToFileURL(path.join(tmp, 'other')).href }] });
      server = { listRoots } as unknown as Server;
      callProvider.mockImplementation(async () => { await fs.writeFile(path.join(tmp, 'generated/target.png'), 'racing writer'); return [image]; });
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(listRoots).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(path.join(tmp, 'other'))).toEqual([]);
    });

    it('rejects a provider format mismatch rather than publishing under a wrong extension', async () => {
      callProvider.mockResolvedValue([{ ...image, format: 'webp', mimeType: 'image/webp' }]);
      const result = await execute({ save_to_workspace: true, workspace_output_path: 'target.png' }, server);
      expect(result.isError).toBe(true);
      expect(await fs.readdir(path.join(tmp, 'generated'))).toEqual([]);
    });
  });
}
