/**
 * Hyprland integration: put a game launched from Play on its own workspace,
 * fullscreen, and bring R2SD back afterwards.
 *
 * Hyprland has no "minimize"; what a desktop user wants is the game on a fresh
 * workspace with nothing else on it. Hyprland can't be told that at spawn time
 * for a Proton game (the window belongs to a grandchild process several forks
 * down: faugus → umu → wine → game), so R2SD watches `hyprctl clients` after
 * launch, recognises the game's windows by walking each window's PID ancestry
 * up to the launcher child, and moves/fullscreens them via `hyprctl dispatch`.
 *
 * Two dispatcher dialects: Hyprland ≥ 0.56 (Lua config) wants
 *   hyprctl dispatch 'hl.dsp.window.move({ workspace = "empty", window = "address:0x…" })'
 * while older releases want
 *   hyprctl dispatch movetoworkspace empty,address:0x…
 * The Lua form is tried first; a non-"ok" reply falls back to the classic form.
 *
 * No electron imports; hyprctl and /proc are injectable for tests.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';

export interface HyprClient {
  address: string;
  pid: number;
  class: string;
  initialClass?: string;
  title?: string;
  mapped?: boolean;
  fullscreen?: number;
  workspace?: { id: number; name: string };
  size?: [number, number];
}

export interface HyprEnv {
  env: Record<string, string | undefined>;
  /** Run hyprctl with args, resolve stdout ('' on failure). */
  hyprctl: (args: string[]) => Promise<string>;
  /** Parent pid of a pid, or null when it can't be read (exited / not Linux). */
  ppid: (pid: number) => number | null;
}

export function realEnv(): HyprEnv {
  return {
    env: process.env,
    hyprctl: (args) => new Promise((resolve) => {
      execFile('hyprctl', args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    }),
    ppid: (pid) => {
      try {
        const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
        return m ? Number(m[1]) : null;
      } catch { return null; }
    },
  };
}

export function isHyprland(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.HYPRLAND_INSTANCE_SIGNATURE;
}

/** Windows that never count as "the game": R2SD itself, Faugus's loading window. */
export const IGNORED_CLASSES = new Set(['romm2steamdeck', 'faugus-launcher']);

/** Is `ancestor` in pid's parent chain (bounded walk)? */
export function descendsFrom(pid: number, ancestor: number, ppid: HyprEnv['ppid']): boolean {
  let cur: number | null = pid;
  for (let i = 0; i < 32 && cur && cur > 1; i++) {
    if (cur === ancestor) return true;
    cur = ppid(cur);
  }
  return false;
}

export async function listClients(hy: HyprEnv): Promise<HyprClient[]> {
  try {
    const out = await hy.hyprctl(['-j', 'clients']);
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Mapped windows belonging to the launched game (descendants of the launcher child, ignoring known non-game classes). */
export async function gameWindows(hy: HyprEnv, launcherPid: number): Promise<HyprClient[]> {
  const all = await listClients(hy);
  return all.filter((c) => c.mapped !== false && !IGNORED_CLASSES.has(c.class) && descendsFrom(c.pid, launcherPid, hy.ppid));
}

// ── Dispatchers (Lua dialect first, classic fallback) ───────────────────────

const ok = (r: string) => r.trim() === 'ok';

/** Lua form first; when the compositor rejects it (classic config), the classic sequence. */
async function dispatch(hy: HyprEnv, lua: string, classic: string[][]): Promise<boolean> {
  if (ok(await hy.hyprctl(['dispatch', lua]))) return true;
  for (const args of classic) if (!ok(await hy.hyprctl(['dispatch', ...args]))) return false;
  return classic.length > 0;
}

export const moveToWorkspace = (hy: HyprEnv, address: string, workspace: string | number, silent = false) =>
  dispatch(hy,
    `hl.dsp.window.move({ workspace = ${typeof workspace === 'number' ? workspace : JSON.stringify(workspace)}, window = "address:${address}"${silent ? ', silent = true' : ''} })`,
    [[silent ? 'movetoworkspacesilent' : 'movetoworkspace', `${workspace},address:${address}`]]);

/** Classic `fullscreen` has no window selector, so focus the window first. */
export const fullscreen = (hy: HyprEnv, address: string) =>
  dispatch(hy, `hl.dsp.window.fullscreen({ window = "address:${address}", mode = 0 })`,
    [['focuswindow', `address:${address}`], ['fullscreen', '0']]);

export const focusWindow = (hy: HyprEnv, address: string) =>
  dispatch(hy, `hl.dsp.focus({ window = "address:${address}" })`, [['focuswindow', `address:${address}`]]);

export async function findByClass(hy: HyprEnv, cls: string): Promise<HyprClient | null> {
  return (await listClients(hy)).find((c) => c.class === cls) ?? null;
}

// ── The watcher ─────────────────────────────────────────────────────────────

export interface PresentOptions {
  /** 'fullscreen': own workspace + fullscreen; 'workspace': own workspace only. */
  mode: 'fullscreen' | 'workspace';
  intervalMs?: number;
  /** Stop looking for a first window after this long (the game never opened one). */
  firstWindowTimeoutMs?: number;
  /** Fullscreen only windows at least this fraction of the monitor (skips splash dialogs). */
  minFullscreenFraction?: number;
  monitorSize?: () => Promise<[number, number] | null>;
  isRunning: () => boolean;
}

export interface PresentResult { workspace: number | null; windows: number; }

/**
 * Watch for the game's windows while it runs. The first one gets a fresh
 * ("empty") workspace and focus; later ones (a second window, a relaunch by a
 * launcher) join it. Big windows are fullscreened in 'fullscreen' mode.
 * Resolves when the game exits or no window ever appeared.
 */
export async function presentGame(hy: HyprEnv, launcherPid: number, opts: PresentOptions): Promise<PresentResult> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + (opts.firstWindowTimeoutMs ?? 5 * 60_000);
  const handled = new Set<string>();
  let workspace: number | null = null;
  const monitor = await (opts.monitorSize ?? (() => monitorSizeOf(hy)))();
  const minFrac = opts.minFullscreenFraction ?? 0.6;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

  while (opts.isRunning()) {
    if (workspace === null && Date.now() > deadline) break;
    for (const w of await gameWindows(hy, launcherPid)) {
      if (handled.has(w.address)) continue;
      handled.add(w.address);
      if (workspace === null) {
        // First window: a fresh workspace, and follow it there
        if (await moveToWorkspace(hy, w.address, 'empty')) {
          const now = (await listClients(hy)).find((c) => c.address === w.address);
          workspace = now?.workspace?.id ?? null;
        }
      } else if (w.workspace?.id !== workspace) {
        await moveToWorkspace(hy, w.address, workspace, true);
      }
      if (opts.mode === 'fullscreen' && w.fullscreen === 0 && isBig(w, monitor, minFrac)) {
        await fullscreen(hy, w.address);
      }
    }
    await sleep(interval);
  }
  return { workspace, windows: handled.size };
}

function isBig(w: HyprClient, monitor: [number, number] | null, minFrac: number): boolean {
  if (!monitor || !w.size) return true;
  return w.size[0] >= monitor[0] * minFrac && w.size[1] >= monitor[1] * minFrac;
}

export async function monitorSizeOf(hy: HyprEnv): Promise<[number, number] | null> {
  try {
    const mons = JSON.parse(await hy.hyprctl(['-j', 'monitors']));
    const m = (Array.isArray(mons) ? mons : []).find((x: { focused?: boolean }) => x.focused) ?? mons[0];
    return m ? [Number(m.width) / (Number(m.scale) || 1), Number(m.height) / (Number(m.scale) || 1)] : null;
  } catch { return null; }
}
