import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only surface the renderer can touch. Everything else (network, fs,
 * credentials) stays in the main process.
 */
contextBridge.exposeInMainWorld('r2sd', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  isConfigured: () => ipcRenderer.invoke('config:isConfigured'),
  setConfig: (update: object) => ipcRenderer.invoke('config:set', update),
  clearCache: () => ipcRenderer.invoke('config:clearCache'),
  testConnection: (creds: object) => ipcRenderer.invoke('connection:test', creds),

  // Library
  getPlatforms: (opts?: object) => ipcRenderer.invoke('library:platforms', opts),
  getRoms: (platformId: number, opts?: object) => ipcRenderer.invoke('library:roms', platformId, opts),
  getAsset: (romId: number, serverPath: string) => ipcRenderer.invoke('asset:get', romId, serverPath),
  pickFolder: (title?: string) => ipcRenderer.invoke('dialog:pickFolder', title),

  // Downloads
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  startDownload: (rom: object, installPath?: string) => ipcRenderer.invoke('download:start', rom, installPath),
  cancelDownload: (romId: number) => ipcRenderer.invoke('download:cancel', romId),
  deleteDownload: (romId: number) => ipcRenderer.invoke('download:delete', romId),
  syncDownloads: (platformId: number) => ipcRenderer.invoke('downloads:sync', platformId),
  onDownloadEvent: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('download:event', (_e, payload) => cb(payload)),

  // Desktop shortcuts
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  listExes: (romId: number) => ipcRenderer.invoke('game:listExes', romId),
  createShortcut: (exePath: string, gameName: string) => ipcRenderer.invoke('shortcut:create', exePath, gameName),
  steamStatus: () => ipcRenderer.invoke('steam:status'),
  addToSteam: (exePath: string, gameName: string) => ipcRenderer.invoke('steam:add', exePath, gameName),

  // Background-refresh + progress events
  onPlatformsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:platforms-updated', (_e, payload) => cb(payload)),
  onRomsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-updated', (_e, payload) => cb(payload)),
  onRomsProgress: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-progress', (_e, payload) => cb(payload)),
});
