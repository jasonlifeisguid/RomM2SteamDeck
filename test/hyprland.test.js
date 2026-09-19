// Hyprland presentation: pid ancestry, Lua-then-classic dispatch, and the watcher
// that puts a game's windows on a fresh workspace. hyprctl and /proc are stubbed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const hypr = require('../dist/hyprland.js');

/** A fake compositor: clients list, pid tree, and a log of dispatches. Lua dialect on/off. */
function fakeHypr({ lua = true, clients = [], tree = {}, monitor = [3440, 1440] } = {}) {
  const calls = [];
  const state = { clients, nextWs: 3 };
  const hy = {
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'x' },
    ppid: (pid) => (pid in tree ? tree[pid] : null),
    hyprctl: async (args) => {
      calls.push(args.join(' '));
      if (args[0] === '-j' && args[1] === 'clients') return JSON.stringify(state.clients);
      if (args[0] === '-j' && args[1] === 'monitors') return JSON.stringify([{ focused: true, width: monitor[0], height: monitor[1], scale: 1 }]);
      if (args[0] !== 'dispatch') return '';
      const isLua = args[1].startsWith('hl.');
      if (isLua && !lua) return "error: [string ...]: ')' expected";
      if (!isLua && lua) return 'error: dispatch in lua is a shorthand';
      // apply moves / fullscreen to the fake state
      const addr = (args.join(' ').match(/address:(0x[0-9a-f]+)/) || [])[1];
      const c = state.clients.find((x) => x.address === addr);
      if (/window\.move|movetoworkspace/.test(args.join(' ')) && c) {
        const m = args.join(' ').match(/workspace = (\d+|"empty")|movetoworkspace(?:silent)? (\d+|empty),/);
        const ws = m ? (m[1] || m[2]) : null;
        c.workspace = { id: ws === '"empty"' || ws === 'empty' ? state.nextWs++ : Number(ws), name: '' };
      }
      if (/fullscreen/.test(args.join(' ')) && c) c.fullscreen = 2;
      return 'ok';
    },
  };
  return { hy, calls, state };
}

test('descendsFrom walks the parent chain and stops at init', () => {
  const tree = { 500: 400, 400: 300, 300: 100, 100: 1 };
  const ppid = (p) => (p in tree ? tree[p] : null);
  assert.equal(hypr.descendsFrom(500, 300, ppid), true);
  assert.equal(hypr.descendsFrom(500, 500, ppid), true);
  assert.equal(hypr.descendsFrom(500, 999, ppid), false);
  assert.equal(hypr.descendsFrom(42, 300, ppid), false); // unknown pid → no chain
});

test('gameWindows keeps mapped descendants and ignores R2SD / Faugus windows', async () => {
  const tree = { 900: 800, 800: 700, 700: 100, 950: 800, 42: 1 };
  const { hy } = fakeHypr({ tree, clients: [
    { address: '0x1', pid: 900, class: 'steam_app_default', mapped: true },
    { address: '0x2', pid: 950, class: 'faugus-launcher', mapped: true },
    { address: '0x3', pid: 42, class: 'firefox', mapped: true },
    { address: '0x4', pid: 900, class: 'steam_app_default', mapped: false },
  ] });
  const w = await hypr.gameWindows(hy, 700);
  assert.deepEqual(w.map((x) => x.address), ['0x1']);
});

test('dispatchers: Lua dialect first, classic fallback when the compositor rejects it', async () => {
  const luaBox = fakeHypr({ lua: true, clients: [{ address: '0xa', pid: 1, class: 'x', fullscreen: 0 }] });
  assert.equal(await hypr.fullscreen(luaBox.hy, '0xa'), true);
  assert.deepEqual(luaBox.calls.filter((c) => c.startsWith('dispatch')), ['dispatch hl.dsp.window.fullscreen({ window = "address:0xa", mode = 0 })']);

  const oldBox = fakeHypr({ lua: false, clients: [{ address: '0xa', pid: 1, class: 'x', fullscreen: 0 }] });
  assert.equal(await hypr.fullscreen(oldBox.hy, '0xa'), true);
  assert.deepEqual(oldBox.calls.filter((c) => c.startsWith('dispatch')), [
    'dispatch hl.dsp.window.fullscreen({ window = "address:0xa", mode = 0 })',
    'dispatch focuswindow address:0xa',
    'dispatch fullscreen 0',
  ]);
  assert.equal(await hypr.moveToWorkspace(oldBox.hy, '0xa', 'empty'), true);
  assert.ok(oldBox.calls.includes('dispatch movetoworkspace empty,address:0xa'));
});

test('presentGame: first window → fresh workspace + fullscreen; a later window joins it; splash dialogs stay windowed', async () => {
  const tree = { 900: 800, 800: 700, 901: 800, 902: 800 };
  const box = fakeHypr({ tree, clients: [] });
  let running = true;
  const keep = setInterval(() => {}, 50);
  const done = hypr.presentGame(box.hy, 700, { mode: 'fullscreen', intervalMs: 5, isRunning: () => running });
  // t+15ms: a small splash window, then the real game window, then a second full-size window
  setTimeout(() => box.state.clients.push({ address: '0x10', pid: 901, class: 'steam_app_default', mapped: true, fullscreen: 0, size: [400, 200], workspace: { id: 1 } }), 15);
  setTimeout(() => box.state.clients.push({ address: '0x11', pid: 900, class: 'steam_app_default', mapped: true, fullscreen: 0, size: [3440, 1440], workspace: { id: 1 } }), 40);
  setTimeout(() => box.state.clients.push({ address: '0x12', pid: 902, class: 'steam_app_default', mapped: true, fullscreen: 0, size: [2560, 1440], workspace: { id: 1 } }), 70);
  setTimeout(() => { running = false; }, 110);
  const r = await done;
  clearInterval(keep);
  assert.equal(r.windows, 3);
  assert.equal(r.workspace, 3);                                   // the "empty" workspace the fake handed out
  const by = Object.fromEntries(box.state.clients.map((c) => [c.address, c]));
  assert.equal(by['0x10'].workspace.id, 3); assert.equal(by['0x10'].fullscreen, 0);   // splash: moved, not fullscreened
  assert.equal(by['0x11'].workspace.id, 3); assert.equal(by['0x11'].fullscreen, 2);
  assert.equal(by['0x12'].workspace.id, 3); assert.equal(by['0x12'].fullscreen, 2);
  // later windows join silently (no workspace switch away from the game)
  assert.ok(box.calls.some((c) => c.includes('silent = true') && c.includes('0x11')));
});

test('presentGame gives up when no window ever appears', async () => {
  const box = fakeHypr({ clients: [] });
  const keep = setInterval(() => {}, 50);
  const r = await hypr.presentGame(box.hy, 700, { mode: 'workspace', intervalMs: 5, firstWindowTimeoutMs: 30, isRunning: () => true });
  clearInterval(keep);
  assert.deepEqual(r, { workspace: null, windows: 0 });
});
