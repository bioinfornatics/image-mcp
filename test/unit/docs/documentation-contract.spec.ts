import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('documentation contracts', () => {
  const readme = read('README.md');
  const api = read('docs/API.md');
  const goose = read('docs/HOWTO_GOOSE.md');
  const security = read('docs/SECURITY.md');

  it('matches the package Node.js engine', () => {
    const minimum = JSON.parse(read('package.json')).engines.node.replace(/^>=/, '');
    expect(readme).toContain('Node.js ≥ ' + minimum);
    expect(readme).not.toContain('Node.js ≥ 18');
    expect(goose).toContain('Node.js ' + minimum + ' or newer');
  });

  it('uses boolean save_to_workspace and current elicitation action', () => {
    expect(api).not.toMatch(/`save_to_workspace` \| string/);
    expect(api).not.toMatch(/"save_to_workspace": "/);
    expect(api).toContain('"save_to_workspace": true');
    expect(api).toContain('"action": "accept"');
    expect(api).not.toContain('"action": "submit"');
  });

  it('does not document obsolete text JSON image payload keys', () => {
    expect(api).not.toContain('"success": true');
    expect(api).not.toContain('"usage": {');
    expect(api).not.toContain('"metadata": {');
    expect(api).toContain('native `image` block');
  });

  it('keeps machine-readable sizes ASCII', () => {
    expect(readme).not.toMatch(/"size": "[0-9]+×[0-9]+"/);
  });

  it('does not recommend historical package downgrades in the current Goose guide', () => {
    expect(goose).not.toContain('to `@0.1.2`');
    expect(goose).toContain('Validate the configured Azure provider');
  });

  it('documents local-only Roots, link protection, TOCTOU limits, and response path semantics', () => {
    for (const term of ['IMAGE_WORKSPACE_ALLOWED_ROOTS', 'symlink', 'junction', 'TOCTOU']) {
      expect(security).toContain(term);
    }
    expect(readme).toContain('`saved_to`');
    expect(readme).toContain('`file_uri`');
    expect(readme).toContain('`workspace_copy`');
    expect(readme).toContain('UNC/network authorities');
  });

  it('ships standalone copy-ready Goose examples', () => {
    for (const path of ['examples/goose-openai.yaml', 'examples/goose-azure-foundry.yaml', 'examples/goose-http.yaml', 'examples/goose-openrouter.yaml']) {
      expect(read(path)).toContain('extensions:');
    }
  });
});
