import * as path from 'path';
import type { ImageFormat } from '../../providers/image-media';

export const WORKSPACE_OUTPUT_PATH_DESCRIPTION =
  'Relative path below <workspace>/generated, e.g. design/target.png (not generated/design/target.png). ' +
  'Requires save_to_workspace=true; extension must match output_format (default png). ' +
  'Absolute paths, traversal, empty/dot components, backslashes, platform-unsafe names, existing files and symlinks are rejected. ' +
  'For n>1, -1, -2, etc. are inserted before the extension.';

/** Validate without normalizing: the accepted spelling is the destination. */
export function validateWorkspaceOutputPath(value: string, format: ImageFormat = 'png'): void {
  const components = value.split('/');
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      /[\\<>:"|?*\x00-\x1f\x7f]/.test(value) ||
      components.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('workspace_output_path must be a safe relative path with no absolute path, traversal, empty/dot components, backslashes or platform-unsafe names.');
  }
  if (components[0].toLowerCase() === 'generated') {
    throw new Error('workspace_output_path is relative to <workspace>/generated; do not include a leading generated/ component.');
  }
  if (path.posix.extname(value) !== '.' + format) {
    throw new Error('workspace_output_path extension must match output_format (expected .' + format + ').');
  }
}

/** Suffixes depend on requested n, never on a partial provider response. */
export function workspaceOutputPaths(value: string, n: number, format: ImageFormat = 'png'): string[] {
  validateWorkspaceOutputPath(value, format);
  const ext = path.posix.extname(value);
  const stem = value.slice(0, -ext.length);
  return Array.from({ length: n }, (_, index) => n === 1 ? value : stem + '-' + (index + 1) + ext);
}
