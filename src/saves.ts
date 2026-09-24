/**
 * Back up / restore a game's Windows-side save data.
 *
 * On Linux the data lives in a Proton prefix: ~350 MB of scaffolding around a
 * user profile at drive_c/users/steamuser with Documents, Saved Games and
 * AppData. On Windows it is the real user profile — the same folder layout,
 * except that Documents (and Saved Games) may be redirected elsewhere by
 * Known Folders (OneDrive does this), so every folder is resolved individually.
 * Backups are plain zips of those folders with paths relative to the profile
 * ("Documents/My Games/…", "AppData/Local/…"), so a zip taken from a Proton
 * prefix restores onto Windows and vice versa.
 *
 * SCOPE. A per-game Proton prefix holds only that game, so everything in its
 * profile is the game's. The real Windows profile holds everything — every
 * other game, the user's actual documents — so on Windows only the game's
 * known save locations (its "scope", see savepaths.ts) are ever listed; with
 * no scope, nothing is. A scope can also narrow a Linux prefix.
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
 * Uses the bundled 7-Zip (sevenzip.ts). No electron imports.
 */
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sevenZipPath } from './sevenzip';

/** Profile folders that hold game data. Everything else in the profile is skipped. */
export const SAVE_FOLDERS = ['Documents', 'My Documents', 'Saved Games', 'AppData/Roaming', 'AppData/Local', 'AppData/LocalLow'];

/** Never a save: Windows/Wine housekeeping, driver caches, crash dumps. Always excluded, not user-editable. */
export const JUNK_EXCLUDES = [
  'AppData/Local/Temp/**', 'AppData/Local/Microsoft/**', 'AppData/Roaming/Microsoft/**', 'AppData/LocalLow/Microsoft/**',
  'AppData/Local/CrashDumps/**', 'AppData/Local/D3DSCache/**', 'AppData/Local/NVIDIA/**', 'AppData/Local/AMD/**',
  'AppData/Local/Packages/**', 'AppData/Local/ConnectedDevicesPlatform/**', 'AppData/Local/Comms/**', 'AppData/Local/PeerDistRepub/**',
  'AppData/Local/Steam/**', 'AppData/Local/Ubisoft Game Launcher/logs/**', 'AppData/Local/Ubisoft Game Launcher/cache/**',
  'AppData/Local/Ubisoft Game Launcher/spool/**', 'AppData/Local/EasyAntiCheat/**', 'AppData/Roaming/EasyAntiCheat/**',
];

/**
 * Folders that belong to a launcher, runtime or engine shared by many games —
 * never one game's save location. A per-game Proton prefix has them too (the
 * game installed Ubisoft Connect into it), so a save zip made there can carry
 * them; they must not be learned as that game's scope or written into the real
 * Windows profile, where they would overwrite the user's own launcher setup.
 */
export const SHARED_APP_FOLDERS = [
  'AppData/Local/Ubisoft Game Launcher/**', 'AppData/Roaming/Ubisoft/**',
  'AppData/Local/EpicGamesLauncher/**', 'AppData/Local/Epic Games/**',
  'AppData/Local/Electronic Arts/**', 'AppData/Roaming/EA/**', 'AppData/Local/EADesktop/**',
  'AppData/Roaming/Origin/**', 'AppData/Local/Origin/**',
  'AppData/Roaming/Rockstar Games/Launcher/**', 'AppData/Local/Rockstar Games/Launcher/**',
  'AppData/Local/Battle.net/**', 'AppData/Roaming/Battle.net/**', 'AppData/Local/Blizzard Entertainment/**',
  'AppData/Roaming/GOG.com/**', 'AppData/Local/GOG.com/**',
  'AppData/Roaming/Steam/**', 'AppData/Roaming/Goldberg SteamEmu Saves/settings/**', 'AppData/Roaming/GSE Saves/settings/**',
  'AppData/Local/UnrealEngine/**', 'AppData/Local/CrashReportClient/**', 'AppData/LocalLow/Unity/**',
  'AppData/Local/CEF/**', 'AppData/Local/pip/**', 'AppData/Roaming/Mozilla/**',
];

/** Per-device settings, not progress. Default; user-editable; can be ignored per game. */
export const DEFAULT_CONFIG_EXCLUDES = ['**/Saved/Config/**', '*.ini', '*.cfg'];

export interface SaveRules {
  /** Config-file patterns (see DEFAULT_CONFIG_EXCLUDES). */
  configExcludes: string[];
  /** Ignore configExcludes for this game (its progress lives in "config" files). */
  includeConfig: boolean;
  /** Profile-relative folders/files that belong to this game ("Documents/My Games/X").
   *  Empty → the whole profile (fine for a per-game prefix; refused on the real Windows profile). */
  scope?: string[];
}

export const DEFAULT_RULES: SaveRules = { configExcludes: DEFAULT_CONFIG_EXCLUDES, includeConfig: false };

export interface SaveFile { rel: string; size: number; mtimeMs: number; }
export interface ExcludedFile { rel: string; size: number; reason: 'junk' | 'config'; pattern: string; }
export interface SaveListing {
  profile: string;
  included: SaveFile[];
  excluded: ExcludedFile[];
  totalBytes: number;
  /** The layout needs a scope and none was given: nothing was listed. */
  unscoped?: boolean;
}

export interface SaveResult {
  ok: boolean; error?: string; file?: string; folders?: string[]; files?: number; bytes?: number; excludedConfig?: number; entries?: string[];
  /** Restore into the Windows profile: files left out because they are outside the game's save locations. */
  skipped?: number;
}

// ── Layouts ────────────────────────────────────────────────────────────────

/** Where a profile's save folders actually are. */
export interface SaveLayout {
  /** The profile root — shown to the user and the root the zip paths are relative to. */
  profile: string;
  /** Real directory for each SAVE_FOLDERS entry that exists (Windows: Documents may be redirected). */
  roots: Record<string, string>;
  /** Every root sits at <profile>/<top> — zips and restores can work in place. */
  direct: boolean;
  /** The real Windows profile: never list it without a scope. */
  requireScope: boolean;
}

/** A Proton/Wine prefix root (string) or an explicit layout. */
export type SaveTarget = string | SaveLayout;

/** The Windows user profile directory inside a prefix (Proton: steamuser; plain Wine: the Linux user), or null. */
export function profileDir(prefixRoot: string): string | null {
  const users = path.join(prefixRoot, 'drive_c', 'users');
  for (const name of ['steamuser', path.basename(os.homedir())]) {
    const p = path.join(users, name);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

const isRealDir = (p: string) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/** Layout of a Proton/Wine prefix, or null when the prefix has no profile yet.
 *  Symlinked folders (Proton's "My Documents" → Documents) are left out so nothing is listed twice. */
export function prefixLayout(prefixRoot: string): SaveLayout | null {
  const profile = profileDir(prefixRoot);
  if (!profile) return null;
  const roots: Record<string, string> = {};
  for (const top of SAVE_FOLDERS) {
    const dir = path.join(profile, top);
    if (isRealDir(dir)) roots[top] = dir;
  }
  return { profile, roots, direct: true, requireScope: false };
}

export interface WindowsFolders { profile: string; documents: string; savedGames: string; appData: string; localAppData: string; }

/** Read the Known Folder locations from the registry (Documents / Saved Games can be
 *  redirected, typically into OneDrive). Falls back to the classic layout. */
export function windowsKnownFolders(env: Record<string, string | undefined> = process.env, regQuery?: () => string): WindowsFolders {
  const profile = env.USERPROFILE || os.homedir();
  const out: WindowsFolders = {
    profile,
    documents: path.join(profile, 'Documents'),
    savedGames: path.join(profile, 'Saved Games'),
    appData: env.APPDATA || path.join(profile, 'AppData', 'Roaming'),
    localAppData: env.LOCALAPPDATA || path.join(profile, 'AppData', 'Local'),
  };
  let text = '';
  try {
    text = regQuery ? regQuery() : spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  } catch { return out; }
  const expand = (v: string) => v.replace(/%([^%]+)%/g, (m, name) => env[name] ?? env[name.toUpperCase()] ?? m);
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = expand(m[2]);
    if (key === 'personal') out.documents = val;
    else if (key === '{4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4}') out.savedGames = val;
    else if (key === 'appdata') out.appData = val;
    else if (key === 'local appdata') out.localAppData = val;
  }
  return out;
}

/** Layout of the real Windows profile. Always requires a scope. */
export function windowsLayout(folders: WindowsFolders = windowsKnownFolders()): SaveLayout {
  const candidates: Record<string, string> = {
    'Documents': folders.documents,
    'Saved Games': folders.savedGames,
    'AppData/Roaming': folders.appData,
    'AppData/Local': folders.localAppData,
    'AppData/LocalLow': path.join(folders.profile, 'AppData', 'LocalLow'),
  };
  // Roots are kept even when the folder doesn't exist yet (a restore creates it);
  // only a symlinked folder is left out, as in a prefix.
  const isSymlink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const roots: Record<string, string> = {};
  let direct = true;
  for (const [top, dir] of Object.entries(candidates)) {
    if (isSymlink(dir)) continue;
    roots[top] = dir;
    if (path.resolve(dir).toLowerCase() !== path.resolve(folders.profile, top).toLowerCase()) direct = false;
  }
  return { profile: folders.profile, roots, direct, requireScope: true };
}

export function resolveLayout(target: SaveTarget): SaveLayout | null {
  return typeof target === 'string' ? prefixLayout(target) : target;
}

// ── Listing ────────────────────────────────────────────────────────────────

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

/** Scope entries as clean forward-slash relative paths, de-duplicated. Bare top-level
 *  folders ("Documents") are dropped — a scope must name something inside them. */
export function normalizeScope(scope: string[] | undefined | null): string[] {
  const out: string[] = [];
  const tops = new Set(SAVE_FOLDERS.map((t) => t.toLowerCase()));
  for (const raw of scope || []) {
    const s = String(raw).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s || s.includes('..') || tops.has(s.toLowerCase()) || s.toLowerCase() === 'appdata') continue;
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

/** Walk the layout's save folders (pruned to the scope) and classify every file. */
export function listSaveFiles(target: SaveTarget, rules: SaveRules = DEFAULT_RULES): SaveListing | null {
  const layout = resolveLayout(target);
  if (!layout) return null;
  const scope = normalizeScope(rules.scope).map((s) => s.toLowerCase());
  if (layout.requireScope && !scope.length) return { profile: layout.profile, included: [], excluded: [], totalBytes: 0, unscoped: true };
  const inScope = (rel: string) => !scope.length || scope.some((s) => rel === s || rel.startsWith(s + '/'));
  const mayContain = (relDir: string) => inScope(relDir) || scope.some((s) => s.startsWith(relDir + '/'));

  const included: SaveFile[] = [];
  const excluded: ExcludedFile[] = [];
  const configPatterns = rules.includeConfig ? [] : rules.configExcludes;
  const walk = (dir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const relL = rel.toLowerCase();
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (mayContain(relL)) walk(path.join(dir, e.name), rel); continue; }
      if (!e.isFile() || !inScope(relL)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      const junk = firstMatch(rel, JUNK_EXCLUDES);
      if (junk) { excluded.push({ rel, size: st.size, reason: 'junk', pattern: junk }); continue; }
      const cfg = firstMatch(rel, configPatterns);
      if (cfg) { excluded.push({ rel, size: st.size, reason: 'config', pattern: cfg }); continue; }
      included.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  for (const [top, dir] of Object.entries(layout.roots)) {
    if (mayContain(top.toLowerCase())) walk(dir, top);
  }
  included.sort((a, b) => a.rel.localeCompare(b.rel));
  excluded.sort((a, b) => a.rel.localeCompare(b.rel));
  return { profile: layout.profile, included, excluded, totalBytes: included.reduce((n, f) => n + f.size, 0) };
}

/** Cheap change detector: MD5 over (path, size, mtime) of the included files.
 *  Two devices with the same files at the same times agree; any edit differs. */
export function fingerprint(listing: SaveListing): string {
  const h = crypto.createHash('md5');
  for (const f of listing.included) h.update(`${f.rel}|${f.size}|${Math.round(f.mtimeMs)}\n`);
  return h.digest('hex');
}

/**
 * Guess a game's save locations from the files of one of its backups: the
 * first folder under each save root, one level deeper inside generic
 * containers ("Documents/My Games/<game>", "AppData/LocalLow/<company>/<game>",
 * "AppData/Roaming/Goldberg SteamEmu Saves/<appid>"). Used to learn a Windows
 * scope from a save that was made in a per-game Proton prefix.
 */
export function learnScope(entries: string[]): string[] {
  const containers = new Set(['my games', 'goldberg steamemu saves', 'gse saves']);
  const out: string[] = [];
  for (const raw of entries) {
    const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (firstMatch(rel, JUNK_EXCLUDES) || firstMatch(rel, SHARED_APP_FOLDERS)) continue;
    const parts = rel.split('/');
    const top = SAVE_FOLDERS.find((t) => rel.toLowerCase().startsWith(t.toLowerCase() + '/'));
    if (!top) continue;
    const topDepth = top.split('/').length;
    let depth = topDepth + 1;                                      // <top>/<X>
    const first = parts[topDepth]?.toLowerCase();
    if (first && (containers.has(first) || top === 'AppData/LocalLow')) depth = topDepth + 2;
    if (parts.length <= depth) continue;                           // a loose file directly in the root: skip
    const s = parts.slice(0, depth).join('/');
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return normalizeScope(out);
}

// ── Zip / unzip ────────────────────────────────────────────────────────────

function run7za(args: string[], cwd?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(sevenZipPath(), args, { cwd, windowsHide: true });
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

/** Copy the listed files into a temp dir laid out like a profile, so one zip
 *  command sees them at their canonical relative paths (redirected folders). */
function stageFiles(layout: SaveLayout, listing: SaveListing): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-stage-'));
  for (const f of listing.included) {
    const top = Object.keys(layout.roots).find((t) => f.rel.toLowerCase().startsWith(t.toLowerCase() + '/'))!;
    const src = path.join(layout.roots[top], f.rel.slice(top.length + 1));
    const dst = path.join(stage, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    try { const st = fs.statSync(src); fs.utimesSync(dst, st.atime, st.mtime); } catch { /* keep copy time */ }
  }
  return stage;
}

/**
 * Zip the listing's included files (paths relative to the profile, so the zip
 * holds "Documents/…", "AppData/Roaming/…" — portable across prefixes, users
 * and OSes) to `file`. The file list is handed to 7za via a list file, so the
 * exclusion rules are applied exactly as previewed.
 */
export async function zipSaves(target: SaveTarget, file: string, rules: SaveRules = DEFAULT_RULES): Promise<SaveResult & { listing?: SaveListing }> {
  const layout = resolveLayout(target);
  if (!layout) return { ok: false, error: 'No Windows user profile in this prefix yet (run the game once first)' };
  const listing = listSaveFiles(layout, rules)!;
  if (listing.unscoped) return { ok: false, error: 'No save locations known for this game yet — set them in "What syncs…"' };
  if (!listing.included.length) return { ok: false, error: 'Nothing to back up — no save files found' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch { /* fresh */ }
  const stage = layout.direct ? null : stageFiles(layout, listing);
  const cwd = stage ?? layout.profile;
  const listFile = `${file}.files.txt`;
  fs.writeFileSync(listFile, listing.included.map((f) => f.rel).join('\n') + '\n', 'utf8');
  try {
    const r = await run7za(['a', '-tzip', '-mx=5', '-y', '-spf2', file, `@${listFile}`], cwd);
    if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
  } finally {
    try { fs.unlinkSync(listFile); } catch { /* best effort */ }
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
  }
  const folders = [...new Set(listing.included.map((f) => f.rel.split('/')[0]))];
  return {
    ok: true, file, folders, files: listing.included.length, bytes: listing.totalBytes,
    excludedConfig: listing.excluded.filter((e) => e.reason === 'config').length, listing,
  };
}

/** Zip the profile's save folders into <destDir>/<game> saves <date>.zip. */
export async function backupSaves(target: SaveTarget, destDir: string, gameName: string, rules: SaveRules = DEFAULT_RULES): Promise<SaveResult> {
  return zipSaves(target, path.join(destDir, backupFileName(gameName)), rules);
}

/** File entries in a zip (forward-slash paths), or null if unreadable. */
export async function listZipEntries(file: string): Promise<string[] | null> {
  const r = await run7za(['l', '-slt', '-ba', file]);
  if (r.code !== 0) return null;
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^Path = (.+)$/);
    if (m) { cur = m[1].replace(/\\/g, '/'); continue; }
    const f = line.match(/^Folder = (.)/);
    if (f && cur !== null) { if (f[1] === '-') out.push(cur); cur = null; }
  }
  return out;
}

/**
 * Extract a backup into the profile, overwriting files with the same names
 * and leaving everything else alone. Refuses zips whose top-level entries
 * aren't the known save folders (so a random zip can't spray files into the
 * profile). With `createProfile`, a missing prefix profile is created first —
 * used to seed a brand-new prefix from a cloud save before the game's first
 * run. Returns the zip's file entries so the caller can learn a scope.
 */
export async function restoreSaves(target: SaveTarget, zipFile: string, opts: { createProfile?: boolean; scope?: string[] } = {}): Promise<SaveResult> {
  if (!fs.existsSync(zipFile)) return { ok: false, error: 'Backup file not found' };
  let layout = resolveLayout(target);
  if (!layout && opts.createProfile && typeof target === 'string') {
    fs.mkdirSync(path.join(target, 'drive_c', 'users', 'steamuser'), { recursive: true });
    layout = prefixLayout(target);
  }
  if (!layout) return { ok: false, error: 'No Windows user profile in this prefix yet (run the game once first, then restore)' };
  const entries = await listZipEntries(zipFile);
  if (!entries || !entries.length) return { ok: false, error: 'Not a readable zip' };
  const tops = new Set(entries.map((e) => e.split('/')[0]));
  const allowed = new Set(SAVE_FOLDERS.map((f) => f.split('/')[0]));
  const bad = [...tops].filter((t) => !allowed.has(t) || t.includes('..'));
  if (bad.length || entries.some((e) => e.split('/').includes('..'))) {
    return { ok: false, error: `Not a save backup — unexpected top-level entries: ${bad.slice(0, 3).join(', ') || '..'}` };
  }
  if (layout.requireScope) {
    // The real Windows profile: write only inside the game's save locations —
    // the ones already known plus those this zip reveals (learnScope skips
    // launcher/runtime folders). A zip made in a Proton prefix can also hold
    // whatever else that prefix had; none of it belongs in the user's profile.
    const scope = normalizeScope([...(opts.scope || []), ...learnScope(entries)]).map((s) => s.toLowerCase());
    const inScope = (rel: string) => scope.some((s) => rel.toLowerCase() === s || rel.toLowerCase().startsWith(s + '/'));
    const wanted = entries.filter(inScope);
    const skipped = entries.length - wanted.length;
    if (!wanted.length) return { ok: false, error: 'Nothing in this backup is inside the game\'s save locations — set them in "What syncs…"' };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-restore-'));
    try {
      const r = await run7za(['x', '-y', '-aoa', `-o${tmp}`, zipFile]);
      if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
      const topsByLength = Object.keys(layout.roots).sort((a, b) => b.length - a.length);
      for (const rel of wanted) {
        const top = topsByLength.find((t) => rel.toLowerCase().startsWith(t.toLowerCase() + '/'));
        const dest = top ? path.join(layout.roots[top], rel.slice(top.length + 1)) : path.join(layout.profile, rel);
        const src = path.join(tmp, rel);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        try { const st = fs.statSync(src); fs.utimesSync(dest, st.atime, st.mtime); } catch { /* keep copy time */ }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { ok: true, folders: [...new Set(wanted.map((e) => e.split('/')[0]))], entries: wanted, skipped };
  }
  if (layout.direct) {
    const r = await run7za(['x', '-y', '-aoa', `-o${layout.profile}`, zipFile]);
    if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
  } else {
    // Redirected folders: extract to a temp dir, then copy each save root to where it really lives.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-restore-'));
    try {
      const r = await run7za(['x', '-y', '-aoa', `-o${tmp}`, zipFile]);
      if (r.code !== 0) return { ok: false, error: `7za exited ${r.code}: ${r.stderr.slice(0, 300)}` };
      // Longest tops first so "AppData/Roaming" is moved before "AppData" could be
      for (const top of Object.keys(layout.roots).sort((a, b) => b.length - a.length)) {
        const src = path.join(tmp, top);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, layout.roots[top], { recursive: true, force: true, preserveTimestamps: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
      // Anything left is a save root that doesn't exist here yet (e.g. no LocalLow): create it in place.
      for (const top of tops) {
        const src = path.join(tmp, top);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(layout.profile, top), { recursive: true, force: true, preserveTimestamps: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { ok: true, folders: [...tops], entries };
}

/** MD5 of a file — RomM's `content_hash` for uploaded saves is MD5, so this is directly comparable. */
export function md5File(file: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}
