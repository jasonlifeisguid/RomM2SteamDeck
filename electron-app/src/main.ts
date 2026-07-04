import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { RommClient, RommPlatform, RommRom } from './romm';
import * as config from './config';
import * as cache from './cache';
import * as downloads from './downloads';
import * as shortcuts from './shortcuts';
import * as steam from './steam';

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

/** Full fetch with progressive page events so a long cold load renders as it arrives. */
async function refreshRoms(platformId: number): Promise<RommRom[]> {
  const roms = await getClient().getRomsByPlatform(platformId, (page, loaded, total) => {
    send('library:roms-progress', { platformId, page, loaded, total });
  });
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

  const byId = new Map(cached.data.map((r) => [r.id, r]));
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
    .catch((err) => console.error(`Background refresh ${key} failed:`, err))
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
    const roms = await refreshRoms(platformId);
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

  ipcMain.handle('download:delete', (_e, romId: number) => downloads.deleteDownload(romId));

  // Host OS (renderer gates the Steam Deck tip on this)
  ipcMain.handle('app:platform', () => process.platform);
  ipcMain.handle('app:version', () => app.getVersion());

  // Desktop shortcuts for extracted PC games
  ipcMain.handle('game:listExes', (_e, romId: number) => {
    const record = downloads.listDownloads().find((r) => r.romId === romId);
    if (!record || !record.filePath) return [];
    return shortcuts.listExes(record.filePath);
  });
  ipcMain.handle('shortcut:create', (_e, exePath: string, gameName: string) =>
    shortcuts.createShortcut(exePath, gameName)
  );

  // Set a game's default exe and launch it
  ipcMain.handle('game:setDefaultExe', (_e, romId: number, exePath: string) =>
    downloads.setDefaultExe(romId, exePath)
  );
  ipcMain.handle('game:launch', (_e, romId: number, exePath?: string) => {
    if (exePath) downloads.setDefaultExe(romId, exePath);
    const rec = downloads.listDownloads().find((r) => r.romId === romId);
    const target = exePath || rec?.defaultExe;
    if (!target) return { ok: false, error: 'No executable selected for this game yet' };
    return shortcuts.launchGame(target);
  });

  // Add to Steam (safe shortcuts.vdf writing)
  ipcMain.handle('steam:status', () => ({
    found: steam.findSteamRoot() !== null,
    running: steam.isSteamRunning(),
    users: steam.findSteamUsers().length,
  }));
  ipcMain.handle('steam:add', (_e, exePath: string, appName: string) =>
    steam.addNonSteamGame(exePath, appName, { tags: ['RomM'] })
  );

  ipcMain.handle('downloads:sync', (_e, platformId: number) => {
    const cached = cache.readCache<RommRom[]>(`roms-${platformId}`);
    if (!cached) return { added: 0, removed: 0 };
    const roms = cached.data.map((r) => ({ id: r.id, name: r.name || r.fs_name, fsName: r.fs_name }));
    return downloads.syncPlatform(platformId, roms);
  });

  // Server-hosted images (covers, screenshots): returns a local file path,
  // fetching + caching on first request
  ipcMain.handle('asset:get', async (_e, romId: number, serverPath: string) => {
    if (!serverPath) return null;
    const file = cache.assetCachePath(romId, serverPath);
    if (fs.existsSync(file)) return file;
    const data = await getClient().getBinary(serverPath);
    if (!data) return null;
    fs.mkdirSync(cache.coversDir(), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
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
    },
  });
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
