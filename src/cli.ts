/**
 * "Run this .exe with Faugus" — outside the R2SD library, from a file manager.
 *
 * R2SD already knows how to give a Windows game its own Faugus prefix and
 * launch it (faugus.ts). This exposes that to the rest of the desktop:
 *
 *   RomM2SteamDeck.AppImage --run-exe "/path/Game/bin/Game.exe"
 *   RomM2SteamDeck.AppImage --pick                 (file dialog, then the same)
 *   RomM2SteamDeck.AppImage --install-file-handler (Open With… integration)
 *
 * The first run registers the game in Faugus's library (own prefix) and writes
 * a .desktop launcher in the same format Faugus's own "shortcut" option uses,
 * so next time it's one click from the app menu — no R2SD involved. Running the
 * same exe again just launches the existing entry.
 *
 * Linux only. No electron imports: main.ts handles argv before the GUI starts,
 * and the file dialog is its own (optional) callback.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as faugus from './faugus';

/** Linux-only module: build paths with POSIX rules so the unit tests behave the same on Windows. */
const path = nodePath.posix;

export type CliMode = 'gui' | 'run' | 'pick' | 'install-handler' | 'uninstall-handler' | 'help';

export interface CliArgs {
  mode: CliMode;
  exe?: string;
  /** Override the guessed game title. */
  title?: string;
  /** Run in Faugus's shared default prefix instead of a per-game one. */
  shared: boolean;
  /** Write a .desktop launcher for the game (default true for --run-exe). */
  shortcut: boolean;
}

/** Args after the executable (and, in dev, after the script path). */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { mode: 'gui', shared: false, shortcut: true };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-exe' || a === '--run') { out.mode = 'run'; if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.exe = argv[++i]; }
    else if (a === '--pick') out.mode = 'pick';
    else if (a === '--install-file-handler') out.mode = 'install-handler';
    else if (a === '--uninstall-file-handler') out.mode = 'uninstall-handler';
    else if (a === '--help' || a === '-h') out.mode = 'help';
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--shared-prefix') out.shared = true;
    else if (a === '--no-shortcut') out.shortcut = false;
    else if (!a.startsWith('--') && !a.startsWith('-')) rest.push(a);
  }
  // "--run-exe" with the path as a later positional (how some file managers pass %f)
  if (out.mode === 'run' && !out.exe && rest.length) out.exe = rest[rest.length - 1];
  // A bare .exe argument (file manager "Open With" without a flag) means run it
  if (out.mode === 'gui' && rest.some((r) => r.toLowerCase().endsWith('.exe'))) {
    out.mode = 'run';
    out.exe = [...rest].reverse().find((r) => r.toLowerCase().endsWith('.exe'));
  }
  return out;
}

export const HELP = `RomM2SteamDeck — Linux command line

  --run-exe <file.exe>    Run a Windows .exe through Faugus Launcher, giving it
                          its own prefix and a launcher in your app menu.
      --title <name>      Name for the game (default: guessed from the folder)
      --shared-prefix     Use Faugus's shared default prefix instead
      --no-shortcut       Don't write a .desktop launcher
  --pick                  Choose an .exe in a file dialog, then run it
  --install-file-handler  Add "Run with Faugus (R2SD)" to your file manager's
                          Open With menu for .exe files
  --uninstall-file-handler  Remove it again
  (no arguments)          Start the R2SD library app
`;

// ── Titles ─────────────────────────────────────────────────────────────────

/** Folder names that are never the game's name. */
const BINARY_DIRS = new Set([
  'bin', 'bin64', 'binaries', 'binary', 'win64', 'win32', 'x64', 'x86', 'x86_64', 'game', 'games',
  'retail', 'release', 'debug', 'build', 'builds', 'exe', 'app', 'application', 'data', 'files',
  'win64_shipping', 'shipping', 'redist', 'system', 'launcher', 'client', 'dist',
]);

/** A game name from the exe's path: the nearest folder that isn't a "bin"-style one. */
export function guessTitle(exePath: string): string {
  const parts = exePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const file = parts.pop() || 'game';
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts[i];
    const key = dir.toLowerCase().replace(/[\s-]+/g, '_');
    if (BINARY_DIRS.has(key) || /^(win|x)\d{2}$/.test(key) || key.endsWith('_shipping')) continue;
    if (['home', 'usr', 'opt', 'mnt', 'media', 'run', 'tmp', 'srv'].includes(key)) break;
    return cleanTitle(dir);
  }
  return cleanTitle(file.replace(/\.exe$/i, ''));
}

export function cleanTitle(raw: string): string {
  return raw
    .replace(/[_.]+/g, ' ')
    .replace(/[[(][^\])]*[\])]/g, ' ')            // [FitGirl], (v1.2)
    .replace(/\b(repack|multi\d*|gog|elamigos|dodi|fitgirl|razor1911|codex|plaza|skidrow)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Game';
}

// ── Desktop integration ────────────────────────────────────────────────────

/** Real .exe files report this; Faugus's own .desktop only claims the older
 *  x-ms-dos-executable, which is why .exe "Open With" often lists nothing. */
export const EXE_MIME_TYPES = [
  'application/vnd.microsoft.portable-executable',
  'application/x-ms-dos-executable',
  'application/x-msdownload',
  'application/x-msi',
];

export const HANDLER_DESKTOP_ID = 'r2sd-run-with-faugus.desktop';

/** The "Open With → Run with Faugus (R2SD)" entry. `launcher` is the AppImage path. */
export function handlerDesktopContents(launcher: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Run with Faugus (R2SD)',
    'Comment=Run this Windows program through Faugus Launcher, in its own prefix',
    `Exec=${quoteExec(launcher)} --run-exe %f`,
    'Icon=io.github.Faugus.faugus-launcher',
    'Terminal=false',
    'NoDisplay=true',                       // an Open With handler, not an app-menu entry
    'Categories=Game;',
    `MimeType=${EXE_MIME_TYPES.join(';')};`,
    '',
  ].join('\n');
}

/** A per-game launcher, in the same shape Faugus's own shortcut option writes. */
export function gameDesktopContents(game: { title: string; gameId: string; exePath: string; faugusBin: string; iconPath?: string }): string {
  const lines = [
    '[Desktop Entry]',
    `Name=${game.title}`,
    `Exec=${quoteExec(game.faugusBin)} --game ${game.gameId}`,
  ];
  if (game.iconPath) lines.push(`Icon=${game.iconPath}`);
  lines.push('Type=Application', 'Categories=Game;', `Path=${path.dirname(game.exePath)}`, '');
  return lines.join('\n');
}

const quoteExec = (p: string) => (/[\s"']/.test(p) ? `"${p}"` : p);

export interface DesktopEnv {
  homedir: string;
  xdgDataHome?: string;
  exists: (p: string) => boolean;
  writeFile: (p: string, data: string) => void;
  remove: (p: string) => void;
  mkdirp: (dir: string) => void;
  /** Run a desktop helper (update-desktop-database, xdg-mime); failures are cosmetic. */
  run: (cmd: string, args: string[]) => void;
}

export function realDesktopEnv(): DesktopEnv {
  return {
    homedir: os.homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    exists: (p) => fs.existsSync(p),
    writeFile: (p, data) => fs.writeFileSync(p, data, 'utf8'),
    remove: (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } },
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    run: (cmd, args) => { try { spawnSync(cmd, args, { timeout: 10_000 }); } catch { /* optional helper */ } },
  };
}

export const applicationsDir = (env: DesktopEnv) =>
  path.join(env.xdgDataHome || path.join(env.homedir, '.local', 'share'), 'applications');

export function installFileHandler(launcher: string, env: DesktopEnv = realDesktopEnv()): { ok: boolean; file?: string; error?: string } {
  if (!launcher) return { ok: false, error: 'Could not work out this app\'s own path (running from source?)' };
  const dir = applicationsDir(env);
  const file = path.join(dir, HANDLER_DESKTOP_ID);
  try {
    env.mkdirp(dir);
    env.writeFile(file, handlerDesktopContents(launcher));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  env.run('update-desktop-database', [dir]);
  return { ok: true, file };
}

export function uninstallFileHandler(env: DesktopEnv = realDesktopEnv()): { ok: boolean; file: string; error?: string } {
  const dir = applicationsDir(env);
  const file = path.join(dir, HANDLER_DESKTOP_ID);
  env.remove(file);
  env.run('update-desktop-database', [dir]);
  return { ok: true, file };
}

/** Make the handler the default for .exe (double-click), not just an Open With option. */
export function setAsDefaultForExe(env: DesktopEnv = realDesktopEnv()): void {
  for (const mime of EXE_MIME_TYPES) env.run('xdg-mime', ['default', HANDLER_DESKTOP_ID, mime]);
}

// ── Running ────────────────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  error?: string;
  title?: string;
  gameId?: string | null;
  prefix?: string;
  /** A new Faugus entry was created for this exe. */
  registered?: boolean;
  /** Where the .desktop launcher was written. */
  shortcut?: string;
  via?: faugus.FaugusMethod;
}

/**
 * Register (if needed) and launch an exe through Faugus, then leave a launcher
 * behind. Everything the GUI's Play button does, minus the library.
 */
export function runExe(exePath: string, opts: { title?: string; shared?: boolean; shortcut?: boolean } = {}, env: faugus.Env = faugus.realEnv(), desktop: DesktopEnv = realDesktopEnv()): RunResult {
  const file = nodePath.resolve(exePath).split(nodePath.sep).join('/');
  if (!fs.existsSync(file)) return { ok: false, error: `Not found: ${file}` };
  if (!file.toLowerCase().endsWith('.exe')) return { ok: false, error: `Not a Windows program: ${path.basename(file)}` };
  const install = faugus.findFaugus(env);
  if (!install) {
    return { ok: false, error: 'Faugus Launcher is not installed — get it from https://github.com/Faugus/faugus-launcher' };
  }
  const title = opts.title || guessTitle(file);
  const res = faugus.launchWithFaugus(file, install, env, { perGame: !opts.shared, title });
  if (!res.ok) return { ok: false, error: res.error, title };

  const out: RunResult = { ok: true, title, gameId: res.gameId, registered: res.registered, via: res.via };
  if (res.registerError) out.error = res.registerError; // launched in the shared prefix instead
  // A launcher for next time (Faugus's own format, so it sits beside the ones it writes)
  if (opts.shortcut !== false && res.gameId) {
    const dataHome = env.xdgDataHome || path.join(env.homedir, '.local', 'share');
    const icon = path.join(dataHome, 'faugus-launcher', 'icons', `${res.gameId}.png`);
    const faugusBin = install.method === 'flatpak' ? 'flatpak' : install.target;
    const exec = install.method === 'flatpak' ? `run ${install.target}` : '';
    const contents = gameDesktopContents({
      title, gameId: res.gameId, exePath: file,
      faugusBin: exec ? `${faugusBin} ${exec}`.trim() : faugusBin,
      // Faugus's runner writes this icon during the first launch, i.e. just after
      // us — point at it either way so the entry picks it up once it exists.
      iconPath: icon,
    });
    const dir = applicationsDir(desktop);
    const shortcutFile = path.join(dir, `${res.gameId}.desktop`);
    try {
      desktop.mkdirp(dir);
      desktop.writeFile(shortcutFile, contents);
      desktop.run('update-desktop-database', [dir]);
      out.shortcut = shortcutFile;
    } catch { /* the game still launched */ }
  }
  return out;
}

/** Desktop notification for file-manager launches (no terminal to print to). */
export function notify(title: string, body: string, urgency: 'normal' | 'critical' = 'normal'): void {
  try {
    spawnSync('notify-send', ['-a', 'RomM2SteamDeck', '-u', urgency, '-i', 'io.github.Faugus.faugus-launcher', title, body], { timeout: 5000 });
  } catch { /* no notification daemon — stdout already has it */ }
}
