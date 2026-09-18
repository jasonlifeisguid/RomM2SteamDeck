// Release check: version compare and the GitHub response shape.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions, checkForUpdate, RELEASES_API } = require('../dist/updates.js');
const { watchGameExit } = require('../dist/shortcuts.js');

test('compareVersions: numeric, tolerant of v prefix and length, pre-releases sort first', () => {
  assert.equal(compareVersions('2.2.20', '2.2.19'), 1);
  assert.equal(compareVersions('v2.2.19', '2.2.19'), 0);
  assert.equal(compareVersions('2.2.9', '2.2.10'), -1);
  assert.equal(compareVersions('2.3', '2.2.19'), 1);
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
  assert.equal(compareVersions('2.2.20-beta', '2.2.20'), -1);
  assert.equal(compareVersions('2.2.20', '2.2.20-beta'), 1);
});

test('checkForUpdate reports newer/not-newer from the latest-release payload', async () => {
  const payload = { tag_name: 'v2.2.20', html_url: 'https://github.com/jasonlifeisguid/RomM2SteamDeck/releases/tag/v2.2.20', published_at: '2026-09-17T00:00:00Z', body: 'notes' };
  let asked = null;
  const fetchJson = async (url) => { asked = url; return { status: 200, json: payload }; };
  const info = await checkForUpdate('2.2.19', fetchJson);
  assert.equal(asked, RELEASES_API);
  assert.equal(info.newer, true);
  assert.equal(info.latest, '2.2.20');
  assert.equal(info.url, payload.html_url);
  const same = await checkForUpdate('2.2.20', fetchJson);
  assert.equal(same.newer, false);
  await assert.rejects(checkForUpdate('2.2.19', async () => ({ status: 403, json: null })), /403/);
  await assert.rejects(checkForUpdate('2.2.19', async () => ({ status: 200, json: {} })), /No release tag/);
});

test('watchGameExit waits for the child AND for the install folder to go quiet', async () => {
  // Launcher stub: our child exits at once, the real game (in the folder) runs for a while.
  let exited = false; let running = 3;
  const keepAlive = setInterval(() => {}, 100); // the watcher's timers are unref'd on purpose
  const counts = [];
  const countRunning = async () => { counts.push(running); return running; };
  const done = new Promise((resolve) => {
    watchGameExit('C:\\Games\\X', () => exited, resolve, { intervalMs: 5, firstDelayMs: 5, countRunning });
  });
  setTimeout(() => { exited = true; }, 20);
  setTimeout(() => { running = 0; }, 60);
  await done;
  clearInterval(keepAlive);
  // While the child was alive nothing was polled; afterwards the folder was seen busy before two idle ticks
  assert.ok(counts.some((c) => c > 0));
  assert.deepEqual(counts.slice(-2), [0, 0]);
});
