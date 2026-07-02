import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { RommClient, RommPlatform, RommRom } from './romm';
import * as config from './config';
import * as cache from './cache';

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

  // Cover art: returns a local file path, fetching + caching on first request
  ipcMain.handle('cover:get', async (_e, romId: number, serverPath: string) => {
    if (!serverPath) return null;
    const file = cache.coverCachePath(romId, serverPath);
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
