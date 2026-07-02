/**
 * App configuration, stored in the Electron userData directory.
 *
 * The RomM password is encrypted at rest with safeStorage, which uses
 * DPAPI on Windows, Keychain on macOS, and libsecret on Linux — an
 * upgrade over the plaintext SQLite storage in the Python version.
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeBaseUrl } from './romm';

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
  pinnedPlatforms: number[];
  platforms: Record<string, PlatformSetup>;
  basePath: string;    // used by the auto-fill helper (folder = basePath/fs_slug)
  stagingPath: string; // where archives land before extraction ('' = extract destination)
}

export interface PublicConfig {
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  theme: string;
  pinnedPlatforms: number[];
  platforms: Record<string, PlatformSetup>;
  basePath: string;
  stagingPath: string;
}

const DEFAULTS: StoredConfig = {
  baseUrl: '', username: '', passwordEncrypted: '', theme: 'oled-limited',
  pinnedPlatforms: [], platforms: {}, basePath: '', stagingPath: '',
};

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function readStored(): StoredConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeStored(config: StoredConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export function getPublicConfig(): PublicConfig {
  const stored = readStored();
  return {
    baseUrl: stored.baseUrl,
    username: stored.username,
    hasPassword: stored.passwordEncrypted.length > 0,
    theme: stored.theme,
    pinnedPlatforms: Array.isArray(stored.pinnedPlatforms) ? stored.pinnedPlatforms : [],
    platforms: stored.platforms || {},
    basePath: stored.basePath || '',
    stagingPath: stored.stagingPath || '',
  };
}

export function getCredentials(): { baseUrl: string; username: string; password: string } {
  const stored = readStored();
  let password = '';
  if (stored.passwordEncrypted) {
    try {
      password = safeStorage.decryptString(Buffer.from(stored.passwordEncrypted, 'base64'));
    } catch {
      password = '';
    }
  }
  return { baseUrl: stored.baseUrl, username: stored.username, password };
}

export function isConfigured(): boolean {
  const stored = readStored();
  return Boolean(stored.baseUrl && stored.username && stored.passwordEncrypted);
}

export function setConfig(update: {
  baseUrl?: string; username?: string; password?: string; theme?: string;
  pinnedPlatforms?: number[]; platforms?: Record<string, PlatformSetup>;
  basePath?: string; stagingPath?: string;
}): PublicConfig {
  const stored = readStored();
  if (update.baseUrl !== undefined) stored.baseUrl = normalizeBaseUrl(update.baseUrl);
  if (update.username !== undefined) stored.username = update.username.trim();
  if (update.theme !== undefined) stored.theme = update.theme;
  if (update.basePath !== undefined) stored.basePath = update.basePath.trim();
  if (update.stagingPath !== undefined) stored.stagingPath = update.stagingPath.trim();
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
    stored.passwordEncrypted = safeStorage.encryptString(update.password).toString('base64');
  }
  writeStored(stored);
  return getPublicConfig();
}
