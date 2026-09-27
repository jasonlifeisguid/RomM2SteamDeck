// pump.ts on its own: the double-buffered .part writer's two promises —
// network reads continue while a write is on its way to disk, and read-ahead
// is bounded — checked by behaviour (a deliberately slow fs.writev), not by
// timing, so the tests say the same on a fast box, a loaded one, or the Deck.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pump = require('../dist/pump.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-pump-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CHUNK = 64 * 1024;
const BATCH = pump.WRITE_BATCH_BYTES;
const opts = (partPath, total) => ({ partPath, append: false, startAt: 0, total, extractTo: null, stallMs: 60_000 });
const hooks = { onProgress() {}, onStall() {} };

/** A body that makes deterministic bytes on demand and reports each pull. */
function body(total, onPull) {
  let pulled = 0;
  return new ReadableStream({
    pull(c) {
      if (pulled >= total) { c.close(); return; }
      const n = Math.min(CHUNK, total - pulled);
      const chunk = new Uint8Array(n);
      for (let i = 0; i < n; i += 4096) chunk[i] = (pulled + i) % 251;
      c.enqueue(chunk);
      pulled += n;
      onPull(pulled);
    },
  }, { highWaterMark: 0 });
}

/** Replace fs.writev for the duration of fn; `wrap(orig)` returns the stand-in. */
async function withWritev(wrap, fn) {
  const orig = fs.writev;
  fs.writev = wrap(orig);
  try { return await fn(); } finally { fs.writev = orig; }
}

function expected(total) {
  const b = Buffer.alloc(total);
  for (let pos = 0; pos < total; pos += CHUNK) for (let i = 0; i < Math.min(CHUNK, total - pos); i += 4096) b[pos + i] = (pos + i) % 251;
  return b;
}

test('reads keep flowing while a write is in flight, read-ahead stays bounded, bytes land exact', async () => {
  const total = 3 * BATCH + 12345;
  const partPath = path.join(tmp, 'slow.part');
  let inflight = 0;
  let written = 0;
  let pullsThisWrite = 0; // chunks read from the network since the current write started
  let mostPullsInOneWrite = 0;
  let maxAhead = 0;

  const result = await withWritev(
    (orig) => (fd, bufs, cb) => {
      inflight++;
      pullsThisWrite = 0;
      setTimeout(() => orig(fd, bufs, (err, n) => { inflight--; written += n || 0; cb(err, n); }), 40); // a slow disk
    },
    () => pump.pumpToFile(body(total, (pulled) => {
      if (inflight) mostPullsInOneWrite = Math.max(mostPullsInOneWrite, ++pullsThisWrite);
      maxAhead = Math.max(maxAhead, pulled - written);
    }), opts(partPath, total), hooks)
  );

  assert.equal(result.downloaded, total);
  // Overlap: while one batch is on its way to disk, (most of) the next batch
  // is read. A pump that waits for each write reads at most a chunk or two.
  assert.ok(mostPullsInOneWrite >= BATCH / CHUNK / 2, `a batch's worth read during one write (got ${mostPullsInOneWrite} chunks)`);
  // One batch on its way to disk + one filling (+ the chunk that tipped it over).
  assert.ok(maxAhead <= 2 * BATCH + 2 * CHUNK, `read-ahead bounded: ${maxAhead} bytes`);
  assert.ok(fs.readFileSync(partPath).equals(expected(total)), 'file is byte-exact');
});

test('a disk error mid-download is reported, not swallowed, and the .part is closed', async () => {
  const total = 3 * BATCH;
  const partPath = path.join(tmp, 'fail.part');
  let calls = 0;
  await withWritev(
    (orig) => (fd, bufs, cb) => {
      if (++calls === 2) { setImmediate(() => cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))); return; }
      orig(fd, bufs, cb);
    },
    () => assert.rejects(pump.pumpToFile(body(total, () => {}), opts(partPath, total), hooks), /ENOSPC/)
  );
  // Closed: the file can be removed and recreated on every platform.
  fs.rmSync(partPath);
  assert.equal(fs.existsSync(partPath), false);
});

test('resume appends to the existing .part', async () => {
  const partPath = path.join(tmp, 'resume.part');
  const head = crypto.randomBytes(1000);
  fs.writeFileSync(partPath, head);
  const total = 5 * CHUNK;
  const r = await pump.pumpToFile(body(total, () => {}), { ...opts(partPath, 0), append: true, startAt: head.length }, hooks);
  assert.equal(r.downloaded, head.length + total);
  assert.ok(fs.readFileSync(partPath).equals(Buffer.concat([head, expected(total)])));
});
