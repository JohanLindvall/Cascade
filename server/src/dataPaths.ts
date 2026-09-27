import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors';

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve existing ancestors too: a missing file can still sit under a symlink. */
async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonicalPath(parent), path.basename(candidate));
  }
}

/** Check before erasing metadata, and again before unlinking after the RPC round trip. */
export async function assertDeletable(basePath: string, deleteRoots: readonly string[]): Promise<string> {
  const resolved = path.resolve(basePath);
  const roots = deleteRoots.map((root) => path.resolve(root));
  const refuse = () => new HttpError(403,
    `refusing to delete "${resolved}": it is outside the permitted data roots or would delete a data root (${roots.join(', ') || 'none'})`);
  if (!path.isAbsolute(basePath) || !roots.some((root) => within(resolved, root))) throw refuse();
  const canonical = await canonicalPath(resolved);
  const realRoots = await Promise.all(roots.map(canonicalPath));
  if (!realRoots.some((root) => within(canonical, root)) ||
      realRoots.some((root) => within(root, canonical))) throw refuse();
  // rm unlinks a final symlink itself; preserve the original path rather than
  // returning its target. Ancestor symlinks have already been checked above.
  return resolved;
}
