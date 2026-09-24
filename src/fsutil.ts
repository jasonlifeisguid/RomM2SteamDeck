/**
 * Small filesystem/string/process helpers shared by the download manager,
 * the launchers and tests. No electron imports — unit-testable standalone.
 */
import type { ChildProcess } from 'child_process';
import * as path from 'path';

/**
 * A file name that came from outside (the server's Content-Disposition, a rom's
 * fs_name) reduced to a plain name inside the target folder: no directories,
 * no "..", no characters Windows refuses. Used before every path.join with it —
 * "../../.bashrc" from a server must never become a path.
 */
export function safeFileName(raw: string, fallback: string): string {
  const base = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  let name = base
    .replace(/[:*?"<>|\x00-\x1f]/g, '')  // reserved on Windows, control chars
    .replace(/[. ]+$/g, '')              // trailing dots/spaces (also turns "." and ".." into "")
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`; // Windows device names
  return name || fallback;
}

/**
 * Resolves once the OS has actually started `child` (null), or with the error
 * that stopped it. spawn() never throws for a missing or refused program — it
 * emits 'error' later, which crashes the process when nobody listens and is
 * otherwise easy to report as a successful launch.
 */
export function whenSpawned(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    child.on('error', () => { /* handled below; a later error must not crash the app */ });
    child.once('spawn', () => resolve(null));
    child.once('error', (err) => resolve(err));
  });
}

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
