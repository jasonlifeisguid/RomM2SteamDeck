/**
 * Small filesystem/string helpers shared by the download manager and tests.
 * No electron imports — unit-testable standalone.
 */
import * as path from 'path';

/** Guard against zip-slip: the resolved entry must stay inside the destination.
 *  Returns the absolute target path, or null if the entry escapes the root. */
export function safeJoin(destRoot: string, entryPath: string): string | null {
  const target = path.resolve(destRoot, entryPath.replace(/\\/g, '/'));
  const root = path.resolve(destRoot);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Lowercase alphanumerics only — used to match folders on disk to rom names. */
export function sanitizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/** A rom name made safe to use as a folder name on every OS. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '')   // reserved on Windows
    .replace(/[\x00-\x1f]/g, '')    // control chars
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')         // Windows rejects trailing dots/spaces
    .trim();
  return cleaned || 'Game';
}

/** True when `child` is `parent` or lives somewhere beneath it. */
export function isInsideFolder(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
