// Binary VDF parser/serializer — the safety-critical half of "Add to Steam".
// Run with `npm test` (builds first; tests exercise the compiled dist/ output).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseVdf, serializeVdf, shortcutAppId, buildShortcutEntry, OVERLAY_STRIP_LAUNCH_OPTS } = require('../dist/steam.js');

// A hand-built shortcuts.vdf with one entry, matching Steam's layout.
function sampleVdf() {
  return {
    shortcuts: {
      '0': {
        appid: -1234567890,
        AppName: 'Balls',
        Exe: '"C:\\Games\\Balls\\balls.exe"',
        StartDir: 'C:\\Games\\Balls\\',
        icon: '',
        ShortcutPath: '',
        LaunchOptions: '',
        IsHidden: 0,
        AllowDesktopConfig: 1,
        AllowOverlay: 1,
        OpenVR: 0,
        Devkit: 0,
        DevkitGameID: '',
        DevkitOverrideAppID: 0,
        LastPlayTime: 1700000000,
        FlatpakAppID: '',
        sortas: '',
        tags: { '0': 'RomM', '1': 'favorite' },
      },
    },
  };
}

test('serialize → parse round-trips a synthetic shortcuts map', () => {
  const buf = serializeVdf(sampleVdf());
  assert.deepEqual(parseVdf(buf), sampleVdf());
});

test('parse → serialize reproduces the bytes exactly (the safety gate)', () => {
  const original = serializeVdf(sampleVdf());
  assert.ok(serializeVdf(parseVdf(original)).equals(original));
});

test('int32 values keep their sign and full range', () => {
  const map = { m: { neg: -1, min: -2147483648, max: 2147483647, zero: 0 } };
  assert.deepEqual(parseVdf(serializeVdf(map)), map);
});

test('utf-8 strings survive (names with accents / CJK)', () => {
  const map = { shortcuts: { '0': { AppName: 'Pokémon — ポケモン', Exe: '"/tmp/é.AppImage"' } } };
  assert.deepEqual(parseVdf(serializeVdf(map)), map);
});

test('unsupported value types are rejected rather than guessed', () => {
  const buf = Buffer.from([0x03, 0x6b, 0x00, 0x08]); // type 0x03 (float) is not handled
  assert.throws(() => parseVdf(buf), /Unsupported VDF type 0x3/);
});

test('a truncated file (no 0x08 terminator) is rejected', () => {
  const buf = serializeVdf(sampleVdf()).subarray(0, 40);
  assert.throws(() => parseVdf(buf), /Unexpected end of VDF|Unsupported VDF type/);
});

test('shortcutAppId is deterministic, has the high bit set, and is a signed int32', () => {
  const a = shortcutAppId('"/x/game.exe"', 'Game');
  const b = shortcutAppId('"/x/game.exe"', 'Game');
  assert.equal(a, b);
  assert.ok(Number.isInteger(a));
  assert.ok(a < 0, 'high bit set ⇒ negative as int32');
  assert.ok(((a >>> 0) & 0x80000000) !== 0);
  assert.notEqual(a, shortcutAppId('"/x/game.exe"', 'Other'));
});

test('buildShortcutEntry serializes and parses back unchanged', () => {
  const exe = path.join(os.tmpdir(), 'RomM2SteamDeck.AppImage');
  const entry = buildShortcutEntry(exe, 'RomM2SteamDeck', { tags: ['RomM'], overlayOff: true });
  assert.equal(entry.Exe, `"${exe}"`);
  assert.equal(entry.AllowOverlay, 0);
  assert.equal(entry.LaunchOptions, OVERLAY_STRIP_LAUNCH_OPTS);
  assert.ok(entry.StartDir.endsWith(path.sep));
  const root = { shortcuts: { '0': entry } };
  assert.deepEqual(parseVdf(serializeVdf(root)), root);
});

test('game shortcuts keep the overlay on by default', () => {
  const entry = buildShortcutEntry('/games/x/x.exe', 'X');
  assert.equal(entry.AllowOverlay, 1);
  assert.equal(entry.LaunchOptions, '');
});

// Real-world fixture: the byte-exact round trip against an actual Steam file
// on this machine, when one exists. Skipped elsewhere.
const realCandidates = [];
if (process.platform === 'win32') {
  const root = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const userdata = path.join(root, 'Steam', 'userdata');
  if (fs.existsSync(userdata)) {
    for (const u of fs.readdirSync(userdata)) realCandidates.push(path.join(userdata, u, 'config', 'shortcuts.vdf'));
  }
} else {
  realCandidates.push(path.join(os.homedir(), '.steam', 'steam', 'userdata'));
}
const realFile = realCandidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());

test('real shortcuts.vdf on this machine round-trips byte-for-byte', { skip: !realFile && 'no Steam shortcuts.vdf found' }, () => {
  const original = fs.readFileSync(realFile);
  const parsed = parseVdf(original);
  assert.ok(parsed.shortcuts && typeof parsed.shortcuts === 'object');
  assert.ok(serializeVdf(parsed).equals(original), 'serializer must reproduce Steam\'s own bytes');
});
