/**
 * Add non-Steam games by writing Steam's shortcuts.vdf (binary VDF).
 *
 * SAFETY MODEL (this is the feature that historically wiped libraries):
 *  1. Refuse to write while Steam is running (Steam rewrites the file on exit
 *     and would clobber our change — or worse).
 *  2. Before writing, re-serialize the EXISTING file and require it to match
 *     the original bytes exactly. If our serializer can't reproduce this
 *     Steam version's format perfectly, we abort — never corrupt.
 *  3. Back up the file before writing.
 *  4. Append to the parsed structure; never regenerate from scratch.
 *  5. Write atomically (temp + rename).
 *
 * No electron imports — unit-testable standalone.
 */
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type VdfValue = string | number | VdfMap;
interface VdfMap { [key: string]: VdfValue; }

// ── Binary VDF parse / serialize ────────────────────────────────────────

export function parseVdf(buf: Buffer): VdfMap {
  let off = 0;
  const readCStr = (): string => {
    const start = off;
    while (off < buf.length && buf[off] !== 0x00) off++;
    const s = buf.slice(start, off).toString('utf8');
    off++; // skip null terminator
    return s;
  };
  const readMap = (): VdfMap => {
    const obj: VdfMap = {};
    while (off < buf.length) {
      const type = buf[off++];
      if (type === 0x08) return obj;
      const key = readCStr();
      if (type === 0x00) obj[key] = readMap();
      else if (type === 0x01) obj[key] = readCStr();
      else if (type === 0x02) { obj[key] = buf.readInt32LE(off); off += 4; }
      else throw new Error(`Unsupported VDF type 0x${type.toString(16)} at offset ${off - 1}`);
    }
    throw new Error('Unexpected end of VDF (missing 0x08 terminator)');
  };
  return readMap();
}

export function serializeVdf(map: VdfMap): Buffer {
  const parts: Buffer[] = [];
  const key = (k: string) => { parts.push(Buffer.from(k, 'utf8')); parts.push(Buffer.from([0x00])); };
  for (const [k, v] of Object.entries(map)) {
    if (v !== null && typeof v === 'object') {
      parts.push(Buffer.from([0x00])); key(k); parts.push(serializeVdf(v));
    } else if (typeof v === 'string') {
      parts.push(Buffer.from([0x01])); key(k);
      parts.push(Buffer.from(v, 'utf8')); parts.push(Buffer.from([0x00]));
    } else if (typeof v === 'number') {
      parts.push(Buffer.from([0x02])); key(k);
      const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); parts.push(b);
    }
  }
  parts.push(Buffer.from([0x08]));
  return Buffer.concat(parts);
}

// Steam's shortcut appid: crc32(exe + appname) with the high bit set.
function crc32(str: string): number {
  let crc = ~0;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

export function shortcutAppId(exe: string, appName: string): number {
  return (crc32(exe + appName) | 0x80000000) | 0; // signed int32
}

// ── Steam install discovery ─────────────────────────────────────────────

export function findSteamRoot(): string | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Steam'),
    ];
    for (const c of candidates) if (fs.existsSync(path.join(c, 'steam.exe'))) return c;
    try {
      const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', { encoding: 'utf8' });
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
      if (m) return path.normalize(m[1].trim());
    } catch { /* not in registry */ }
    return null;
  }
  if (process.platform === 'linux') {
    const candidates = [
      path.join(os.homedir(), '.steam', 'steam'),
      path.join(os.homedir(), '.local', 'share', 'Steam'),
      path.join(os.homedir(), '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    ];
    return candidates.find((c) => fs.existsSync(path.join(c, 'userdata'))) || null;
  }
  if (process.platform === 'darwin') {
    const p = path.join(os.homedir(), 'Library', 'Application Support', 'Steam');
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

interface SteamUser { user: string; shortcutsPath: string; configDir: string; mtime: number; }

export function findSteamUsers(root = findSteamRoot()): SteamUser[] {
  if (!root) return [];
  const userdata = path.join(root, 'userdata');
  if (!fs.existsSync(userdata)) return [];
  const users: SteamUser[] = [];
  for (const d of fs.readdirSync(userdata)) {
    if (d === '0' || d === 'anonymous') continue;
    const configDir = path.join(userdata, d, 'config');
    if (!fs.existsSync(configDir)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(configDir).mtimeMs; } catch { /* ignore */ }
    users.push({ user: d, shortcutsPath: path.join(configDir, 'shortcuts.vdf'), configDir, mtime });
  }
  // Most recently active user first
  return users.sort((a, b) => b.mtime - a.mtime);
}

export function isSteamRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', { encoding: 'utf8' });
      return /steam\.exe/i.test(out);
    }
    const out = execSync('pgrep -x steam steamwebhelper 2>/dev/null || pgrep -i steam 2>/dev/null || true', {
      encoding: 'utf8', shell: '/bin/sh',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Add non-Steam game ──────────────────────────────────────────────────

export interface AddResult {
  ok: boolean;
  error?: string;
  appId?: number;
  appName?: string;
  alreadyPresent?: boolean;
  backupPath?: string;
  targetUser?: string;
  /** True when the running Steam client did the write (steam:// path), so no restart is needed. */
  live?: boolean;
  /** True when an existing shortcut was updated (e.g. Steam Overlay turned off) rather than added. */
  repaired?: boolean;
  method?: 'file' | 'steamos-add-to-steam' | 'steam-url';
}

// Clears the Steam Overlay's LD_PRELOAD for one shortcut. The overlay
// (gameoverlayrenderer.so) injects threads before Electron starts and Electron's
// startup fork() races them — intermittently deadlocking / adding a ~45s delay
// under gamescope. Setting AllowOverlay=0 alone does NOT stop the preload for a
// non-Steam game; stripping LD_PRELOAD via launch options does. Verified on real
// hardware. Only applied to R2SD (an Electron app), never to game shortcuts.
export const OVERLAY_STRIP_LAUNCH_OPTS = 'env LD_PRELOAD= %command%';

export function buildShortcutEntry(exePath: string, appName: string, opts: { startDir?: string; tags?: string[]; overlayOff?: boolean } = {}): VdfMap {
  const quotedExe = `"${exePath}"`;
  const dir = opts.startDir || path.dirname(exePath);
  const tagMap: VdfMap = {};
  (opts.tags || []).forEach((t, i) => { tagMap[String(i)] = t; });
  // Field order mirrors what Steam itself writes (see a real entry).
  return {
    appid: shortcutAppId(quotedExe, appName),
    AppName: appName,
    Exe: quotedExe,
    StartDir: dir.endsWith(path.sep) ? dir : dir + path.sep,
    icon: '',
    ShortcutPath: '',
    LaunchOptions: opts.overlayOff ? OVERLAY_STRIP_LAUNCH_OPTS : '',
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: opts.overlayOff ? 0 : 1,
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: '',
    DevkitOverrideAppID: 0,
    LastPlayTime: 0,
    FlatpakAppID: '',
    sortas: '',
    tags: tagMap,
  };
}

export function addNonSteamGame(exePath: string, appName: string, opts: { startDir?: string; tags?: string[] } = {}): AddResult {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Executable not found' };
  if (isSteamRunning()) {
    return { ok: false, error: 'Steam is running. Fully exit Steam (right-click the tray icon → Exit), then try again — Steam overwrites shortcuts on exit.' };
  }

  const users = findSteamUsers();
  if (!users.length) return { ok: false, error: 'No Steam user profile found. Is Steam installed and have you signed in at least once?' };
  const target = users[0]; // most recently active

  try {
    // Load existing (or start a fresh, empty shortcuts map)
    let root: VdfMap;
    let original: Buffer | null = null;
    if (fs.existsSync(target.shortcutsPath)) {
      original = fs.readFileSync(target.shortcutsPath);
      root = parseVdf(original);

      // SAFETY GATE: our serializer must reproduce the existing file exactly.
      const reserialized = serializeVdf(root);
      if (!reserialized.equals(original)) {
        return {
          ok: false,
          error: 'Aborted for safety: could not reproduce the existing shortcuts.vdf byte-for-byte, so writing might corrupt it. No changes made.',
        };
      }
    } else {
      root = { shortcuts: {} };
    }

    const shortcuts = (root.shortcuts as VdfMap) || (root.shortcuts = {} as VdfMap);
    const quotedExe = `"${exePath}"`;
    const isR2SD = /RomM2SteamDeck[^"]*\.AppImage/i.test(exePath);

    // Repair every existing R2SD (Electron) shortcut: overlay off AND LD_PRELOAD
    // stripped via launch options (the flag alone doesn't stop the preload). This
    // races Electron's startup fork and slows/deadlocks Game Mode. Also fixes
    // duplicate/older entries added earlier via the live path. Game shortcuts are
    // left alone (they want their overlay).
    let exactExists = false;
    let changed = false;
    for (const entry of Object.values(shortcuts)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as VdfMap;
      const exe = typeof e.Exe === 'string' ? e.Exe : '';
      if (e.Exe === quotedExe) exactExists = true;
      const isR2SDEntry = e.Exe === quotedExe ? isR2SD : /RomM2SteamDeck[^"]*\.AppImage/i.test(exe);
      if (isR2SDEntry) {
        if (e.AllowOverlay !== 0) { e.AllowOverlay = 0; changed = true; }
        if (e.LaunchOptions !== OVERLAY_STRIP_LAUNCH_OPTS) { e.LaunchOptions = OVERLAY_STRIP_LAUNCH_OPTS; changed = true; }
      }
    }

    // Nothing to do: it's already present and overlay is already off.
    if (exactExists && !changed) {
      return { ok: true, alreadyPresent: true, appName, targetUser: target.user };
    }

    // Back up before writing
    let backupPath: string | undefined;
    if (original) {
      backupPath = `${target.shortcutsPath}.bak-${Date.now()}`;
      fs.writeFileSync(backupPath, original);
    }

    // Add the entry only if it's not already there (otherwise we just repaired it).
    let appId = 0;
    if (!exactExists) {
      const nextIndex = Object.keys(shortcuts).length;
      const entry = buildShortcutEntry(exePath, appName, { startDir: opts.startDir, tags: opts.tags, overlayOff: isR2SD });
      shortcuts[String(nextIndex)] = entry;
      appId = entry.appid as number;
    }

    // Atomic write
    const out = serializeVdf(root);
    const tmp = `${target.shortcutsPath}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, target.shortcutsPath);

    return { ok: true, appId, appName, backupPath, targetUser: target.user, method: 'file', repaired: exactExists && changed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Add to a RUNNING Steam (SteamOS / Linux) ─────────────────────────────
//
// This is how Valve's own Dolphin "Add to Steam" context menu works, and it's
// the only safe way to add a shortcut while Steam is running: don't touch
// shortcuts.vdf at all — fire a steam:// URL at the live client and let STEAM
// write the file (it owns it in memory and rewrites it on exit, so any file we
// wrote underneath would be clobbered or corrupt the user's other shortcuts).
//
// Valve's chain is: Dolphin service menu → /usr/bin/steamos-add-to-steam →
//   steam "steam://addnonsteamgame/<url-encoded-abs-path>"
// with a touch of /tmp/addnonsteamgamefile as a marker that tells the client to
// add directly instead of opening the interactive "browse for a game" dialog.
//
// Tradeoff vs the file method: no control over the display name / icon / tags —
// Steam names the entry after the file. Artwork/renaming is done in Steam
// afterwards (e.g. Decky + SteamGridDB).

function commandPath(cmd: string): string | null {
  try {
    const out = execSync(`command -v ${cmd} 2>/dev/null`, { encoding: 'utf8', shell: '/bin/sh' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Can we add to a running Steam on this box? (Linux with Steam's helper or the steam binary.) */
export function canAddLive(): boolean {
  if (process.platform !== 'linux') return false;
  return commandPath('steamos-add-to-steam') !== null || commandPath('steam') !== null;
}

export function addNonSteamGameLive(exePath: string): AddResult {
  if (process.platform !== 'linux') return { ok: false, error: 'Live add is only supported on SteamOS / Linux.' };
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Executable not found' };
  try { fs.chmodSync(exePath, 0o755); } catch { /* best effort — AppImages/binaries must be executable */ }

  // Best-effort read-only dedup: the live protocol has no "already added" check,
  // so a repeated click would create a duplicate. Reading shortcuts.vdf while
  // Steam runs is safe (we never write it here). This catches cross-session
  // dupes; a same-session re-add that Steam hasn't flushed yet may still slip
  // through, which matches Valve's own menu.
  try {
    const quoted = `"${exePath}"`;
    for (const u of findSteamUsers()) {
      if (!fs.existsSync(u.shortcutsPath)) continue;
      const existing = parseVdf(fs.readFileSync(u.shortcutsPath));
      const sc = existing.shortcuts as VdfMap | undefined;
      if (!sc) continue;
      for (const e of Object.values(sc)) {
        if (e && typeof e === 'object' && (e as VdfMap).Exe === quoted) {
          return { ok: true, alreadyPresent: true, live: true, targetUser: u.user };
        }
      }
    }
  } catch { /* unreadable/odd format — just proceed to add */ }

  // Prefer Valve's own helper: it handles mime detection, exact URL encoding,
  // and the /tmp marker, so we match the Dolphin context menu byte-for-byte.
  const helper = commandPath('steamos-add-to-steam');
  try {
    if (helper) {
      // No -ui: that flag routes errors to kdialog; we want them on stderr.
      execFileSync(helper, [exePath], { stdio: 'pipe', timeout: 15000 });
      return { ok: true, live: true, method: 'steamos-add-to-steam' };
    }
    // Fallback (non-SteamOS Linux with Steam installed): emit the URL ourselves.
    const steamBin = commandPath('steam');
    if (!steamBin) return { ok: false, error: 'Steam is running but neither steamos-add-to-steam nor the steam command was found.' };
    try { fs.writeFileSync('/tmp/addnonsteamgamefile', ''); } catch { /* marker is best-effort */ }
    const url = `steam://addnonsteamgame/${encodeURIComponent(exePath)}`;
    execFileSync(steamBin, [url], { stdio: 'pipe', timeout: 15000 });
    return { ok: true, live: true, method: 'steam-url' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Add a non-Steam game the best way for the current state:
 *  - Linux + Steam running → hand it to the live client (works in Game Mode).
 *  - otherwise → the byte-safe shortcuts.vdf write (nicer: sets name/icon/tags,
 *    but needs Steam closed).
 */
export function addNonSteamGameSmart(exePath: string, appName: string, opts: { startDir?: string; tags?: string[] } = {}): AddResult {
  if (process.platform === 'linux' && isSteamRunning() && canAddLive()) {
    return addNonSteamGameLive(exePath);
  }
  return addNonSteamGame(exePath, appName, opts);
}
