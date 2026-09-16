/**
 * Back up / restore a game's Windows-side save data from a Proton prefix.
 *
 * A prefix is ~350 MB of Proton scaffolding; the part worth moving between
 * devices is the user profile under drive_c/users/steamuser: Documents,
 * Saved Games and AppData. Backups are plain zips of those folders (paths
 * relative to the profile), minus Windows/Wine housekeeping that is large
 * and machine-specific (Temp, the Microsoft shell folders). Restore extracts
 * into the profile of any prefix — so a backup taken from Faugus's shared
 * `default` prefix can be restored into a game's own prefix, which is how
 * saves migrate after switching to per-game prefixes.
 *
 * Uses the bundled 7za. No electron imports.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const path7za = (require('7zip-bin').path7za as string).replace('app.asar', 'app.asar.unpacked');

/** Profile folders that hold game data. Everything else in the profile is skipped. */
export const SAVE_FOLDERS = ['Documents', 'My Documents', 'Saved Games', 'AppData/Roaming', 'AppData/Local', 'AppData/LocalLow'];
/** Inside those, junk that is never a save. */
export const EXCLUDES = ['AppData/Local/Temp', 'AppData/Local/Microsoft', 'AppData/Roaming/Microsoft', 'AppData/LocalLow/Microsoft'];

export interface SaveResult { ok: boolean; error?: string; file?: string; folders?: string[]; }

/** The Windows user profile directory inside a prefix (Proton: steamuser; plain Wine: the Linux user), or null. */
export function profileDir(prefixRoot: string): string | null {
  const users = path.join(prefixRoot, 'drive_c', 'users');
  for (const name of ['steamuser', path.basename(os.homedir())]) {
    const p = path.join(users, name);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

function run7za(args: string[], cwd?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { try { fs.chmodSync(path7za, 0o755); } catch { /* read-only */ } }
    const proc = spawn(path7za, args, { cwd, windowsHide: true });
    let stderr = ''; let stdout = '';
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr, stdout }));
  });
}

/** A filename-safe stem for the backup, e.g. "Stellar Blade" → "Stellar Blade". */
export function backupFileName(gameName: string, when = new Date()): string {
  const stem = gameName.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'game';
  const d = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  return `${stem} saves ${d}.zip`;
}

/** Zip the profile's save folders into <destDir>/<name>. Returns the zip path. */
export async function backupSaves(prefixRoot: string, destDir: string, gameName: string): Promise<SaveResult> {
  const profile = profileDir(prefixRoot);
  if (!profile) return { ok: false, error: 'No Windows user profile in this prefix yet (run the game once first)' };
  // Real directories only: Proton prefixes carry legacy symlinks ("My Documents"
  // → Documents, "Application Data" → AppData/Roaming) that would double the zip.
  const present = SAVE_FOLDERS.filter((f) => {
    try { const st = fs.lstatSync(path.join(profile, f)); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
  });
  if (!present.length) return { ok: false, error: 'Nothing to back up — no save folders in this prefix' };
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, backupFileName(gameName));
  try { fs.unlinkSync(file); } catch { /* fresh */ }
  // Paths are given relative to the profile (cwd), so the zip contains
  // "Documents/…", "AppData/Roaming/…" — portable across prefixes and users.
  const args = ['a', '-tzip', '-mx=5', '-y', file, ...present, ...EXCLUDES.map((e) => `-xr!${e}`)];
  const r = await run7za(args, profile);
  if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
  return { ok: true, file, folders: present };
}

/** Top-level entries in a zip (via 7za listing), or null if unreadable. */
async function zipTopLevels(file: string): Promise<Set<string> | null> {
  const r = await run7za(['l', '-slt', '-ba', file]);
  if (r.code !== 0) return null;
  const tops = new Set<string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^Path = (.+)$/);
    if (m) tops.add(m[1].replace(/\\/g, '/').split('/')[0]);
  }
  return tops;
}

/**
 * Extract a backup into the prefix's profile, overwriting files with the same
 * names and leaving everything else alone. Refuses zips whose top-level
 * entries aren't the known save folders (so a random zip can't spray files
 * into the prefix).
 */
export async function restoreSaves(prefixRoot: string, zipFile: string): Promise<SaveResult> {
  if (!fs.existsSync(zipFile)) return { ok: false, error: 'Backup file not found' };
  const profile = profileDir(prefixRoot);
  if (!profile) return { ok: false, error: 'No Windows user profile in this prefix yet (run the game once first, then restore)' };
  const tops = await zipTopLevels(zipFile);
  if (!tops || !tops.size) return { ok: false, error: 'Not a readable zip' };
  const allowed = new Set(SAVE_FOLDERS.map((f) => f.split('/')[0]));
  const bad = [...tops].filter((t) => !allowed.has(t) || t.includes('..'));
  if (bad.length) return { ok: false, error: `Not a save backup — unexpected top-level entries: ${bad.slice(0, 3).join(', ')}` };
  const r = await run7za(['x', '-y', '-aoa', `-o${profile}`, zipFile]);
  if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
  return { ok: true, folders: [...tops] };
}
