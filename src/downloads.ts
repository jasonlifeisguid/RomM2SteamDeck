/**
 * Download manager: streaming downloads with progress, cancel, extraction,
 * tracking, delete, and filesystem sync.
 *
 * Extraction strategy (the Steam-style trick):
 *  - .zip + auto-extract: extracted WHILE downloading. Each network chunk is
 *    written to the archive file on disk AND fed to a streaming zip parser,
 *    with backpressure tied to both. If the parser chokes (exotic zip), we
 *    finish the download and fall back to extracting the on-disk archive
 *    with the bundled 7za.
 *  - .7z: not streamable by design (solid blocks, trailing metadata) —
 *    download fully, then extract with bundled 7za (progress parsed from
 *    its output).
 *
 * Every archive is extracted into a private staging folder inside the install
 * path (`.r2sd-extract-<romId>/`) and only then moved to its final name. That
 * gives each game exactly one folder regardless of how the archive was laid
 * out: a single top-level directory is moved as-is; a flat archive (files at
 * the root) or one with several top-level entries becomes `<rom name>/`.
 * Before this, a flat archive left the game's files loose in the install root
 * and the tracking record pointed at whichever subfolder came first — so
 * "delete" removed only that subfolder and the exe scanner never saw the exe.
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { RommClient } from './romm';
import * as config from './config';
import { safeJoin, sanitizeForMatch, sanitizeFolderName } from './fsutil';

const unzipper = require('unzipper');
// In a packaged app the 7za binary is unpacked from the asar archive (see
// asarUnpack in package.json); rewrite the path so spawn can find it.
// In dev the path has no app.asar segment, so the replace is a no-op.
const path7za = (require('7zip-bin').path7za as string).replace('app.asar', 'app.asar.unpacked');

export interface DownloadRecord {
  romId: number;
  romName: string;
  fileName: string;
  filePath: string; // file for standard downloads, game folder for extracted ('' if unknown)
  platformId: number;
  size: number;
  downloadedAt: number;
  defaultExe?: string; // chosen executable for Play / shortcuts
}

export interface RomInfo {
  id: number;
  name: string;
  fsName: string;
  platformId: number;
  size: number;
}

export type EventSender = (payload: Record<string, unknown>) => void;

const activeDownloads = new Map<number, AbortController>();

// ── Serial download queue ───────────────────────────────────────────────
// Clicking download enqueues; one download+extract runs at a time, the rest
// wait. A separate queue:update stream drives the global bottom bar.

interface QueueItem { rom: RomInfo; installPath: string; }
interface QueueCtx { client: RommClient; emitDownload: EventSender; emitQueue: EventSender; }

const queue: QueueItem[] = [];
let activeItem: QueueItem | null = null;
let queueCtx: QueueCtx | null = null;

export interface QueueEntry { romId: number; romName: string; status: 'active' | 'queued'; }

export function getQueueSnapshot(): { items: QueueEntry[] } {
  const items: QueueEntry[] = [];
  if (activeItem) items.push({ romId: activeItem.rom.id, romName: activeItem.rom.name, status: 'active' });
  for (const q of queue) items.push({ romId: q.rom.id, romName: q.rom.name, status: 'queued' });
  return { items };
}

function emitQueueState(): void {
  queueCtx?.emitQueue(getQueueSnapshot() as unknown as Record<string, unknown>);
}

/** Add a game to the download queue (idempotent per rom). */
export function enqueueDownload(client: RommClient, rom: RomInfo, installPath: string, emitDownload: EventSender, emitQueue: EventSender): void {
  queueCtx = { client, emitDownload, emitQueue };
  if (activeItem?.rom.id === rom.id || queue.some((q) => q.rom.id === rom.id)) {
    emitQueueState();
    return;
  }
  queue.push({ rom, installPath });
  emitQueueState();
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (activeItem || !queueCtx) return; // already running one
  const next = queue.shift();
  if (!next) { emitQueueState(); return; }
  activeItem = next;
  emitQueueState();
  try {
    await startDownload(queueCtx.client, next.rom, next.installPath, queueCtx.emitDownload);
  } catch (err) {
    console.error('Queue item failed:', err);
  }
  activeItem = null;
  emitQueueState();
  void processQueue();
}

// ── Tracking records (userData/downloads.json) ──────────────────────────

// Where downloads.json lives. Overridable so the download/extract pipeline can
// be exercised by `npm test` under plain Node, where `app` is not available.
let userDataDirOverride: string | null = null;
export function setUserDataDirForTests(dir: string | null): void { userDataDirOverride = dir; }

function recordsPath(): string {
  return path.join(userDataDirOverride ?? app.getPath('userData'), 'downloads.json');
}

function loadRecords(): DownloadRecord[] {
  try {
    return JSON.parse(fs.readFileSync(recordsPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function saveRecords(records: DownloadRecord[]): void {
  const file = recordsPath();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(`${file}.tmp`, file);
}

export function listDownloads(): DownloadRecord[] {
  return loadRecords();
}

export function findDownload(romId: number): DownloadRecord | undefined {
  return loadRecords().find((r) => r.romId === romId);
}

function upsertRecord(record: DownloadRecord): void {
  const records = loadRecords().filter((r) => r.romId !== record.romId);
  records.push(record);
  saveRecords(records);
}

function removeRecord(romId: number): void {
  saveRecords(loadRecords().filter((r) => r.romId !== romId));
}

/** Remember the chosen executable for a downloaded game (for Play / shortcuts). */
export function setDefaultExe(romId: number, exePath: string): boolean {
  const records = loadRecords();
  const rec = records.find((r) => r.romId === romId);
  if (!rec) return false;
  rec.defaultExe = exePath;
  saveRecords(records);
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function platformSetup(platformId: number): config.PlatformSetup {
  return config.getPublicConfig().platforms[String(platformId)]
    ?? { folder: '', autoExtract: false, installPaths: [] };
}

/** All configured root folders — deletion of these is always refused. */
function protectedRoots(): Set<string> {
  const cfg = config.getPublicConfig();
  const roots = new Set<string>();
  const add = (p: string) => { if (p && p.trim()) roots.add(path.normalize(p.trim()).toLowerCase()); };
  add(cfg.basePath);
  add(cfg.stagingPath);
  for (const setup of Object.values(cfg.platforms)) {
    add(setup.folder);
    for (const ip of setup.installPaths) add(ip);
  }
  return roots;
}

function isProtected(target: string, roots = protectedRoots()): boolean {
  return roots.has(path.normalize(target).toLowerCase());
}

/** Private per-rom staging folder for extraction, inside the install path. */
function extractStagingDir(installPath: string, romId: number): string {
  return path.join(installPath, `.r2sd-extract-${romId}`);
}

const STAGING_DIR_RE = /^\.r2sd-extract-\d+$/;

function run7za(archive: string, dest: string, onPercent: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Belt-and-suspenders for running from source on Linux/macOS, where the
    // bundled 7za may lack the exec bit. In a packaged AppImage this path is
    // read-only (the afterPack hook already set it), so ignore failures.
    if (process.platform !== 'win32') {
      try { fs.chmodSync(path7za, 0o755); } catch { /* read-only or already ok */ }
    }
    // -bsp1 prints progress percentages to stdout
    const proc = spawn(path7za, ['x', archive, `-o${dest}`, '-y', '-bsp1'], { windowsHide: true });
    let stderr = '';
    proc.stdout.on('data', (buf: Buffer) => {
      const m = buf.toString().match(/(\d+)%/);
      if (m) onPercent(Number(m[1]));
    });
    proc.stderr.on('data', (buf: Buffer) => { stderr += buf.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7za exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/**
 * Move the extracted content out of the staging folder to its final home and
 * return that folder. One top-level directory → moved as-is (keeps the
 * archive's own folder name); anything else → everything goes under
 * `<install path>/<rom name>/`. An existing folder of the same name is a
 * re-install of the same game and is replaced.
 */
function promoteExtracted(staging: string, installPath: string, rom: RomInfo): string {
  const tops = fs.readdirSync(staging);
  if (tops.length === 0) throw new Error('Archive was empty — nothing was extracted');

  let dest: string;
  let source: string;
  if (tops.length === 1 && fs.statSync(path.join(staging, tops[0])).isDirectory()) {
    source = path.join(staging, tops[0]);
    dest = path.join(installPath, tops[0]);
  } else {
    source = staging;
    dest = path.join(installPath, sanitizeFolderName(rom.name || rom.fsName.replace(/\.[^.]+$/, '')));
  }

  if (fs.existsSync(dest)) {
    if (isProtected(dest)) throw new Error(`Refusing to replace a configured folder: ${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(source, dest);
  fs.rmSync(staging, { recursive: true, force: true }); // no-op when staging itself moved
  return dest;
}

// ── Download ────────────────────────────────────────────────────────────

export async function startDownload(
  client: RommClient,
  rom: RomInfo,
  installPathChoice: string,
  send: EventSender
): Promise<void> {
  const emit = (payload: Record<string, unknown>) => send({ romId: rom.id, ...payload });

  if (activeDownloads.has(rom.id)) {
    emit({ status: 'error', message: 'Download already in progress' });
    return;
  }

  const setup = platformSetup(rom.platformId);
  const extract = setup.autoExtract;
  const installPath = extract ? (installPathChoice || setup.installPaths[0] || '') : '';

  if (extract && !installPath) {
    emit({ status: 'error', message: 'No install path configured for this platform — set one in Settings → Platform Folders' });
    return;
  }
  if (!extract && !setup.folder) {
    emit({ status: 'error', message: 'No folder configured for this platform — set one in Settings → Platform Folders' });
    return;
  }

  const cfg = config.getPublicConfig();
  const archiveDir = extract ? (cfg.stagingPath || installPath) : setup.folder;
  const staging = extract ? extractStagingDir(installPath, rom.id) : '';

  // ── Resume support ──────────────────────────────────────────────────
  // A failed/interrupted download leaves "<file>.part" plus a small sidecar
  // holding the server ETag; the next attempt (automatic retry or a later
  // manual click, even after an app restart) asks the server to continue with
  // Range/If-Range. RomM serves single-file roms from disk with range support
  // (206 Partial Content); multi-file roms are zipped on the fly and ignore
  // Range (200) — detected per response, in which case we restart from byte 0.
  const resumeMetaPath = path.join(archiveDir, `.r2sd-resume-${rom.id}.json`);
  const readResumeMeta = (): { fileName: string; etag: string; partPath: string } | null => {
    try {
      const m = JSON.parse(fs.readFileSync(resumeMetaPath, 'utf-8'));
      return m && m.partPath && fs.existsSync(m.partPath) ? m : null;
    } catch { return null; }
  };

  emit({ status: 'starting' });

  const STALL_TIMEOUT_MS = 60_000; // no bytes for this long → abort + retry
  const MAX_ATTEMPTS = 3;          // 1 try + 2 automatic retries
  const RETRY_DELAY_MS = [2000, 5000];

  let filePath = '';
  let partPath = '';
  let fileName = rom.fsName;
  let etag = '';
  let downloaded = 0;
  let total = 0;
  let isZip = false;
  let is7z = false;
  let inlineExtracted = false;
  let userCancelled = false;

  const clearStaging = () => { if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } } };

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    if (extract) fs.mkdirSync(installPath, { recursive: true });

    let pumped = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !pumped; attempt++) {
      // Fresh controller per attempt — an aborted controller can't be reused.
      const controller = new AbortController() as AbortController & { stalled?: boolean };
      activeDownloads.set(rom.id, controller);

      // Partial left by a previous attempt (this run or an earlier session)?
      const meta = readResumeMeta();
      let resumeFrom = 0;
      if (meta) {
        try { resumeFrom = fs.statSync(meta.partPath).size; } catch { resumeFrom = 0; }
        if (resumeFrom > 0) { fileName = meta.fileName; etag = meta.etag || etag; }
      }

      try {
        const response = await client.openDownloadStream(
          rom.id, rom.fsName, controller.signal,
          resumeFrom > 0 ? { from: resumeFrom, ifRange: etag || undefined } : undefined
        );
        etag = response.headers.get('etag') || etag;

        // 206 = the server is continuing our partial. Anything else (fresh
        // start, range unsupported on an on-the-fly zip, or the file changed
        // under If-Range) is a full body from byte 0.
        const resumed = resumeFrom > 0 && response.status === 206;
        if (resumed) {
          const cr = response.headers.get('content-range');
          const crMatch = cr?.match(/\/(\d+)\s*$/);
          total = crMatch ? Number(crMatch[1]) : resumeFrom + (Number(response.headers.get('content-length')) || 0);
        } else {
          total = Number(response.headers.get('content-length')) || rom.size || 0;
          // Prefer the server-provided filename (multi-file roms arrive as a zip)
          const disposition = response.headers.get('content-disposition');
          const dispMatch = disposition?.match(/filename="?([^";]+)"?/);
          if (dispMatch) fileName = decodeURIComponent(dispMatch[1]);
        }

        filePath = path.join(archiveDir, fileName);
        partPath = filePath + '.part';
        isZip = fileName.toLowerCase().endsWith('.zip');
        is7z = fileName.toLowerCase().endsWith('.7z');

        // Already fully downloaded and not an extraction run? Skip.
        if (!extract && fs.existsSync(filePath) && total > 0 && fs.statSync(filePath).size === total) {
          controller.abort();
          try { fs.unlinkSync(resumeMetaPath); } catch { /* absent */ }
          try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* best effort */ }
          upsertRecord({ romId: rom.id, romName: rom.name, fileName, filePath, platformId: rom.platformId, size: total, downloadedAt: Date.now() });
          emit({ status: 'complete', percent: 100, message: 'Already downloaded', path: filePath });
          return;
        }

        // Streaming zip extractor (zip + auto-extract only). Only possible from
        // byte 0 — a zip stream can't be joined mid-file — so resumed archives
        // skip this and extract after download via the 7za fallback instead.
        // Entries land in the staging folder, never directly in the install path.
        let extractor: any = null;
        let extractorFailed = false;
        const entryWrites: Promise<void>[] = [];
        let extractorClosed: Promise<void> = Promise.resolve();
        // Resolves the moment any part of inline extraction fails, so the pump
        // never sits waiting for a 'drain' from a parser that has stopped.
        let signalFailed: () => void = () => {};
        const extractorFailedP = new Promise<void>((resolve) => { signalFailed = resolve; });
        const failExtractor = () => { extractorFailed = true; signalFailed(); };

        if (extract && isZip && !resumed) {
          clearStaging();
          fs.mkdirSync(staging, { recursive: true });
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

        // Pump: chunk → part file AND (optionally) extractor. Backpressure is
        // drain-based: we only wait when a writable's buffer is full, so network
        // reads and disk writes overlap. (Awaiting every write's completion
        // callback serialized the two, making a download take roughly network
        // time PLUS disk time — noticeable on the Deck's SD card.)
        const out = fs.createWriteStream(partPath, resumed ? { flags: 'a' } : undefined);
        let outError: Error | null = null;
        out.on('error', (e) => { outError = e; });

        downloaded = resumed ? resumeFrom : 0;
        if (resumed) {
          emit({ status: 'downloading', downloaded, total, percent: total > 0 ? Math.floor((downloaded / total) * 100) : 0, message: 'Resuming download' });
        }

        let lastEmit = 0;
        let lastData = Date.now();
        // Stall watchdog: a connection that dies without closing would other-
        // wise block reader.read() forever (and the serial queue behind it).
        const watchdog = setInterval(() => {
          if (Date.now() - lastData > STALL_TIMEOUT_MS) { controller.stalled = true; controller.abort(); }
        }, 5000);

        try {
          const body = response.body!;
          const reader = body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            lastData = Date.now();
            const chunk = Buffer.from(value);
            if (!out.write(chunk)) await once(out, 'drain');
            if (outError) throw outError;
            if (extractor && !extractorFailed) {
              try {
                if (!extractor.write(chunk)) await Promise.race([once(extractor, 'drain'), extractorClosed, extractorFailedP]);
              } catch { failExtractor(); }
            }
            downloaded += chunk.length;
            const now = Date.now();
            if (now - lastEmit > 250) {
              lastEmit = now;
              emit({
                status: 'downloading',
                downloaded, total,
                percent: total > 0 ? Math.floor((downloaded / total) * 100) : 0,
                inlineExtract: Boolean(extractor && !extractorFailed),
              });
            }
          }
        } finally {
          clearInterval(watchdog);
        }

        await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
        if (outError) throw outError;

        if (downloaded === 0) {
          throw new Error('Server sent an empty file — this rom appears to be 0 bytes in the RomM library');
        }
        if (total > 0 && downloaded < total) {
          throw new Error(`Connection closed early — got ${downloaded} of ${total} bytes`);
        }

        // Complete: finish inline extraction, then promote .part → real name
        if (extractor && !extractorFailed) {
          extractor.end();
          await extractorClosed;
          await Promise.all(entryWrites);
          inlineExtracted = !extractorFailed;
        }
        if (extractor && !inlineExtracted) {
          try { extractor.destroy(); } catch { /* already closed */ }
        }
        try { fs.unlinkSync(resumeMetaPath); } catch { /* absent */ }
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
        fs.renameSync(partPath, filePath);
        pumped = true;
      } catch (err) {
        // User cancel (abort without the stall flag) propagates immediately.
        if (controller.signal.aborted && !controller.stalled) { userCancelled = true; throw err; }
        // Keep the partial + ETag so the next attempt (or a later manual
        // download) can resume instead of starting over.
        if (partPath && fs.existsSync(partPath) && fs.statSync(partPath).size > 0) {
          try { fs.writeFileSync(resumeMetaPath, JSON.stringify({ fileName, etag, partPath })); } catch { /* best effort */ }
        }
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = !/empty file|Download failed: 4\d\d/.test(msg);
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        emit({
          status: 'downloading', downloaded, total,
          percent: total > 0 ? Math.floor((downloaded / total) * 100) : 0,
          message: `Connection lost — retrying (${attempt + 1}/${MAX_ATTEMPTS})…`,
        });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS[attempt - 1] ?? 5000));
        // Cancelled while waiting to retry?
        const cur = activeDownloads.get(rom.id) as (AbortController & { stalled?: boolean }) | undefined;
        if (cur?.signal.aborted && !cur.stalled) { userCancelled = true; throw err; }
      }
    }

    // ── Post-download ────────────────────────────────────────────────
    if (!extract) {
      upsertRecord({ romId: rom.id, romName: rom.name, fileName, filePath, platformId: rom.platformId, size: downloaded, downloadedAt: Date.now() });
      emit({ status: 'complete', percent: 100, path: filePath });
      return;
    }

    if (!isZip && !is7z) {
      // Not an archive — auto-extract platform but plain file: move to install path
      const finalPath = path.join(installPath, fileName);
      if (path.resolve(finalPath) !== path.resolve(filePath)) {
        fs.renameSync(filePath, finalPath);
        filePath = finalPath;
      }
      upsertRecord({ romId: rom.id, romName: rom.name, fileName, filePath, platformId: rom.platformId, size: downloaded, downloadedAt: Date.now() });
      emit({ status: 'complete', percent: 100, path: filePath });
      return;
    }

    if (!inlineExtracted) {
      // Fallback (or 7z): extract the on-disk archive with bundled 7za
      emit({ status: 'extracting', percent: 0 });
      clearStaging();
      fs.mkdirSync(staging, { recursive: true });
      await run7za(filePath, staging, (pct) => emit({ status: 'extracting', percent: pct }));
    }

    const gameFolder = promoteExtracted(staging, installPath, rom);

    // Remove the archive after successful extraction
    try { fs.unlinkSync(filePath); } catch { /* best effort */ }

    upsertRecord({ romId: rom.id, romName: rom.name, fileName, filePath: gameFolder, platformId: rom.platformId, size: downloaded, downloadedAt: Date.now() });
    emit({ status: 'extracted', percent: 100, path: gameFolder });
  } catch (err) {
    // Whatever happened, half-extracted content in the staging folder is junk:
    // a retry re-extracts from the archive, a cancel discards everything.
    clearStaging();
    if (userCancelled) {
      // User cancelled: throw everything away, including the resume state
      try { fs.unlinkSync(resumeMetaPath); } catch { /* absent */ }
      try { if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* best effort */ }
      emit({ status: 'cancelled', message: 'Download cancelled' });
    } else {
      // Failure after retries: KEEP the .part + sidecar so a later manual
      // download picks up where this one stopped (resume metadata was written
      // in the attempt-level catch).
      console.error(`Download ${rom.id} failed:`, err);
      const base = err instanceof Error ? err.message : String(err);
      let saved = '';
      try {
        if (partPath && fs.existsSync(partPath) && fs.existsSync(resumeMetaPath) && total > 0) {
          const pct = Math.floor((fs.statSync(partPath).size / total) * 100);
          if (pct > 0) saved = ` — ${pct}% saved; downloading again will resume from there`;
        }
      } catch { /* best effort */ }
      emit({ status: 'error', message: base + saved });
    }
  } finally {
    activeDownloads.delete(rom.id);
  }
}

export function cancelDownload(romId: number): boolean {
  // Queued (not yet started) → just drop it from the queue
  const qi = queue.findIndex((q) => q.rom.id === romId);
  if (qi >= 0) {
    queue.splice(qi, 1);
    emitQueueState();
    queueCtx?.emitDownload({ romId, status: 'cancelled', message: 'Removed from queue' });
    return true;
  }
  // Active download → abort the stream
  const controller = activeDownloads.get(romId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ── Delete ──────────────────────────────────────────────────────────────

export function deleteDownload(romId: number): { deleted: string[]; error?: string } {
  const record = findDownload(romId);
  if (!record) return { deleted: [], error: 'Not tracked as downloaded' };

  const deleted: string[] = [];
  const target = record.filePath;
  if (target && fs.existsSync(target)) {
    if (isProtected(target)) {
      return { deleted, error: 'Refusing to delete: path is a configured platform/install folder' };
    }
    fs.rmSync(target, { recursive: true, force: true });
    deleted.push(target);
  }
  removeRecord(romId);
  return { deleted };
}

// ── Filesystem sync ─────────────────────────────────────────────────────

/**
 * Reconcile records with the filesystem for one platform:
 *  - drop records whose files vanished
 *  - adopt files in the platform folder matching a rom's fs_name
 *  - adopt folders in install paths matching a rom's (sanitized) name
 *
 * All changes are applied to one in-memory list and written once at the end
 * (each adopt/drop used to re-read and rewrite downloads.json).
 */
export function syncPlatform(
  platformId: number,
  roms: { id: number; name: string; fsName: string }[]
): { added: number; removed: number } {
  const setup = platformSetup(platformId);
  let records = loadRecords();
  let added = 0;
  let removed = 0;

  // Drop stale records
  const before = records.length;
  records = records.filter((r) => !(r.platformId === platformId && r.filePath && !fs.existsSync(r.filePath)));
  removed = before - records.length;
  const recordedIds = new Set(records.filter((r) => r.platformId === platformId).map((r) => r.romId));

  const byFsName = new Map<string, { id: number; name: string; fsName: string }>();
  const byCleanName = new Map<string, { id: number; name: string; fsName: string }>();
  for (const rom of roms) {
    if (rom.fsName) {
      byFsName.set(rom.fsName.toLowerCase(), rom);
      byCleanName.set(sanitizeForMatch(rom.fsName.replace(/\.[^.]+$/, '')), rom);
    }
    if (rom.name) byCleanName.set(sanitizeForMatch(rom.name), rom);
  }

  const adopt = (rom: { id: number; name: string }, fileName: string, filePath: string, size: number) => {
    records.push({ romId: rom.id, romName: rom.name, fileName, filePath, platformId, size, downloadedAt: Date.now() });
    recordedIds.add(rom.id);
    added++;
  };

  // Adopt loose files in the platform folder
  if (setup.folder && fs.existsSync(setup.folder)) {
    for (const item of fs.readdirSync(setup.folder)) {
      const rom = byFsName.get(item.toLowerCase());
      if (rom && !recordedIds.has(rom.id)) {
        const full = path.join(setup.folder, item);
        adopt(rom, item, full, fs.statSync(full).size);
      }
    }
  }

  // Adopt extracted game folders in install paths
  for (const installPath of setup.installPaths) {
    if (!installPath || !fs.existsSync(installPath)) continue;
    for (const item of fs.readdirSync(installPath)) {
      if (STAGING_DIR_RE.test(item)) continue; // an in-progress or abandoned extraction
      const full = path.join(installPath, item);
      if (!fs.statSync(full).isDirectory()) continue;
      const rom = byCleanName.get(sanitizeForMatch(item));
      if (rom && !recordedIds.has(rom.id)) adopt(rom, item, full, 0);
    }
  }

  if (added || removed) saveRecords(records);
  return { added, removed };
}
