/**
 * Faugus Launcher integration (Linux only).
 *
 * Faugus (https://github.com/Faugus/faugus-launcher) runs Windows games on
 * Linux through UMU/Proton. Its entry point accepts a bare .exe path:
 *
 *     faugus-launcher "/path/to/game.exe"
 *
 * which runs the exe in Faugus's shared "default" prefix with the user's
 * default Proton (this is what its own installer shortcuts do). Games the
 * user has added inside Faugus get a per-game prefix + settings and are
 * launched with `--game <gameid>`; those are recorded in
 * ~/.local/share/faugus-launcher/games.json. We READ that file to prefer a
 * registered entry when its path matches the exe, and never write it — the
 * schema is large and undocumented, and the bare-exe path already gives the
 * "title + exe + Play" experience.
 *
 * Detection covers the three ways Faugus ships: a binary on PATH (distro
 * package), an AppImage in the usual folders, or the Flatpak.
 *
 * No electron imports — unit-testable standalone; fs/env are injectable.
 */
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

// Linux-only module: always use POSIX path semantics so the pure functions
// (detection, games.json matching) behave identically under the Windows test
// runner. Only spawn/fs touch the real OS, and only on Linux.
const path = nodePath.posix;

export type FaugusMethod = 'binary' | 'appimage' | 'flatpak';

export interface FaugusInstall {
  method: FaugusMethod;
  /** Binary or AppImage path; for flatpak, the app id. */
  target: string;
}

export interface FaugusLaunch {
  command: string;
  args: string[];
  /** Registered Faugus game id when the exe matched games.json, else null. */
  gameId: string | null;
}

export const FLATPAK_APP_ID = 'io.github.Faugus.faugus-launcher';

export interface Env {
  platform: NodeJS.Platform;
  homedir: string;
  pathDirs: string[];
  exists: (p: string) => boolean;
  readdir: (dir: string) => string[];
  readFile: (p: string) => string;
  /** Atomic write (tmp + rename). */
  writeFile: (p: string, data: string) => void;
  copyFile: (from: string, to: string) => void;
  mkdirp: (dir: string) => void;
  /** Is Faugus's own window (launcher/tray) running? It loads games.json once
   *  at startup and saves its in-memory list on edits, so an entry added
   *  behind its back would be lost on its next save. */
  faugusUiRunning: () => boolean;
  xdgConfigHome?: string;
  xdgDataHome?: string;
}

export function realEnv(): Env {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    pathDirs: (process.env.PATH || '').split(nodePath.delimiter).filter(Boolean),
    exists: (p) => fs.existsSync(p),
    readdir: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, data) => { fs.writeFileSync(`${p}.r2sd-tmp`, data, 'utf8'); fs.renameSync(`${p}.r2sd-tmp`, p); },
    copyFile: (from, to) => fs.copyFileSync(from, to),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    faugusUiRunning: () => {
      try {
        // The game runner is `faugus.runner`; only the UI processes matter here.
        const out = execFileSync('pgrep', ['-f', 'faugus\\.(launcher|tray_only)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.trim().length > 0;
      } catch { return false; }
    },
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgDataHome: process.env.XDG_DATA_HOME,
  };
}

function dataDir(env: Env): string {
  return path.join(env.xdgDataHome || path.join(env.homedir, '.local', 'share'), 'faugus-launcher');
}

/** Faugus's config.json (its ConfigManager stores every value as a string). */
export function readFaugusConfig(env: Env = realEnv()): { prefixesDir: string; defaultRunner: string } {
  const cfgFile = path.join(env.xdgConfigHome || path.join(env.homedir, '.config'), 'faugus-launcher', 'config.json');
  let prefixesDir = path.join(env.homedir, 'Faugus');
  let defaultRunner = 'Proton-CachyOS Latest'; // Faugus's own default
  try {
    if (env.exists(cfgFile)) {
      const cfg = JSON.parse(env.readFile(cfgFile));
      const unq = (v: unknown) => (typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : '');
      const p = unq(cfg?.['default-prefix']);
      if (p) prefixesDir = p.startsWith('~/') ? path.join(env.homedir, p.slice(2)) : p;
      const r = unq(cfg?.['default-runner']);
      if (r) defaultRunner = r;
    }
  } catch { /* defaults */ }
  return { prefixesDir, defaultRunner };
}

/**
 * Faugus's game id from a title — mirrors its `format_title()`: trim,
 * lowercase, drop everything that isn't a word character / space / dash,
 * collapse whitespace to dashes. (Python's \w is Unicode-aware, hence \p{L}\p{N}.)
 */
export function formatTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/g, '-');
}

export interface RegisterResult {
  ok: boolean;
  gameId?: string;
  prefix?: string;
  /** true when the entry already existed (matched by exe path) */
  existing?: boolean;
  error?: string;
}

/**
 * Register a game in Faugus (games.json) the way its own "Add game" dialog
 * would, so it gets a per-game prefix and shows up in Faugus's library.
 * Only the fields Faugus doesn't default are written (gameid, title, path,
 * prefix, runner, optional cover); `prepare_game_kwargs` fills the rest.
 *
 * Read-modify-write is atomic and keeps a `.r2sd-bak` copy of the previous
 * file. Refused while the Faugus window is open (see Env.faugusUiRunning).
 */
export function registerGame(
  game: { title: string; exePath: string; coverPng?: string },
  env: Env = realEnv()
): RegisterResult {
  if (env.faugusUiRunning()) {
    return { ok: false, error: 'Faugus Launcher is open — close it so R2SD can add the game to its library' };
  }
  const jsonPath = gamesJsonPath(env);
  let games: Record<string, unknown>[] = [];
  try {
    if (env.exists(jsonPath)) {
      const parsed = JSON.parse(env.readFile(jsonPath));
      if (!Array.isArray(parsed)) return { ok: false, error: 'Faugus games.json is not a list — not touching it' };
      games = parsed;
    }
  } catch (err) {
    return { ok: false, error: `Faugus games.json is unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Already registered (by exe path)? Reuse — same rule as launch matching.
  const want = path.resolve(game.exePath);
  const expand = (p: string) => (p.startsWith('~/') ? path.join(env.homedir, p.slice(2)) : p);
  for (const g of games) {
    const p = typeof g?.path === 'string' ? g.path : '';
    const id = typeof g?.gameid === 'string' ? g.gameid : '';
    if (!p || !id) continue;
    if (path.resolve(expand(p)) === want) {
      const prefix = typeof g.prefix === 'string' ? expand(g.prefix) : '';
      return { ok: true, gameId: id, prefix, existing: true };
    }
  }

  const { prefixesDir, defaultRunner } = readFaugusConfig(env);
  const taken = new Set(games.map((g) => (typeof g?.gameid === 'string' ? g.gameid : '')));
  const base = formatTitle(game.title) || 'game';
  let gameId = base;
  for (let n = 2; taken.has(gameId); n++) gameId = `${base}-${n}`;
  const prefix = path.join(prefixesDir, gameId);

  const entry: Record<string, unknown> = { gameid: gameId, title: game.title.trim(), path: want, prefix, runner: defaultRunner };
  if (game.coverPng && env.exists(game.coverPng)) {
    try {
      const coversDir = path.join(dataDir(env), 'covers');
      env.mkdirp(coversDir);
      const dest = path.join(coversDir, `${gameId}.png`);
      env.copyFile(game.coverPng, dest);
      entry.cover = dest;
    } catch { /* cover is cosmetic */ }
  }

  try {
    env.mkdirp(path.dirname(jsonPath));
    if (env.exists(jsonPath)) env.copyFile(jsonPath, `${jsonPath}.r2sd-bak`);
    env.writeFile(jsonPath, JSON.stringify([...games, entry], null, 4) + '\n');
  } catch (err) {
    return { ok: false, error: `Could not write Faugus games.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, gameId, prefix, existing: false };
}

/** Find a Faugus install, or null. Cheap (a handful of stats), so not memoized —
 *  the user may install Faugus while R2SD is open. */
export function findFaugus(env: Env = realEnv()): FaugusInstall | null {
  if (env.platform !== 'linux') return null;

  for (const dir of env.pathDirs) {
    const bin = path.join(dir, 'faugus-launcher');
    if (env.exists(bin)) return { method: 'binary', target: bin };
  }

  const appImageDirs = [
    path.join(env.homedir, 'Applications'),
    env.homedir,
    path.join(env.homedir, 'Desktop'),
    path.join(env.homedir, 'Downloads'),
  ];
  for (const dir of appImageDirs) {
    const hit = env.readdir(dir).filter((f) => /^Faugus.*\.AppImage$/i.test(f)).sort().pop();
    if (hit) return { method: 'appimage', target: path.join(dir, hit) };
  }

  const flatpakDirs = [
    path.join(env.homedir, '.local', 'share', 'flatpak', 'app', FLATPAK_APP_ID),
    path.join('/var/lib/flatpak/app', FLATPAK_APP_ID),
  ];
  if (flatpakDirs.some((d) => env.exists(d))) return { method: 'flatpak', target: FLATPAK_APP_ID };

  return null;
}

/** games.json location (XDG_DATA_HOME aware, matching Faugus's PathManager). */
export function gamesJsonPath(env: Env = realEnv(), xdgDataHome: string | undefined = env.xdgDataHome): string {
  const dataHome = xdgDataHome || path.join(env.homedir, '.local', 'share');
  return path.join(dataHome, 'faugus-launcher', 'games.json');
}

/**
 * The gameid of a Faugus-registered game whose `path` is this exe, or null.
 * Read-only; any parse problem just means "not registered".
 */
export function findRegisteredGameId(exePath: string, env: Env = realEnv(), jsonPath = gamesJsonPath(env)): string | null {
  try {
    if (!env.exists(jsonPath)) return null;
    const games = JSON.parse(env.readFile(jsonPath));
    if (!Array.isArray(games)) return null;
    const want = path.resolve(exePath);
    for (const g of games) {
      if (!g || typeof g !== 'object') continue;
      const p = typeof g.path === 'string' ? g.path : '';
      const id = typeof g.gameid === 'string' ? g.gameid : '';
      if (!p || !id) continue;
      const expanded = p.startsWith('~/') ? path.join(env.homedir, p.slice(2)) : p;
      if (path.resolve(expanded) === want) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the exact command Faugus's own shortcuts would run for this exe. */
export function buildLaunch(install: FaugusInstall, exePath: string, env: Env = realEnv()): FaugusLaunch {
  const gameId = findRegisteredGameId(exePath, env);
  const gameArgs = gameId ? ['--game', gameId] : [exePath];
  if (install.method === 'flatpak') {
    return { command: 'flatpak', args: ['run', install.target, ...gameArgs], gameId };
  }
  return { command: install.target, args: gameArgs, gameId };
}

export interface LaunchResult {
  ok: boolean; error?: string; via?: FaugusMethod; gameId?: string | null;
  /** A new Faugus entry (own prefix) was created on this launch. */
  registered?: boolean;
  /** Per-game mode was requested but registration was refused; launched in the shared prefix instead. */
  registerError?: string;
  /** onExit will fire when the game closes (only for `--game` launches). */
  exitTracked?: boolean;
  /** The launcher child's pid (the game's windows are its descendants). */
  pid?: number;
}

/**
 * Launch an exe through Faugus, detached. Caller has already validated the path.
 * With `perGame`, the exe is first registered in Faugus (own prefix, listed in
 * Faugus's library) unless that isn't possible right now, in which case it
 * falls back to the shared default prefix and says why.
 */
export function launchWithFaugus(
  exePath: string,
  install: FaugusInstall,
  env: Env = realEnv(),
  opts: { perGame?: boolean; title?: string; coverPng?: string; onExit?: (code: number | null) => void } = {}
): LaunchResult {
  let registered = false;
  let registerError: string | undefined;
  if (opts.perGame && opts.title && !findRegisteredGameId(exePath, env)) {
    const reg = registerGame({ title: opts.title, exePath, coverPng: opts.coverPng }, env);
    if (reg.ok) registered = !reg.existing; else registerError = reg.error;
  }
  const launch = buildLaunch(install, exePath, env);
  try {
    if (install.method === 'appimage') { try { fs.chmodSync(install.target, 0o755); } catch { /* best effort */ } }
    const child = spawn(launch.command, launch.args, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // `--game` runs Faugus's runner in the foreground of this child, which
    // waits for the game — so 'exit' means the game closed. (The bare-exe path
    // returns immediately after handing off; exit tracking only works per-game.)
    if (opts.onExit && launch.gameId) child.on('exit', (code) => opts.onExit!(code));
    return { ok: true, via: install.method, gameId: launch.gameId, registered, registerError, exitTracked: Boolean(opts.onExit && launch.gameId), pid: child.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
