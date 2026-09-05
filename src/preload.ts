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
  getQueue: () => ipcRenderer.invoke('queue:get'),
  onDownloadEvent: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('download:event', (_e, payload) => cb(payload)),
  onQueueUpdate: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('queue:update', (_e, payload) => cb(payload)),

  // UI scale (renderer zoom)
  getUiScaleInfo: () => ipcRenderer.invoke('ui:scaleInfo'),
  setUiScale: (scale: string) => ipcRenderer.invoke('ui:setScale', scale),
  stepUiScale: (direction: number) => ipcRenderer.invoke('ui:stepScale', direction),
  onUiScaleChanged: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('ui:scale-changed', (_e, payload) => cb(payload)),

  // Desktop shortcuts
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  listExes: (romId: number) => ipcRenderer.invoke('game:listExes', romId),
  createShortcut: (romId: number, exePath: string, gameName: string) => ipcRenderer.invoke('shortcut:create', romId, exePath, gameName),
  steamStatus: () => ipcRenderer.invoke('steam:status'),
  addToSteam: (romId: number, exePath: string, gameName: string, proton?: boolean, coverPath?: string) =>
    ipcRenderer.invoke('steam:add', romId, exePath, gameName, proton, coverPath),
  addSelfToSteam: () => ipcRenderer.invoke('steam:addSelf'),
  setDefaultExe: (romId: number, exePath: string) => ipcRenderer.invoke('game:setDefaultExe', romId, exePath),
  launchGame: (romId: number, exePath?: string) => ipcRenderer.invoke('game:launch', romId, exePath),

  // Background-refresh + progress events
  onPlatformsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:platforms-updated', (_e, payload) => cb(payload)),
  onRomsUpdated: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-updated', (_e, payload) => cb(payload)),
  onRomsProgress: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:roms-progress', (_e, payload) => cb(payload)),
  onRefreshFailed: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('library:refresh-failed', (_e, payload) => cb(payload)),
});
