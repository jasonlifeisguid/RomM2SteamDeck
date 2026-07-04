#!/usr/bin/env node
/*
 * add-r2sd-to-steam.js — add the RomM2SteamDeck AppImage to Steam as a
 * non-Steam game so it shows up in your Library and in Game Mode.
 *
 * Self-contained: no npm dependencies, runs on any Node the Deck has.
 * It reuses the exact byte-safe shortcuts.vdf logic from the app (src/steam.ts):
 *   - refuses to write while Steam is running,
 *   - re-serializes the existing file and aborts unless it matches byte-for-byte
 *     (so a format it can't reproduce can never be corrupted),
 *   - backs up shortcuts.vdf before writing,
 *   - appends to the parsed structure (never regenerates from scratch),
 *   - writes atomically (temp + rename).
 *
 * Usage:
 *   node add-r2sd-to-steam.js [/path/to/RomM2SteamDeck.AppImage] [--name "Display Name"] [--dry-run]
 * With no path, it auto-detects the AppImage in the usual folders.
 * --dry-run runs every check (including the byte-exact safety gate) and reports
 * what it WOULD do, without touching shortcuts.vdf.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// ── Binary VDF parse / serialize (mirrors src/steam.ts) ──────────────────
function parseVdf(buf) {
  let off = 0;
  const readCStr = () => {
    const start = off;
    while (off < buf.length && buf[off] !== 0x00) off++;
    const s = buf.slice(start, off).toString('utf8');
    off++;
    return s;
  };
  const readMap = () => {
    const obj = {};
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

function serializeVdf(map) {
  const parts = [];
  const key = (k) => { parts.push(Buffer.from(k, 'utf8')); parts.push(Buffer.from([0x00])); };
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

function crc32(str) {
  let crc = ~0;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}
function shortcutAppId(exe, appName) { return (crc32(exe + appName) | 0x80000000) | 0; }

// ── Steam discovery (Linux/SteamOS; falls back for mac) ──────────────────
function findSteamRoot() {
  const candidates = [
    path.join(os.homedir(), '.steam', 'steam'),
    path.join(os.homedir(), '.local', 'share', 'Steam'),
    path.join(os.homedir(), '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Steam'), // macOS
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'userdata'))) || null;
}

function findSteamUsers(root) {
  if (!root) return [];
  const userdata = path.join(root, 'userdata');
  if (!fs.existsSync(userdata)) return [];
  const users = [];
  for (const d of fs.readdirSync(userdata)) {
    if (d === '0' || d === 'anonymous') continue;
    const configDir = path.join(userdata, d, 'config');
    if (!fs.existsSync(configDir)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(configDir).mtimeMs; } catch { /* ignore */ }
    users.push({ user: d, shortcutsPath: path.join(configDir, 'shortcuts.vdf'), mtime });
  }
  return users.sort((a, b) => b.mtime - a.mtime);
}

function isSteamRunning() {
  try {
    const out = execSync('pgrep -x steam steamwebhelper 2>/dev/null || pgrep -i steam 2>/dev/null || true',
      { encoding: 'utf8', shell: '/bin/sh' });
    return out.trim().length > 0;
  } catch { return false; }
}

function buildShortcutEntry(exePath, appName, iconPath) {
  const quotedExe = `"${exePath}"`;
  const dir = path.dirname(exePath);
  return {
    appid: shortcutAppId(quotedExe, appName),
    AppName: appName,
    Exe: quotedExe,
    StartDir: dir.endsWith(path.sep) ? dir : dir + path.sep,
    icon: iconPath || '',
    ShortcutPath: '',
    LaunchOptions: '',
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: 0, // overlay races Electron's startup fork → Game Mode deadlock
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: '',
    DevkitOverrideAppID: 0,
    LastPlayTime: 0,
    FlatpakAppID: '',
    sortas: '',
    tags: {},
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────
function autoDetectAppImage() {
  const dirs = [
    path.join(os.homedir(), 'Applications'),
    os.homedir(),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
  ];
  const hits = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/^RomM2SteamDeck.*\.AppImage$/i.test(f)) hits.push(path.join(d, f));
    }
  }
  // Prefer the newest by mtime
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// Best-effort: pull the app icon out of the AppImage so Steam shows it.
function extractIcon(appImage) {
  try {
    const destDir = path.join(os.homedir(), '.local', 'share', 'RomM2SteamDeck');
    fs.mkdirSync(destDir, { recursive: true });
    const iconOut = path.join(destDir, 'icon.png');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-icon-'));
    execSync(`"${appImage}" --appimage-extract .DirIcon`, { cwd: tmp, stdio: 'ignore' });
    let src = path.join(tmp, 'squashfs-root', '.DirIcon');
    // .DirIcon is often a symlink to the real png inside the squashfs; resolve it.
    if (fs.existsSync(src) && fs.lstatSync(src).isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      src = path.isAbsolute(target) ? target : path.join(tmp, 'squashfs-root', target);
    }
    if (fs.existsSync(src)) fs.copyFileSync(src, iconOut);
    fs.rmSync(path.join(tmp, 'squashfs-root'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    return fs.existsSync(iconOut) ? iconOut : '';
  } catch { return ''; }
}

// Add to a RUNNING Steam via the steam:// protocol (Valve's Dolphin method).
// Lets Steam itself write the shortcut, so it's safe while Steam is open — the
// only way to add in Game Mode. Tradeoff: Steam names the entry after the file
// (rename/art in Steam afterwards). Returns { ok, method } or { ok:false,error }.
function commandPath(cmd) {
  try {
    const out = execSync(`command -v ${cmd} 2>/dev/null`, { encoding: 'utf8', shell: '/bin/sh' }).trim();
    return out || null;
  } catch { return null; }
}
function addLive(appImage) {
  try { fs.chmodSync(appImage, 0o755); } catch { /* best effort */ }
  const helper = commandPath('steamos-add-to-steam');
  try {
    if (helper) {
      execFileSync(helper, [appImage], { stdio: 'pipe', timeout: 15000 });
      return { ok: true, method: 'steamos-add-to-steam' };
    }
    const steamBin = commandPath('steam');
    if (!steamBin) return { ok: false, error: 'Steam is running but neither steamos-add-to-steam nor the steam command was found.' };
    try { fs.writeFileSync('/tmp/addnonsteamgamefile', ''); } catch { /* marker best-effort */ }
    execFileSync(steamBin, [`steam://addnonsteamgame/${encodeURIComponent(appImage)}`], { stdio: 'pipe', timeout: 15000 });
    return { ok: true, method: 'steam-url' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  let appImage = null;
  let name = 'RomM2SteamDeck';
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') { name = args[++i] || name; }
    else if (args[i] === '--dry-run' || args[i] === '-n') { dryRun = true; }
    else if (!appImage) { appImage = args[i]; }
  }
  if (!appImage) appImage = autoDetectAppImage();

  if (!appImage) {
    console.error('✗ Could not find a RomM2SteamDeck AppImage. Pass its path:\n' +
      '    node add-r2sd-to-steam.js /path/to/RomM2SteamDeck.AppImage');
    process.exit(1);
  }
  appImage = path.resolve(appImage);
  if (!fs.existsSync(appImage)) { console.error(`✗ File not found: ${appImage}`); process.exit(1); }

  // Make sure it's executable (AppImages must have the exec bit).
  try { fs.chmodSync(appImage, 0o755); } catch { /* best effort */ }

  const steamRunning = isSteamRunning();
  const liveCapable = process.platform === 'linux' &&
    (commandPath('steamos-add-to-steam') || commandPath('steam'));

  // Steam running + we can talk to it (SteamOS/Linux): add live via steam://,
  // which works even in Game Mode. No file write, so skip the vdf path entirely.
  if (steamRunning && liveCapable && !dryRun) {
    const r = addLive(appImage);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(1); }
    console.log(`✓ Added "${path.basename(appImage)}" to the running Steam client (${r.method}).`);
    console.log('    It will appear in your Library shortly (Steam names it after the file —');
    console.log('    rename it and add artwork in Steam, e.g. via Decky + SteamGridDB).');
    process.exit(0);
  }

  if (steamRunning) {
    const msg = 'Steam is running. Fully exit Steam first (in Game Mode: hold the\n' +
      '  STEAM button → Power → Switch to Desktop, or on desktop right-click the\n' +
      '  tray icon → Exit), then run this again. Steam rewrites shortcuts on exit.';
    if (!dryRun) { console.error('✗ ' + msg); process.exit(1); }
    // Dry run only reads, so continue past this to exercise the safety gate,
    // but make the blocker clear.
    console.log('⚠ ' + msg + '\n  (dry run continues read-only to verify the safety gate)\n');
  }

  const root = findSteamRoot();
  const users = findSteamUsers(root);
  if (!users.length) {
    console.error('✗ No Steam user profile found. Is Steam installed and signed in at least once?');
    process.exit(1);
  }
  const target = users[0];

  let vdf;
  let original = null;
  if (fs.existsSync(target.shortcutsPath)) {
    original = fs.readFileSync(target.shortcutsPath);
    vdf = parseVdf(original);
    if (!serializeVdf(vdf).equals(original)) {
      console.error('✗ Aborted for safety: could not reproduce the existing shortcuts.vdf\n' +
        '  byte-for-byte, so writing might corrupt it. No changes made.');
      process.exit(1);
    }
  } else {
    vdf = { shortcuts: {} };
  }

  const shortcuts = vdf.shortcuts || (vdf.shortcuts = {});
  const quotedExe = `"${appImage}"`;
  for (const entry of Object.values(shortcuts)) {
    if (entry && typeof entry === 'object' && entry.Exe === quotedExe) {
      console.log(`✓ Already added as "${entry.AppName}" (user ${target.user}). Nothing to do.`);
      console.log('  Restart Steam to see it if it isn\'t in your Library yet.');
      process.exit(0);
    }
  }

  if (dryRun) {
    console.log('✓ Dry run — all checks passed, no changes written.');
    console.log(`    Would add : "${name}"`);
    console.log(`    AppImage  : ${appImage}`);
    console.log(`    Steam user: ${target.user}`);
    console.log(`    shortcuts.vdf ${original ? 'exists and reproduced byte-for-byte (safe to write)' : 'does not exist yet (a new one would be created)'}`);
    console.log(`    existing entries: ${Object.keys(shortcuts).length}`);
    process.exit(0);
  }

  const icon = extractIcon(appImage);
  const entry = buildShortcutEntry(appImage, name, icon);

  // Back up, then atomic write.
  let backupPath;
  if (original) {
    backupPath = `${target.shortcutsPath}.bak-${Date.now()}`;
    fs.writeFileSync(backupPath, original);
  }
  shortcuts[String(Object.keys(shortcuts).length)] = entry;
  const outBuf = serializeVdf(vdf);
  const tmp = `${target.shortcutsPath}.tmp`;
  fs.writeFileSync(tmp, outBuf);
  fs.renameSync(tmp, target.shortcutsPath);

  console.log(`✓ Added "${name}" as a non-Steam game.`);
  console.log(`    AppImage : ${appImage}`);
  console.log(`    Steam user: ${target.user}`);
  if (icon) console.log(`    Icon      : ${icon}`);
  if (backupPath) console.log(`    Backup    : ${backupPath}`);
  console.log('\n  Start Steam (or switch back to Game Mode). RomM2SteamDeck will be in your\n' +
    '  Library under "Non-Steam". In Game Mode you may want to set a controller layout.');
}

main();
