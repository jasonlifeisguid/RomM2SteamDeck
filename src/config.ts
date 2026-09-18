/**
 * App configuration, stored in the Electron userData directory.
 *
 * The RomM password is encrypted at rest with safeStorage, which uses
 * DPAPI on Windows, Keychain on macOS, and libsecret on Linux — an
 * upgrade over the plaintext SQLite storage in the Python version.
 *
 * The parsed config (and the decrypted password) is memoized in memory and
 * invalidated on every write. Before this, each getPublicConfig() call
 * re-read config.json and, on Windows, ran a DPAPI decrypt — and the download
 * manager calls it several times per download (once per protected-root check).
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeBaseUrl } from './romm';
import { normalizeUiScale, UiScale } from './device';
import { DEFAULT_CONFIG_EXCLUDES } from './saves';

export interface PlatformSetup {
  folder: string;        // destination for standard (non-extracted) downloads
  autoExtract: boolean;  // extract zip/7z after (or during) download
  installPaths: string[]; // extraction destinations (first is default)
}

interface StoredConfig {
  baseUrl: string;
  username: string;
  passwordEncrypted: string; // base64
  theme: string;
  view: string;              // 'grid' | 'list'
  pinnedPlatforms: number[];
  platforms: Record<string, PlatformSetup>;
  basePath: string;    // used by the auto-fill helper (folder = basePath/fs_slug)
  stagingPath: string; // where archives land before extraction ('' = extract destination)
  uiScale: UiScale;    // renderer zoom: 'auto' (Deck → 140%, else 100%) or an explicit percent
  faugus: 'auto' | 'off'; // Linux: Play a .exe through Faugus Launcher when installed
  faugusPrefix: 'per-game' | 'shared'; // register each game in Faugus (own prefix) or use its shared default prefix
  installedOnly: boolean; // library shows only games present on disk
  cloudSaves: 'off' | 'auto'; // sync per-game prefix saves with RomM around Play
  saveExcludes: string[];     // config-file patterns kept out of save backups/sync
  rommDeviceId: string;       // this machine's RomM device id ('' until registered)
  updateCheck: 'auto' | 'off'; // ask GitHub for a newer release on startup
  updateCheckedAt: number;     // last check (ms epoch), so startup checks are at most daily
  updateSkip: string;          // a version the user chose not to be told about again
  playWindow: 'minimize' | 'stay'; // minimize R2SD while a game launched from Play runs
}

export interface PublicConfig {
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  /** A password is stored but can't be decrypted (e.g. encrypted under a keyring
   *  that's no longer available) — the user needs to re-enter it. */
  passwordNeedsReentry: boolean;
  theme: string;
  view: string;
  pinnedPlatforms: number[];
  platforms: Record<string, PlatformSetup>;
  basePath: string;
  stagingPath: string;
  uiScale: UiScale;
  faugus: 'auto' | 'off';
  faugusPrefix: 'per-game' | 'shared';
  installedOnly: boolean;
  cloudSaves: 'off' | 'auto';
  saveExcludes: string[];
  rommDeviceId: string;
  updateCheck: 'auto' | 'off';
  updateCheckedAt: number;
  updateSkip: string;
  playWindow: 'minimize' | 'stay';
}

const DEFAULTS: StoredConfig = {
  baseUrl: '', username: '', passwordEncrypted: '', theme: 'oled-limited', view: 'grid',
  pinnedPlatforms: [], platforms: {}, basePath: '', stagingPath: '', uiScale: 'auto', faugus: 'auto',
  installedOnly: false, faugusPrefix: 'per-game',
  cloudSaves: 'off', saveExcludes: DEFAULT_CONFIG_EXCLUDES, rommDeviceId: '',
  updateCheck: 'auto', updateCheckedAt: 0, updateSkip: '', playWindow: 'minimize',
};

// Overridable so modules that read config can run under plain Node in tests.
let userDataDirOverride: string | null = null;
export function setUserDataDirForTests(dir: string | null): void { userDataDirOverride = dir; memo = null; }

function configPath(): string {
  return path.join(userDataDirOverride ?? app.getPath('userData'), 'config.json');
}

// ── Memoized read ────────────────────────────────────────────────────────

interface Loaded { stored: StoredConfig; password: string | null; }
let memo: Loaded | null = null;

function readStoredFromDisk(): StoredConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function load(): Loaded {
  if (!memo) {
    const stored = readStoredFromDisk();
    memo = { stored, password: decryptStored(stored) };
  }
  return memo;
}

function writeStored(config: StoredConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const file = configPath();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(`${file}.tmp`, file);
  memo = null; // re-read (and re-decrypt) lazily on the next access
}

// ── Password storage ─────────────────────────────────────────────────────
//
// safeStorage (OS keyring) is genuinely secure on Windows (DPAPI) and macOS
// (Keychain), so we use it there. But on the Steam Deck the Linux keyring
// (kwallet/libsecret) isn't running in Game Mode and varies across a
// Desktop<->Game Mode switch — a value encrypted in one session silently fails
// to decrypt in another, which surfaced as RomM 403s ("failed to load games").
// So on Linux we DON'T touch the keyring: we store the password with a
// mode-independent local obfuscation. This is plaintext-equivalent security
// (the key is in the source), matching the Python app's plaintext storage —
// an acceptable trade for a LAN homelab client that MUST work in Game Mode.
//
// Stored format is scheme-prefixed: "ss:" = safeStorage, "ob:" = obfuscated.
// A legacy value with no prefix is an old raw-safeStorage blob (tried best-effort).

const OBFUSCATION_KEY = 'R2SD/local-obfuscation-not-real-encryption/v1';

function xorCode(buf: Buffer): Buffer {
  for (let i = 0; i < buf.length; i++) buf[i] ^= OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length) & 0xff;
  return buf;
}

function useKeyring(): boolean {
  // Only trust the OS keyring where it's reliable across sessions.
  if (process.platform === 'linux') return false;
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function encodePassword(password: string): string {
  if (useKeyring()) return 'ss:' + safeStorage.encryptString(password).toString('base64');
  return 'ob:' + xorCode(Buffer.from(password, 'utf8')).toString('base64');
}

/** Decode the stored password, or null if there's none / it can't be decoded. */
function decryptStored(stored: StoredConfig): string | null {
  const blob = stored.passwordEncrypted;
  if (!blob) return null;
  try {
    if (blob.startsWith('ob:')) return xorCode(Buffer.from(blob.slice(3), 'base64')).toString('utf8');
    // On Linux we NEVER touch the OS keyring. Beyond being unreliable across
    // Desktop<->Game Mode, a safeStorage call can BLOCK on a dbus timeout in
    // Game Mode (no secret service) — and this runs at boot (getPublicConfig /
    // isConfigured), which would freeze startup before the window appears.
    // An 'ss:'/legacy blob on Linux therefore just means "re-enter the password".
    if (process.platform === 'linux') return null;
    if (blob.startsWith('ss:')) return safeStorage.decryptString(Buffer.from(blob.slice(3), 'base64'));
    // Legacy: raw base64 of a safeStorage blob (may be undecodable here → re-entry).
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    return null;
  }
}

export function getPublicConfig(): PublicConfig {
  const { stored, password } = load();
  return {
    baseUrl: stored.baseUrl,
    username: stored.username,
    hasPassword: Boolean(password),
    passwordNeedsReentry: stored.passwordEncrypted.length > 0 && password === null,
    theme: stored.theme,
    view: stored.view === 'list' ? 'list' : 'grid',
    pinnedPlatforms: Array.isArray(stored.pinnedPlatforms) ? stored.pinnedPlatforms : [],
    platforms: stored.platforms || {},
    basePath: stored.basePath || '',
    stagingPath: stored.stagingPath || '',
    uiScale: normalizeUiScale(stored.uiScale),
    faugus: stored.faugus === 'off' ? 'off' : 'auto',
    faugusPrefix: stored.faugusPrefix === 'shared' ? 'shared' : 'per-game',
    installedOnly: stored.installedOnly === true,
    cloudSaves: stored.cloudSaves === 'auto' ? 'auto' : 'off',
    saveExcludes: Array.isArray(stored.saveExcludes) ? stored.saveExcludes.filter((p) => typeof p === 'string') : DEFAULT_CONFIG_EXCLUDES,
    rommDeviceId: typeof stored.rommDeviceId === 'string' ? stored.rommDeviceId : '',
    updateCheck: stored.updateCheck === 'off' ? 'off' : 'auto',
    updateCheckedAt: typeof stored.updateCheckedAt === 'number' ? stored.updateCheckedAt : 0,
    updateSkip: typeof stored.updateSkip === 'string' ? stored.updateSkip : '',
    playWindow: stored.playWindow === 'stay' ? 'stay' : 'minimize',
  };
}

export function getCredentials(): { baseUrl: string; username: string; password: string } {
  const { stored, password } = load();
  return { baseUrl: stored.baseUrl, username: stored.username, password: password ?? '' };
}

export function isConfigured(): boolean {
  const { stored, password } = load();
  return Boolean(stored.baseUrl && stored.username && password);
}

export function setConfig(update: {
  baseUrl?: string; username?: string; password?: string; theme?: string; view?: string;
  pinnedPlatforms?: number[]; platforms?: Record<string, PlatformSetup>;
  basePath?: string; stagingPath?: string; uiScale?: string; faugus?: string; faugusPrefix?: string; installedOnly?: boolean;
  cloudSaves?: string; saveExcludes?: string[]; rommDeviceId?: string;
  updateCheck?: string; updateCheckedAt?: number; updateSkip?: string; playWindow?: string;
}): PublicConfig {
  // Copy before mutating so a failed write can't leave the memo half-updated.
  const stored: StoredConfig = { ...load().stored };
  if (update.baseUrl !== undefined) stored.baseUrl = normalizeBaseUrl(update.baseUrl);
  if (update.username !== undefined) stored.username = update.username.trim();
  if (update.theme !== undefined) stored.theme = update.theme;
  if (update.view !== undefined) stored.view = update.view === 'list' ? 'list' : 'grid';
  if (update.basePath !== undefined) stored.basePath = update.basePath.trim();
  if (update.stagingPath !== undefined) stored.stagingPath = update.stagingPath.trim();
  if (update.uiScale !== undefined) stored.uiScale = normalizeUiScale(update.uiScale);
  if (update.faugus !== undefined) stored.faugus = update.faugus === 'off' ? 'off' : 'auto';
  if (update.installedOnly !== undefined) stored.installedOnly = Boolean(update.installedOnly);
  if (update.faugusPrefix !== undefined) stored.faugusPrefix = update.faugusPrefix === 'shared' ? 'shared' : 'per-game';
  if (update.cloudSaves !== undefined) stored.cloudSaves = update.cloudSaves === 'auto' ? 'auto' : 'off';
  if (update.saveExcludes !== undefined) stored.saveExcludes = (Array.isArray(update.saveExcludes) ? update.saveExcludes : []).map((p) => String(p).trim()).filter(Boolean);
  if (update.rommDeviceId !== undefined) stored.rommDeviceId = String(update.rommDeviceId);
  if (update.updateCheck !== undefined) stored.updateCheck = update.updateCheck === 'off' ? 'off' : 'auto';
  if (update.updateCheckedAt !== undefined) stored.updateCheckedAt = Number(update.updateCheckedAt) || 0;
  if (update.updateSkip !== undefined) stored.updateSkip = String(update.updateSkip);
  if (update.playWindow !== undefined) stored.playWindow = update.playWindow === 'stay' ? 'stay' : 'minimize';
  if (update.pinnedPlatforms !== undefined) {
    stored.pinnedPlatforms = (Array.isArray(update.pinnedPlatforms) ? update.pinnedPlatforms : [])
      .filter((id) => Number.isInteger(id));
  }
  if (update.platforms !== undefined) {
    const cleaned: Record<string, PlatformSetup> = {};
    for (const [id, setup] of Object.entries(update.platforms)) {
      cleaned[id] = {
        folder: (setup.folder || '').trim(),
        autoExtract: Boolean(setup.autoExtract),
        installPaths: (Array.isArray(setup.installPaths) ? setup.installPaths : [])
          .map((p) => (p || '').trim()).filter(Boolean),
      };
    }
    stored.platforms = cleaned;
  }
  // Only touch the password when a new one is provided (empty string keeps the old one)
  if (update.password) {
    stored.passwordEncrypted = encodePassword(update.password);
  }
  writeStored(stored);
  return getPublicConfig();
}
