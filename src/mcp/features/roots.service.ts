import { Injectable, Logger } from '@nestjs/common';
import type { Server } from '@modelcontextprotocol/server';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { maskSecret } from '../../security/sanitise';
import { fileUriToLocalPath, isPathWithin } from './path-utils';
export interface WorkspaceRoot { uri: string; name?: string; }
@Injectable()
export class RootsService {
  private readonly logger = new Logger(RootsService.name);
  private readonly transport = (process.env['IMAGE_MCP_TRANSPORT'] ?? 'http').toLowerCase();
  private readonly allowedRootPrefixes = (process.env['IMAGE_WORKSPACE_ALLOWED_ROOTS'] ?? '').split(path.delimiter).map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
  async getRoots(server: Server): Promise<WorkspaceRoot[]> { try { return (await server.listRoots())?.roots as WorkspaceRoot[] ?? []; } catch (error) { this.logger.debug('Roots not available: ' + maskSecret(String(error))); return []; } }
  async saveImageToWorkspace(server: Server, b64Data: string, format: 'png' | 'jpeg' | 'webp' = 'png', relativeOutputPath?: string): Promise<string | null> {
    if (this.transport !== 'stdio' && this.allowedRootPrefixes.length === 0) { this.logger.warn('Workspace saving is disabled for HTTP/multi-user mode until IMAGE_WORKSPACE_ALLOWED_ROOTS is configured.'); return null; }
    for (const root of await this.getRoots(server)) { const rootPath = fileUriToLocalPath(root.uri); if (!rootPath || !await this.isRootAllowed(rootPath)) continue; const result = await this.writeImage(rootPath, b64Data, format, relativeOutputPath); if (result) return result; } return null;
  }
  private async isRootAllowed(rootPath: string): Promise<boolean> {
    if (this.allowedRootPrefixes.length === 0) return this.transport === 'stdio';
    try { const rootReal = await fs.realpath(rootPath); for (const prefix of this.allowedRootPrefixes) { try { if (isPathWithin(await fs.realpath(prefix), rootReal)) return true; } catch { /* unavailable entries grant nothing */ } } } catch { return false; } return false;
  }
  private async writeImage(rootPath: string, b64Data: string, format: 'png' | 'jpeg' | 'webp', relativeOutputPath?: string): Promise<string | null> {
    let temp: string | undefined;
    try {
      const rootResolved = path.resolve(rootPath); const rootStat = await fs.lstat(rootResolved); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null; const rootReal = await fs.realpath(rootResolved);
      const generated = path.join(rootReal, 'generated'); await fs.mkdir(generated, { mode: 0o700, recursive: true }); const generatedStat = await fs.lstat(generated); if (!generatedStat.isDirectory() || generatedStat.isSymbolicLink()) return null;
      const generatedReal = await fs.realpath(generated); if (!isPathWithin(rootReal, generatedReal) || generatedReal === rootReal) return null;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); const filename = relativeOutputPath ?? ('img_' + timestamp + '_' + randomUUID() + '.' + format);
      if (path.isAbsolute(filename) || filename.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) return null;
      const resolved = path.resolve(generatedReal, filename); const parent = path.dirname(resolved); if (!isPathWithin(generatedReal, resolved) || resolved === generatedReal) return null;
      let cursor = generatedReal; for (const component of path.relative(generatedReal, parent).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, component); try { const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) return null; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(cursor, { mode: 0o700 }); const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) return null; } }
      const parentReal = await fs.realpath(parent); if (parentReal !== parent || !isPathWithin(generatedReal, parentReal)) return null;
      temp = path.join(parentReal, '.image-mcp-' + randomUUID() + '.tmp'); const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(b64Data.replace(/^data:[^;]+;base64,/, ''), 'base64')); await handle.sync(); } finally { await handle.close(); }
      if (await fs.realpath(parent) !== parentReal) return null; await fs.link(temp, resolved); await fs.unlink(temp); temp = undefined; this.logger.log('Image saved: ' + resolved); return resolved;
    } catch (error) { this.logger.warn('Unsafe or unavailable workspace path: ' + maskSecret(String(error))); return null; } finally { if (temp) await fs.unlink(temp).catch(() => undefined); }
  }
}
