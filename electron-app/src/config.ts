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

interface StoredConfig {
  baseUrl: string;
  username: string;
  passwordEncrypted: string; // base64
  theme: string;
  pinnedPlatforms: number[];
}

export interface PublicConfig {
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  theme: string;
  pinnedPlatforms: number[];
}

const DEFAULTS: StoredConfig = { baseUrl: '', username: '', passwordEncrypted: '', theme: 'oled-limited', pinnedPlatforms: [] };

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

export function setConfig(update: { baseUrl?: string; username?: string; password?: string; theme?: string; pinnedPlatforms?: number[] }): PublicConfig {
  const stored = readStored();
  if (update.baseUrl !== undefined) stored.baseUrl = normalizeBaseUrl(update.baseUrl);
  if (update.username !== undefined) stored.username = update.username.trim();
  if (update.theme !== undefined) stored.theme = update.theme;
  if (update.pinnedPlatforms !== undefined) {
    stored.pinnedPlatforms = (Array.isArray(update.pinnedPlatforms) ? update.pinnedPlatforms : [])
      .filter((id) => Number.isInteger(id));
  }
  // Only touch the password when a new one is provided (empty string keeps the old one)
  if (update.password) {
    stored.passwordEncrypted = safeStorage.encryptString(update.password).toString('base64');
  }
  writeStored(stored);
  return getPublicConfig();
}
