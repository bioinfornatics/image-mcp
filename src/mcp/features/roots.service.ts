import { Injectable, Logger } from '@nestjs/common';
import type { Server } from '@modelcontextprotocol/server';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { maskSecret } from '../../security/sanitise';
import type { ImageFormat } from '../../providers/image-media';
import { fileUriToLocalPath, isPathWithin } from './path-utils';
import { validateWorkspaceOutputPath, workspaceOutputPaths } from './workspace-destination';

export interface WorkspaceRoot { uri: string; name?: string; }
export interface WorkspaceDestination {
  readonly rootPath: string;
  readonly relativeOutputPath: string;
  readonly outputPath: string;
  readonly format: ImageFormat;
}

@Injectable()
export class RootsService {
  private readonly logger = new Logger(RootsService.name);
  private readonly transport = (process.env['IMAGE_MCP_TRANSPORT'] ?? 'http').toLowerCase();
  private readonly allowedRootPrefixes = (process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] ?? '').split(path.delimiter).map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));

  async getRoots(server: Server): Promise<WorkspaceRoot[]> {
    try { return (await server.listRoots())?.roots as WorkspaceRoot[] ?? []; }
    catch (error) { this.logger.debug('Roots not available: ' + maskSecret(String(error))); return []; }
  }

  /** Explicit requests are pinned to the first accepted root and checked before billing. */
  async prepareWorkspaceOutputs(server: Server | undefined, relativeOutputPath: string, format: ImageFormat, n: number): Promise<WorkspaceDestination[]> {
    const filenames = workspaceOutputPaths(relativeOutputPath, n, format);
    if (!server) throw new Error('workspace_output_path requires an MCP server connection with workspace roots.');
    if (!this.workspaceSavingEnabled()) throw new Error('workspace_output_path is unavailable: HTTP workspace saving requires IMAGE_WORKSPACE_ALLOWED_ROOTS.');
    for (const root of await this.getRoots(server)) {
      const rootPath = fileUriToLocalPath(root.uri);
      if (!rootPath || !await this.isRootAllowed(rootPath)) continue;
      const destinations: WorkspaceDestination[] = [];
      // Do not move an occupied/unavailable explicit target to another root.
      for (const filename of filenames) {
        const outputPath = await this.resolveOutputPath(rootPath, filename);
        destinations.push({ rootPath, relativeOutputPath: filename, outputPath, format });
      }
      return destinations;
    }
    throw new Error('workspace_output_path is unavailable: no accepted local MCP workspace root.');
  }

  async saveImageToDestination(destination: WorkspaceDestination, b64Data: string, format: ImageFormat): Promise<string> {
    validateWorkspaceOutputPath(destination.relativeOutputPath, format);
    if (format !== destination.format) throw new Error('workspace_output_path does not match the provider output format.');
    if (!this.workspaceSavingEnabled() || !await this.isRootAllowed(destination.rootPath)) {
      throw new Error('workspace_output_path root is no longer available or allowed.');
    }
    return this.writeImage(destination.rootPath, b64Data, format, destination.relativeOutputPath, destination.outputPath);
  }

  /** Without an explicit path retain best-effort, random-name workspace copies. */
  async saveImageToWorkspace(server: Server, b64Data: string, format: ImageFormat = 'png', relativeOutputPath?: string): Promise<string | null> {
    if (relativeOutputPath !== undefined) {
      // Preserve this legacy nullable helper; tools use the strict preflight/write APIs.
      try {
        const [destination] = await this.prepareWorkspaceOutputs(server, relativeOutputPath, format, 1);
        return await this.saveImageToDestination(destination, b64Data, format);
      } catch (error) {
        this.logger.warn('Unsafe or unavailable workspace path: ' + maskSecret(String(error)));
        return null;
      }
    }
    if (!this.workspaceSavingEnabled()) {
      this.logger.warn('Workspace saving is disabled for HTTP/multi-user mode until IMAGE_WORKSPACE_ALLOWED_ROOTS is configured.');
      return null;
    }
    for (const root of await this.getRoots(server)) {
      const rootPath = fileUriToLocalPath(root.uri);
      if (!rootPath || !await this.isRootAllowed(rootPath)) continue;
      try { return await this.writeImage(rootPath, b64Data, format); }
      catch (error) { this.logger.warn('Unsafe or unavailable workspace path: ' + maskSecret(String(error))); }
    }
    return null;
  }

  private workspaceSavingEnabled(): boolean { return this.transport === 'stdio' || this.allowedRootPrefixes.length > 0; }

  private async isRootAllowed(rootPath: string): Promise<boolean> {
    if (this.allowedRootPrefixes.length === 0) return this.transport === 'stdio';
    try {
      const rootReal = await fs.realpath(rootPath);
      for (const prefix of this.allowedRootPrefixes) {
        try { if (isPathWithin(await fs.realpath(prefix), rootReal)) return true; }
        catch { /* unavailable entries grant nothing */ }
      }
    } catch { return false; }
    return false;
  }

  private async requireDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace_output_path has an unavailable or symlinked directory: ' + directory);
  }

  /** Creates safe parents, rejects even dangling destination links, and checks write access. */
  private async resolveOutputPath(rootPath: string, filename: string): Promise<string> {
    try {
      const rootResolved = path.resolve(rootPath);
      await this.requireDirectory(rootResolved);
      const rootReal = await fs.realpath(rootResolved);
      const generated = path.join(rootReal, 'generated');
      await fs.mkdir(generated, { mode: 0o700, recursive: true });
      await this.requireDirectory(generated);
      const generatedReal = await fs.realpath(generated);
      if (!isPathWithin(rootReal, generatedReal) || generatedReal === rootReal) throw new Error('Generated directory escapes workspace root.');
      const resolved = path.resolve(generatedReal, filename);
      if (!isPathWithin(generatedReal, resolved) || resolved === generatedReal) throw new Error('Output escapes generated directory.');
      const parent = path.dirname(resolved);
      let cursor = generatedReal;
      for (const component of path.relative(generatedReal, parent).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, component);
        try { await this.requireDirectory(cursor); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await fs.mkdir(cursor, { mode: 0o700 });
          await this.requireDirectory(cursor);
        }
      }
      if (await fs.realpath(parent) !== parent || !isPathWithin(generatedReal, parent)) throw new Error('Output parent escapes generated directory.');
      try {
        await fs.lstat(resolved);
        throw new Error('Occupied workspace_output_path: ' + filename);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.access(parent, constants.W_OK);
      return resolved;
    } catch (error) {
      throw new Error('Unsafe or unavailable workspace_output_path: ' + filename + ': ' + maskSecret(error instanceof Error ? error.message : String(error)));
    }
  }

  private async writeImage(rootPath: string, b64Data: string, format: ImageFormat, relativeOutputPath?: string, expectedOutputPath?: string): Promise<string> {
    let temp: string | undefined;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = relativeOutputPath ?? ('img_' + timestamp + '_' + randomUUID() + '.' + format);
      const resolved = await this.resolveOutputPath(rootPath, filename);
      if (expectedOutputPath && resolved !== expectedOutputPath) throw new Error('workspace_output_path changed after preflight.');
      const parent = path.dirname(resolved);
      const rootReal = await fs.realpath(rootPath);
      temp = path.join(parent, '.image-mcp-' + randomUUID() + '.tmp');
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(b64Data.replace(/^data:[^;]+;base64,/, ''), 'base64')); await handle.sync(); }
      finally { await handle.close(); }
      await this.requireDirectory(path.resolve(rootPath));
      await this.requireDirectory(path.join(rootReal, 'generated'));
      if (await fs.realpath(rootPath) !== rootReal || await fs.realpath(parent) !== parent) throw new Error('workspace_output_path directory changed during write.');
      // Exclusive atomic publish: a provider-time or final-moment collision cannot overwrite.
      await fs.link(temp, resolved);
      await fs.unlink(temp);
      temp = undefined;
      this.logger.log('Image saved: ' + resolved);
      return resolved;
    } catch (error) {
      throw new Error('Unable to write workspace_output_path: ' + maskSecret(error instanceof Error ? error.message : String(error)));
    } finally { if (temp) await fs.unlink(temp).catch(() => undefined); }
  }
}
