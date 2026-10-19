import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '../../..');
const SCRIPT = join(ROOT, 'bin/verify-openssl.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkOpenSsl(crypto: string, ssl: string, options: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'image-mcp-openssl-'));
  temporaryDirectories.push(directory);
  const apk = join(directory, 'apk');
  writeFileSync(apk, [
    '#!/bin/sh',
    'case "$1" in',
    'info)',
    '  [ "$2" = -v ] || exit 9',
    '  [ "$INFO_FAILURE" != true ] || exit 17',
    '  [ "$#" = 2 ] || exit 9',
    '  [ -z "$CRYPTO_VERSION" ] || printf "libcrypto3-%s\\n" "$CRYPTO_VERSION"',
    '  [ -z "$SSL_VERSION" ] || printf "libssl3-%s\\n" "$SSL_VERSION"',
    '  printf "unrelated-package-1.0-r0\\n" ;;',
    'version)',
    '  [ "$2" = -t ] && [ "$4" = 3.5.8-r0 ] || exit 9',
    '  [ "$COMPARE_FAILURE" != true ] || exit 19',
    '  [ "$COMPARE_EMPTY" != true ] || exit 0',
    '  case "$3" in',
    '    3.5.8-r0) echo "=" ;;',
    '    3.5.8-r1|3.5.9-r0|3.6.0-r0) echo ">" ;;',
    '    3.5.7-r0) echo "<" ;;',
    '    *) echo "?" ;;',
    '  esac ;;',
    '*) exit 9 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(apk, 0o700);
  return spawnSync('sh', [SCRIPT], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, PATH: directory + ':' + process.env.PATH,
      CRYPTO_VERSION: crypto, SSL_VERSION: ssl, INFO_FAILURE: '', COMPARE_FAILURE: '', COMPARE_EMPTY: '', ...options },
  });
}

describe('OpenSSL security gate', () => {
  for (const version of ['3.5.8-r0', '3.5.8-r1', '3.5.9-r0', '3.6.0-r0']) {
    it('accepts both libraries at ' + version + ' from an unrelated cwd', () => {
      const result = checkOpenSsl(version, version);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('libcrypto3');
      expect(result.stdout).toContain('libssl3');
    });
  }
  for (const [crypto, ssl] of [['3.5.7-r0', '3.5.9-r0'], ['3.5.9-r0', '3.5.7-r0'], ['', '3.5.9-r0'], ['3.5.9-r0', '']]) {
    it('rejects outdated or missing libraries (' + crypto + ', ' + ssl + ')', () => {
      const result = checkOpenSsl(crypto, ssl);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toBe('');
    });
  }
  for (const options of [{ INFO_FAILURE: 'true' }, { COMPARE_FAILURE: 'true' }, { COMPARE_EMPTY: 'true' }]) {
    it('fails closed on apk failure ' + JSON.stringify(options), () => {
      expect(checkOpenSsl('3.5.9-r0', '3.5.9-r0', options).status).not.toBe(0);
    });
  }
  it('rejects an unrecognized version comparison', () => {
    expect(checkOpenSsl('invalid', '3.5.9-r0').status).not.toBe(0);
  });
});

describe('CI security dependencies', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  for (const job of ['docker', 'publish-gpr', 'publish-npm']) {
    it(job + ' requires a successful security audit', () => {
      const block = workflow.split('\n  ' + job + ':')[1]?.split(/\n  [a-z][a-z-]*:/)[0];
      expect(block).toBeDefined();
      expect(block).toMatch(/needs: \[[^\]\n]*\bsecurity\b[^\]\n]*\]/);
    });
  }
  it('runs the tested OpenSSL check inside the container before Trivy', () => {
    const check = workflow.indexOf('--entrypoint sh image-mcp:ci -s < bin/verify-openssl.sh');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(workflow.indexOf('name: Run Trivy vulnerability scanner'));
    expect(workflow).not.toContain('grep -E');
  });
});
