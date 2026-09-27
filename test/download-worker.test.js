// Downloads through the worker-thread pump (download-worker.ts + pump.ts),
// against a real local HTTP server that can honour or ignore Range, cut the
// connection mid-file, go silent, or serve slowly — the cases the stub
// Response in downloads.test.js can't produce. Every test also checks which
// pump actually ran.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const config = require('../dist/config.js');
const downloads = require('../dist/downloads.js');

const EXTRACT = 1;
const PLAIN = 2;
const tempRoots = [];
test.after(() => { for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true }); });
test.afterEach(() => { downloads.setDownloadWorkerForTests(null); downloads.setTimeoutsForTests(null); });

function makeTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2sd-dlw-'));
  tempRoots.push(root);
  const userData = path.join(root, 'userdata');
  const install = path.join(root, 'install');
  const loose = path.join(root, 'loose');
  for (const d of [userData, install, loose]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    baseUrl: 'http://romm.test', username: 'u', passwordEncrypted: '',
    platforms: {
      [EXTRACT]: { folder: '', autoExtract: true, installPaths: [install] },
      [PLAIN]: { folder: loose, autoExtract: false, installPaths: [] },
    },
  }));
  config.setUserDataDirForTests(userData);
  downloads.setUserDataDirForTests(userData);
  return { root, install, loose };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Serves `data` as `fileName` with Content-Length, ETag and Range support.
 * behaviour: { cutFirstAt: n }   first response is cut after n bytes
 *            { ignoreRange }     always 200 with the full body (RomM's on-the-fly zips)
 *            { silentAfter: n }  send headers + n bytes, then nothing (connection stays open)
 *            { slow }            4 KB every 10 ms
 *            { status: 404 }
 */
async function serve(t, data, fileName, behaviour = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range || null, ifRange: req.headers['if-range'] || null });
    if (behaviour.status) { res.writeHead(behaviour.status, 'Nope'); res.end(); return; }
    const headers = { 'content-disposition': `attachment; filename="${fileName}"`, etag: '"v1"', 'accept-ranges': 'bytes' };
    let body = data;
    const m = !behaviour.ignoreRange && req.headers.range && /^bytes=(\d+)-$/.exec(req.headers.range);
    if (m && req.headers['if-range'] === '"v1"') {
      const from = Number(m[1]);
      body = data.subarray(from);
      res.writeHead(206, { ...headers, 'content-length': body.length, 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` });
    } else {
      res.writeHead(200, { ...headers, 'content-length': data.length });
    }
    if (behaviour.cutFirstAt && requests.length === 1) {
      res.write(body.subarray(0, behaviour.cutFirstAt), () => res.socket.destroy());
    } else if (behaviour.silentAfter !== undefined) {
      res.write(body.subarray(0, behaviour.silentAfter)); // …and never finish
    } else if (behaviour.slow) {
      let pos = 0;
      const tick = setInterval(() => {
        if (res.destroyed) { clearInterval(tick); return; }
        res.write(body.subarray(pos, pos + 4096));
        pos += 4096;
        if (pos >= body.length) { clearInterval(tick); res.end(); }
      }, 10);
    } else {
      res.end(body);
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/rom`;
  const client = {
    // What the real RommClient provides: the worker makes the request itself…
    downloadRequest: (_id, _fsName, resume) => {
      const headers = { Authorization: 'Basic x' };
      if (resume && resume.from > 0) {
        headers.Range = `bytes=${resume.from}-`;
        if (resume.ifRange) headers['If-Range'] = resume.ifRange;
      }
      return { url, headers };
    },
    // …and the in-process fallback uses this.
    openDownloadStream: async (id, fsName, signal, resume) => {
      const { headers } = client.downloadRequest(id, fsName, resume);
      const r = await fetch(url, { headers, signal });
      if (!r.ok) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
      return r;
    },
  };
  return { client, requests };
}

async function run(client, rom) {
  const events = [];
  await downloads.startDownload(client, rom, '', (e) => events.push(e));
  return events;
}
const plainRom = (id) => ({ id, name: `Plain ${id}`, fsName: 'game.bin', platformId: PLAIN, size: 0 });

/** Stored zip (no compression), enough for the streaming parser. */
function zipOf(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content); const nb = Buffer.from(name); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('worker: a plain download arrives byte-exact, with progress, same as the in-process pump', async (t) => {
  const tmp = makeTemp();
  const data = crypto.randomBytes(6 * 1024 * 1024 + 123);
  const { client } = await serve(t, data, 'game.bin');

  const events = await run(client, plainRom(41));
  assert.equal(events.at(-1).status, 'complete', JSON.stringify(events.at(-1)));
  assert.equal(downloads.lastTransferKindForTests(), 'worker');
  assert.equal(sha(fs.readFileSync(path.join(tmp.loose, 'game.bin'))), sha(data));
  assert.ok(events.some((e) => e.status === 'downloading' && e.downloaded > 0), 'progress reached the main process');
  assert.equal(downloads.findDownload(41).size, data.length);

  // The in-process pump, same server, same bytes.
  downloads.setDownloadWorkerForTests({ disabled: true });
  fs.rmSync(path.join(tmp.loose, 'game.bin'));
  const again = await run(client, plainRom(42));
  assert.equal(again.at(-1).status, 'complete');
  assert.equal(downloads.lastTransferKindForTests(), 'main');
  assert.equal(sha(fs.readFileSync(path.join(tmp.loose, 'game.bin'))), sha(data));
});

test('worker: a zip is extracted while it downloads, without the 7za fallback', async (t) => {
  const tmp = makeTemp();
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  const { client } = await serve(t, zipOf([['Game/data.bin', payload], ['Game/run.exe', 'MZ']]), 'game.zip');

  const events = await run(client, { id: 43, name: 'Zip', fsName: 'game.zip', platformId: EXTRACT, size: 0 });
  assert.equal(events.at(-1).status, 'extracted', JSON.stringify(events.at(-1)));
  assert.equal(downloads.lastTransferKindForTests(), 'worker');
  assert.ok(!events.some((e) => e.status === 'extracting'), 'no 7za fallback');
  assert.equal(sha(fs.readFileSync(path.join(tmp.install, 'Game', 'data.bin'))), sha(payload));
  assert.equal(fs.existsSync(path.join(tmp.install, '.r2sd-extract-43')), false, 'staging cleaned up');
});

test('worker: a connection cut mid-file is retried and resumed with Range + If-Range', async (t) => {
  downloads.setTimeoutsForTests({ retryDelaysMs: [20, 20] });
  const tmp = makeTemp();
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const { client, requests } = await serve(t, data, 'game.bin', { cutFirstAt: 1024 * 1024 });

  const events = await run(client, plainRom(44));
  assert.equal(events.at(-1).status, 'complete', JSON.stringify(events.at(-1)));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].range, null);
  assert.match(requests[1].range, /^bytes=\d+-$/, 'second request resumes');
  assert.ok(Number(requests[1].range.slice(6, -1)) > 0);
  assert.equal(requests[1].ifRange, '"v1"');
  assert.equal(sha(fs.readFileSync(path.join(tmp.loose, 'game.bin'))), sha(data));
  assert.equal(fs.existsSync(path.join(tmp.loose, '.r2sd-resume-44.json')), false, 'resume note removed');
});

test('worker: a server that ignores Range restarts from byte 0 (the on-the-fly zip case)', async (t) => {
  downloads.setTimeoutsForTests({ retryDelaysMs: [20, 20] });
  const tmp = makeTemp();
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const { client, requests } = await serve(t, data, 'game.bin', { cutFirstAt: 1024 * 1024, ignoreRange: true });

  const events = await run(client, plainRom(45));
  assert.equal(events.at(-1).status, 'complete', JSON.stringify(events.at(-1)));
  assert.ok(requests[1].range, 'asked to resume…');
  assert.equal(sha(fs.readFileSync(path.join(tmp.loose, 'game.bin'))), sha(data), '…got the whole file, written from 0');
});

test('worker: a server that goes silent is detected by the stall watchdog, and the partial is kept', async (t) => {
  downloads.setTimeoutsForTests({ stallMs: 600, retryDelaysMs: [20, 20] });
  const tmp = makeTemp();
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const { client, requests } = await serve(t, data, 'game.bin', { silentAfter: 256 * 1024 });

  const events = await run(client, plainRom(46));
  const last = events.at(-1);
  assert.equal(last.status, 'error', JSON.stringify(last));
  assert.match(last.message, /stopped responding/);
  assert.equal(requests.length, 3, 'one try + two retries');
  assert.ok(fs.statSync(path.join(tmp.loose, 'game.bin.part')).size > 0, '.part kept for a later resume');
  assert.ok(fs.existsSync(path.join(tmp.loose, '.r2sd-resume-46.json')));
});

test('worker: cancel mid-download stops it at once and leaves nothing behind', async (t) => {
  const tmp = makeTemp();
  const data = crypto.randomBytes(8 * 1024 * 1024); // ~20 s at the slow rate: only a cancel ends it in time
  const { client } = await serve(t, data, 'game.bin', { slow: true });

  const started = Date.now();
  const done = run(client, plainRom(47));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(downloads.cancelDownload(47), true);
  const events = await done;
  assert.equal(events.at(-1).status, 'cancelled', JSON.stringify(events.at(-1)));
  assert.ok(Date.now() - started < 5000, 'cancel took effect promptly');
  assert.equal(downloads.lastTransferKindForTests(), 'worker');
  assert.deepEqual(fs.readdirSync(tmp.loose), [], 'no .part, no resume note');
});

test('worker: an HTTP error is reported with its status and not retried', async (t) => {
  makeTemp();
  const { client, requests } = await serve(t, Buffer.alloc(10), 'game.bin', { status: 404 });
  const events = await run(client, plainRom(48));
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).message, /^Download failed: 404/);
  assert.equal(requests.length, 1);
});

test('a worker that cannot start falls back to the in-process pump', async (t) => {
  const tmp = makeTemp();
  downloads.setDownloadWorkerForTests({ script: path.join(tmp.root, 'no-such-worker.js') });
  const data = crypto.randomBytes(1024 * 1024);
  const { client } = await serve(t, data, 'game.bin');

  const events = await run(client, plainRom(49));
  assert.equal(events.at(-1).status, 'complete', JSON.stringify(events.at(-1)));
  assert.equal(downloads.lastTransferKindForTests(), 'main');
  assert.equal(sha(fs.readFileSync(path.join(tmp.loose, 'game.bin'))), sha(data));
});
