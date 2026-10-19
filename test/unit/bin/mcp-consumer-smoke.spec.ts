import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '../../..');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function smoke(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'image-mcp-protocol-stub-'));
  directories.push(directory);
  const npx = join(directory, 'npx');
  writeFileSync(
    npx,
    '#!' +
      process.execPath +
      '\n' +
      [
        "const readline = require('readline');",
        'const mode = ' + JSON.stringify(mode) + ';',
        "if (process.env.IMAGE_API_KEY !== 'sk-fake-consumer-smoke-key') process.exit(8);",
        'if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || process.env.NODE_OPTIONS) process.exit(9);',
        "if (mode === 'exit') process.exit(31);",
        'const rl = readline.createInterface({input:process.stdin});',
        "rl.on('line', line => {",
        '  const message = JSON.parse(line);',
        "  if (mode === 'stdout') { console.log('not JSON-RPC'); return; }",
        '  if (!message.id) return;',
        '  let result;',
        "  if (message.method === 'initialize') result = { serverInfo:{name:'image-mcp',version:mode === 'version' ? 'wrong' : '0.3.3'},capabilities:{tools:{}} };",
        "  if (message.method === 'tools/list') result = {tools: Array.from({length: mode === 'tools' ? 1 : 5}, (_,i) => ({name: i === 0 ? 'provider_list' : 'tool_' + i}))};",
        "  if (message.method === 'tools/call') result = {isError:mode === 'provider',content:[{type:'text',text:'openai'}]};",
        "  console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));",
        '});',
      ].join('\n'),
  );
  chmodSync(npx, 0o700);
  writeFileSync(join(directory, 'empty.npmrc'), '');
  return spawnSync(
    'node',
    [
      join(ROOT, 'bin/smoke-mcp-consumer.mjs'),
      directory,
      '0.3.3',
      join(directory, 'empty.npmrc'),
      join(directory, 'empty.npmrc'),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        IMAGE_API_KEY: 'must-not-be-inherited',
        NPM_TOKEN: 'must-not-be-inherited',
      },
    },
  );
}

describe('installed MCP smoke protocol verification', () => {
  it('accepts the complete initialize, discovery and read-only listing exchange', () => {
    const result = smoke('success');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed through npx');
  });
  for (const mode of ['version', 'tools', 'provider', 'stdout', 'exit']) {
    it('fails closed on ' + mode + ' failure without leaking real credentials', () => {
      const result = smoke(mode);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('must-not-be-inherited');
    });
  }
});
