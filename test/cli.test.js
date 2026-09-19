// The Linux "run any .exe with Faugus" command line: argument parsing, title
// guessing, .desktop contents, and the run path (Faugus env stubbed).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('../dist/cli.js');

test('parseArgs: modes, flags, and a bare .exe from a file manager', () => {
  assert.deepEqual(cli.parseArgs([]), { mode: 'gui', shared: false, shortcut: true });
  assert.deepEqual(cli.parseArgs(['--run-exe', '/g/Game/game.exe']), { mode: 'run', exe: '/g/Game/game.exe', shared: false, shortcut: true });
  // "Open With" hands over just the path
  assert.deepEqual(cli.parseArgs(['/g/Game/game.exe']), { mode: 'run', exe: '/g/Game/game.exe', shared: false, shortcut: true });
  // a non-exe positional is not a run request (Chromium passes odd argv in dev)
  assert.equal(cli.parseArgs(['.', 'something']).mode, 'gui');
  const full = cli.parseArgs(['--run-exe', '/g/x.exe', '--title', 'My Game', '--shared-prefix', '--no-shortcut']);
  assert.deepEqual(full, { mode: 'run', exe: '/g/x.exe', title: 'My Game', shared: true, shortcut: false });
  // path given after the flag rather than next to it
  assert.equal(cli.parseArgs(['--run-exe', '--title', 'T', '/g/y.exe']).exe, '/g/y.exe');
  assert.equal(cli.parseArgs(['--pick']).mode, 'pick');
  assert.equal(cli.parseArgs(['--install-file-handler']).mode, 'install-handler');
  assert.equal(cli.parseArgs(['--uninstall-file-handler']).mode, 'uninstall-handler');
  assert.equal(cli.parseArgs(['--help']).mode, 'help');
});

test('guessTitle: the nearest folder that is not a bin-style one', () => {
  assert.equal(cli.guessTitle('/run/media/jason/Games/Maneater/bin/x64/Maneater.exe'), 'Maneater');
  assert.equal(cli.guessTitle('/home/jason/Games/Stellar Blade/SB/Binaries/Win64/SB-Win64-Shipping.exe'), 'SB');
  assert.equal(cli.guessTitle('/home/jason/Games/The_Witcher_3/bin/x64/witcher3.exe'), 'The Witcher 3');
  assert.equal(cli.guessTitle('/games/Doom [FitGirl Repack]/DOOM.exe'), 'Doom');
  // nothing usable above it → the file name
  assert.equal(cli.guessTitle('/home/game.exe'), 'game');
});

test('handlerDesktopContents claims the mime type real .exe files actually have', () => {
  const d = cli.handlerDesktopContents('/home/jason/Applications/RomM2SteamDeck.AppImage');
  assert.match(d, /^\[Desktop Entry\]$/m);
  assert.match(d, /^Exec=\/home\/jason\/Applications\/RomM2SteamDeck\.AppImage --run-exe %f$/m);
  // Faugus's own entry only lists x-ms-dos-executable, which modern .exe files are not
  assert.match(d, /MimeType=.*application\/vnd\.microsoft\.portable-executable/);
  assert.match(d, /^NoDisplay=true$/m);
  // a path with spaces is quoted for Exec
  assert.match(cli.handlerDesktopContents('/home/j/My Apps/R2SD.AppImage'), /^Exec="\/home\/j\/My Apps\/R2SD\.AppImage" --run-exe %f$/m);
});

test('gameDesktopContents matches the shape Faugus writes for its own shortcuts', () => {
  const d = cli.gameDesktopContents({
    title: 'Maneaters', gameId: 'maneaters', exePath: '/games/Maneater/bin/Maneater.exe',
    faugusBin: '/usr/bin/faugus-launcher', iconPath: '/home/j/.local/share/faugus-launcher/icons/maneaters.png',
  });
  assert.equal(d, [
    '[Desktop Entry]',
    'Name=Maneaters',
    'Exec=/usr/bin/faugus-launcher --game maneaters',
    'Icon=/home/j/.local/share/faugus-launcher/icons/maneaters.png',
    'Type=Application',
    'Categories=Game;',
    'Path=/games/Maneater/bin',
    '',
  ].join('\n'));
  // no icon path given → the key is left out rather than pointing at nothing
  assert.ok(!cli.gameDesktopContents({ title: 'X', gameId: 'x', exePath: '/g/x.exe', faugusBin: '/usr/bin/faugus-launcher' }).includes('Icon='));
});

// ── install / uninstall against a fake XDG dir ─────────────────────────────

function fakeDesktopEnv() {
  const files = {}; const ran = [];
  return {
    files, ran,
    homedir: '/home/j', xdgDataHome: '/home/j/.local/share',
    exists: (p) => p in files,
    writeFile: (p, data) => { files[p] = data; },
    remove: (p) => { delete files[p]; },
    mkdirp: () => {},
    run: (cmd, args) => ran.push([cmd, ...args].join(' ')),
  };
}

test('installFileHandler writes the entry and refreshes the desktop database', () => {
  const env = fakeDesktopEnv();
  const res = cli.installFileHandler('/home/j/Applications/R2SD.AppImage', env);
  const expected = '/home/j/.local/share/applications/' + cli.HANDLER_DESKTOP_ID;
  assert.deepEqual(res, { ok: true, file: expected });
  assert.match(env.files[expected], /--run-exe %f/);
  assert.deepEqual(env.ran, ['update-desktop-database /home/j/.local/share/applications']);

  cli.uninstallFileHandler(env);
  assert.equal(expected in env.files, false);

  // no launcher path (running from source) → refused with a reason, nothing written
  const env2 = fakeDesktopEnv();
  const bad = cli.installFileHandler('', env2);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /own path/);
  assert.deepEqual(Object.keys(env2.files), []);
});

// ── runExe, with Faugus stubbed ────────────────────────────────────────────

function fakeFaugusEnv(over = {}) {
  return {
    platform: 'linux', homedir: '/home/j', pathDirs: ['/usr/bin'],
    exists: (p) => p === '/usr/bin/faugus-launcher',
    readdir: () => [], readFile: () => { throw new Error('ENOENT'); },
    writeFile: () => {}, copyFile: () => {}, mkdirp: () => {},
    faugusUiRunning: () => false, xdgDataHome: '/home/j/.local/share',
    ...over,
  };
}

test('runExe rejects a missing file, a non-exe, and a missing Faugus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-cli-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'Game.exe');
  fs.writeFileSync(exe, 'MZ');
  const notExe = path.join(dir, 'readme.txt');
  fs.writeFileSync(notExe, 'hi');

  assert.match(cli.runExe(path.join(dir, 'nope.exe'), {}, fakeFaugusEnv(), fakeDesktopEnv()).error, /Not found/);
  assert.match(cli.runExe(notExe, {}, fakeFaugusEnv(), fakeDesktopEnv()).error, /Not a Windows program/);
  const noFaugus = cli.runExe(exe, {}, fakeFaugusEnv({ exists: () => false }), fakeDesktopEnv());
  assert.equal(noFaugus.ok, false);
  assert.match(noFaugus.error, /Faugus Launcher is not installed/);
});
