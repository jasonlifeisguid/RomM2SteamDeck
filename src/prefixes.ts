/**
 * Where a game's Windows-side files live: saves, configs, AppData.
 *
 * A Windows game run through Proton/UMU sees a fake C: drive inside a Wine
 * "prefix". Its Documents, Saved Games and AppData folders are real Linux
 * directories under <prefix>/drive_c/users/steamuser/, but hunting for them by
 * hand means knowing which prefix the game ran in. This module resolves the
 * candidate prefixes for an exe and lists the user folders inside each:
 *
 *  - Faugus registered game  → the `prefix` field of its games.json entry
 *  - Faugus bare-exe launch  → <default-prefix>/default (default ~/Faugus/default)
 *  - Steam / Add to Steam    → <steam>/steamapps/compatdata/<appid>/pfx
 *
 * On Windows the "prefix" is the real user profile, so the same folder list
 * maps straight onto %USERPROFILE%.
 *
 * No electron imports — unit-testable standalone; fs/env are injectable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as faugus from './faugus';

export interface FolderEntry { label: string; path: string; }
export interface PrefixInfo {
  source: 'faugus-game' | 'faugus-default' | 'steam' | 'windows';
  label: string;
  root: string;             // the prefix root (or the profile dir on Windows)
  folders: FolderEntry[];   // only folders that exist
}

export interface Env {
  platform: NodeJS.Platform;
  homedir: string;
  exists: (p: string) => boolean;
  isDir: (p: string) => boolean;
  readFile: (p: string) => string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
  env: Record<string, string | undefined>;
}

export function realEnv(): Env {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    exists: (p) => fs.existsSync(p),
    isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgDataHome: process.env.XDG_DATA_HOME,
    env: process.env,
  };
}

const expandHome = (p: string, home: string) => (p.startsWith('~/') || p === '~') ? nodePath.posix.join(home, p.slice(2)) : p;

/** Faugus's configured prefix root (its `default-prefix`, default ~/Faugus). */
export function faugusPrefixesDir(env: Env): string {
  const cfgDir = env.xdgConfigHome || nodePath.posix.join(env.homedir, '.config');
  const cfgFile = nodePath.posix.join(cfgDir, 'faugus-launcher', 'config.json');
  try {
    if (env.exists(cfgFile)) {
      const cfg = JSON.parse(env.readFile(cfgFile));
      const raw = typeof cfg?.['default-prefix'] === 'string' ? cfg['default-prefix'].replace(/^"|"$/g, '').trim() : '';
      if (raw) return expandHome(raw, env.homedir);
    }
  } catch { /* fall through to the default */ }
  return nodePath.posix.join(env.homedir, 'Faugus');
}

/** The `prefix` of the Faugus games.json entry for this exe, or null. */
export function faugusGamePrefix(exePath: string, env: Env): string | null {
  const jsonPath = nodePath.posix.join(env.xdgDataHome || nodePath.posix.join(env.homedir, '.local', 'share'), 'faugus-launcher', 'games.json');
  try {
    if (!env.exists(jsonPath)) return null;
    const games = JSON.parse(env.readFile(jsonPath));
    if (!Array.isArray(games)) return null;
    const want = nodePath.posix.resolve(exePath);
    for (const g of games) {
      if (!g || typeof g !== 'object' || typeof g.path !== 'string' || typeof g.prefix !== 'string') continue;
      if (nodePath.posix.resolve(expandHome(g.path, env.homedir)) === want) return expandHome(g.prefix, env.homedir);
    }
  } catch { /* unreadable → not registered */ }
  return null;
}

/** User-folder candidates inside a Proton/Wine prefix (Proton names the user "steamuser";
 *  plain Wine uses the Linux username — both are checked). */
export function prefixUserFolders(prefixRoot: string, env: Env): FolderEntry[] {
  const P = nodePath.posix;
  const driveC = P.join(prefixRoot, 'drive_c');
  const users = P.join(driveC, 'users');
  const linuxUser = P.basename(env.homedir);
  const profile = [P.join(users, 'steamuser'), P.join(users, linuxUser)].find((d) => env.isDir(d));
  const out: FolderEntry[] = [];
  const add = (label: string, p: string) => { if (env.isDir(p)) out.push({ label, path: p }); };
  if (profile) {
    add('User profile', profile);
    add('Documents', P.join(profile, 'Documents'));
    add('Documents', P.join(profile, 'My Documents'));
    add('Saved Games', P.join(profile, 'Saved Games'));
    add('AppData \\ Roaming', P.join(profile, 'AppData', 'Roaming'));
    add('AppData \\ Local', P.join(profile, 'AppData', 'Local'));
    add('AppData \\ LocalLow', P.join(profile, 'AppData', 'LocalLow'));
  }
  add('Drive C:', driveC);
  // De-dupe labels (Documents vs My Documents) keeping the first that exists
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)));
}

/** Real Windows user folders for the current user. */
export function windowsUserFolders(env: Env): FolderEntry[] {
  const W = nodePath.win32;
  const profile = env.env.USERPROFILE || env.homedir;
  const out: FolderEntry[] = [];
  const add = (label: string, p: string | undefined) => { if (p && env.isDir(p)) out.push({ label, path: p }); };
  add('User profile', profile);
  add('Documents', W.join(profile, 'Documents'));
  add('Saved Games', W.join(profile, 'Saved Games'));
  add('AppData \\ Roaming', env.env.APPDATA || W.join(profile, 'AppData', 'Roaming'));
  add('AppData \\ Local', env.env.LOCALAPPDATA || W.join(profile, 'AppData', 'Local'));
  add('AppData \\ LocalLow', W.join(profile, 'AppData', 'LocalLow'));
  return out;
}

export interface ResolveOpts {
  /** Unsigned shortcut appid when the exe is in Steam's shortcuts.vdf (Linux). */
  steamAppId?: number | null;
  steamRoot?: string | null;
}

/**
 * Every prefix this exe plausibly runs in, each with the user folders that
 * exist inside it. Empty when nothing has been run yet (no prefix created).
 */
export function resolvePrefixes(exePath: string, opts: ResolveOpts = {}, env: Env = realEnv()): PrefixInfo[] {
  const out: PrefixInfo[] = [];
  if (env.platform === 'win32') {
    const folders = windowsUserFolders(env);
    if (folders.length) out.push({ source: 'windows', label: 'Windows user folders', root: env.env.USERPROFILE || env.homedir, folders });
    return out;
  }
  if (env.platform !== 'linux') return out;

  const P = nodePath.posix;
  const seenRoots = new Set<string>();
  const push = (source: PrefixInfo['source'], label: string, root: string) => {
    const norm = P.resolve(root);
    if (seenRoots.has(norm) || !env.isDir(norm)) return;
    seenRoots.add(norm);
    out.push({ source, label, root: norm, folders: prefixUserFolders(norm, env) });
  };

  const gamePrefix = faugusGamePrefix(exePath, env);
  if (gamePrefix) push('faugus-game', 'Faugus (this game\'s prefix)', gamePrefix);
  if (faugus.findFaugus()) push('faugus-default', 'Faugus (default prefix)', P.join(faugusPrefixesDir(env), 'default'));

  if (opts.steamAppId && opts.steamRoot) {
    push('steam', 'Steam / Proton (compatdata)', P.join(opts.steamRoot, 'steamapps', 'compatdata', String(opts.steamAppId), 'pfx'));
  }
  return out;
}
