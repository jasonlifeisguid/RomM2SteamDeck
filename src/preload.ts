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
  getDesktop: () => ipcRenderer.invoke('app:desktop'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  listExes: (romId: number) => ipcRenderer.invoke('game:listExes', romId),
  createShortcut: (romId: number, exePath: string, gameName: string) => ipcRenderer.invoke('shortcut:create', romId, exePath, gameName),
  steamStatus: () => ipcRenderer.invoke('steam:status'),
  faugusStatus: () => ipcRenderer.invoke('faugus:status'),
  setFaugusFileHandler: (enable: boolean) => ipcRenderer.invoke('faugus:setFileHandler', enable),
  gameFolders: (romId: number) => ipcRenderer.invoke('game:folders', romId),
  openGameFolder: (romId: number, target: string) => ipcRenderer.invoke('game:openFolder', romId, target),
  addToSteam: (romId: number, exePath: string, gameName: string, proton?: boolean, coverPath?: string) =>
    ipcRenderer.invoke('steam:add', romId, exePath, gameName, proton, coverPath),
  addSelfToSteam: () => ipcRenderer.invoke('steam:addSelf'),
  setDefaultExe: (romId: number, exePath: string) => ipcRenderer.invoke('game:setDefaultExe', romId, exePath),
  launchGame: (romId: number, exePath?: string, coverPath?: string) => ipcRenderer.invoke('game:launch', romId, exePath, coverPath),
  backupSaves: (romId: number, prefixRoot: string) => ipcRenderer.invoke('saves:backup', romId, prefixRoot),
  cloudStatus: (romId: number, prefixRoot: string) => ipcRenderer.invoke('cloud:status', romId, prefixRoot),
  cloudUpload: (romId: number, prefixRoot: string) => ipcRenderer.invoke('cloud:upload', romId, prefixRoot),
  cloudDownload: (romId: number, prefixRoot: string) => ipcRenderer.invoke('cloud:download', romId, prefixRoot),
  cloudOwnStatus: (romId: number) => ipcRenderer.invoke('cloud:ownStatus', romId),
  setCloudAsk: (romId: number, ask: boolean) => ipcRenderer.invoke('cloud:setAsk', romId, ask),
  onCloudSuggest: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('cloud:suggest', (_e, payload) => cb(payload)),
  cloudHistory: (romId: number, prefixRoot: string) => ipcRenderer.invoke('cloud:history', romId, prefixRoot),
  cloudRestoreVersion: (romId: number, prefixRoot: string, saveId: number, label: string) =>
    ipcRenderer.invoke('cloud:restoreVersion', romId, prefixRoot, saveId, label),
  showSaveBackup: (file: string) => ipcRenderer.invoke('saves:showBackup', file),
  savesPreview: (romId: number, prefixRoot: string) => ipcRenderer.invoke('saves:preview', romId, prefixRoot),
  setIncludeConfig: (romId: number, include: boolean) => ipcRenderer.invoke('saves:setIncludeConfig', romId, include),
  setSaveExcludes: (patterns: string[] | null) => ipcRenderer.invoke('saves:setExcludes', patterns),
  setSavePaths: (romId: number, paths: string[]) => ipcRenderer.invoke('saves:setPaths', romId, paths),
  detectSavePaths: (romId: number) => ipcRenderer.invoke('saves:detectPaths', romId),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  skipUpdate: (version: string) => ipcRenderer.invoke('update:skip', version),
  openReleasePage: (url?: string) => ipcRenderer.invoke('update:open', url),
  onUpdateAvailable: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('update:available', (_e, payload) => cb(payload)),
  onGameRunning: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('game:running', (_e, payload) => cb(payload)),
  onGameExited: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('game:exited', (_e, payload) => cb(payload)),
  onCloudEvent: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('cloud:event', (_e, payload) => cb(payload)),
  restoreSaves: (romId: number, prefixRoot: string) => ipcRenderer.invoke('saves:restore', romId, prefixRoot),

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
