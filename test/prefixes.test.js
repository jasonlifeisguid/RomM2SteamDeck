'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix;

const { faugusPrefixesDir, faugusGamePrefix, prefixUserFolders, resolvePrefixes, windowsUserFolders } = require('../dist/prefixes.js');

const HOME = '/home/deck';
const EXE = '/home/deck/Games/Doom/doom.exe';
function fakeEnv({ dirs = [], files = {}, platform = 'linux', env = {} } = {}) {
  const d = new Set(dirs);
  return {
    platform, homedir: HOME, env,
    exists: (p) => d.has(p) || p in files,
    isDir: (p) => d.has(p),
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
  };
}
const CFG = path.join(HOME, '.config/faugus-launcher/config.json');
const GAMES = path.join(HOME, '.local/share/faugus-launcher/games.json');

test('faugusPrefixesDir: default ~/Faugus, honors a quoted default-prefix with ~', () => {
  assert.equal(faugusPrefixesDir(fakeEnv()), '/home/deck/Faugus');
  const env = fakeEnv({ files: { [CFG]: JSON.stringify({ 'default-prefix': '"~/Prefixes"' }) } });
  assert.equal(faugusPrefixesDir(env), '/home/deck/Prefixes');
  const bad = fakeEnv({ files: { [CFG]: '{oops' } });
  assert.equal(faugusPrefixesDir(bad), '/home/deck/Faugus');
});

test('faugusGamePrefix: the registered entry\'s prefix (with ~ expansion), else null', () => {
  const env = fakeEnv({ files: { [GAMES]: JSON.stringify([{ gameid: 'doom', path: '~/Games/Doom/doom.exe', prefix: '~/Faugus/doom' }]) } });
  assert.equal(faugusGamePrefix(EXE, env), '/home/deck/Faugus/doom');
  assert.equal(faugusGamePrefix('/other.exe', env), null);
  assert.equal(faugusGamePrefix(EXE, fakeEnv()), null);
});

test('prefixUserFolders lists only folders that exist, Proton steamuser first', () => {
  const root = '/home/deck/Faugus/doom';
  const prof = path.join(root, 'drive_c/users/steamuser');
  const env = fakeEnv({ dirs: [root, path.join(root, 'drive_c'), prof, path.join(prof, 'Documents'), path.join(prof, 'AppData/Roaming'), path.join(prof, 'AppData/Local')] });
  assert.deepEqual(prefixUserFolders(root, env).map((f) => f.label), ['User profile', 'Documents', 'AppData \\ Roaming', 'AppData \\ Local', 'Drive C:']);
  assert.equal(prefixUserFolders(root, env)[1].path, path.join(prof, 'Documents'));
});

test('prefixUserFolders falls back to the Linux username (plain Wine) and "My Documents"', () => {
  const root = '/home/deck/.wine';
  const prof = path.join(root, 'drive_c/users/deck');
  const env = fakeEnv({ dirs: [root, path.join(root, 'drive_c'), prof, path.join(prof, 'My Documents')] });
  const labels = prefixUserFolders(root, env).map((f) => f.label);
  assert.deepEqual(labels, ['User profile', 'Documents', 'Drive C:']);
});

test('resolvePrefixes: registered game prefix + steam compatdata, de-duplicated, existing only', () => {
  const gamePfx = '/home/deck/Faugus/doom';
  const steamPfx = '/home/deck/.local/share/Steam/steamapps/compatdata/3040223621/pfx';
  const env = fakeEnv({
    dirs: [gamePfx, path.join(gamePfx, 'drive_c'), steamPfx, path.join(steamPfx, 'drive_c'), path.join(steamPfx, 'drive_c/users/steamuser'), path.join(steamPfx, 'drive_c/users/steamuser/Saved Games')],
    files: { [GAMES]: JSON.stringify([{ gameid: 'doom', path: EXE, prefix: gamePfx }]) },
  });
  const res = resolvePrefixes(EXE, { steamAppId: 3040223621, steamRoot: '/home/deck/.local/share/Steam' }, env);
  assert.deepEqual(res.map((p) => p.source), ['faugus-game', 'steam']);
  assert.deepEqual(res[1].folders.map((f) => f.label), ['User profile', 'Saved Games', 'Drive C:']);
  // A missing compatdata dir is simply not listed
  const none = resolvePrefixes('/other.exe', { steamAppId: 1, steamRoot: '/home/deck/.local/share/Steam' }, env);
  assert.deepEqual(none, []);
});

test('resolvePrefixes on Windows maps to the real profile folders', () => {
  const env = fakeEnv({
    platform: 'win32',
    dirs: ['C:\\Users\\jason', 'C:\\Users\\jason\\Documents', 'C:\\Users\\jason\\AppData\\Roaming'],
    env: { USERPROFILE: 'C:\\Users\\jason', APPDATA: 'C:\\Users\\jason\\AppData\\Roaming' },
  });
  const res = resolvePrefixes('C:\\Games\\x.exe', {}, env);
  assert.equal(res.length, 1);
  assert.equal(res[0].source, 'windows');
  assert.deepEqual(res[0].folders.map((f) => f.label), ['User profile', 'Documents', 'AppData \\ Roaming']);
  assert.deepEqual(windowsUserFolders(env)[2].path, 'C:\\Users\\jason\\AppData\\Roaming');
});
