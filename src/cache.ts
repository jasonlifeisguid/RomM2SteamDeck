/**
 * On-disk library cache (stale-while-revalidate).
 *
 * Platform and ROM lists are cached as JSON in userData/cache; cover art is
 * cached as image files in userData/covers. The UI always renders from cache
 * instantly when available, while a background refresh updates the cache and
 * notifies the renderer — so only the very first view of a platform waits on
 * the network.
 */
import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CacheEntry<T> {
  data: T;
  fetchedAt: number; // epoch ms
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'cache');
}

export function coversDir(): string {
  return path.join(app.getPath('userData'), 'covers');
}

export function readCache<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = fs.readFileSync(path.join(cacheDir(), `${key}.json`), 'utf-8');
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): CacheEntry<T> {
  const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), `${key}.json`);
  // Write-then-rename so a crash mid-write can't corrupt the cache file
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry), 'utf-8');
  fs.renameSync(`${file}.tmp`, file);
  return entry;
}

export function clearCache(): void {
  fs.rmSync(cacheDir(), { recursive: true, force: true });
  fs.rmSync(coversDir(), { recursive: true, force: true });
}

/** Cache path for a rom image asset (cover or screenshot). The server path is
 *  hashed into the filename so multiple assets per rom don't collide. */
export function assetCachePath(romId: number, serverPath: string): string {
  const ext = path.extname(new URL(serverPath, 'http://x').pathname) || '.png';
  const hash = crypto.createHash('sha1').update(serverPath.split('?')[0]).digest('hex').slice(0, 8);
  return path.join(coversDir(), `${romId}-${hash}${ext}`);
}
