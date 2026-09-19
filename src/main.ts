import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { RommClient, RommPlatform, RommRom, slimRom } from './romm';
import * as config from './config';
import * as cache from './cache';
import * as downloads from './downloads';
import * as shortcuts from './shortcuts';
import * as steam from './steam';
import * as steamclient from './steamclient';
import { isInsideFolder } from './fsutil';
import { isSteamDeckCached, zoomForScale, stepScale, normalizeUiScale } from './device';
import * as faugus from './faugus';
import * as prefixes from './prefixes';
import * as saves from './saves';
import * as cloud from './cloudsaves';
import * as savepaths from './savepaths';
import * as updates from './updates';
import * as hypr from './hyprland';

// Cover art and screenshots are served to the renderer over a private scheme
// that maps only onto the covers cache directory, so the renderer's CSP no
// longer needs to allow file: images (which would let any local path render
// if a path ever leaked into an <img src>). Must be registered before ready.
const ASSET_SCHEME = 'r2sd-asset';
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

// Steam Deck / Linux rendering. The black window on SteamOS/Plasma was caused
// by two flags that were originally added as "safe" defaults but actively broke
// rendering: --no-sandbox (breaks the GPU buffer path — the namespace sandbox
// works fine on SteamOS) and --disable-dev-shm-usage (forces Chromium's shm onto
// /tmp where creation fails in a 57k-error flood; the default /dev/shm is a 15G
// tmpfs that works). The only remaining default is --disable-gpu-sandbox, a
// harmless stability hedge; verified rendering the full UI on SteamOS. Rendering
// can still be tuned per-device via env vars without a rebuild
// (R2SD_GL / R2SD_ANGLE / R2SD_OZONE / R2SD_FLAGS). No-ops on Windows/macOS.
if (process.platform === 'linux') {
  // Full override for device tuning/diagnostics: R2SD_FLAGS is a space-separated
  // list of Chromium switches ("--no-sandbox --use-gl=angle"); an empty string
  // means "no flags at all". When unset, use the safe defaults plus optional
  // per-switch env overrides.
  if (process.env.R2SD_FLAGS !== undefined) {
    for (const f of process.env.R2SD_FLAGS.split(/\s+/).filter(Boolean)) {
      const [k, v] = f.replace(/^--/, '').split('=');
      app.commandLine.appendSwitch(k, v);
    }
  } else {
    // THE fix for the SteamOS black window: do NOT pass --no-sandbox. It was
    // added for AppImage compatibility, but on SteamOS/Plasma it breaks the GPU
    // buffer path and renders a black window (verified: --no-sandbox → black,
    // without it → the UI renders). The Chromium namespace sandbox works here.
    // --disable-gpu-sandbox is harmless and kept as a small stability hedge.
    // (--disable-dev-shm-usage was also removed: on SteamOS it forces Chromium
    // onto /tmp where shm creation fails with a 57k-error flood.)
    // If a host lacks user namespaces and won't start, set R2SD_FLAGS=--no-sandbox.
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    if (process.env.R2SD_GL) app.commandLine.appendSwitch('use-gl', process.env.R2SD_GL);
    if (process.env.R2SD_ANGLE) app.commandLine.appendSwitch('use-angle', process.env.R2SD_ANGLE);
    if (process.env.R2SD_OZONE) app.commandLine.appendSwitch('ozone-platform', process.env.R2SD_OZONE);
  }
}

// Explicit userData dir. The Electron default (productName "RomM2SteamDeck")
// collides case-insensitively on Windows with the Python app's
// %APPDATA%\romm2steamdeck — the two apps merged into one directory and
// clobbered each other's config.json, and our JSON caches landed inside
// Chromium's own "Cache" dir.
const userDataDir = path.join(app.getPath('appData'), 'romm2steamdeck-app');
app.setPath('userData', userDataDir);
migrateLegacyUserData();

/**
 * The path Steam should launch to run R2SD itself. For an AppImage this is the
 * outer .AppImage (Electron sets APPIMAGE), NOT process.execPath (which points
 * inside the read-only mount). Returns null in a dev run, where there's no
 * stable launcher to register.
 */
function selfLauncherPath(): string | null {
  if (process.platform === 'linux') return process.env.APPIMAGE || null;
  if (process.platform === 'win32') return app.isPackaged ? process.execPath : null;
  if (process.platform === 'darwin') {
    const m = process.execPath.match(/^(.*\.app)\//); // .../R2SD.app/Contents/MacOS/R2SD → the .app
    return m ? m[1] : null;
  }
  return null;
}

/** A freshly-added shortcut takes a moment to land in shortcuts.vdf (Steam
 *  persists after a live add), so poll briefly for its appid. */
async function pollShortcutAppId(exePath: string): Promise<number | null> {
  for (let i = 0; i < 12; i++) {
    const id = steam.readShortcutAppId(exePath);
    if (id !== null) return id;
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/**
 * Apply live SteamClient edits to a just-added shortcut in one pass (looks up
 * the appid once). Each field is best-effort; the returned flags say what stuck
 * so the UI can fall back to manual tips. No-op / all-false when the CEF debugger
 * isn't available (non-Decky) — the caller then relies on the file-write + tips.
 */
// Steam library asset slot for the portrait "capsule" (the main grid tile that
// RomM cover art maps to). Confirmed on-device via the artwork probe.
const CAPSULE_ASSET_TYPE = 0;

interface LiveResult { nameLive?: boolean; launchOptionLive?: boolean; protonLive?: boolean; artworkLive?: boolean; }

async function configureShortcutLive(
  exePath: string,
  opts: { name?: string; launchOptions?: string; compatTool?: string; artwork?: { base64: string; imageType: string } }
): Promise<LiveResult> {
  const appId = await pollShortcutAppId(exePath);
  if (appId === null) return {};
  const out: LiveResult = {};
  // The live add names shortcuts after the filename — set the real name first.
  if (opts.name) out.nameLive = (await steamclient.setShortcutName(appId, opts.name)).ok;
  if (opts.launchOptions) out.launchOptionLive = (await steamclient.setLaunchOptions(appId, opts.launchOptions)).ok;
  if (opts.compatTool) out.protonLive = (await steamclient.specifyCompatTool(appId, opts.compatTool)).ok;
  if (opts.artwork) out.artworkLive = (await steamclient.setArtwork(appId, opts.artwork.base64, opts.artwork.imageType, CAPSULE_ASSET_TYPE)).ok;
  return out;
}

// ── Server-hosted images (covers, screenshots) ────────────────────────────
// Fetched on first request and cached as files. Network fetches are capped:
// RomM serves requests serially, and a fast scroll otherwise fires one request
// per tile that passed by, so the covers actually on screen would wait behind
// the ones scrolled past. FIFO, so first-visible is fetched first.
const ASSET_FETCH_CONCURRENCY = 4;
let assetFetchesActive = 0;
const assetFetchWaiters: (() => void)[] = [];

async function withAssetSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (assetFetchesActive >= ASSET_FETCH_CONCURRENCY) {
    await new Promise<void>((resolve) => assetFetchWaiters.push(resolve));
  }
  assetFetchesActive++;
  try {
    return await fn();
  } finally {
    assetFetchesActive--;
    assetFetchWaiters.shift()?.();
  }
}

/** Local cache file for a rom image, fetching from the server on a miss.
 *  Returns the file path, or null if unavailable. */
async function ensureAsset(romId: number, serverPath: string): Promise<string | null> {
  if (!serverPath) return null;
  const file = cache.assetCachePath(romId, serverPath);
  if (fs.existsSync(file)) return file;
  const data = await withAssetSlot(() => getClient().getBinary(serverPath));
  if (!data || !data.length) return null;
  fs.mkdirSync(cache.coversDir(), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/** Cover art bytes as base64 for a rom, for pushing to Steam as the shortcut's
 *  capsule artwork. Returns null if unavailable. */
async function fetchCoverBase64(romId: number, serverPath: string): Promise<{ base64: string; imageType: string } | null> {
  try {
    const file = await ensureAsset(romId, serverPath);
    if (!file) return null;
    const data = fs.readFileSync(file);
    if (!data.length) return null;
    const imageType = data[0] === 0x89 && data[1] === 0x50 ? 'png' : 'jpg'; // PNG magic vs JPEG
    return { base64: data.toString('base64'), imageType };
  } catch {
    return null;
  }
}

/**
 * Resolve an executable path the renderer handed us against the rom's tracked
 * install location: the exe must live inside the game's folder (or be the
 * tracked file itself). Anything else — a path outside every game folder, or
 * a rom that isn't installed — is refused, so a misbehaving renderer can't
 * launch or register arbitrary programs.
 */
function exeForRom(romId: number, exePath: string): string | null {
  if (!exePath || typeof exePath !== 'string' || !Number.isInteger(romId)) return null;
  const rec = downloads.findDownload(romId);
  if (!rec || !rec.filePath) return null;
  const resolved = path.resolve(exePath);
  const root = path.resolve(rec.filePath);
  let inside = false;
  try {
    inside = fs.statSync(root).isDirectory() ? isInsideFolder(root, resolved) : resolved === root;
  } catch { return null; }
  return inside && fs.existsSync(resolved) ? resolved : null;
}

const EXE_OUTSIDE_GAME = 'Executable is not inside this game\'s install folder';

/** One-time untangle of the shared %APPDATA%\romm2steamdeck directory. */
function migrateLegacyUserData(): void {
  const legacyDir = path.join(app.getPath('appData'), 'romm2steamdeck');
  const legacyConfig = path.join(legacyDir, 'config.json');
  const newConfig = path.join(userDataDir, 'config.json');
  try {
    if (!fs.existsSync(legacyConfig) || fs.existsSync(newConfig)) return;
    const parsed = JSON.parse(fs.readFileSync(legacyConfig, 'utf-8'));
    if (!parsed.baseUrl && !parsed.passwordEncrypted) return; // no Electron keys there

    fs.mkdirSync(userDataDir, { recursive: true });
    const ours = {
      baseUrl: parsed.baseUrl ?? '',
      username: parsed.username ?? '',
      passwordEncrypted: parsed.passwordEncrypted ?? '',
      theme: parsed.theme ?? 'oled-limited',
      pinnedPlatforms: parsed.pinnedPlatforms ?? [],
    };
    fs.writeFileSync(newConfig, JSON.stringify(ours, null, 2), 'utf-8');

    // Give the Python app back a clean config.json with only its keys
    const pythonKeys: Record<string, unknown> = {};
    for (const key of ['server', 'database']) {
      if (parsed[key] !== undefined) pythonKeys[key] = parsed[key];
    }
    if (Object.keys(pythonKeys).length > 0) {
      fs.writeFileSync(legacyConfig, JSON.stringify(pythonKeys, null, 4), 'utf-8');
    }

    // Move our asset + list caches over
    const legacyCovers = path.join(legacyDir, 'covers');
    if (fs.existsSync(legacyCovers) && !fs.existsSync(path.join(userDataDir, 'covers'))) {
      fs.renameSync(legacyCovers, path.join(userDataDir, 'covers'));
    }
    const legacyCache = path.join(legacyDir, 'Cache'); // Chromium's dir, case-merged
    const newCache = path.join(userDataDir, 'cache');
    if (fs.existsSync(legacyCache)) {
      fs.mkdirSync(newCache, { recursive: true });
      for (const f of fs.readdirSync(legacyCache)) {
        if (/^(platforms|roms-\d+)\.json$/.test(f)) {
          fs.renameSync(path.join(legacyCache, f), path.join(newCache, f));
        }
      }
    }
    console.log('Migrated legacy userData out of', legacyDir);
  } catch (err) {
    console.error('Legacy userData migration failed:', err);
  }
}

let mainWindow: BrowserWindow | null = null;

// ── UI scale (renderer zoom) ──────────────────────────────────────────────
// See device.ts for why: the Deck's 215-PPI panel reports DPR 1, so the page
// renders ~2.5x smaller than on a monitor. Zooming the whole renderer keeps
// every layout rule intact and scales text, tiles and hit targets together.

function currentZoom(): number {
  return zoomForScale(config.getPublicConfig().uiScale, isSteamDeckCached());
}

function applyZoom(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const zoom = currentZoom();
  if (Math.abs(mainWindow.webContents.getZoomFactor() - zoom) > 1e-6) mainWindow.webContents.setZoomFactor(zoom);
}

function uiScaleInfo(): { scale: string; zoom: number; deck: boolean } {
  return { scale: config.getPublicConfig().uiScale, zoom: currentZoom(), deck: isSteamDeckCached() };
}

/** Persist a scale choice, apply it, and tell the renderer (Settings dropdown). */
function setUiScale(scale: string): { scale: string; zoom: number; deck: boolean } {
  config.setConfig({ uiScale: normalizeUiScale(scale) });
  applyZoom();
  const info = uiScaleInfo();
  send('ui:scale-changed', info);
  return info;
}

function getClient(): RommClient {
  const { baseUrl, username, password } = config.getCredentials();
  return new RommClient(baseUrl, username, password);
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Library access with stale-while-revalidate ────────────────────────────
// Cached data is returned immediately; a background refresh follows and the
// renderer is notified via events when fresh data lands.

const inFlight = new Set<string>();

async function refreshPlatforms(): Promise<RommPlatform[]> {
  const platforms = await getClient().getPlatforms();
  cache.writeCache('platforms', platforms);
  return platforms;
}

/**
 * Full fetch. With `reportProgress`, each page is streamed to the renderer so
 * a long cold load renders as it arrives. Only the no-cache path asks for
 * that: a background resync (delta sync hit a count mismatch) must stay
 * silent, because the renderer appends progress pages onto whatever it is
 * showing — with a cached list already on screen that produced every game
 * twice until the final roms-updated event replaced the list.
 */
async function refreshRoms(platformId: number, reportProgress = false): Promise<RommRom[]> {
  const roms = await getClient().getRomsByPlatform(platformId, reportProgress
    ? (page, loaded, total) => send('library:roms-progress', { platformId, page, loaded, total })
    : undefined);
  cache.writeCache(`roms-${platformId}`, roms);
  return roms;
}

/**
 * Cheap background refresh for an existing cache: pull only roms updated
 * since the cache was written (~1s), merge them in, then reconcile the count
 * against the server's rom_count — a mismatch means something was deleted,
 * which delta sync can't see, so fall back to a full fetch.
 */
async function deltaRefreshRoms(platformId: number, cached: cache.CacheEntry<RommRom[]>): Promise<RommRom[]> {
  const client = getClient();
  // 60s overlap so boundary-timestamp updates can't slip through
  const since = new Date(cached.fetchedAt - 60_000);
  const updated = await client.getRomsUpdatedAfter(platformId, since);

  // slimRom is idempotent — this also shrinks caches written before trimming existed.
  const byId = new Map<number, RommRom>();
  for (const r of cached.data) { const slim = slimRom(r as unknown as Record<string, unknown>); byId.set(slim.id, slim); }
  for (const rom of updated) byId.set(rom.id, rom);
  const merged = [...byId.values()].sort((a, b) => (a.name || a.fs_name || '').localeCompare(b.name || b.fs_name || ''));

  const platforms = await client.getPlatforms();
  cache.writeCache('platforms', platforms);
  const expected = platforms.find((p) => p.id === platformId)?.rom_count;

  if (expected !== undefined && expected !== merged.length) {
    return refreshRoms(platformId); // deletions happened — resync fully
  }
  cache.writeCache(`roms-${platformId}`, merged);
  return merged;
}

function backgroundRefresh(key: string, refresh: () => Promise<unknown>, event: string, payload: object): void {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  refresh()
    .then((data) => send(event, { ...payload, data, fetchedAt: Date.now() }))
    .catch((err) => {
      console.error(`Background refresh ${key} failed:`, err);
      // Tell the renderer, or the sidebar sits on "refreshing…" indefinitely.
      send('library:refresh-failed', { ...payload, key, error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => inFlight.delete(key));
}

// ── Game folders: install dir + Windows-side user folders (saves/configs) ──
// Everything the renderer may open is computed here and re-validated on
// open, so the renderer can only ever open paths this function produced.
const gameFolders = (romId: number) => {
  const rec = downloads.findDownload(romId);
  if (!rec || !rec.filePath) return { gameFolder: null as string | null, exe: null as string | null, prefixes: [] as prefixes.PrefixInfo[] };
  const exe = rec.defaultExe && fs.existsSync(rec.defaultExe) ? rec.defaultExe : null;
  let found: prefixes.PrefixInfo[] = [];
  if (exe) {
    const steamAppId = process.platform === 'linux' ? steam.readShortcutAppId(exe) : null;
    found = prefixes.resolvePrefixes(exe, { steamAppId, steamRoot: steam.findSteamRoot() });
  } else if (process.platform === 'win32') {
    found = prefixes.resolvePrefixes('', {});
  }
  const gameFolder = fs.existsSync(rec.filePath) ? (fs.statSync(rec.filePath).isDirectory() ? rec.filePath : path.dirname(rec.filePath)) : null;
  return { gameFolder, exe, prefixes: found };
};

// ── Cloud saves (RomM) ─────────────────────────────────────────────────────

function saveRulesFor(romId: number): saves.SaveRules {
  const cfg = config.getPublicConfig();
  const rec = downloads.findDownload(romId);
  return {
    configExcludes: cfg.saveExcludes,
    includeConfig: rec?.syncConfigFiles === true,
    // Windows: the real profile is only ever read at the game's known save locations
    scope: process.platform === 'win32' ? saves.normalizeScope(rec?.savePaths) : undefined,
  };
}

/** A save target for one of the prefixes gameFolders() resolved for this rom: the prefix
 *  root on Linux, the real profile's layout (Known Folders resolved) on Windows. */
function targetFor(romId: number, root: string): saves.SaveTarget | null {
  const info = gameFolders(romId);
  const p = info.prefixes.find((x) => x.root === root);
  if (!p) return null;
  return p.source === 'windows' ? saves.windowsLayout() : p.root;
}
const rootOf = (t: saves.SaveTarget) => (typeof t === 'string' ? t : t.profile);

/** Merge newly found save locations into the game's record. Returns the full list. */
function addSavePaths(romId: number, paths: string[], note: string): string[] {
  const rec = downloads.findDownload(romId);
  const merged = saves.normalizeScope([...(rec?.savePaths || []), ...paths]);
  const notes = [...new Set([...(rec?.savePathsNote ? rec.savePathsNote.split(' · ') : []), ...(merged.length > (rec?.savePaths || []).length ? [note] : [])])];
  downloads.updateRecord(romId, { savePaths: merged, savePathsNote: notes.join(' · ') });
  return merged;
}

/** Windows: look up where this game saves (Steam-emulator appid, PCGamingWiki manifest) and remember it. */
async function detectSavePaths(romId: number): Promise<{ paths: string[]; note: string; found: string[] }> {
  const rec = downloads.findDownload(romId);
  const info = gameFolders(romId);
  const index = await savepaths.getIndex(path.join(app.getPath('userData'), 'save-locations.json'));
  const det = savepaths.detectPaths(index, { name: rec?.romName, fsName: rec?.fileName, folder: info.gameFolder, exe: info.exe });
  const paths = det.paths.length ? addSavePaths(romId, det.paths, det.notes.join(', ')) : saves.normalizeScope(rec?.savePaths);
  return { paths, note: downloads.findDownload(romId)?.savePathsNote || '', found: det.paths };
}

/** Register this machine with RomM once (servers without the devices API → ''). */
let deviceRegistration: Promise<string> | null = null;
function rommDeviceId(): Promise<string> {
  const have = config.getPublicConfig().rommDeviceId;
  if (have) return Promise.resolve(have);
  if (!deviceRegistration) {
    deviceRegistration = (async () => {
      try {
        const id = await getClient().registerDevice({
          name: os.hostname(), platform: process.platform, client: 'RomM2SteamDeck', client_version: app.getVersion(), hostname: os.hostname(),
        });
        if (id) config.setConfig({ rommDeviceId: id });
        return id || '';
      } catch (err) {
        console.error('RomM device registration failed:', err);
        return '';
      } finally {
        deviceRegistration = null;
      }
    })();
  }
  return deviceRegistration;
}

async function cloudDeps(romId: number): Promise<cloud.CloudDeps> {
  return {
    client: getClient(),
    rules: () => saveRulesFor(romId),
    deviceId: (await rommDeviceId()) || null,
    getRecord: () => downloads.findDownload(romId)?.cloud ?? null,
    setRecord: (rec) => { downloads.updateRecord(romId, { cloud: rec }); },
    // A restored save shows where the game writes — on Windows that becomes the scope
    onRestored: process.platform === 'win32' ? (entries) => { addSavePaths(romId, saves.learnScope(entries), 'learned from a restore'); } : undefined,
  };
}

// ── Running game ───────────────────────────────────────────────────────────
// While a game launched from Play runs, R2SD must not react to the controller:
// the Gamepad API keeps delivering the game's button presses to our window
// (seen on Hyprland: A-presses in a game opened cards and started downloads).
// The renderer ignores the gamepad while `game:running` is in effect and the
// window is minimized out of the way; both are undone when the game exits.
let runningGame: { romId: number; minimized: boolean; hyprland: boolean } | null = null;
/** Under gamescope (Steam Deck Game Mode) windows aren't minimized — the compositor switches to the game itself. */
const underGamescope = () => !!process.env.GAMESCOPE_WAYLAND_DISPLAY || /gamescope/i.test(process.env.XDG_CURRENT_DESKTOP || '');

function gameStarted(romId: number, gameName: string, exitTracked: boolean, launcherPid?: number): void {
  const cfg = config.getPublicConfig();
  // Hyprland has no minimize; the equivalent is the game on a fresh workspace (hyprland.ts).
  // Only possible when we know the launcher pid and will hear about the exit.
  const useHypr = hypr.isHyprland() && cfg.playWorkspace !== 'off' && !!launcherPid && exitTracked && !underGamescope();
  const minimize = cfg.playWindow !== 'stay' && !underGamescope() && !useHypr && !!mainWindow && !mainWindow.isDestroyed();
  runningGame = { romId, minimized: minimize, hyprland: useHypr };
  send('game:running', { romId, gameName, exitTracked });
  if (minimize) mainWindow!.minimize();
  if (useHypr) {
    hypr.presentGame(hypr.realEnv(), launcherPid!, { mode: cfg.playWorkspace === 'workspace' ? 'workspace' : 'fullscreen', isRunning: () => runningGame?.romId === romId })
      .then((r) => { if (r.windows) console.log(`hyprland: ${gameName} on workspace ${r.workspace} (${r.windows} window${r.windows === 1 ? '' : 's'})`); })
      .catch((err) => console.error('hyprland presentation failed:', err));
  }
}

function gameExited(romId: number, gameName: string): void {
  const wasMinimized = runningGame?.romId === romId && runningGame.minimized;
  const wasHypr = runningGame?.romId === romId && runningGame.hyprland;
  if (runningGame?.romId === romId) runningGame = null;
  send('game:exited', { romId, gameName });
  // Bring R2SD back only if it is still where we put it (the user may have restored it themselves)
  if (wasMinimized && mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) { mainWindow.restore(); mainWindow.focus(); }
  if (wasHypr && mainWindow && !mainWindow.isDestroyed()) {
    // The game's workspace is gone with its last window; jump back to R2SD's
    const hy = hypr.realEnv();
    hypr.findByClass(hy, 'romm2steamdeck').then((w) => { if (w) return hypr.focusWindow(hy, w.address); }).catch(() => { /* cosmetic */ });
    mainWindow.focus();
  }
}

/** The target auto-sync is allowed to touch: the game's own prefix (never Faugus's shared
 *  default), or on Windows the real profile (scoped to the game's save locations). */
function ownTargetFor(romId: number): saves.SaveTarget | null {
  const info = gameFolders(romId);
  if (process.platform === 'win32') return info.prefixes.some((p) => p.source === 'windows') ? saves.windowsLayout() : null;
  return info.prefixes.find((p) => p.source === 'faugus-game' || p.source === 'steam')?.root ?? null;
}

function registerIpc(): void {
  // Config
  ipcMain.handle('config:get', () => config.getPublicConfig());
  ipcMain.handle('config:isConfigured', () => config.isConfigured());
  ipcMain.handle('config:set', (_e, update) => config.setConfig(update));
  ipcMain.handle('config:clearCache', () => cache.clearCache());

  ipcMain.handle('connection:test', async (_e, creds: { baseUrl: string; username: string; password: string }) => {
    // Test with the provided password, or the stored one if left blank
    const password = creds.password || config.getCredentials().password;
    const client = new RommClient(creds.baseUrl, creds.username, password);
    return client.heartbeat();
  });

  // Library (stale-while-revalidate)
  ipcMain.handle('library:platforms', async (_e, opts?: { refresh?: boolean }) => {
    const cached = cache.readCache<RommPlatform[]>('platforms');
    if (cached && !opts?.refresh) {
      backgroundRefresh('platforms', refreshPlatforms, 'library:platforms-updated', {});
      return { platforms: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    const platforms = await refreshPlatforms();
    return { platforms, fromCache: false, fetchedAt: Date.now() };
  });

  ipcMain.handle('library:roms', async (_e, platformId: number, opts?: { refresh?: boolean }) => {
    const key = `roms-${platformId}`;
    const cached = cache.readCache<RommRom[]>(key);
    if (cached && !opts?.refresh) {
      // Cache hit: return instantly, delta-sync in the background (~1s)
      backgroundRefresh(key, () => deltaRefreshRoms(platformId, cached), 'library:roms-updated', { platformId });
      return { roms: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    if (cached) {
      // Explicit refresh: delta sync is enough (falls back to full on count mismatch)
      const roms = await deltaRefreshRoms(platformId, cached);
      return { roms, fromCache: false, fetchedAt: Date.now() };
    }
    // No cache yet: full fetch (progress streamed to the renderer per page)
    const roms = await refreshRoms(platformId, true);
    return { roms, fromCache: false, fetchedAt: Date.now() };
  });

  // Native folder picker
  ipcMain.handle('dialog:pickFolder', async (_e, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: title || 'Select folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Downloads
  ipcMain.handle('downloads:list', () => downloads.listDownloads());

  ipcMain.handle('download:start', (_e, rom: downloads.RomInfo, installPath?: string) => {
    // Enqueue — the serial queue runs one at a time; progress flows back via
    // download:event, queue composition via queue:update
    downloads.enqueueDownload(
      getClient(), rom, installPath || '',
      (payload) => send('download:event', payload),
      (payload) => send('queue:update', payload)
    );
    return true;
  });

  ipcMain.handle('queue:get', () => downloads.getQueueSnapshot());

  ipcMain.handle('download:cancel', (_e, romId: number) => downloads.cancelDownload(romId));

  ipcMain.handle('download:delete', async (_e, romId: number) => {
    // Capture the install folder before the record is removed, so we can also
    // clean up any Steam shortcut that pointed into it.
    const rec = downloads.findDownload(romId);
    const result = downloads.deleteDownload(romId);
    if (result.error || !rec || !rec.filePath) return result;
    const steamRes = await steam.removeNonSteamGamesUnder(rec.filePath);
    return { ...result, steamRemoved: steamRes.removed, steamSkipped: !!steamRes.skippedSteamRunning };
  });

  // UI scale
  ipcMain.handle('ui:scaleInfo', () => uiScaleInfo());
  ipcMain.handle('ui:setScale', (_e, scale: string) => setUiScale(scale));
  // Ctrl+= / Ctrl+- from the renderer's keydown handler (no menu bar → no
  // built-in zoom accelerators). Steps through the explicit sizes.
  ipcMain.handle('ui:stepScale', (_e, direction: number) => setUiScale(stepScale(currentZoom(), direction > 0 ? 1 : -1)));

  // Newer release on GitHub? Manual check from Settings; the startup check lives in app.whenReady.
  ipcMain.handle('update:check', async () => {
    try {
      const info = await updates.checkForUpdate(app.getVersion());
      config.setConfig({ updateCheckedAt: info.checkedAt });
      return { ok: true, ...info };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle('update:skip', (_e, version: string) => { config.setConfig({ updateSkip: String(version || '') }); });
  ipcMain.handle('update:open', (_e, url?: string) => {
    // Only ever the project's own release pages
    const target = typeof url === 'string' && url.startsWith('https://github.com/jasonlifeisguid/RomM2SteamDeck/') ? url : updates.RELEASES_PAGE;
    return shell.openExternal(target);
  });

  // Host OS (renderer gates the Steam Deck tip on this)
  ipcMain.handle('app:platform', () => process.platform);
  ipcMain.handle('app:desktop', () => ({ hyprland: hypr.isHyprland(), gamescope: underGamescope() }));
  ipcMain.handle('app:version', () => app.getVersion());
  // Clean quit — essential in Game Mode, where there's no window chrome to close.
  // Use app.exit(0), not app.quit(): a graceful quit can stall on a lingering
  // child (e.g. the Steam Overlay), leaving gamescope on a black screen with no
  // "game exited" signal. A hard exit tears the whole tree down deterministically
  // so Steam returns to the library. Config/downloads are already persisted.
  ipcMain.handle('app:quit', () => { app.exit(0); });

  // Desktop shortcuts for extracted PC games
  ipcMain.handle('game:listExes', (_e, romId: number) => {
    const record = downloads.findDownload(romId);
    if (!record || !record.filePath) return [];
    return shortcuts.listExes(record.filePath);
  });
  ipcMain.handle('shortcut:create', (_e, romId: number, exePath: string, gameName: string) => {
    const exe = exeForRom(romId, exePath);
    if (!exe) return { error: EXE_OUTSIDE_GAME };
    return shortcuts.createShortcut(exe, gameName);
  });

  // Set a game's default exe and launch it
  // Changing which executable Play runs. On Linux with per-game prefixes the
  // game may already be in Faugus's library under the OLD exe; repoint that
  // entry instead of letting the next launch register a second one with its
  // own (empty) prefix. An empty exePath clears the choice.
  ipcMain.handle('game:setDefaultExe', (_e, romId: number, exePath: string) => {
    const rec = downloads.findDownload(romId);
    const previous = rec?.defaultExe || '';
    if (!exePath) {
      downloads.updateRecord(romId, { defaultExe: '' });
      return { ok: true, cleared: true };
    }
    const exe = exeForRom(romId, exePath);
    if (!exe) return { ok: false, error: EXE_OUTSIDE_GAME };
    if (!downloads.setDefaultExe(romId, exe)) return { ok: false, error: 'Game is not tracked as installed' };
    let repointed: { gameId?: string; prefix?: string; error?: string } | undefined;
    const cfg = config.getPublicConfig();
    if (process.platform === 'linux' && previous && previous !== exe && cfg.faugus !== 'off' && cfg.faugusPrefix !== 'shared') {
      const r = faugus.repointGame(previous, exe);
      if (!r.ok) repointed = { error: r.error };
      else if (!r.notFound) repointed = { gameId: r.gameId, prefix: r.prefix };
    }
    return { ok: true, exe, faugus: repointed };
  });
  ipcMain.handle('game:launch', async (_e, romId: number, exePath?: string, coverPath?: string) => {
    if (exePath) {
      const exe = exeForRom(romId, exePath);
      if (!exe) return { ok: false, error: EXE_OUTSIDE_GAME };
      downloads.setDefaultExe(romId, exe);
    }
    const rec = downloads.findDownload(romId);
    const target = exePath || rec?.defaultExe;
    if (!target) return { ok: false, error: 'No executable selected for this game yet' };
    const cfg = config.getPublicConfig();
    // Faugus wants a PNG cover in its own covers dir; RomM covers are usually JPEG.
    let coverPng: string | undefined;
    if (process.platform === 'linux' && cfg.faugusPrefix !== 'shared' && coverPath) {
      try {
        const src = await ensureAsset(romId, coverPath);
        if (src) {
          const png = path.join(cache.coversDir(), `${romId}-faugus.png`);
          if (!fs.existsSync(png)) fs.writeFileSync(png, nativeImage.createFromPath(src).toPNG());
          coverPng = png;
        }
      } catch { /* cosmetic */ }
    }
    // Cloud saves (auto): bring the game's own prefix up to date first. If the
    // prefix doesn't exist yet we still know where Faugus will create it —
    // the registration path — so a cloud save can seed it before first run.
    let cloudAction: cloud.AutoAction | undefined;
    let cloudTarget: saves.SaveTarget | null = null;
    const gameName = rec?.romName || path.basename(target);
    const autoCloud = cfg.cloudSaves === 'auto' && config.isConfigured() && (
      process.platform === 'win32' || (process.platform === 'linux' && cfg.faugus !== 'off' && cfg.faugusPrefix !== 'shared'));
    if (autoCloud) {
      cloudTarget = ownTargetFor(romId);
      if (!cloudTarget && process.platform === 'linux') {
        const fx = faugus.readFaugusConfig();
        cloudTarget = path.join(fx.prefixesDir, faugus.formatTitle(gameName) || 'game');
      }
      // Windows: with no known save locations yet, look them up first (a restore from
      // RomM would teach them too, but an upload needs them from the start).
      if (process.platform === 'win32' && !saves.normalizeScope(rec?.savePaths).length) {
        try { await detectSavePaths(romId); } catch (err) { console.error('save path lookup failed:', err); }
      }
      if (cloudTarget) cloudAction = await cloud.beforeLaunch(await cloudDeps(romId), romId, cloudTarget, gameName);
    }
    const res = shortcuts.launchGame(target, {
      faugusEnabled: cfg.faugus !== 'off',
      faugusPerGame: cfg.faugusPrefix !== 'shared',
      title: rec?.romName,
      coverPng,
      gameFolder: gameFolders(romId).gameFolder || undefined,
      onExit: async () => {
        gameExited(romId, gameName);
        if (!autoCloud) return;
        // Re-resolve: the prefix now exists (and the registration may have
        // chosen a suffixed id if the title clashed).
        const tgt = ownTargetFor(romId) || cloudTarget;
        if (!tgt) return;
        const action = await cloud.afterExit(await cloudDeps(romId), romId, tgt, gameName);
        send('cloud:event', { romId, gameName, ...action });
      },
    });
    if (res.ok) gameStarted(romId, gameName, res.exitTracked === true, res.pid);
    return { ...res, cloud: cloudAction };
  });

  ipcMain.handle('game:folders', (_e, romId: number) => gameFolders(romId));
  ipcMain.handle('game:openFolder', async (_e, romId: number, target: string) => {
    const info = gameFolders(romId);
    const allowed = new Set<string>();
    if (info.gameFolder) allowed.add(info.gameFolder);
    for (const p of info.prefixes) for (const f of p.folders) allowed.add(f.path);
    if (typeof target !== 'string' || !allowed.has(target)) return { ok: false, error: 'Not a folder of this game' };
    const err = await shell.openPath(target); // '' on success
    return err ? { ok: false, error: err } : { ok: true };
  });

  // ── Save backup / restore ────────────────────────────────────────────────
  // The root must be one gameFolders() resolved for this rom (a Proton prefix,
  // or the Windows profile — which is only ever read at the game's save locations).
  ipcMain.handle('saves:backup', async (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    const rec = downloads.findDownload(romId);
    const picked = await dialog.showOpenDialog(mainWindow!, { title: 'Folder to save the backup in', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return saves.backupSaves(tgt, picked.filePaths[0], rec?.romName || 'game', saveRulesFor(romId));
  });
  ipcMain.handle('saves:restore', async (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    const picked = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a saves backup (.zip)', properties: ['openFile'], filters: [{ name: 'Save backups', extensions: ['zip'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    const confirm = await dialog.showMessageBox(mainWindow!, {
      type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1,
      message: process.platform === 'win32' ? 'Restore saves into your Windows user folders?' : 'Restore saves into this prefix?',
      detail: `Files from the backup will overwrite same-named files in\n${rootOf(tgt)}\n\nOther files are left alone.`,
    });
    if (confirm.response !== 0) return { ok: false, cancelled: true };
    const r = await saves.restoreSaves(tgt, picked.filePaths[0]);
    if (r.ok && r.entries && process.platform === 'win32') addSavePaths(romId, saves.learnScope(r.entries), 'learned from a restore');
    return r;
  });

  // ── Cloud saves IPC ──────────────────────────────────────────────────────
  ipcMain.handle('cloud:status', async (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    if (!config.isConfigured()) return { ok: false, error: 'Not connected to RomM' };
    const own = ownTargetFor(romId);
    try { return { ok: true, ...(await cloud.status(await cloudDeps(romId), romId, tgt)), own: own !== null && rootOf(own) === rootOf(tgt) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle('cloud:upload', async (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    const rec = downloads.findDownload(romId);
    return cloud.upload(await cloudDeps(romId), romId, tgt, rec?.romName || 'game');
  });
  ipcMain.handle('cloud:download', async (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    const confirm = await dialog.showMessageBox(mainWindow!, {
      type: 'warning', buttons: ['Download & restore', 'Cancel'], defaultId: 1, cancelId: 1,
      message: process.platform === 'win32' ? 'Restore the latest RomM save into your Windows user folders?' : 'Restore the latest RomM save into this prefix?',
      detail: `Files from the cloud save will overwrite same-named files in\n${rootOf(tgt)}\n\nOther files are left alone.`,
    });
    if (confirm.response !== 0) return { ok: false, cancelled: true };
    return cloud.download(await cloudDeps(romId), romId, tgt);
  });
  // What would be backed up / synced from this prefix, and what's excluded and why
  ipcMain.handle('saves:preview', (_e, romId: number, prefixRoot: string) => {
    const tgt = targetFor(romId, prefixRoot);
    if (!tgt) return { ok: false, error: 'Not a prefix of this game' };
    const listing = saves.listSaveFiles(tgt, saveRulesFor(romId));
    if (!listing) return { ok: false, error: 'No Windows user profile in this prefix yet' };
    const rec = downloads.findDownload(romId);
    return {
      ok: true, included: listing.included, excluded: listing.excluded, totalBytes: listing.totalBytes, unscoped: listing.unscoped === true,
      includeConfig: rec?.syncConfigFiles === true, patterns: config.getPublicConfig().saveExcludes,
      // Windows: the game's save locations (scope) and where they came from
      scoped: process.platform === 'win32', savePaths: saves.normalizeScope(rec?.savePaths), savePathsNote: rec?.savePathsNote || '',
    };
  });
  // Windows save locations: edit by hand, or look them up (Steam-emulator appid + PCGamingWiki manifest)
  ipcMain.handle('saves:setPaths', (_e, romId: number, paths: string[]) => {
    const clean = saves.normalizeScope(Array.isArray(paths) ? paths : []);
    downloads.updateRecord(romId, { savePaths: clean, savePathsNote: clean.length ? 'set by hand' : '' });
    return clean;
  });
  ipcMain.handle('saves:detectPaths', async (_e, romId: number) => {
    try { return { ok: true, ...(await detectSavePaths(romId)) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle('saves:setIncludeConfig', (_e, romId: number, include: boolean) => downloads.updateRecord(romId, { syncConfigFiles: Boolean(include) }));
  ipcMain.handle('saves:setExcludes', (_e, patterns: string[] | null) => {
    config.setConfig({ saveExcludes: patterns === null ? saves.DEFAULT_CONFIG_EXCLUDES : patterns });
    return config.getPublicConfig().saveExcludes;
  });

  // Faugus Launcher (Linux): is it installed, and is Play routed through it?
  ipcMain.handle('faugus:status', () => {
    const install = faugus.findFaugus();
    return { found: install !== null, method: install?.method ?? null, enabled: config.getPublicConfig().faugus !== 'off' };
  });

  // Add to Steam (safe shortcuts.vdf writing)
  ipcMain.handle('steam:status', async () => {
    const [running, canEditLive] = await Promise.all([
      steam.isSteamRunning(),
      // Can we drive SteamClient live (set launch options / Proton) — i.e. is the
      // CEF debugger reachable (Decky-enabled)?
      steamclient.isAvailable(),
    ]);
    return {
      found: steam.findSteamRoot() !== null,
      running,
      users: steam.findSteamUsers().length,
      canAddLive: steam.canAddLive(),
      canEditLive,
    };
  });
  ipcMain.handle('steam:add', async (_e, romId: number, exePath: string, appName: string, proton?: boolean, coverPath?: string) => {
    const exe = exeForRom(romId, exePath);
    if (!exe) return { ok: false, error: EXE_OUTSIDE_GAME };
    const res = await steam.addNonSteamGameSmart(exe, appName, { tags: ['RomM'] });
    // Live-configure via SteamClient (Decky/CEF): real game name (the live add
    // names it after the .exe), optional Proton, and the RomM cover art as the
    // library capsule. Falls back to the manual tips when the bridge is absent.
    if (res.ok && process.platform === 'linux') {
      const artwork = coverPath ? await fetchCoverBase64(romId, coverPath) : null;
      const live = await configureShortcutLive(exe, {
        name: appName,
        compatTool: proton ? 'proton_experimental' : undefined,
        artwork: artwork || undefined,
      });
      return { ...res, ...live };
    }
    return res;
  });
  // Add R2SD *itself* to Steam (Settings button). Uses the same hybrid path.
  ipcMain.handle('steam:addSelf', async () => {
    const self = selfLauncherPath();
    if (!self) {
      return { ok: false, error: 'This works from the packaged app (installed .exe / AppImage / .app), not a dev run.' };
    }
    const res = await steam.addNonSteamGameSmart(self, 'RomM2SteamDeck', { tags: ['RomM'] });
    // Live-configure via SteamClient: a clean name + the overlay-strip Launch
    // Option (so it sticks in Game Mode / across Cloud — no restart, no revert).
    if (res.ok && process.platform === 'linux') {
      const live = await configureShortcutLive(self, {
        name: 'RomM2SteamDeck',
        launchOptions: steam.OVERLAY_STRIP_LAUNCH_OPTS,
      });
      return { ...res, ...live };
    }
    return res;
  });

  ipcMain.handle('downloads:sync', (_e, platformId: number) => {
    const cached = cache.readCache<RommRom[]>(`roms-${platformId}`);
    if (!cached) return { added: 0, removed: 0 };
    const roms = cached.data.map((r) => ({ id: r.id, name: r.name || r.fs_name, fsName: r.fs_name }));
    return downloads.syncPlatform(platformId, roms);
  });

  // Server-hosted images (covers, screenshots): returns a URL on the private
  // asset scheme, fetching + caching on first request
  ipcMain.handle('asset:get', async (_e, romId: number, serverPath: string) => {
    if (typeof serverPath !== 'string' || !serverPath) return null;
    const file = await ensureAsset(romId, serverPath);
    return file ? `${ASSET_SCHEME}://covers/${encodeURIComponent(path.basename(file))}` : null;
  });
}

/** r2sd-asset://covers/<file> → the covers cache directory, nothing else. */
function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    // One plain filename: no separators, no traversal.
    if (url.hostname !== 'covers' || !/^[\w.-]+$/.test(name) || name.includes('..')) {
      return new Response('', { status: 404 });
    }
    const file = path.join(cache.coversDir(), name);
    if (!fs.existsSync(file)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Once a day at most, a few seconds after startup: tell the renderer when a newer release exists. */
function scheduleUpdateCheck(): void {
  const cfg = config.getPublicConfig();
  if (cfg.updateCheck === 'off' || Date.now() - cfg.updateCheckedAt < 24 * 3600_000) return;
  setTimeout(async () => {
    try {
      const info = await updates.checkForUpdate(app.getVersion());
      config.setConfig({ updateCheckedAt: info.checkedAt });
      if (info.newer && info.latest !== config.getPublicConfig().updateSkip) send('update:available', info);
    } catch (err) { console.error('update check failed:', err); }
  }, 6000).unref();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    // Create hidden and only show once the first frame is painted. On the
    // Steam Deck with software (SwiftShader) rendering the window otherwise
    // races the first paint and appears as a gray/black unpainted surface.
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Initial zoom so the first paint is already at the right scale (no jump)
      zoomFactor: currentZoom(),
    },
  });
  // Re-assert after load: Chromium restores a per-origin zoom level it saved
  // from a previous session, which would otherwise override the setting.
  mainWindow.webContents.on('did-finish-load', applyZoom);

  // The renderer is a local, single-page UI: never let it navigate away or
  // open windows, whatever ends up in a rendered string.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Safety net: show anyway if ready-to-show is delayed, and nudge a repaint
  // (a 1px resize forces the compositor to present a frame).
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      const [w, h] = mainWindow.getSize();
      mainWindow.setSize(w, h + 1);
      mainWindow.setSize(w, h);
    }
  }, 2500);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Remove a Chromium "Singleton" profile lock that points to a process that is
 * no longer alive. On the Steam Deck this is the difference between the app
 * launching and hanging forever: switching Desktop↔Game Mode (or a crash) can
 * leave a stale SingletonLock, and Electron's own reclaim doesn't recover
 * cleanly under gamescope — requestSingleInstanceLock() returns false, app.quit()
 * fires, and the already-forked Chromium zygote is orphaned, so Steam's launch
 * reaper spins forever with no window and no way to cancel. We only delete the
 * lock when it points to a DEAD pid on THIS host, so a genuinely running second
 * instance is still respected.
 */
function clearStaleSingletonLock(): void {
  if (process.platform === 'win32') return; // Windows doesn't use these symlinks
  try {
    const lock = path.join(userDataDir, 'SingletonLock');
    const target = fs.readlinkSync(lock); // "<hostname>-<pid>"
    const dash = target.lastIndexOf('-');
    if (dash < 0) return;
    if (target.slice(0, dash) !== os.hostname()) return; // lock from another machine
    const pid = Number(target.slice(dash + 1));
    if (!Number.isInteger(pid) || pid <= 0) return;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } // signal 0 = existence check
    catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; } // exists but not ours
    if (alive) {
      // Guard against PID reuse (common after a reboot): only respect the lock
      // if that PID is actually one of our processes, not some unrelated one
      // that happened to inherit the number.
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8');
        if (!comm.includes('romm2steamdeck')) alive = false;
      } catch { alive = false; }
    }
    if (alive) return;
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(userDataDir, f)); } catch { /* already gone */ }
    }
  } catch { /* no lock / not a symlink — nothing stale to clear */ }
}
clearStaleSingletonLock();

// Single instance — a second launch focuses the existing window instead
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerAssetProtocol();
    registerIpc();

    // Automated smoke test: verify startup then exit
    if (process.env.R2SD_SMOKE) {
      console.log('SMOKE OK: app ready, ipc registered');
      app.quit();
      return;
    }

    createWindow();
    scheduleUpdateCheck();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit(); // closing the window exits the app — on every OS, macOS included
  });
}
