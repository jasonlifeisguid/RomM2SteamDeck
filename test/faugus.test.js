'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix; // the module is Linux-only and uses POSIX paths

const { findFaugus, findRegisteredGameId, buildLaunch, gamesJsonPath, FLATPAK_APP_ID, formatTitle, readFaugusConfig, registerGame, repointGame } = require('../dist/faugus.js');

const HOME = '/home/deck';
function fakeEnv({ files = [], dirs = {}, contents = {}, platform = 'linux', pathDirs = ['/usr/bin', '/usr/local/bin'], uiRunning = false } = {}) {
  const set = new Set(files);
  const written = {};   // path -> data (writes are recorded, and become readable)
  const copied = [];    // [from, to]
  const env = {
    platform, homedir: HOME, pathDirs, written, copied,
    exists: (p) => set.has(p) || p in contents || p in written,
    readdir: (d) => dirs[d] || [],
    readFile: (p) => { if (p in written) return written[p]; if (!(p in contents)) throw new Error('ENOENT'); return contents[p]; },
    writeFile: (p, data) => { written[p] = data; },
    copyFile: (from, to) => { copied.push([from, to]); written[to] = env.readFile(from); },
    mkdirp: () => {},
    faugusUiRunning: () => uiRunning,
  };
  return env;
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

// ── registration (per-game prefixes) ──────────────────────────────────────

const CFG = path.join(HOME, '.config/faugus-launcher/config.json');

test('formatTitle mirrors Faugus format_title()', () => {
  assert.equal(formatTitle("Assassin's Creed Shadows"), 'assassins-creed-shadows');
  assert.equal(formatTitle('  Stellar   Blade '), 'stellar-blade');
  assert.equal(formatTitle('METAL GEAR SOLID 4 - MCV'), 'metal-gear-solid-4---mcv');
  assert.equal(formatTitle('The Simpsons: Hit & Run'), 'the-simpsons-hit-run');
  assert.equal(formatTitle('Pokémon'), 'pokémon');
});

test('readFaugusConfig: defaults, then quoted/unquoted values from config.json', () => {
  assert.deepEqual(readFaugusConfig(fakeEnv()), { prefixesDir: '/home/deck/Faugus', defaultRunner: 'Proton-CachyOS Latest' });
  const env = fakeEnv({ contents: { [CFG]: JSON.stringify({ 'default-prefix': '"~/Prefixes"', 'default-runner': 'GE-Proton10-4' }) } });
  assert.deepEqual(readFaugusConfig(env), { prefixesDir: '/home/deck/Prefixes', defaultRunner: 'GE-Proton10-4' });
});

test('registerGame creates a minimal entry with its own prefix and keeps a backup', () => {
  const existing = [{ gameid: 'maneaters', title: 'Maneaters', path: '/g/Maneater/Maneater.exe', prefix: '~/Faugus/maneaters', runner: 'Proton-CachyOS Latest', playtime: 12 }];
  const env = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify(existing), [CFG]: JSON.stringify({ 'default-prefix': '/home/deck/Faugus', 'default-runner': 'Proton-CachyOS Latest' }), '/covers/1.png': 'PNG' } });
  const res = registerGame({ title: "Assassin's Creed Shadows", exePath: '/g/ACS/ACShadows.exe', coverPng: '/covers/1.png' }, env);
  assert.deepEqual(res, { ok: true, gameId: 'assassins-creed-shadows', prefix: '/home/deck/Faugus/assassins-creed-shadows', existing: false });
  const out = JSON.parse(env.written[GAMES_JSON]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], existing[0], 'existing entries untouched (playtime kept)');
  assert.deepEqual(out[1], {
    gameid: 'assassins-creed-shadows', title: "Assassin's Creed Shadows", path: '/g/ACS/ACShadows.exe',
    prefix: '/home/deck/Faugus/assassins-creed-shadows', runner: 'Proton-CachyOS Latest',
    cover: path.join(HOME, '.local/share/faugus-launcher/covers/assassins-creed-shadows.png'),
  });
  assert.ok(env.written[GAMES_JSON + '.r2sd-bak'], 'previous games.json backed up');
  assert.ok(env.written[GAMES_JSON].endsWith('\n'));
});

test('registerGame reuses an entry that already points at the exe (by path, ~ expanded)', () => {
  const env = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify([{ gameid: 'maneaters', title: 'Maneaters', path: '~/G/Maneater/Maneater.exe', prefix: '~/Faugus/maneaters' }]) } });
  const res = registerGame({ title: 'Maneater', exePath: '/home/deck/G/Maneater/Maneater.exe' }, env);
  assert.deepEqual(res, { ok: true, gameId: 'maneaters', prefix: '/home/deck/Faugus/maneaters', existing: true });
  assert.equal(env.written[GAMES_JSON], undefined, 'nothing written');
});

test('registerGame de-duplicates the game id against a different game with the same title', () => {
  const env = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify([{ gameid: 'doom', title: 'Doom', path: '/old/doom.exe', prefix: '~/Faugus/doom' }]) } });
  const res = registerGame({ title: 'Doom', exePath: '/new/doom.exe' }, env);
  assert.equal(res.gameId, 'doom-2');
  assert.equal(res.prefix, '/home/deck/Faugus/doom-2');
});

test('registerGame starts a games.json when Faugus has none yet', () => {
  const env = fakeEnv();
  const res = registerGame({ title: 'Quake', exePath: '/g/quake.exe' }, env);
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(env.written[GAMES_JSON]).map((g) => g.gameid), ['quake']);
});

test('registerGame refuses while the Faugus window is open, and on a malformed file', () => {
  const open = registerGame({ title: 'Quake', exePath: '/g/quake.exe' }, fakeEnv({ uiRunning: true }));
  assert.equal(open.ok, false); assert.match(open.error, /Faugus Launcher is open/);
  const bad = registerGame({ title: 'Quake', exePath: '/g/quake.exe' }, fakeEnv({ contents: { [GAMES_JSON]: '{"not":"a list"}' } }));
  assert.equal(bad.ok, false); assert.match(bad.error, /not a list/);
});


// ── repointGame: changing which exe a registered game uses ─────────────────

const REPOINT_ENTRY = [{
  gameid: 'stellar-blade', title: 'Stellar Blade', path: '/g/SB/launcher.exe',
  prefix: '/home/deck/Faugus/stellar-blade', runner: 'Proton-CachyOS Latest', cover: '/covers/sb.png',
}];

test('repointGame moves an existing entry to a new exe, keeping gameid/prefix/cover', () => {
  const env = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify(REPOINT_ENTRY) } });
  const res = repointGame('/g/SB/launcher.exe', '/g/SB/bin/SB-Win64-Shipping.exe', env);
  assert.deepEqual(res, { ok: true, gameId: 'stellar-blade', prefix: '/home/deck/Faugus/stellar-blade' });
  const written = JSON.parse(env.written[GAMES_JSON]);
  assert.equal(written.length, 1, 'no duplicate entry');
  assert.deepEqual(written[0], { ...REPOINT_ENTRY[0], path: '/g/SB/bin/SB-Win64-Shipping.exe' });
  assert.deepEqual(env.copied, [[GAMES_JSON, GAMES_JSON + '.r2sd-bak']]);
});

test('repointGame + registerGame: the pair never creates a second prefix for one game', () => {
  const env = fakeEnv({
    contents: {
      [GAMES_JSON]: JSON.stringify(REPOINT_ENTRY),
      [CFG]: JSON.stringify({ 'default-prefix': '/home/deck/Faugus', 'default-runner': 'Proton-CachyOS Latest' }),
    },
  });
  // Without the repoint, registering the new exe would make "stellar-blade-2" with its own prefix
  const naive = registerGame({ title: 'Stellar Blade', exePath: '/g/SB/bin/SB-Win64-Shipping.exe' }, fakeEnv({
    contents: { [GAMES_JSON]: JSON.stringify(REPOINT_ENTRY), [CFG]: JSON.stringify({ 'default-prefix': '/home/deck/Faugus', 'default-runner': 'x' }) },
  }));
  assert.equal(naive.gameId, 'stellar-blade-2');
  assert.equal(naive.prefix, '/home/deck/Faugus/stellar-blade-2');
  // With the repoint first, the next launch finds the entry and reuses prefix + saves
  repointGame('/g/SB/launcher.exe', '/g/SB/bin/SB-Win64-Shipping.exe', env);
  const after = registerGame({ title: 'Stellar Blade', exePath: '/g/SB/bin/SB-Win64-Shipping.exe' }, env);
  assert.deepEqual(after, { ok: true, gameId: 'stellar-blade', prefix: '/home/deck/Faugus/stellar-blade', existing: true });
  assert.equal(JSON.parse(env.written[GAMES_JSON]).length, 1);
});

test('repointGame: unknown old exe is a no-op, and it refuses while the Faugus UI is open', () => {
  const env = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify(REPOINT_ENTRY) } });
  assert.deepEqual(repointGame('/g/other/other.exe', '/g/SB/x.exe', env), { ok: true, notFound: true });
  assert.equal(env.written[GAMES_JSON], undefined, 'nothing written');
  assert.deepEqual(repointGame('/g/SB/launcher.exe', '/g/SB/launcher.exe', env), { ok: true, gameId: 'stellar-blade', prefix: '/home/deck/Faugus/stellar-blade' });

  const busy = fakeEnv({ contents: { [GAMES_JSON]: JSON.stringify(REPOINT_ENTRY) }, uiRunning: true });
  const res = repointGame('/g/SB/launcher.exe', '/g/SB/bin/new.exe', busy);
  assert.equal(res.ok, false);
  assert.match(res.error, /Faugus Launcher is open/);
  assert.equal(busy.written[GAMES_JSON], undefined);

  // no games.json at all
  assert.deepEqual(repointGame('/a.exe', '/b.exe', fakeEnv()), { ok: true, notFound: true });
});
