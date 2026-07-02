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
  getCover: (romId: number, serverPath: string) => ipcRenderer.invoke('cover:get', romId, serverPath),

  // Background-refresh + progress events
  onPlatformsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:platforms-updated', (_e, payload) => cb(payload)),
  onRomsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-updated', (_e, payload) => cb(payload)),
  onRomsProgress: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-progress', (_e, payload) => cb(payload)),
});
