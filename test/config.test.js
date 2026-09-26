// Settings defaults and normalization, against a throwaway userData dir.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../dist/config.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Point config.ts at a fresh userData dir, optionally pre-seeded with a config.json. */
function withConfig(stored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-cfg-'));
  dirs.push(dir);
  if (stored) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(stored));
  config.setUserDataDirForTests(dir);
  return dir;
}

test('a fresh install leaves the game window to the compositor', () => {
  withConfig(null);
  const cfg = config.getPublicConfig();
  assert.equal(cfg.playWorkspace, 'off', 'R2SD must not rearrange windows unless asked');
  assert.equal(cfg.playWindow, 'minimize');
});

test('an explicit choice is kept, and anything unrecognized falls back to off', () => {
  withConfig({ playWorkspace: 'fullscreen' });
  assert.equal(config.getPublicConfig().playWorkspace, 'fullscreen');

  withConfig({ playWorkspace: 'workspace' });
  assert.equal(config.getPublicConfig().playWorkspace, 'workspace');

  withConfig({ playWorkspace: 'nonsense' });
  assert.equal(config.getPublicConfig().playWorkspace, 'off');

  withConfig({ playWorkspace: 42 });
  assert.equal(config.getPublicConfig().playWorkspace, 'off');
});

test('setConfig round-trips each mode and rejects junk', () => {
  const dir = withConfig(null);
  assert.equal(config.setConfig({ playWorkspace: 'fullscreen' }).playWorkspace, 'fullscreen');
  assert.equal(config.setConfig({ playWorkspace: 'workspace' }).playWorkspace, 'workspace');
  assert.equal(config.setConfig({ playWorkspace: 'off' }).playWorkspace, 'off');
  assert.equal(config.setConfig({ playWorkspace: 'sideways' }).playWorkspace, 'off');
  // persisted, not just in memory
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.playWorkspace, 'off');
});

test('cloudSaves accepts off / ask / auto and falls back to off', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const config = require('../dist/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-cfg-ask-'));
  try {
    config.setUserDataDirForTests(dir);
    assert.equal(config.getPublicConfig().cloudSaves, 'off', 'default');
    for (const v of ['ask', 'auto', 'off']) assert.equal(config.setConfig({ cloudSaves: v }).cloudSaves, v);
    assert.equal(config.setConfig({ cloudSaves: 'sometimes' }).cloudSaves, 'off');
  } finally { config.setUserDataDirForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});
