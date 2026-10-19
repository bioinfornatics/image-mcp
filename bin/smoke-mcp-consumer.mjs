#!/usr/bin/env node
// Standalone protocol smoke: no repository SDK imports or live provider requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [cwd, version, npmrc, globalNpmrc] = process.argv.slice(2);
assert(cwd && version && npmrc && globalNpmrc, 'Missing consumer smoke arguments');
const child = spawn(
  'npx',
  [
    '--no',
    '--registry=https://registry.npmjs.org/',
    '--userconfig=' + npmrc,
    '--globalconfig=' + globalNpmrc,
    '--',
    'image-mcp',
    '--transport',
    'stdio',
  ],
  {
    cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      IMAGE_PROVIDER: 'openai',
      IMAGE_API_KEY: 'sk-fake-consumer-smoke-key',
      IMAGE_MCP_SECRET_BACKEND: 'env',
      IMAGE_MCP_TRANSPORT: 'stdio',
      IMAGE_LOG_LEVEL: 'error',
      IMAGE_USE_ELICITATION: 'false',
      IMAGE_USE_SAMPLING: 'false',
    },
  },
);
const pending = new Map();
let protocolError;
let stderr = '';
function fail(error) {
  protocolError = error;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
child.stderr.on('data', (data) => {
  stderr = (stderr + data).slice(-4096);
});
child.on('error', fail);
child.stdin.on('error', fail);
child.on('exit', (code, signal) =>
  fail(new Error('MCP process exited: ' + (signal ?? code) + '\n' + stderr)),
);
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0', 'Non-protocol output on stdout');
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  } catch (error) {
    fail(error);
  }
});
let id = 0;
function send(message) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}
function request(method, params) {
  if (protocolError) return Promise.reject(protocolError);
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ id: requestId, method, params });
  });
}
const timeout = setTimeout(
  () => fail(new Error('MCP consumer initialization timed out\n' + stderr)),
  30000,
);
try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'clean-npm-consumer', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'image-mcp');
  assert.equal(initialized.serverInfo.version, version);
  assert(initialized.capabilities.tools);
  send({ method: 'notifications/initialized' });
  const listed = await request('tools/list', {});
  assert.equal(listed.tools.length, 5);
  assert(listed.tools.some((tool) => tool.name === 'provider_list'));
  const providers = await request('tools/call', { name: 'provider_list', arguments: {} });
  assert(!providers.isError, 'Configured provider listing failed');
  assert(providers.content.some((item) => item.type === 'text' && item.text.includes('openai')));
  console.log('MCP initialize, tools/list and provider_list passed through npx');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  lines.close();
  child.stdin.end();
  // npx spawns a shell and Node process; terminate the whole test-owned group.
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
