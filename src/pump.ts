/**
 * The byte-moving half of a download: response body → `<file>.part`, and for
 * a zip on an auto-extract platform the same bytes into a streaming zip
 * parser that extracts into the staging folder as they arrive.
 *
 * Runs inside the download worker (download-worker.ts), off the Electron main
 * thread, or — if the worker can't be used — in the main process. So: no
 * Electron imports here, and nothing that needs the app's state; every
 * decision (resume, file name, space, retries, records) stays in downloads.ts.
 */
import { once } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from './fsutil';

const unzipper = require('unzipper');

/**
 * Size of one batch of .part writes (see BatchWriter). Measured on a 10 GbE
 * download to an SSD: 1 MB 296 MB/s, 16 MB 504 MB/s (the network's limit),
 * 64 MB no better. At most two batches are held in memory.
 */
export const WRITE_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Double-buffered file writer: one writev in flight while the next batch
 * fills, and the caller only waits when that next batch is full as well — so
 * network reads and disk writes genuinely overlap. fs.WriteStream can't do
 * that: its 'drain' fires only once everything, including the write in
 * flight, is on disk, so a pump waiting for it alternated between reading and
 * writing (~320 MB/s where either side alone managed ~520). Matters on slow
 * disks too: the Deck's SD card keeps being written while the next batch
 * downloads.
 */
class BatchWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private inflight: Promise<void> | null = null;
  private error: Error | null = null;

  private constructor(private readonly fd: number, private readonly batchBytes: number) {}

  static open(file: string, append: boolean, batchBytes: number): BatchWriter {
    return new BatchWriter(fs.openSync(file, append ? 'a' : 'w'), batchBytes);
  }

  /** Queue a chunk. Resolves at once unless a full batch is already waiting. */
  async write(chunk: Buffer): Promise<void> {
    if (this.error) throw this.error;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (!this.inflight) this.flush();
    else if (this.pendingBytes >= this.batchBytes) await this.inflight;
    if (this.error) throw this.error;
  }

  private flush(): void {
    const bufs = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.inflight = new Promise<void>((resolve) => {
      fs.writev(this.fd, bufs, (err) => {
        if (err) this.error = err;
        this.inflight = null;
        if (this.pending.length && !this.error) this.flush();
        resolve();
      });
    });
  }

  /** Write out everything queued, then close. Throws the first write error. */
  async close(): Promise<void> {
    try {
      while (this.inflight) await this.inflight;
      if (this.pending.length && !this.error) {
        this.flush();
        while (this.inflight) await this.inflight;
      }
    } finally {
      fs.closeSync(this.fd);
    }
    if (this.error) throw this.error;
  }
}
/** How often progress is reported (and, from the worker, posted to main). */
export const PROGRESS_INTERVAL_MS = 250;

export interface PumpOptions {
  partPath: string;
  /** Continue an existing .part (a 206 resume) instead of starting it over. */
  append: boolean;
  /** Bytes already in the .part (progress counts from here). */
  startAt: number;
  /** Size of the whole file, 0 when the server didn't say. */
  total: number;
  /** Existing staging folder to extract a zip into while downloading, or null. */
  extractTo: string | null;
  /** No bytes for this long → onStall(). */
  stallMs: number;
}

export interface PumpHooks {
  onProgress(downloaded: number, inlineExtract: boolean): void;
  /** No data for stallMs: abort the request (the pending read then rejects). */
  onStall(): void;
}

export interface PumpResult {
  downloaded: number;
  /** The zip was fully extracted into extractTo while downloading. */
  inlineExtracted: boolean;
}

export async function pumpToFile(body: ReadableStream<Uint8Array>, o: PumpOptions, hooks: PumpHooks): Promise<PumpResult> {
  // Streaming zip extractor. Only possible from byte 0 — a zip stream can't
  // be joined mid-file — so the caller passes extractTo only for fresh zips.
  let extractor: any = null;
  let extractorFailed = false;
  const entryWrites: Promise<void>[] = [];
  let extractorClosed: Promise<void> = Promise.resolve();
  // Resolves the moment any part of inline extraction fails, so the pump
  // never sits waiting for a 'drain' from a parser that has stopped.
  let signalFailed: () => void = () => {};
  const extractorFailedP = new Promise<void>((resolve) => { signalFailed = resolve; });
  const failExtractor = () => { extractorFailed = true; signalFailed(); };

  if (o.extractTo) {
    const staging = o.extractTo;
    extractor = unzipper.Parse();
    extractorClosed = new Promise<void>((resolve) => {
      extractor.on('close', resolve);
      extractor.on('error', () => { failExtractor(); resolve(); });
    });
    extractor.on('entry', (entry: any) => {
      const target = safeJoin(staging, entry.path);
      if (!target || extractorFailed) { entry.autodrain(); return; }
      // Never let a filesystem error escape this listener (illegal name,
      // path too long, a file where a directory is needed, disk full…).
      // unzipper turns a throw here into an 'error' event today, but
      // relying on that is fragile — and with the old await-per-write
      // pump it hung the download outright (PR #5, vlapietra). Failing
      // the extractor explicitly routes us to the 7za fallback.
      try {
        if (entry.type === 'Directory') {
          fs.mkdirSync(target, { recursive: true });
          entry.autodrain();
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
      } catch {
        failExtractor();
        entry.autodrain();
        return;
      }
      entryWrites.push(new Promise<void>((resolve) => {
        const out = fs.createWriteStream(target);
        entry.pipe(out);
        out.on('finish', resolve);
        out.on('error', () => { failExtractor(); entry.autodrain(); resolve(); });
        entry.on('error', () => { failExtractor(); entry.autodrain(); resolve(); });
      }));
    });
  }

  // Pump: chunk → part file AND (optionally) extractor. We only wait when
  // a writer's buffer is full, so network reads and disk writes overlap.
  // (Awaiting every write's completion serialized the two, making a download
  // take roughly network time PLUS disk time — noticeable on the Deck's SD
  // card.)
  const out = BatchWriter.open(o.partPath, o.append, WRITE_BATCH_BYTES);
  let outClosed = false;

  let downloaded = o.startAt;
  let lastEmit = 0;
  let lastData = Date.now();
  // Stall watchdog: a connection that dies without closing would other-
  // wise block reader.read() forever (and the serial queue behind it).
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > o.stallMs) hooks.onStall();
  }, Math.min(5000, o.stallMs));

  try {
    try {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastData = Date.now();
        // Wrap, don't copy: Buffer.from(value) copied every byte (~20% of
        // the pump's CPU per GB). The chunk is ours alone once read() hands
        // it over, and nothing below mutates it.
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        await out.write(chunk);
        if (extractor && !extractorFailed) {
          try {
            if (!extractor.write(chunk)) await Promise.race([once(extractor, 'drain'), extractorClosed, extractorFailedP]);
          } catch { failExtractor(); }
        }
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastEmit > PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          hooks.onProgress(downloaded, Boolean(extractor && !extractorFailed));
        }
      }
    } finally {
      clearInterval(watchdog);
    }

    outClosed = true;
    await out.close();

    if (downloaded === 0) {
      throw new Error('Server sent an empty file — this rom appears to be 0 bytes in the RomM library');
    }
    if (o.total > 0 && downloaded < o.total) {
      throw new Error(`Connection closed early — got ${downloaded} of ${o.total} bytes`);
    }
  } catch (err) {
    // Flush and close the .part (it stays for a resume, which continues from
    // its size on disk — so don't throw away what's still in the buffer);
    // a half-fed parser is dropped — the caller clears the staging folder.
    if (!outClosed) await out.close().catch(() => { /* write error: closed anyway */ });
    if (extractor) { try { extractor.destroy(); } catch { /* already closed */ } }
    throw err;
  }

  // Complete: let inline extraction finish writing its last entries.
  let inlineExtracted = false;
  if (extractor && !extractorFailed) {
    extractor.end();
    await extractorClosed;
    await Promise.all(entryWrites);
    inlineExtracted = !extractorFailed;
  }
  if (extractor && !inlineExtracted) {
    try { extractor.destroy(); } catch { /* already closed */ }
  }
  return { downloaded, inlineExtracted };
}
