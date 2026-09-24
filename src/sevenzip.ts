/**
 * Where the bundled 7-Zip is.
 *
 * R2SD ships the official 7-Zip binaries (vendor/7zip, see its README for
 * provenance and hashes) instead of the `7zip-bin` npm package, which was
 * stuck on 7-Zip 21.07 from 2021 — several security fixes behind. Each
 * platform build carries only its own binary, in resources/7zip/.
 *
 * No electron imports: process.resourcesPath is set by Electron at runtime and
 * simply absent under plain Node (tests, running from source).
 */
import * as fs from 'fs';
import * as path from 'path';

const EXE = process.platform === 'win32' ? '7za.exe' : '7zz';
const VENDOR_DIR = process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? 'mac' : 'linux-x64';

let memo: string | null = null;

/** Absolute path of the 7-Zip command-line binary for this platform. */
export function sevenZipPath(): string {
  if (memo) return memo;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resources ? path.join(resources, '7zip', EXE) : '',                   // packaged app
    path.join(__dirname, '..', 'vendor', '7zip', VENDOR_DIR, EXE),        // from source / tests
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
  // Git on Windows and some unpackers drop the exec bit; best effort (a
  // read-only AppImage mount already has it from the build).
  if (process.platform !== 'win32') { try { fs.chmodSync(found, 0o755); } catch { /* read-only or already set */ } }
  memo = found;
  return found;
}
