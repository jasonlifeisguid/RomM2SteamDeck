'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix; // the module is Linux-only and uses POSIX paths

const { findFaugus, findRegisteredGameId, buildLaunch, gamesJsonPath, FLATPAK_APP_ID } = require('../dist/faugus.js');

const HOME = '/home/deck';
function fakeEnv({ files = [], dirs = {}, contents = {}, platform = 'linux', pathDirs = ['/usr/bin', '/usr/local/bin'] } = {}) {
  const set = new Set(files);
  return {
    platform, homedir: HOME, pathDirs,
    exists: (p) => set.has(p),
    readdir: (d) => dirs[d] || [],
    readFile: (p) => { if (!(p in contents)) throw new Error('ENOENT'); return contents[p]; },
  };
}
const EXE = '/home/deck/Games/Doom/doom.exe';
const GAMES_JSON = path.join(HOME, '.local/share/faugus-launcher/games.json');

test('findFaugus: binary on PATH wins', () => {
  const env = fakeEnv({ files: ['/usr/bin/faugus-launcher'] });
  assert.deepEqual(findFaugus(env), { method: 'binary', target: '/usr/bin/faugus-launcher' });
});

test('findFaugus: AppImage in ~/Applications (newest name last)', () => {
  const env = fakeEnv({ dirs: { [path.join(HOME, 'Applications')]: ['Faugus-2.2.0-1-x86_64.AppImage', 'Faugus-2.3.0-1-x86_64.AppImage', 'other.AppImage'] } });
  assert.deepEqual(findFaugus(env), { method: 'appimage', target: path.join(HOME, 'Applications', 'Faugus-2.3.0-1-x86_64.AppImage') });
});

test('findFaugus: user flatpak, then system flatpak', () => {
  assert.deepEqual(findFaugus(fakeEnv({ files: [path.join(HOME, '.local/share/flatpak/app', FLATPAK_APP_ID)] })), { method: 'flatpak', target: FLATPAK_APP_ID });
  assert.deepEqual(findFaugus(fakeEnv({ files: ['/var/lib/flatpak/app/' + FLATPAK_APP_ID] })), { method: 'flatpak', target: FLATPAK_APP_ID });
});

test('findFaugus: nothing installed / not linux', () => {
  assert.equal(findFaugus(fakeEnv()), null);
  assert.equal(findFaugus(fakeEnv({ files: ['/usr/bin/faugus-launcher'], platform: 'win32' })), null);
});

test('gamesJsonPath honors XDG_DATA_HOME', () => {
  const env = fakeEnv();
  assert.equal(gamesJsonPath(env, undefined), GAMES_JSON);
  assert.equal(gamesJsonPath(env, '/custom/data'), '/custom/data/faugus-launcher/games.json');
});

test('findRegisteredGameId matches by resolved path, expands ~, ignores junk', () => {
  const json = JSON.stringify([
    { gameid: 'doom-abc123', title: 'Doom', path: '~/Games/Doom/doom.exe', runner: 'Proton-CachyOS Latest' },
    { gameid: 'other', path: '/elsewhere/x.exe' },
    'garbage', null, { path: '/no/id.exe' },
  ]);
  const env = fakeEnv({ files: [GAMES_JSON], contents: { [GAMES_JSON]: json } });
  assert.equal(findRegisteredGameId(EXE, env), 'doom-abc123');
  assert.equal(findRegisteredGameId('/home/deck/Games/Doom/../Doom/doom.exe', env), 'doom-abc123');
  assert.equal(findRegisteredGameId('/home/deck/Games/Quake/quake.exe', env), null);
});

test('findRegisteredGameId tolerates a missing or malformed games.json', () => {
  assert.equal(findRegisteredGameId(EXE, fakeEnv()), null);
  const bad = fakeEnv({ files: [GAMES_JSON], contents: { [GAMES_JSON]: '{not json' } });
  assert.equal(findRegisteredGameId(EXE, bad), null);
  const obj = fakeEnv({ files: [GAMES_JSON], contents: { [GAMES_JSON]: '{"gameid":"x","path":"' + EXE + '"}' } });
  assert.equal(findRegisteredGameId(EXE, obj), null, 'top level must be an array');
});

test('buildLaunch: bare exe for each install method', () => {
  const env = fakeEnv();
  assert.deepEqual(buildLaunch({ method: 'binary', target: '/usr/bin/faugus-launcher' }, EXE, env),
    { command: '/usr/bin/faugus-launcher', args: [EXE], gameId: null });
  assert.deepEqual(buildLaunch({ method: 'appimage', target: '/home/deck/Applications/Faugus.AppImage' }, EXE, env),
    { command: '/home/deck/Applications/Faugus.AppImage', args: [EXE], gameId: null });
  assert.deepEqual(buildLaunch({ method: 'flatpak', target: FLATPAK_APP_ID }, EXE, env),
    { command: 'flatpak', args: ['run', FLATPAK_APP_ID, EXE], gameId: null });
});

test('buildLaunch: registered game uses --game <id> (per-game prefix/Proton apply)', () => {
  const json = JSON.stringify([{ gameid: 'doom-abc123', path: EXE }]);
  const env = fakeEnv({ files: [GAMES_JSON], contents: { [GAMES_JSON]: json } });
  assert.deepEqual(buildLaunch({ method: 'binary', target: '/usr/bin/faugus-launcher' }, EXE, env),
    { command: '/usr/bin/faugus-launcher', args: ['--game', 'doom-abc123'], gameId: 'doom-abc123' });
  assert.deepEqual(buildLaunch({ method: 'flatpak', target: FLATPAK_APP_ID }, EXE, env).args,
    ['run', FLATPAK_APP_ID, '--game', 'doom-abc123']);
});
