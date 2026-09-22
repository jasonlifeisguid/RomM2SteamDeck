// Download + extraction pipeline, end to end against a stub RomM client.
// Builds real archives with the bundled 7za, streams them through
// startDownload(), and checks the on-disk result + tracking record.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const path7za = require('7zip-bin').path7za;
// The bundled 7za ships without its exec bit on Linux/macOS (the packaged app
// fixes that in build/after-pack.js; run7za() also chmods at runtime).
if (process.platform !== 'win32') { try { fs.chmodSync(path7za, 0o755); } catch { /* read-only */ } }
const config = require('../dist/config.js');
const downloads = require('../dist/downloads.js');

const PLATFORM_ID = 1;
const tempRoots = [];
test.after(() => { for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true }); });

function makeTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-dl-'));
  tempRoots.push(root);
  const userData = path.join(root, 'userdata');
  const install = path.join(root, 'install');
  const loose = path.join(root, 'loose');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    baseUrl: 'http://romm.test', username: 'u', passwordEncrypted: '',
    platforms: {
      [PLATFORM_ID]: { folder: '', autoExtract: true, installPaths: [install] },
      2: { folder: loose, autoExtract: false, installPaths: [] },
    },
  }));
  config.setUserDataDirForTests(userData);
  downloads.setUserDataDirForTests(userData);
  return { root, userData, install, loose };
}

/** Create an archive from a directory tree described as { relPath: content }. */
function makeArchive(root, name, files, type) {
  const src = path.join(root, `src-${name}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(src, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const archive = path.join(root, name);
  const r = spawnSync(path7za, ['a', `-t${type}`, archive, '.'], { cwd: src, windowsHide: true });
  assert.equal(r.status, 0, `7za failed: ${r.stderr}`);
  return archive;
}

/**
 * Minimal zip writer (stored, no compression) so a test can control entry
 * names and ORDER exactly — 7za can't produce a file and a directory with the
 * same name, which is what provokes an fs error inside the parser's entry
 * handler.
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
  return file;
}

/** A RommClient stand-in that serves a local file with the given filename. */
function stubClient(file, fileName, { status = 200 } = {}) {
  return {
    openDownloadStream: async (_romId, _fsName, signal) => {
      const data = fs.readFileSync(file);
      if (signal?.aborted) throw new Error('aborted');
      return new Response(new Blob([data]), {
        status,
        headers: {
          'content-length': String(data.length),
          'content-disposition': `attachment; filename="${fileName}"`,
          etag: '"abc"',
        },
      });
    },
  };
}

async function run(client, rom, installPath = '') {
  const events = [];
  await downloads.startDownload(client, rom, installPath, (e) => events.push(e));
  return events;
}

const rom = (id, name, fsName) => ({ id, name, fsName, platformId: PLATFORM_ID, size: 0 });

test('flat zip (files at the archive root) → one folder named after the rom', async () => {
  const t = makeTemp();
  const zip = makeArchive(t.root, 'flat.zip', { 'game.exe': 'MZ', 'readme.txt': 'hi', 'data/level1.bin': 'x'.repeat(5000) }, 'zip');
  const events = await run(stubClient(zip, 'flat.zip'), rom(11, 'Cool Game: Deluxe?', 'flat.zip'));

  const last = events.at(-1);
  assert.equal(last.status, 'extracted', JSON.stringify(events.at(-1)));
  const dest = path.join(t.install, 'Cool Game Deluxe');
  assert.equal(last.path, dest);
  assert.ok(fs.existsSync(path.join(dest, 'game.exe')));
  assert.ok(fs.existsSync(path.join(dest, 'data', 'level1.bin')));
  assert.equal(fs.existsSync(path.join(t.install, 'game.exe')), false, 'nothing loose in the install root');
  assert.equal(fs.existsSync(path.join(t.install, '.r2sd-extract-11')), false, 'staging dir cleaned up');
  assert.equal(fs.existsSync(path.join(t.install, 'flat.zip')), false, 'archive removed after extraction');
  assert.equal(fs.existsSync(path.join(t.install, 'flat.zip.part')), false);

  const rec = downloads.findDownload(11);
  assert.equal(rec.filePath, dest);
});

test('zip with a single top-level folder keeps that folder name', async () => {
  const t = makeTemp();
  const zip = makeArchive(t.root, 'nested.zip', { 'MyGame/bin/run.exe': 'MZ', 'MyGame/assets/a.dat': 'd' }, 'zip');
  const events = await run(stubClient(zip, 'nested.zip'), rom(12, 'Whatever', 'nested.zip'));
  assert.equal(events.at(-1).status, 'extracted');
  const dest = path.join(t.install, 'MyGame');
  assert.equal(events.at(-1).path, dest);
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'run.exe')));
  assert.equal(downloads.findDownload(12).filePath, dest);
  assert.equal(fs.readdirSync(t.install).length, 1, 'install root holds only the game folder');
});

test('7z archive goes through the 7za fallback into the same layout', async () => {
  const t = makeTemp();
  const sz = makeArchive(t.root, 'game.7z', { 'a.exe': 'MZ', 'b.txt': 'b' }, '7z');
  const events = await run(stubClient(sz, 'game.7z'), rom(13, 'Seven', 'game.7z'));
  assert.equal(events.at(-1).status, 'extracted');
  assert.ok(events.some((e) => e.status === 'extracting'), '7za path emits extracting events');
  const dest = path.join(t.install, 'Seven');
  assert.ok(fs.existsSync(path.join(dest, 'a.exe')));
  assert.equal(fs.existsSync(path.join(t.install, '.r2sd-extract-13')), false);
});

test('re-downloading the same game replaces its folder', async () => {
  const t = makeTemp();
  const zip1 = makeArchive(t.root, 'v1.zip', { 'G/old.exe': 'MZ' }, 'zip');
  await run(stubClient(zip1, 'v1.zip'), rom(14, 'G', 'v1.zip'));
  const zip2 = makeArchive(t.root, 'v2.zip', { 'G/new.exe': 'MZ' }, 'zip');
  const events = await run(stubClient(zip2, 'v2.zip'), rom(14, 'G', 'v2.zip'));
  assert.equal(events.at(-1).status, 'extracted');
  const dest = path.join(t.install, 'G');
  assert.ok(fs.existsSync(path.join(dest, 'new.exe')));
  assert.equal(fs.existsSync(path.join(dest, 'old.exe')), false);
});

test('non-extract platform: plain download to the platform folder', async () => {
  const t = makeTemp();
  const bin = path.join(t.root, 'rom.bin');
  fs.writeFileSync(bin, Buffer.alloc(70000, 7));
  const events = await run(stubClient(bin, 'rom.bin'), { id: 21, name: 'Plain', fsName: 'rom.bin', platformId: 2, size: 0 });
  assert.equal(events.at(-1).status, 'complete');
  const dest = path.join(t.loose, 'rom.bin');
  assert.equal(events.at(-1).path, dest);
  assert.equal(fs.statSync(dest).size, 70000);
  assert.equal(downloads.findDownload(21).filePath, dest);
});

test('zip-slip entries are dropped, the rest extracts', async () => {
  const t = makeTemp();
  // Build the zip, then inject a traversal entry name by hand: 7za won't
  // create one, so patch the local file header + central directory name.
  const zip = makeArchive(t.root, 'slip.zip', { 'ok.exe': 'MZ', 'zzzzzzzzzz.txt': 'evil' }, 'zip');
  let buf = fs.readFileSync(zip);
  const bad = Buffer.from('../../oops.txt');
  const orig = Buffer.from('zzzzzzzzzz.txt');
  assert.equal(bad.length, orig.length);
  let idx = buf.indexOf(orig);
  while (idx !== -1) { bad.copy(buf, idx); idx = buf.indexOf(orig, idx + 1); }
  fs.writeFileSync(zip, buf);

  const events = await run(stubClient(zip, 'slip.zip'), rom(15, 'Slip', 'slip.zip'));
  assert.equal(events.at(-1).status, 'extracted', JSON.stringify(events.at(-1)));
  assert.ok(fs.existsSync(path.join(t.install, 'Slip', 'ok.exe')));
  assert.equal(fs.existsSync(path.join(t.root, 'oops.txt')), false);
  assert.equal(fs.existsSync(path.join(t.install, 'oops.txt')), false);
});

test('empty body is reported as an error, not retried forever', async () => {
  const t = makeTemp();
  const empty = path.join(t.root, 'empty.zip');
  fs.writeFileSync(empty, '');
  const events = await run(stubClient(empty, 'empty.zip'), rom(16, 'Empty', 'empty.zip'));
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).message, /empty file/);
  assert.equal(fs.existsSync(path.join(t.install, '.r2sd-extract-16')), false);
});

test('syncPlatform adopts folders, ignores staging dirs, and writes once', async () => {
  const t = makeTemp();
  fs.mkdirSync(path.join(t.install, 'Sonic Mania'));
  fs.mkdirSync(path.join(t.install, '.r2sd-extract-99'));
  fs.mkdirSync(path.join(t.install, 'Unrelated'));
  const res = downloads.syncPlatform(PLATFORM_ID, [
    { id: 31, name: 'Sonic Mania', fsName: 'sonic.zip' },
    { id: 32, name: 'Extract', fsName: 'r2sd-extract-99.zip' },
  ]);
  assert.deepEqual(res, { added: 1, removed: 0 });
  assert.equal(downloads.findDownload(31).filePath, path.join(t.install, 'Sonic Mania'));
  assert.equal(downloads.findDownload(32), undefined);
  // Stale record → removed on the next sync
  fs.rmSync(path.join(t.install, 'Sonic Mania'), { recursive: true });
  assert.deepEqual(downloads.syncPlatform(PLATFORM_ID, []), { added: 0, removed: 1 });
  assert.equal(downloads.findDownload(31), undefined);
});

test('fs error inside the parser entry handler does not hang or crash (PR #5 case)', async () => {
  const t = makeTemp();
  // "ok.exe" is a file, then "ok.exe/child.txt" needs "ok.exe" as a directory:
  // mkdirSync throws EEXIST from inside the extractor's 'entry' listener.
  const pad = 'x'.repeat(200000); // enough bytes after the bad entry to fill the parser's buffer
  const zip = writeZip(path.join(t.root, 'collide.zip'), [
    ['ok.exe', 'MZ'],
    ['ok.exe/child.txt', 'child'],
    ['after.bin', pad],
  ]);
  const client = stubClient(zip, 'collide.zip');
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('startDownload hung')), 20000));
  const events = await Promise.race([run(client, rom(17, 'Collide', 'collide.zip')), timeout]);
  const last = events.at(-1);
  assert.ok(['extracted', 'error'].includes(last.status), `terminal event expected, got ${JSON.stringify(last)}`);
  assert.doesNotMatch(String(last.message || ''), /EBUSY|EPERM/, 'no leaked file handles blocking cleanup');
  assert.equal(fs.existsSync(path.join(t.install, '.r2sd-extract-17')), false, 'staging dir cleaned up');
});


// ── syncPlatform: adopting from disk must not throw away user choices ──────
// The sync runs on every platform open. It used to drop any record whose
// folder it couldn't see and re-adopt a bare one, so a game's chosen
// executable (and cloud sync point, and save locations) vanished on restart.

function plantRecord(t, extra = {}) {
  const { install, userData } = t;
  const folder = path.join(install, 'Stellar Blade');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'Game.exe'), 'MZ');
  const record = {
    romId: 77, romName: 'Stellar Blade', fileName: 'Stellar Blade', filePath: folder,
    platformId: PLATFORM_ID, size: 0, downloadedAt: 111,
    defaultExe: path.join(folder, 'Game.exe'),
    cloud: { saveId: 5, contentHash: 'abc', fingerprint: 'def', syncedAt: 222 },
    savePaths: ['AppData/Local/SB'], savePathsNote: 'learned from a restore',
    syncConfigFiles: true,
    ...extra,
  };
  fs.writeFileSync(path.join(userData, 'downloads.json'), JSON.stringify([record], null, 2));
  return { folder, record };
}
const ROMS = [{ id: 77, name: 'Stellar Blade', fsName: 'Stellar Blade.zip' }];

test('sync leaves a healthy record alone', () => {
  const t = makeTemp();
  plantRecord(t);
  assert.deepEqual(downloads.syncPlatform(PLATFORM_ID, ROMS), { added: 0, removed: 0 });
  assert.ok(downloads.findDownload(77).defaultExe);
});

/** Point the platform at a second install path as well (a moved library). */
function addInstallPath(t, name) {
  const extra = path.join(t.root, name);
  fs.mkdirSync(extra, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(t.userData, 'config.json'), 'utf8'));
  cfg.platforms[PLATFORM_ID].installPaths = [t.install, extra];
  fs.writeFileSync(path.join(t.userData, 'config.json'), JSON.stringify(cfg));
  config.setUserDataDirForTests(t.userData); // drop the memoized config
  return extra;
}

test('a game whose folder moved keeps its executable, cloud sync point and save locations', () => {
  const t = makeTemp();
  const { folder } = plantRecord(t);
  // The library moved to another drive: same folder, different install path
  const moved = path.join(addInstallPath(t, 'install2'), 'Stellar Blade');
  fs.renameSync(folder, moved);

  const changes = downloads.syncPlatform(PLATFORM_ID, ROMS);
  assert.deepEqual(changes, { added: 1, removed: 1 }, 'record is re-adopted at the new path');
  const rec = downloads.findDownload(77);
  assert.equal(rec.filePath, moved);
  assert.equal(rec.defaultExe, path.join(moved, 'Game.exe'), 'the chosen exe follows the game');
  assert.deepEqual(rec.cloud, { saveId: 5, contentHash: 'abc', fingerprint: 'def', syncedAt: 222 });
  assert.deepEqual(rec.savePaths, ['AppData/Local/SB']);
  assert.equal(rec.savePathsNote, 'learned from a restore');
  assert.equal(rec.syncConfigFiles, true);
  assert.equal(rec.downloadedAt, 111, 'still the date it was first installed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.userData, 'downloads.json'), 'utf8')).length, 1);
});

test('a drive that is not mounted is not treated as a deleted game', () => {
  const t = makeTemp();
  // Same shape as a NAS share or external drive that is not up yet: the
  // record's whole parent directory is unreachable.
  plantRecord(t, { filePath: path.join(t.root, 'not-mounted', 'Stellar Blade') });
  assert.deepEqual(downloads.syncPlatform(PLATFORM_ID, ROMS), { added: 0, removed: 0 });
  const rec = downloads.findDownload(77);
  assert.ok(rec, 'record survived');
  assert.ok(rec.defaultExe, 'and so did the chosen exe');
});

test('a genuinely deleted game is still forgotten', () => {
  const t = makeTemp();
  const { folder } = plantRecord(t);
  fs.rmSync(folder, { recursive: true, force: true });   // install path still there, game gone
  assert.deepEqual(downloads.syncPlatform(PLATFORM_ID, ROMS), { added: 0, removed: 1 });
  assert.equal(downloads.findDownload(77), undefined);
});

test('an exe chosen outside the game folder is dropped rather than remapped wrongly', () => {
  const t = makeTemp();
  const outside = path.join(t.root, 'elsewhere.exe');
  fs.writeFileSync(outside, 'MZ');
  const { folder } = plantRecord(t, { defaultExe: outside });
  fs.renameSync(folder, path.join(addInstallPath(t, 'install2'), 'Stellar Blade'));
  downloads.syncPlatform(PLATFORM_ID, ROMS);
  // It still exists on disk, so it stays as-is
  assert.equal(downloads.findDownload(77).defaultExe, outside);

  // …but one that is simply gone doesn't come back as a broken path
  const t2 = makeTemp();
  const { folder: f2 } = plantRecord(t2, { defaultExe: path.join(t2.root, 'vanished.exe') });
  fs.renameSync(f2, path.join(addInstallPath(t2, 'install2'), 'Stellar Blade'));
  downloads.syncPlatform(PLATFORM_ID, ROMS);
  assert.equal(downloads.findDownload(77).defaultExe, undefined);
});
