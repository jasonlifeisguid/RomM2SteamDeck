// The bundled 7-Zip (vendor/7zip): found, runnable, and the version we vetted.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawnSync } = require('child_process');

const { sevenZipPath } = require('../dist/sevenzip.js');

// Bump together with vendor/7zip/README.md when the binaries are updated.
const EXPECTED_VERSION = '26.03';

test('the bundled 7-Zip for this platform exists, runs, and is the vetted version', () => {
  const bin = sevenZipPath();
  assert.ok(fs.existsSync(bin), `missing: ${bin}`);
  const r = spawnSync(bin, ['i'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/7-Zip \([az]\) (\d+\.\d+)/);
  assert.ok(m, `unexpected banner: ${r.stdout.slice(0, 120)}`);
  assert.equal(m[1], EXPECTED_VERSION);
});
