// Save rules (config vs progress), listing/fingerprint, and the cloud sync
// state machine with a stub RomM client. A live round trip against the real
// server runs only when R2SD_LIVE_ROMM=user:pass is set.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const saves = require('../dist/saves.js');
const cloud = require('../dist/cloudsaves.js');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** A Stellar-Blade-shaped Unreal prefix: settings in Saved/Config, progress in Saved/SaveGames. */
function unrealPrefix(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-ue-')); roots.push(root);
  const profile = path.join(root, 'drive_c', 'users', 'steamuser');
  const files = {
    'AppData/Local/SB/Saved/Config/WindowsNoEditor/GameUserSettings.ini': '[/Script/Engine.GameUserSettings]\nResolutionSizeX=3440\n',
    'AppData/Local/SB/Saved/Config/WindowsNoEditor/Engine.ini': '[Core.System]\n',
    'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav': 'SAVE',
    'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSetting.sav': 'SETTINGSAV',
    'Documents/My Games/Starfield/StarfieldCustom.ini': '[Display]\n',
    'Documents/My Games/Starfield/Saves/Save1.sfs': 'SFS',
    'AppData/Roaming/Goldberg UplayEmu Saves/1/config.dat': 'D',
    'AppData/Local/Temp/x.tmp': 'T',
    'AppData/Local/Microsoft/Windows/y.bin': 'M',
    ...extra,
  };
  for (const [rel, c] of Object.entries(files)) { const f = path.join(profile, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
  return { root, profile };
}

test('globToRegExp: bare patterns match the file name anywhere; path patterns span folders with **', () => {
  const re = saves.globToRegExp;
  assert.ok(re('*.ini').test('AppData/Local/SB/Saved/Config/GameUserSettings.ini'));
  assert.ok(re('*.INI').test('a/b.ini'), 'case-insensitive');
  assert.ok(!re('*.ini').test('a/b.ini.bak'));
  assert.ok(re('**/Saved/Config/**').test('AppData/Local/SB/Saved/Config/WindowsNoEditor/Engine.ini'));
  assert.ok(!re('**/Saved/Config/**').test('AppData/Local/SB/Saved/SaveGames/x.sav'));
  assert.ok(re('AppData/Local/Temp/**').test('AppData/Local/Temp/a/b.tmp'));
  assert.ok(!re('AppData/Local/Temp/**').test('Documents/AppData/Local/Temp/x'), 'anchored at the root');
});

test('listSaveFiles: Unreal Config + .ini excluded as config, SaveGames included, junk skipped', () => {
  const { root } = unrealPrefix();
  const l = saves.listSaveFiles(root);
  const inc = l.included.map((f) => f.rel);
  assert.deepEqual(inc, [
    'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav',
    'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSetting.sav',
    'AppData/Roaming/Goldberg UplayEmu Saves/1/config.dat',
    'Documents/My Games/Starfield/Saves/Save1.sfs',
  ]);
  const cfg = l.excluded.filter((e) => e.reason === 'config').map((e) => [e.rel, e.pattern]);
  assert.deepEqual(cfg, [
    ['AppData/Local/SB/Saved/Config/WindowsNoEditor/Engine.ini', '**/Saved/Config/**'],
    ['AppData/Local/SB/Saved/Config/WindowsNoEditor/GameUserSettings.ini', '**/Saved/Config/**'],
    ['Documents/My Games/Starfield/StarfieldCustom.ini', '*.ini'],
  ]);
  assert.deepEqual(l.excluded.filter((e) => e.reason === 'junk').map((e) => e.rel), ['AppData/Local/Microsoft/Windows/y.bin', 'AppData/Local/Temp/x.tmp']);
});

test('listSaveFiles: includeConfig keeps the .ini files (for games that save progress there)', () => {
  const { root } = unrealPrefix();
  const l = saves.listSaveFiles(root, { configExcludes: saves.DEFAULT_CONFIG_EXCLUDES, includeConfig: true });
  assert.ok(l.included.some((f) => f.rel.endsWith('GameUserSettings.ini')));
  assert.equal(l.excluded.filter((e) => e.reason === 'config').length, 0);
  assert.equal(l.excluded.filter((e) => e.reason === 'junk').length, 2, 'junk is never included');
});

test('zipSaves honors the rules and restore brings back only progress', async () => {
  const { root } = unrealPrefix();
  const zip = path.join(root, 'out.zip');
  const z = await saves.zipSaves(root, zip);
  assert.equal(z.ok, true, z.error);
  assert.equal(z.files, 4); assert.equal(z.excludedConfig, 3);
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-ue-dst-')); roots.push(dst);
  const r = await saves.restoreSaves(dst, zip, { createProfile: true });
  assert.equal(r.ok, true, r.error);
  const prof = path.join(dst, 'drive_c/users/steamuser');
  assert.ok(fs.existsSync(path.join(prof, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav')));
  assert.equal(fs.existsSync(path.join(prof, 'AppData/Local/SB/Saved/Config/WindowsNoEditor/GameUserSettings.ini')), false, 'resolution never travels');
});

test('fingerprint changes when a save changes and is stable otherwise', () => {
  const { root, profile } = unrealPrefix();
  const a = saves.fingerprint(saves.listSaveFiles(root));
  assert.equal(saves.fingerprint(saves.listSaveFiles(root)), a);
  fs.writeFileSync(path.join(profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'SAVE-v2');
  assert.notEqual(saves.fingerprint(saves.listSaveFiles(root)), a);
  // Editing a config file must NOT count as a save change
  const b = saves.fingerprint(saves.listSaveFiles(root));
  fs.writeFileSync(path.join(profile, 'AppData/Local/SB/Saved/Config/WindowsNoEditor/GameUserSettings.ini'), 'ResolutionSizeX=1280\n');
  assert.equal(saves.fingerprint(saves.listSaveFiles(root)), b);
});

test('computeState covers the whole matrix', () => {
  const local = { included: [{ rel: 'a', size: 1, mtimeMs: 1 }], excluded: [], totalBytes: 1, profile: '' };
  const fp = saves.fingerprint(local);
  const remote = (hash) => ({ content_hash: hash });
  const rec = (hash, fingerprint) => ({ saveId: 1, contentHash: hash, fingerprint, syncedAt: 0 });
  assert.equal(cloud.computeState(null, null, null).state, 'nothing');
  assert.equal(cloud.computeState(null, remote('A'), null).state, 'remote-only');
  assert.equal(cloud.computeState(local, null, null).state, 'local-only');
  assert.equal(cloud.computeState(local, remote('A'), null).state, 'conflict', 'never synced but both exist → user decides');
  assert.equal(cloud.computeState(local, remote('A'), rec('A', fp)).state, 'in-sync');
  assert.equal(cloud.computeState(local, remote('A'), rec('A', 'old')).state, 'local-newer');
  assert.equal(cloud.computeState(local, remote('B'), rec('A', fp)).state, 'remote-newer');
  assert.equal(cloud.computeState(local, remote('B'), rec('A', 'old')).state, 'conflict');
});

// ── Stub-client sync flows ────────────────────────────────────────────────

function stubClient() {
  const store = []; let nextId = 1;
  return {
    store,
    savesSummary: async () => { const mine = store.filter((s) => s.slot === 'r2sd'); const latest = mine[mine.length - 1]; return { total_count: mine.length, slots: latest ? [{ slot: 'r2sd', count: mine.length, latest }] : [] }; },
    uploadSave: async (romId, fileName, content, opts) => {
      const s = { id: nextId++, rom_id: romId, file_name: fileName, content, slot: opts.slot, emulator: opts.emulator, content_hash: require('crypto').createHash('md5').update(content).digest('hex'), file_size_bytes: content.length, updated_at: new Date().toISOString(), origin_device_id: opts.deviceId || null, device_syncs: [] };
      store.push(s); return s;
    },
    downloadSave: async (id) => store.find((s) => s.id === id).content,
    confirmSaveDownloaded: async () => {},
  };
}
function deps(client, recBox) {
  return { client, rules: saves.DEFAULT_RULES, deviceId: 'dev-1', getRecord: () => recBox.rec, setRecord: (r) => { recBox.rec = r; } };
}

test('beforeLaunch/afterExit: device A uploads after play, device B seeds a fresh prefix, then edits round-trip', async () => {
  const client = stubClient();
  const A = unrealPrefix(); const recA = { rec: null };
  // A: first ever launch → local-only → uploads before launching
  let act = await cloud.beforeLaunch(deps(client, recA), 7, A.root, 'Stellar Blade');
  assert.equal(act.action, 'uploaded'); assert.equal(client.store.length, 1);
  // A plays, nothing changed → afterExit is a no-op
  assert.equal((await cloud.afterExit(deps(client, recA), 7, A.root, 'Stellar Blade')).action, 'none');
  // A plays and saves → afterExit uploads a new version
  fs.writeFileSync(path.join(A.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'SAVE-v2');
  assert.equal((await cloud.afterExit(deps(client, recA), 7, A.root, 'Stellar Blade')).action, 'uploaded');
  assert.equal(client.store.length, 2);
  // B: brand-new machine, prefix does not exist yet → seeded from the cloud before first run
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-devB-')); roots.push(B);
  const bRoot = path.join(B, 'stellar-blade'); const recB = { rec: null };
  act = await cloud.beforeLaunch(deps(client, recB), 7, bRoot, 'Stellar Blade');
  assert.equal(act.action, 'seeded');
  assert.equal(fs.readFileSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'utf8'), 'SAVE-v2');
  assert.equal(fs.existsSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/Config')), false, 'no config travelled');
  // B in sync now; A too (A's record matches the latest)
  assert.equal((await cloud.status(deps(client, recB), 7, bRoot)).state, 'in-sync');
  assert.equal((await cloud.status(deps(client, recA), 7, A.root)).state, 'in-sync');
  // B plays and saves → uploads; A's next launch restores it
  fs.writeFileSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'SAVE-v3');
  assert.equal((await cloud.afterExit(deps(client, recB), 7, bRoot, 'Stellar Blade')).action, 'uploaded');
  act = await cloud.beforeLaunch(deps(client, recA), 7, A.root, 'Stellar Blade');
  assert.equal(act.action, 'restored');
  assert.equal(fs.readFileSync(path.join(A.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'utf8'), 'SAVE-v3');
  // Conflict: both edit before syncing → nothing is overwritten
  fs.writeFileSync(path.join(A.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'SAVE-A4');
  fs.writeFileSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'SAVE-B4');
  assert.equal((await cloud.afterExit(deps(client, recB), 7, bRoot, 'Stellar Blade')).action, 'uploaded');
  act = await cloud.beforeLaunch(deps(client, recA), 7, A.root, 'Stellar Blade');
  assert.equal(act.action, 'conflict');
  assert.equal(fs.readFileSync(path.join(A.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'utf8'), 'SAVE-A4', 'local kept');

  // The game launches anyway. When it exits, A must NOT upload over B's newer
  // save — before 2.2.30 it did, and B then restored A's save over its own.
  const before = client.store.length;
  assert.equal((await cloud.afterExit(deps(client, recA), 7, A.root, 'Stellar Blade')).action, 'conflict');
  assert.equal(client.store.length, before, 'nothing uploaded');
  assert.equal((await cloud.beforeLaunch(deps(client, recB), 7, bRoot, 'Stellar Blade')).action, 'none', 'B keeps its own progress');
  assert.equal(fs.readFileSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'utf8'), 'SAVE-B4');
});

test('afterExit: a launch that could not reach RomM does not upload blindly afterwards', async () => {
  const client = stubClient();
  const A = unrealPrefix(); const recA = { rec: null };
  await cloud.beforeLaunch(deps(client, recA), 8, A.root, 'G');                        // A uploads v1
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-devB-')); roots.push(B);
  const bRoot = path.join(B, 'g'); const recB = { rec: null };
  await cloud.beforeLaunch(deps(client, recB), 8, bRoot, 'G');                          // B seeded with v1
  fs.writeFileSync(path.join(bRoot, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'B-PROGRESS');
  await cloud.afterExit(deps(client, recB), 8, bRoot, 'G');                             // B uploads v2
  // A is offline at launch (so it never learns about v2), plays, and is online again at exit
  const offline = { ...client, savesSummary: async () => { throw new Error('fetch failed'); } };
  assert.equal((await cloud.beforeLaunch(deps(offline, recA), 8, A.root, 'G')).action, 'error');
  fs.writeFileSync(path.join(A.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'A-OFFLINE');
  assert.equal((await cloud.afterExit(deps(client, recA), 8, A.root, 'G')).action, 'conflict');
  // …and when only this device changed, the upload still happens
  const solo = stubClient(); // the stub keeps one save list, so a separate game gets its own
  const C = unrealPrefix(); const recC = { rec: null };
  await cloud.beforeLaunch(deps(solo, recC), 9, C.root, 'H');
  fs.writeFileSync(path.join(C.profile, 'AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav'), 'C-2');
  assert.equal((await cloud.afterExit(deps(solo, recC), 9, C.root, 'H')).action, 'uploaded');
});

// ── Live round trip (opt-in) ──────────────────────────────────────────────

const live = process.env.R2SD_LIVE_ROMM; // "user:pass"
test('live: upload → status → download against RomM', { skip: !live && 'set R2SD_LIVE_ROMM=user:pass' }, async () => {
  const { RommClient } = require('../dist/romm.js');
  const [user, pass] = live.split(':');
  const client = new RommClient('https://romm.lifeisguid.com', user, pass);
  const ROM = 18798;
  const { root } = unrealPrefix();
  const recBox = { rec: null };
  const d = { client, rules: saves.DEFAULT_RULES, deviceId: null, getRecord: () => recBox.rec, setRecord: (r) => { recBox.rec = r; } };
  const up = await cloud.upload(d, ROM, root, 'Live Test');
  assert.equal(up.ok, true, up.error);
  assert.equal(up.files, 4);
  const st = await cloud.status(d, ROM, root);
  assert.equal(st.state, 'in-sync');
  assert.equal(st.remote.contentHash, recBox.rec.contentHash);
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-live-dst-')); roots.push(dst);
  const dl = await cloud.download({ ...d, getRecord: () => null, setRecord: () => {} }, ROM, dst, { createProfile: true });
  assert.equal(dl.ok, true, dl.error);
  assert.ok(fs.existsSync(path.join(dst, 'drive_c/users/steamuser/AppData/Local/SB/Saved/SaveGames/765/StellarBladeSave00.sav')));
  // cleanup on the server
  const res = await fetch('https://romm.lifeisguid.com/api/saves/delete', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(live).toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ saves: [up.saveId] }) });
  assert.equal(res.status, 200);
});
