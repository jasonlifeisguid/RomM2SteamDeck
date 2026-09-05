import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
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

  // Host OS (renderer gates the Steam Deck tip on this)
  ipcMain.handle('app:platform', () => process.platform);
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
  ipcMain.handle('game:setDefaultExe', (_e, romId: number, exePath: string) => {
    const exe = exeForRom(romId, exePath);
    return exe ? downloads.setDefaultExe(romId, exe) : false;
  });
  ipcMain.handle('game:launch', (_e, romId: number, exePath?: string) => {
    if (exePath) {
      const exe = exeForRom(romId, exePath);
      if (!exe) return { ok: false, error: EXE_OUTSIDE_GAME };
      downloads.setDefaultExe(romId, exe);
    }
    const rec = downloads.findDownload(romId);
    const target = exePath || rec?.defaultExe;
    if (!target) return { ok: false, error: 'No executable selected for this game yet' };
    return shortcuts.launchGame(target);
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit(); // closing the window exits the app — on every OS, macOS included
  });
}
