// Save-location discovery: manifest reduction, placeholder conversion, title matching, Goldberg.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sp = require('../dist/savepaths.js');

const SAMPLE = `---
"! That Bastard Is Trying To Steal Our Gold !":
  installDir:
    "! That Bastard Is Trying To Steal Our Gold !": {}
  registry:
    HKEY_CURRENT_USER/SOFTWARE/WTFOMGames/That Dick Trying To Steal Our Gold:
      tags:
        - config
        - save
  steam:
    id: 449940
"!Anyway!":
  cloud:
    steam: true
  files:
    "<winLocalAppData>/anyway":
      tags:
        - save
      when:
        - os: windows
  steam:
    id: 866510
Stellar Blade:
  files:
    "<winDocuments>/My Games/Stellar Blade/Saved/Config":
      tags:
        - config
      when:
        - os: windows
    "<winDocuments>/My Games/Stellar Blade/Saved/SaveGames":
      tags:
        - save
      when:
        - os: windows
    "<root>/userdata/<storeUserId>/3489700/remote":
      tags:
        - save
      when:
        - store: steam
  installDir:
    StellarBlade: {}
  steam:
    id: 3489700
"Assassin's Creed Shadows":
  files:
    "<base>/savegames/*.save":
      tags:
        - save
    "<winLocalAppData>/Ubisoft Game Launcher/savegames/<storeUserId>/7859":
      tags:
        - save
      when:
        - os: windows
          store: uplay
    "<home>/Saved Games/Assassin's Creed Shadows/*.save":
      tags:
        - save
      when:
        - os: windows
Mac Only Game:
  files:
    "<home>/Library/Application Support/MacGame":
      tags:
        - save
      when:
        - os: mac
  steam:
    id: 1
'Quoted: Single':
  files:
    "<winAppData>/QuotedSingle/saves/*.dat":
      tags:
        - save
`;

test('normalizeTitle strips punctuation, diacritics and ™', () => {
  assert.equal(sp.normalizeTitle("Assassin's Creed® Shadows"), 'assassinscreedshadows');
  assert.equal(sp.normalizeTitle('Pokémon: Let\'s Go!'), 'pokemonletsgo');
  assert.equal(sp.normalizeTitle('The Simpsons: Hit & Run'), 'thesimpsonshitandrun');
});

test('titleCandidates: name, file name without tags/extension, install folder', () => {
  assert.deepEqual(sp.titleCandidates({ name: 'Stellar Blade', fsName: 'Stellar Blade (v1.2) [Multi].zip', folder: 'D:\\Games\\StellarBlade' }),
    ['stellarblade']);
  assert.deepEqual(sp.titleCandidates({ name: 'Game A', fsName: 'Game-A-Deluxe.7z', folder: '/games/gamea (goty)' }),
    ['gamea', 'gameadeluxe']);
});

test('convertManifestPath: profile placeholders only, cut at wildcards, never a bare root', () => {
  assert.equal(sp.convertManifestPath('<winDocuments>/My Games/X/Saved/SaveGames'), 'Documents/My Games/X/Saved/SaveGames');
  assert.equal(sp.convertManifestPath('<winAppData>/Q/saves/*.dat'), 'AppData/Roaming/Q/saves');
  assert.equal(sp.convertManifestPath('<winLocalAppData>/Ubisoft Game Launcher/savegames/<storeUserId>/7859'), 'AppData/Local/Ubisoft Game Launcher/savegames');
  assert.equal(sp.convertManifestPath('<winLocalAppDataLow>/Team Cherry/Hollow Knight'), 'AppData/LocalLow/Team Cherry/Hollow Knight');
  assert.equal(sp.convertManifestPath("<home>/Saved Games/Assassin's Creed Shadows/*.save"), "Saved Games/Assassin's Creed Shadows");
  assert.equal(sp.convertManifestPath('<home>/AppData/Roaming/X'), 'AppData/Roaming/X');
  assert.equal(sp.convertManifestPath('<winDocuments>'), null);
  assert.equal(sp.convertManifestPath('<winDocuments>/*'), null);
  assert.equal(sp.convertManifestPath('<base>/savegames/*.save'), null);
  assert.equal(sp.convertManifestPath('<root>/userdata/<storeUserId>/1/remote'), null);
  assert.equal(sp.convertManifestPath('<home>/Library/Application Support/X'), null);
  assert.equal(sp.convertManifestPath('<winProgramData>/X'), null);
});

test('buildIndex reduces the manifest to windows save paths + steam ids', async () => {
  const idx = await sp.buildIndex(SAMPLE.split('\n'), 123, '"etag1"');
  assert.equal(idx.etag, '"etag1"');
  // registry-only game: no paths → not indexed
  assert.equal(idx.games[sp.normalizeTitle('! That Bastard Is Trying To Steal Our Gold !')], undefined);
  assert.deepEqual(idx.games.anyway, { title: '!Anyway!', steam: 866510, paths: ['AppData/Local/anyway'] });
  // config-tagged and steam-userdata entries dropped; save path kept
  assert.deepEqual(idx.games.stellarblade, { title: 'Stellar Blade', steam: 3489700, paths: ['Documents/My Games/Stellar Blade/Saved/SaveGames'] });
  assert.equal(idx.bySteam['3489700'], 'stellarblade');
  assert.deepEqual(idx.games.assassinscreedshadows.paths, ['AppData/Local/Ubisoft Game Launcher/savegames', "Saved Games/Assassin's Creed Shadows"]);
  assert.equal(idx.games.maconlygame, undefined);
  assert.deepEqual(idx.games.quotedsingle.paths, ['AppData/Roaming/QuotedSingle/saves']);
});

test('goldbergAppId reads steam_appid.txt next to the exe, then in the game folder', () => {
  const files = { '/g/bin/steam_appid.txt': '3489700\n', '/h/steam_appid.txt': '12 extra' };
  const exists = (p) => Object.prototype.hasOwnProperty.call(files, p.replace(/\\/g, '/'));
  const read = (p) => files[p.replace(/\\/g, '/')];
  assert.equal(sp.goldbergAppId('/g/bin/game.exe', '/g', exists, read), '3489700');
  assert.equal(sp.goldbergAppId('/h/sub/game.exe', '/h', exists, read), '12');
  assert.equal(sp.goldbergAppId('/x/game.exe', '/x', exists, read), null);
});

test('detectPaths: Goldberg paths + manifest by steam id, else by title', async () => {
  const idx = await sp.buildIndex(SAMPLE.split('\n'));
  const byId = sp.detectPaths(idx, { name: 'Some Other Name', steamAppId: '3489700' });
  assert.deepEqual(byId.paths, [
    'AppData/Roaming/Goldberg SteamEmu Saves/3489700', 'AppData/Roaming/GSE Saves/3489700',
    'Documents/My Games/Stellar Blade/Saved/SaveGames',
  ]);
  assert.deepEqual(byId.notes, ['Steam emulator saves (app 3489700)', 'PCGamingWiki: Stellar Blade']);
  const byTitle = sp.detectPaths(idx, { name: "Assassin's Creed® Shadows", folder: '/nowhere', exe: null });
  assert.deepEqual(byTitle.paths, ['AppData/Local/Ubisoft Game Launcher/savegames', "Saved Games/Assassin's Creed Shadows"]);
  const miss = sp.detectPaths(idx, { name: 'Unknown Game', folder: null, exe: null });
  assert.deepEqual(miss, { paths: [], notes: [] });
  assert.deepEqual(sp.detectPaths(null, { name: 'Stellar Blade' }), { paths: [], notes: [] });
});

test('getIndex: caches, honors max age, keeps the stale copy when the fetch fails, 304 refreshes the stamp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-idx-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'idx.json');
  let calls = 0;
  const body = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(SAMPLE)); c.close(); } });
  const okFetch = async (url, init) => { calls++; return { status: 200, ok: true, headers: { get: (h) => (h === 'etag' ? '"e1"' : null) }, body: body(), text: async () => SAMPLE, init }; };
  const idx1 = await sp.getIndex(file, { fetch: okFetch });
  assert.equal(calls, 1);
  assert.equal(idx1.games.stellarblade.steam, 3489700);
  assert.ok(fs.existsSync(file));
  // fresh → no fetch
  const idx2 = await sp.getIndex(file, { fetch: okFetch });
  assert.equal(calls, 1);
  assert.equal(idx2.etag, '"e1"');
  // stale + failing fetch → stale copy
  const failing = async () => { calls++; throw new Error('offline'); };
  const idx3 = await sp.getIndex(file, { fetch: failing, maxAgeMs: 0 });
  assert.equal(calls, 2);
  assert.equal(idx3.games.stellarblade.steam, 3489700);
  // stale + 304 → same data, new stamp, etag sent
  let sentEtag = null;
  const notModified = async (url, init) => { sentEtag = init.headers['If-None-Match']; return { status: 304, ok: false, headers: { get: () => null }, body: null, text: async () => '' }; };
  const before = idx3.fetchedAt;
  const idx4 = await sp.getIndex(file, { fetch: notModified, maxAgeMs: 0 });
  assert.equal(sentEtag, '"e1"');
  assert.ok(idx4.fetchedAt >= before);
  assert.equal(idx4.games.anyway.steam, 866510);
});
