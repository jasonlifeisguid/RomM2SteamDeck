// Windows-side save handling: scoped listings, Known Folder layouts (redirected
// Documents), staged zips, restore into a redirected profile, scope learning.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const saves = require('../dist/saves.js');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tmp(name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `r2sd-${name}-`)); roots.push(d); return d; }
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** A "Windows profile" whose Documents lives in a OneDrive folder elsewhere. */
function makeRedirectedProfile(files) {
  const profile = tmp('winprofile');
  const oneDrive = tmp('onedrive');
  const folders = {
    profile,
    documents: path.join(oneDrive, 'Documents'),
    savedGames: path.join(profile, 'Saved Games'),
    appData: path.join(profile, 'AppData', 'Roaming'),
    localAppData: path.join(profile, 'AppData', 'Local'),
  };
  for (const [rel, content] of Object.entries(files)) {
    const top = Object.keys({ 'Documents': 1, 'Saved Games': 1, 'AppData/Roaming': 1, 'AppData/Local': 1, 'AppData/LocalLow': 1 }).find((t) => rel.startsWith(t + '/'));
    const real = { 'Documents': folders.documents, 'Saved Games': folders.savedGames, 'AppData/Roaming': folders.appData, 'AppData/Local': folders.localAppData, 'AppData/LocalLow': path.join(profile, 'AppData', 'LocalLow') }[top];
    const full = path.join(real, rel.slice(top.length + 1));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { folders, layout: saves.windowsLayout(folders) };
}

test('normalizeScope cleans paths and refuses bare roots', () => {
  assert.deepEqual(saves.normalizeScope(['Documents\\My Games\\X\\', '/AppData/Local/Y', 'documents/my games/x', 'Documents', 'AppData', 'AppData/Roaming', '', '../etc']),
    ['Documents/My Games/X', 'AppData/Local/Y']);
});

test('learnScope: first folder per root, deeper inside My Games / LocalLow / Goldberg; junk ignored', () => {
  assert.deepEqual(saves.learnScope([
    'Documents/My Games/Stellar Blade/Saved/SaveGames/a.sav',
    'Documents/My Games/Stellar Blade/Saved/Config/x.ini',
    'Documents/Larian Studios/Baldur\'s Gate 3/PlayerProfiles/p.lsv',
    'Saved Games/Respawn/Titanfall2/profile.cfg',
    'AppData/Roaming/Goldberg SteamEmu Saves/3159330/remote/save.bin',
    'AppData/LocalLow/Team Cherry/Hollow Knight/user1.dat',
    'AppData/Local/Temp/junk.tmp',
    'AppData/Local/Microsoft/Windows/x',
    'Documents/loose.txt',
  ]), [
    'Documents/My Games/Stellar Blade',
    'Documents/Larian Studios',
    'Saved Games/Respawn',
    'AppData/Roaming/Goldberg SteamEmu Saves/3159330',
    'AppData/LocalLow/Team Cherry/Hollow Knight',
  ]);
});

test('a scope narrows a prefix listing; case-insensitive; pruned walk still finds nested scope entries', () => {
  const pfx = tmp('pfx');
  write(path.join(pfx, 'drive_c', 'users', 'steamuser'), {
    'Documents/My Games/Game A/save.sav': 'A',
    'Documents/My Games/Game B/save.sav': 'B',
    'AppData/Local/GameA/data.bin': 'A2',
    'AppData/Local/Other/data.bin': 'O',
  });
  const all = saves.listSaveFiles(pfx);
  assert.equal(all.included.length, 4);
  const scoped = saves.listSaveFiles(pfx, { ...saves.DEFAULT_RULES, scope: ['documents/my games/game a', 'AppData/Local/GameA'] });
  assert.deepEqual(scoped.included.map((f) => f.rel), ['AppData/Local/GameA/data.bin', 'Documents/My Games/Game A/save.sav']);
  assert.equal(scoped.unscoped, undefined);
});

test('the real Windows profile is never listed without a scope', () => {
  const { layout } = makeRedirectedProfile({ 'Documents/Private/taxes.xlsx': 'PRIVATE', 'AppData/Local/GameA/data.bin': 'A' });
  const r = saves.listSaveFiles(layout);
  assert.equal(r.unscoped, true);
  assert.equal(r.included.length, 0);
  const scoped = saves.listSaveFiles(layout, { ...saves.DEFAULT_RULES, scope: ['AppData/Local/GameA'] });
  assert.deepEqual(scoped.included.map((f) => f.rel), ['AppData/Local/GameA/data.bin']);
});

test('windowsKnownFolders reads redirected Documents / Saved Games from the registry dump', () => {
  const env = { USERPROFILE: 'C:\\Users\\jane', APPDATA: 'C:\\Users\\jane\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\jane\\AppData\\Local', OneDrive: 'C:\\Users\\jane\\OneDrive' };
  const reg = () => [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Personal    REG_EXPAND_SZ    %OneDrive%\\Documents',
    '    {4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}    REG_SZ    D:\\Saves',
    '    AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming',
    '',
  ].join('\r\n');
  const f = saves.windowsKnownFolders(env, reg);
  assert.equal(f.documents, 'C:\\Users\\jane\\OneDrive\\Documents');
  assert.equal(f.savedGames, 'D:\\Saves');
  assert.equal(f.appData, 'C:\\Users\\jane\\AppData\\Roaming');
  assert.equal(f.localAppData, 'C:\\Users\\jane\\AppData\\Local');
  // No registry at all → classic layout
  const g = saves.windowsKnownFolders(env, () => { throw new Error('no reg'); });
  assert.equal(g.documents, path.join('C:\\Users\\jane', 'Documents'));
});

test('redirected profile: zip is staged with canonical paths; restore lands in the redirected folder', async () => {
  const src = makeRedirectedProfile({
    'Documents/My Games/Game A/save.sav': 'A-SAVE',
    'Documents/My Games/Game A/Saved/Config/GameUserSettings.ini': 'RES=3440',
    'AppData/Local/GameA/data.bin': 'A-DATA',
    'AppData/Local/Other/data.bin': 'OTHER',
  });
  assert.equal(src.layout.direct, false);
  assert.equal(src.layout.requireScope, true);
  const rules = { ...saves.DEFAULT_RULES, scope: ['Documents/My Games/Game A', 'AppData/Local/GameA'] };
  const out = tmp('zipout');
  const z = await saves.zipSaves(src.layout, path.join(out, 'a.zip'), rules);
  assert.equal(z.ok, true, z.error);
  assert.equal(z.files, 2);
  assert.equal(z.excludedConfig, 1);
  const entries = await saves.listZipEntries(z.file);
  assert.deepEqual(entries.sort(), ['AppData/Local/GameA/data.bin', 'Documents/My Games/Game A/save.sav']);

  // Restore into a second redirected profile (fresh machine): files land in ITS OneDrive Documents
  const dst = makeRedirectedProfile({ 'Documents/keep.txt': 'KEEP' });
  const r = await saves.restoreSaves(dst.layout, z.file);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(dst.folders.documents, 'My Games', 'Game A', 'save.sav'), 'utf8'), 'A-SAVE');
  assert.equal(fs.readFileSync(path.join(dst.folders.localAppData, 'GameA', 'data.bin'), 'utf8'), 'A-DATA');
  assert.equal(fs.readFileSync(path.join(dst.folders.documents, 'keep.txt'), 'utf8'), 'KEEP');
  assert.ok(!fs.existsSync(path.join(dst.folders.profile, 'Documents')), 'nothing was written to the un-redirected path');
  assert.deepEqual(saves.learnScope(r.entries), ['AppData/Local/GameA', 'Documents/My Games/Game A']);

  // Unscoped upload from the Windows profile is refused outright
  const bad = await saves.zipSaves(src.layout, path.join(out, 'b.zip'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No save locations known/);
});

test('a Proton-prefix zip restores onto a Windows layout and vice versa (same relative paths)', async () => {
  const pfx = tmp('pfx2');
  write(path.join(pfx, 'drive_c', 'users', 'steamuser'), { 'Saved Games/Game C/slot1.sav': 'DECK' });
  const out = tmp('zipout2');
  const z = await saves.zipSaves(pfx, path.join(out, 'c.zip'));
  assert.equal(z.ok, true, z.error);
  const win = makeRedirectedProfile({});
  const r = await saves.restoreSaves(win.layout, z.file);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(win.folders.savedGames, 'Game C', 'slot1.sav'), 'utf8'), 'DECK');
  // and back: the Windows side (scoped) → zip → a brand-new prefix
  fs.writeFileSync(path.join(win.folders.savedGames, 'Game C', 'slot1.sav'), 'DESKTOP');
  const z2 = await saves.zipSaves(win.layout, path.join(out, 'c2.zip'), { ...saves.DEFAULT_RULES, scope: saves.learnScope(r.entries) });
  assert.equal(z2.ok, true, z2.error);
  const pfx2 = tmp('pfx3');
  const r2 = await saves.restoreSaves(pfx2, z2.file, { createProfile: true });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(fs.readFileSync(path.join(pfx2, 'drive_c', 'users', 'steamuser', 'Saved Games', 'Game C', 'slot1.sav'), 'utf8'), 'DESKTOP');
});

test('restoring into the Windows profile writes only the game\'s save locations, never launcher folders', async () => {
  // A per-game Proton prefix where the game also installed Ubisoft Connect
  const pfx = tmp('pfx-ubi');
  write(path.join(pfx, 'drive_c', 'users', 'steamuser'), {
    'Documents/My Games/Game D/save1.sav': 'PROGRESS',
    'AppData/Local/Ubisoft Game Launcher/settings.yaml': 'linux-paths: /home/deck',
    'AppData/Roaming/Goldberg SteamEmu Saves/settings/account_name.txt': 'deck',
    'Documents/stray-note.txt': 'loose file in the root',
  });
  const out = tmp('zipout-ubi');
  const z = await saves.zipSaves(pfx, path.join(out, 'd.zip'));
  assert.equal(z.ok, true, z.error);
  assert.equal(z.files, 4, 'the prefix-side zip carries everything');

  const win = makeRedirectedProfile({ 'AppData/Local/Ubisoft Game Launcher/settings.yaml': 'THE USER\'S OWN' });
  const r = await saves.restoreSaves(win.layout, z.file);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(win.folders.documents, 'My Games', 'Game D', 'save1.sav'), 'utf8'), 'PROGRESS');
  assert.equal(fs.readFileSync(path.join(win.folders.localAppData, 'Ubisoft Game Launcher', 'settings.yaml'), 'utf8'), 'THE USER\'S OWN', 'launcher settings untouched');
  assert.equal(fs.existsSync(path.join(win.folders.appData, 'Goldberg SteamEmu Saves', 'settings')), false);
  assert.equal(fs.existsSync(path.join(win.folders.documents, 'stray-note.txt')), false);
  assert.equal(r.skipped, 3);
  assert.deepEqual(saves.learnScope(r.entries), ['Documents/My Games/Game D'], 'only the game is learned as scope');

  // A known scope is honoured too (a save location the zip alone wouldn't teach)
  const z2dir = tmp('pfx-scope');
  write(path.join(z2dir, 'drive_c', 'users', 'steamuser'), { 'Documents/loose-save.dat': 'LOOSE' });
  const z2 = await saves.zipSaves(z2dir, path.join(out, 'e.zip'));
  assert.equal((await saves.restoreSaves(makeRedirectedProfile({}).layout, z2.file)).ok, false, 'nothing in scope → refused, nothing written');
  const win2 = makeRedirectedProfile({});
  const r2 = await saves.restoreSaves(win2.layout, z2.file, { scope: ['Documents/loose-save.dat'] });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(fs.readFileSync(path.join(win2.folders.documents, 'loose-save.dat'), 'utf8'), 'LOOSE');
});
