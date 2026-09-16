/**
 * Back up / restore a game's Windows-side save data from a Proton prefix.
 *
 * A prefix is ~350 MB of Proton scaffolding; the part worth moving between
 * devices is the user profile under drive_c/users/steamuser: Documents,
 * Saved Games and AppData. Backups are plain zips of those folders (paths
 * relative to the profile). Restore extracts into the profile of any prefix,
 * so a backup taken from Faugus's shared `default` prefix can be restored
 * into a game's own prefix — that is how saves migrate to per-game prefixes.
 *
 * SAVES VS SETTINGS. Games mix per-device settings (resolution, graphics
 * quality) into the same folders as progress, and syncing those between a
 * Steam Deck and an ultrawide desktop breaks both. There is no universal
 * rule — Steam Cloud has the same problem — so this module applies sensible
 * defaults and makes the result visible:
 *   - Unreal's `Saved/Config/` (GameUserSettings.ini lives there) is settings;
 *     `Saved/SaveGames/` is progress.
 *   - `.ini` / `.cfg` files are settings in nearly every game.
 *   - Registry-backed settings (Unity PlayerPrefs) live in the prefix's
 *     user.reg, outside the profile, and are never touched.
 * The rules are user-editable, can be switched off per game (for the rare
 * game that keeps progress in .ini), and `listSaveFiles()` reports exactly
 * what is included and what was excluded and why.
 *
 * Uses the bundled 7za. No electron imports.
 */
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const path7za = (require('7zip-bin').path7za as string).replace('app.asar', 'app.asar.unpacked');

/** Profile folders that hold game data. Everything else in the profile is skipped. */
export const SAVE_FOLDERS = ['Documents', 'My Documents', 'Saved Games', 'AppData/Roaming', 'AppData/Local', 'AppData/LocalLow'];

/** Never a save: Windows/Wine housekeeping. Always excluded, not user-editable. */
export const JUNK_EXCLUDES = ['AppData/Local/Temp/**', 'AppData/Local/Microsoft/**', 'AppData/Roaming/Microsoft/**', 'AppData/LocalLow/Microsoft/**'];

/** Per-device settings, not progress. Default; user-editable; can be ignored per game. */
export const DEFAULT_CONFIG_EXCLUDES = ['**/Saved/Config/**', '*.ini', '*.cfg'];

export interface SaveRules {
  /** Config-file patterns (see DEFAULT_CONFIG_EXCLUDES). */
  configExcludes: string[];
  /** Ignore configExcludes for this game (its progress lives in "config" files). */
  includeConfig: boolean;
}

export const DEFAULT_RULES: SaveRules = { configExcludes: DEFAULT_CONFIG_EXCLUDES, includeConfig: false };

export interface SaveFile { rel: string; size: number; mtimeMs: number; }
export interface ExcludedFile { rel: string; size: number; reason: 'junk' | 'config'; pattern: string; }
export interface SaveListing {
  profile: string;
  included: SaveFile[];
  excluded: ExcludedFile[];
  totalBytes: number;
}

export interface SaveResult { ok: boolean; error?: string; file?: string; folders?: string[]; files?: number; bytes?: number; excludedConfig?: number; }

/** The Windows user profile directory inside a prefix (Proton: steamuser; plain Wine: the Linux user), or null. */
export function profileDir(prefixRoot: string): string | null {
  const users = path.join(prefixRoot, 'drive_c', 'users');
  for (const name of ['steamuser', path.basename(os.homedir())]) {
    const p = path.join(users, name);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Glob → RegExp over a forward-slash relative path, case-insensitive (Windows
 * semantics). A pattern without "/" matches the file name in any folder
 * ("*.ini"); one with "/" matches the whole relative path, where "**" spans
 * folders and "*" stays within one segment.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const esc = (s: string) => s.replace(/[.+^${}()|[\]]/g, '\\$&');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && p[i + 1] === '*') {
      // "**/" matches zero or more whole segments; a trailing "**" matches the rest
      if (p[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
    } else if (p[i] === '*') re += '[^/]*';
    else if (p[i] === '?') re += '[^/]';
    else re += esc(p[i]);
  }
  return new RegExp(p.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
}

function firstMatch(rel: string, patterns: string[]): string | null {
  for (const pat of patterns) if (pat.trim() && globToRegExp(pat).test(rel)) return pat;
  return null;
}

/** Walk the profile's save folders and classify every file. Symlinked folders
 *  (Proton's "My Documents" → Documents alias) are skipped so nothing is listed twice. */
export function listSaveFiles(prefixRoot: string, rules: SaveRules = DEFAULT_RULES): SaveListing | null {
  const profile = profileDir(prefixRoot);
  if (!profile) return null;
  const included: SaveFile[] = [];
  const excluded: ExcludedFile[] = [];
  const configPatterns = rules.includeConfig ? [] : rules.configExcludes;
  const walk = (dir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      const junk = firstMatch(rel, JUNK_EXCLUDES);
      if (junk) { excluded.push({ rel, size: st.size, reason: 'junk', pattern: junk }); continue; }
      const cfg = firstMatch(rel, configPatterns);
      if (cfg) { excluded.push({ rel, size: st.size, reason: 'config', pattern: cfg }); continue; }
      included.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  for (const top of SAVE_FOLDERS) {
    const dir = path.join(profile, top);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch { continue; }
    walk(dir, top);
  }
  included.sort((a, b) => a.rel.localeCompare(b.rel));
  excluded.sort((a, b) => a.rel.localeCompare(b.rel));
  return { profile, included, excluded, totalBytes: included.reduce((n, f) => n + f.size, 0) };
}

/** Cheap change detector: MD5 over (path, size, mtime) of the included files.
 *  Two devices with the same files at the same times agree; any edit differs. */
export function fingerprint(listing: SaveListing): string {
  const h = crypto.createHash('md5');
  for (const f of listing.included) h.update(`${f.rel}|${f.size}|${Math.round(f.mtimeMs)}\n`);
  return h.digest('hex');
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

/**
 * Zip the listing's included files (paths relative to the profile, so the zip
 * holds "Documents/…", "AppData/Roaming/…" — portable across prefixes and
 * users) to `file`. The file list is handed to 7za via a list file, so the
 * exclusion rules are applied exactly as previewed.
 */
export async function zipSaves(prefixRoot: string, file: string, rules: SaveRules = DEFAULT_RULES): Promise<SaveResult & { listing?: SaveListing }> {
  const listing = listSaveFiles(prefixRoot, rules);
  if (!listing) return { ok: false, error: 'No Windows user profile in this prefix yet (run the game once first)' };
  if (!listing.included.length) return { ok: false, error: 'Nothing to back up — no save files in this prefix' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch { /* fresh */ }
  const listFile = `${file}.files.txt`;
  fs.writeFileSync(listFile, listing.included.map((f) => f.rel).join('\n') + '\n', 'utf8');
  try {
    const r = await run7za(['a', '-tzip', '-mx=5', '-y', '-spf2', file, `@${listFile}`], listing.profile);
    if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
  } finally {
    try { fs.unlinkSync(listFile); } catch { /* best effort */ }
  }
  const folders = [...new Set(listing.included.map((f) => f.rel.split('/')[0]))];
  return {
    ok: true, file, folders, files: listing.included.length, bytes: listing.totalBytes,
    excludedConfig: listing.excluded.filter((e) => e.reason === 'config').length, listing,
  };
}

/** Zip the profile's save folders into <destDir>/<game> saves <date>.zip. */
export async function backupSaves(prefixRoot: string, destDir: string, gameName: string, rules: SaveRules = DEFAULT_RULES): Promise<SaveResult> {
  return zipSaves(prefixRoot, path.join(destDir, backupFileName(gameName)), rules);
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
 * into the prefix). With `createProfile`, a missing profile is created first —
 * used to seed a brand-new prefix from a cloud save before the game's first run.
 */
export async function restoreSaves(prefixRoot: string, zipFile: string, opts: { createProfile?: boolean } = {}): Promise<SaveResult> {
  if (!fs.existsSync(zipFile)) return { ok: false, error: 'Backup file not found' };
  let profile = profileDir(prefixRoot);
  if (!profile && opts.createProfile) {
    profile = path.join(prefixRoot, 'drive_c', 'users', 'steamuser');
    fs.mkdirSync(profile, { recursive: true });
  }
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

/** MD5 of a file — RomM's `content_hash` for uploaded saves is MD5, so this is directly comparable. */
export function md5File(file: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}
