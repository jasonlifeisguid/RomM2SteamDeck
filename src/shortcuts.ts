/**
 * Desktop shortcut creation for extracted PC games.
 *
 * This is the SAFE half of the old "Add to Steam" feature: it scans an
 * installed game folder for .exe files and writes a desktop shortcut the user
 * picks. It never touches Steam's shortcuts.vdf (that's the part that wiped
 * libraries) — on Steam Deck the user right-clicks the created shortcut and
 * chooses "Add to Steam", letting Steam do its own safe VDF write.
 *
 * No electron imports here so the module is unit-testable standalone.
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cli from './cli';
import * as faugus from './faugus';
import { whenSpawned } from './fsutil';

export interface ExeFile {
  name: string;
  path: string;
  relativePath: string;
}

const IGNORE_DIRS = new Set(['__macosx', '.git', 'node_modules', '$recycle.bin']);

/** Recursively list .exe files under an installed game folder (or a single file). */
export function listExes(gameFolder: string): ExeFile[] {
  if (!gameFolder || !fs.existsSync(gameFolder)) return [];

  let root = gameFolder;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (root.toLowerCase().endsWith('.exe')) {
      return [{ name: path.basename(root), path: root, relativePath: path.basename(root) }];
    }
    root = path.dirname(root); // record points at a non-exe file — scan its folder
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  }

  const exes: ExeFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name.toLowerCase())) walk(path.join(dir, entry.name));
      } else if (entry.name.toLowerCase().endsWith('.exe')) {
        const full = path.join(dir, entry.name);
        exes.push({ name: entry.name, path: full, relativePath: path.relative(root, full) });
      }
    }
  };
  walk(root);

  // Shallowest first — the launcher exe is usually near the top
  exes.sort(
    (a, b) =>
      a.relativePath.split(path.sep).length - b.relativePath.split(path.sep).length ||
      a.relativePath.localeCompare(b.relativePath)
  );
  return exes;
}

export interface ShortcutResult {
  path?: string;
  error?: string;
  /** Linux: written to the app menu (a Faugus launcher), not the desktop. */
  appMenu?: boolean;
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
  /** Set when a Linux .exe was handed to Faugus Launcher. */
  via?: 'faugus';
  faugusMethod?: faugus.FaugusMethod;
  faugusGameId?: string | null;
  /** A new Faugus entry with its own prefix was created for this launch. */
  faugusRegistered?: boolean;
  /** Per-game prefix was wanted but couldn't be set up; ran in the shared prefix. */
  faugusRegisterError?: string;
  exitTracked?: boolean;
  /** Pid of the process we spawned (the game's windows descend from it). */
  pid?: number;
  /** Windows: started through the UAC prompt (the game needs administrator rights). */
  elevated?: boolean;
  /** What cloud-save sync did before launch (main fills this in). */
  cloud?: import('./cloudsaves').AutoAction;
}

/**
 * Windows: "the game has exited" is not "the process we spawned has exited" —
 * launcher stubs (Ubisoft Connect, EA app) return at once and start the real
 * game themselves. So after our child ends, keep polling until no process is
 * running from the game's install folder any more. `countRunning` is
 * injectable for tests; the default asks PowerShell.
 */
export function countProcessesUnder(folder: string, extraNames: string[] = []): Promise<number> {
  // Trailing separator: "C:\Games\Halo" must not count a game running from "C:\Games\Halo 2".
  const root = folder.replace(/[\\/]+$/, '') + '\\';
  const esc = (s: string) => s.replace(/'/g, "''");
  // An elevated game hides its Path from a non-elevated caller, so it is also
  // matched by process name (only when the launch had to go through UAC).
  const byName = extraNames.length
    ? ` -or (-not $_.Path -and @(${extraNames.map((n) => `'${esc(n)}'`).join(',')}) -contains $_.ProcessName)`
    : '';
  const ps = `(Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.Path -and $_.Path.StartsWith('${esc(root)}', [System.StringComparison]::OrdinalIgnoreCase))${byName} } | Measure-Object).Count`;
  return new Promise((resolve) => {
    const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    r.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    r.on('error', () => resolve(0));
    r.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

export function watchGameExit(
  folder: string, childExited: () => boolean, onExit: () => void,
  opts: { intervalMs?: number; firstDelayMs?: number; maxMs?: number; countRunning?: (folder: string) => Promise<number> } = {},
): void {
  const interval = opts.intervalMs ?? 10_000;
  const count = opts.countRunning ?? countProcessesUnder;
  const deadline = Date.now() + (opts.maxMs ?? 24 * 3600_000);
  let idle = 0;
  const tick = async () => {
    const n = childExited() ? await count(folder) : 1;
    idle = n === 0 ? idle + 1 : 0;
    if (idle >= 2 || Date.now() > deadline) { onExit(); return; }
    setTimeout(tick, interval).unref();
  };
  setTimeout(tick, opts.firstDelayMs ?? 8_000).unref();
}

export interface LaunchOptions {
  faugusEnabled?: boolean;
  faugusPerGame?: boolean;
  title?: string;
  coverPng?: string;
  gameFolder?: string;
  onExit?: (code: number | null) => void;
  /**
   * Windows: start a program that needs administrator rights. CreateProcess
   * refuses those outright (ERROR_ELEVATION_REQUIRED, which Node reports as
   * EACCES); the shell's own launcher shows the UAC prompt instead. Main
   * passes Electron's shell.openPath. Resolves '' on success, else the error.
   */
  openElevated?: (exePath: string) => Promise<string>;
  /** Tests: stand-in for child_process.spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Launch a game executable. Windows runs it directly. On Linux a Windows
 * .exe is handed to Faugus Launcher (UMU/Proton) when it's installed and
 * enabled; otherwise the user is pointed at Add-to-Steam. macOS has no
 * Proton path, so .exe is always refused there.
 *
 * Resolves only once the OS has started the process (or refused to), so a
 * game that can't start is reported as an error — not as "Launching…" with
 * R2SD minimized and nothing happening.
 */
export async function launchGame(exePath: string, opts: LaunchOptions = {}): Promise<LaunchResult> {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Executable not found' };
  const isExe = exePath.toLowerCase().endsWith('.exe');
  const name = path.basename(exePath);

  if (process.platform === 'linux' && isExe) {
    const install = opts.faugusEnabled === false ? null : faugus.findFaugus();
    if (install) {
      const res = faugus.launchWithFaugus(exePath, install, undefined, {
        perGame: opts.faugusPerGame !== false, title: opts.title, coverPng: opts.coverPng, onExit: opts.onExit,
      });
      if (!res.ok) return { ok: false, error: `Faugus Launcher failed to start: ${res.error}` };
      const err = res.started ? await res.started : null;
      if (err) return { ok: false, error: `Faugus Launcher failed to start: ${err.message}` };
      return { ok: true, via: 'faugus', faugusMethod: res.via, faugusGameId: res.gameId, faugusRegistered: res.registered, faugusRegisterError: res.registerError, exitTracked: res.exitTracked, pid: res.pid };
    }
    return {
      ok: false,
      error: opts.faugusEnabled === false
        ? 'Faugus Launcher is turned off in Settings. Turn it on, or use "Add to Steam" to run this through Proton.'
        : 'Running Windows games here needs Faugus Launcher (recommended — install it and Play just works) or "Add to Steam" for Proton.',
    };
  }
  if (process.platform !== 'win32' && isExe) {
    return {
      ok: false,
      error: 'Launching Windows games on this OS needs Proton/Wine. Use "Add to Steam" to run it through Proton.',
    };
  }
  const folder = opts.gameFolder || path.dirname(exePath);
  let child;
  try {
    child = (opts.spawnFn ?? spawn)(exePath, [], {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let exited = false;
  child.on('exit', () => { exited = true; });
  const err = await whenSpawned(child);
  if (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && code === 'EACCES' && opts.openElevated) {
      const msg = await opts.openElevated(exePath);
      if (msg) return { ok: false, error: `${name} needs administrator rights and was not started: ${msg}` };
      // No child of ours to watch; allow time for the UAC prompt, then follow the
      // game by folder and (its Path being hidden when elevated) by name.
      if (opts.onExit) {
        const onExit = opts.onExit;
        const exeName = name.replace(/\.exe$/i, '');
        watchGameExit(folder, () => true, () => onExit(null), { firstDelayMs: 30_000, countRunning: (f) => countProcessesUnder(f, [exeName]) });
      }
      return { ok: true, elevated: true, exitTracked: Boolean(opts.onExit) };
    }
    return { ok: false, error: `Could not start ${name}: ${err.message}` };
  }
  child.unref();
  if (opts.onExit && process.platform === 'win32') {
    const onExit = opts.onExit;
    watchGameExit(folder, () => exited, () => onExit(null));
    return { ok: true, exitTracked: true, pid: child.pid };
  }
  return { ok: true, pid: child.pid };
}

function sanitizeName(name: string): string {
  return (name.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, ' ').trim()) || 'Game';
}

/**
 * Create a shortcut to a game. Windows: a .lnk on the desktop. Linux: a
 * Windows .exe can only run through Faugus, so it gets an app-menu launcher in
 * Faugus's own format (registering the game first when prefixes are per game);
 * a native Linux program gets a .desktop file on the desktop. macOS: a
 * .command script.
 */
export function createShortcut(exePath: string, gameName: string, opts: { faugusEnabled?: boolean; faugusPerGame?: boolean } = {}): ShortcutResult {
  if (!exePath || !fs.existsSync(exePath)) return { error: 'Executable not found' };

  if (process.platform === 'linux' && exePath.toLowerCase().endsWith('.exe')) {
    const install = opts.faugusEnabled === false ? null : faugus.findFaugus();
    if (!install) {
      return { error: opts.faugusEnabled === false
        ? 'A Windows game needs Faugus Launcher to run — turn it on in Settings, or use Add to Steam.'
        : 'A Windows game needs Faugus Launcher to run — install it, or use Add to Steam.' };
    }
    try {
      let gameId = faugus.findRegisteredGameId(exePath);
      if (!gameId && opts.faugusPerGame !== false) {
        const reg = faugus.registerGame({ title: gameName, exePath });
        if (!reg.ok) return { error: reg.error };
        gameId = reg.gameId ?? null;
      }
      const file = cli.writeGameLauncher({ title: gameName, gameId, exePath }, install, faugus.realEnv(), cli.realDesktopEnv());
      return { path: file, appMenu: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const desktop = path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  const safeName = sanitizeName(gameName);

  try {
    if (process.platform === 'win32') {
      const shortcutPath = path.join(desktop, `${safeName}.lnk`);
      const workingDir = path.dirname(exePath);
      // Paths are passed via environment variables, never interpolated into
      // the command string — so a path containing $(...) can't execute.
      const ps =
        '$ws = New-Object -ComObject WScript.Shell;' +
        '$s = $ws.CreateShortcut($env:R2SD_SHORTCUT);' +
        '$s.TargetPath = $env:R2SD_TARGET;' +
        '$s.WorkingDirectory = $env:R2SD_WORKDIR;' +
        '$s.Save()';
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        env: { ...process.env, R2SD_SHORTCUT: shortcutPath, R2SD_TARGET: exePath, R2SD_WORKDIR: workingDir },
        windowsHide: true,
      });
      if (result.status !== 0) {
        return { error: `Shortcut creation failed: ${result.stderr?.toString().slice(0, 200) || 'unknown error'}` };
      }
      return { path: shortcutPath };
    }

    if (process.platform === 'linux') {
      const shortcutPath = path.join(desktop, `${safeName}.desktop`);
      const content =
        '[Desktop Entry]\n' +
        'Type=Application\n' +
        `Name=${cli.desktopValue(gameName)}\n` +
        `Exec=${cli.execArg(exePath)}\n` +
        `Path=${cli.desktopValue(path.dirname(exePath))}\n` +
        'Icon=application-x-executable\n' +
        'Terminal=false\n';
      fs.writeFileSync(shortcutPath, content);
      fs.chmodSync(shortcutPath, 0o755);
      return { path: shortcutPath };
    }

    if (process.platform === 'darwin') {
      const shortcutPath = path.join(desktop, `${safeName}.command`);
      // Single-quoted for the shell: a path with $(…) or backticks stays text
      fs.writeFileSync(shortcutPath, `#!/bin/bash\nopen '${exePath.replace(/'/g, `'\\''`)}'\n`);
      fs.chmodSync(shortcutPath, 0o755);
      return { path: shortcutPath };
    }

    return { error: `Unsupported platform: ${process.platform}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
