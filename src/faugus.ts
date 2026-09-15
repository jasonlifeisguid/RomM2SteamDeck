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
import { spawn } from 'child_process';
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
}

export function realEnv(): Env {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    pathDirs: (process.env.PATH || '').split(nodePath.delimiter).filter(Boolean),
    exists: (p) => fs.existsSync(p),
    readdir: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
  };
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
export function gamesJsonPath(env: Env = realEnv(), xdgDataHome = process.env.XDG_DATA_HOME): string {
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

export interface LaunchResult { ok: boolean; error?: string; via?: FaugusMethod; gameId?: string | null; }

/** Launch an exe through Faugus, detached. Caller has already validated the path. */
export function launchWithFaugus(exePath: string, install: FaugusInstall, env: Env = realEnv()): LaunchResult {
  const launch = buildLaunch(install, exePath, env);
  try {
    if (install.method === 'appimage') { try { fs.chmodSync(install.target, 0o755); } catch { /* best effort */ } }
    const child = spawn(launch.command, launch.args, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, via: install.method, gameId: launch.gameId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
