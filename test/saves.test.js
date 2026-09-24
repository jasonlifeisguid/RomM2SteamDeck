// Save backup/restore against a fake prefix tree, using the bundled 7za.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { backupSaves, restoreSaves, backupFileName, profileDir } = require('../dist/saves.js');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Build a Proton-style prefix with a steamuser profile and some save data. */
function makePrefix(name, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `r2sd-pfx-${name}-`));
  roots.push(root);
  const profile = path.join(root, 'drive_c', 'users', 'steamuser');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(profile, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, profile };
}

test('backupFileName is filename-safe and dated', () => {
  assert.equal(backupFileName('The Simpsons: Hit & Run', new Date(2026, 8, 15)), 'The Simpsons Hit & Run saves 2026-09-15.zip');
  assert.equal(backupFileName('???', new Date(2026, 0, 1)), 'game saves 2026-01-01.zip');
});

test('profileDir finds steamuser, null without a profile', () => {
  const { root, profile } = makePrefix('p', { 'Documents/x.txt': 'x' });
  assert.equal(profileDir(root), profile);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-pfx-empty-')); roots.push(empty);
  assert.equal(profileDir(empty), null);
});

test('backup zips only save folders, excludes Temp/Microsoft; restore into another prefix', async () => {
  const src = makePrefix('src', {
    'Documents/My Game/save1.dat': 'SAVE1',
    'Saved Games/Other/slot.sav': 'SLOT',
    'AppData/Roaming/Goldberg UplayEmu Saves/123/config.ini': 'GOLD',
    'AppData/Local/Ubisoft/x.cfg': 'UBI',
    'AppData/Local/Temp/junk.tmp': 'JUNK',
    'AppData/Local/Microsoft/Windows/cache.bin': 'MSJUNK',
    'AppData/Roaming/Microsoft/Windows/Themes/t.theme': 'MSJUNK',
    'Desktop/shortcut.lnk': 'NOT A SAVE',
    'Downloads/big.iso': 'NOT A SAVE',
  });
  // Proton's legacy alias symlink must not be archived a second time
  if (process.platform !== 'win32') fs.symlinkSync('./Documents', path.join(src.profile, 'My Documents'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-bk-')); roots.push(out);
  const res = await backupSaves(src.root, out, 'My Game');
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(res.file));
  // Folders are now reported at the top level of the zip (the .cfg under
  // AppData/Local is config and excluded; Goldberg's config.ini too).
  assert.deepEqual(res.folders, ['Documents', 'Saved Games']);
  assert.equal(res.excludedConfig, 2);

  // Restore into a fresh prefix (simulates: backed up on the Deck, restored on Omarchy)
  const dst = makePrefix('dst', { 'Documents/existing.txt': 'KEEP', 'Documents/My Game/save1.dat': 'OLD' });
  const r = await restoreSaves(dst.root, res.file);
  assert.equal(r.ok, true, r.error);
  const read = (rel) => fs.readFileSync(path.join(dst.profile, rel), 'utf8');
  assert.equal(read('Documents/My Game/save1.dat'), 'SAVE1', 'overwritten by the backup');
  assert.equal(read('Documents/existing.txt'), 'KEEP', 'unrelated files untouched');
  assert.equal(read('Saved Games/Other/slot.sav'), 'SLOT');
  assert.equal(fs.existsSync(path.join(dst.profile, 'AppData/Roaming/Goldberg UplayEmu Saves/123/config.ini')), false, '.ini is treated as config by default');
  assert.equal(fs.existsSync(path.join(dst.profile, 'AppData/Local/Ubisoft/x.cfg')), false, '.cfg is treated as config by default');
  for (const junk of ['AppData/Local/Temp/junk.tmp', 'AppData/Local/Microsoft/Windows/cache.bin', 'AppData/Roaming/Microsoft/Windows/Themes/t.theme', 'Desktop/shortcut.lnk', 'Downloads/big.iso']) {
    assert.equal(fs.existsSync(path.join(dst.profile, junk)), false, `${junk} must not be in the backup`);
  }
});

test('restore refuses a zip that is not a save backup', async () => {
  const dst = makePrefix('dst2', { 'Documents/a.txt': 'a' });
  const { spawnSync } = require('child_process');
  const path7za = require('../dist/sevenzip.js').sevenZipPath();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-badzip-')); roots.push(stage);
  fs.mkdirSync(path.join(stage, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'windows', 'evil.dll'), 'x');
  const zip = path.join(stage, 'bad.zip');
  assert.equal(spawnSync(path7za, ['a', '-tzip', zip, 'windows'], { cwd: stage }).status, 0);
  const r = await restoreSaves(dst.root, zip);
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected top-level entries: windows/);
  assert.equal(fs.existsSync(path.join(dst.profile, 'windows', 'evil.dll')), false);
});

test('backup on a prefix with no profile explains itself', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-pfx-none-')); roots.push(empty);
  const r = await backupSaves(empty, empty, 'x');
  assert.equal(r.ok, false); assert.match(r.error, /run the game once/);
});
