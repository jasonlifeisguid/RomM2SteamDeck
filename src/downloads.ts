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
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RommClient } from './romm';
import * as config from './config';

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

function recordsPath(): string {
  return path.join(app.getPath('userData'), 'downloads.json');
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

function sanitizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
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

function isProtected(target: string): boolean {
  return protectedRoots().has(path.normalize(target).toLowerCase());
}

/** Guard against zip-slip: resolved entry must stay inside the destination. */
function safeJoin(destRoot: string, entryPath: string): string | null {
  const target = path.resolve(destRoot, entryPath.replace(/\\/g, '/'));
  const root = path.resolve(destRoot);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

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
  const extractedTopLevels = new Set<string>();

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
        let extractor: any = null;
        let extractorFailed = false;
        const entryWrites: Promise<void>[] = [];
        let extractorClosed: Promise<void> = Promise.resolve();

        if (extract && isZip && !resumed) {
          extractor = unzipper.Parse();
          extractorClosed = new Promise<void>((resolve) => {
            extractor.on('close', resolve);
            extractor.on('error', () => { extractorFailed = true; resolve(); });
          });
          extractor.on('entry', (entry: any) => {
            const target = safeJoin(installPath, entry.path);
            if (!target || extractorFailed) { entry.autodrain(); return; }
            extractedTopLevels.add(entry.path.replace(/\\/g, '/').split('/')[0]);
            if (entry.type === 'Directory') {
              fs.mkdirSync(target, { recursive: true });
              entry.autodrain();
              return;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            entryWrites.push(new Promise<void>((resolve) => {
              const out = fs.createWriteStream(target);
              entry.pipe(out);
              out.on('finish', resolve);
              out.on('error', () => { extractorFailed = true; entry.autodrain(); resolve(); });
              entry.on('error', () => { extractorFailed = true; resolve(); });
            }));
          });
        }

        // Pump: chunk → part file AND (optionally) extractor, with backpressure on both
        const out = fs.createWriteStream(partPath, resumed ? { flags: 'a' } : undefined);
        const writeTo = (stream: NodeJS.WritableStream, chunk: Buffer) =>
          new Promise<void>((resolve, reject) => {
            stream.write(chunk, (err) => (err ? reject(err) : resolve()));
          });

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
            await writeTo(out, chunk);
            if (extractor && !extractorFailed) {
              try { await writeTo(extractor, chunk); } catch { extractorFailed = true; }
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

    let extracted = inlineExtracted;

    if (!extracted && (isZip || is7z)) {
      // Fallback (or 7z): extract the on-disk archive with bundled 7za
      emit({ status: 'extracting', percent: 0 });
      const before = new Set(fs.readdirSync(installPath));
      await run7za(filePath, installPath, (pct) => emit({ status: 'extracting', percent: pct }));
      for (const item of fs.readdirSync(installPath)) {
        if (!before.has(item) && item !== fileName) extractedTopLevels.add(item);
      }
      extracted = true;
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

    // Work out the game folder for tracking. Never record the install root
    // itself — a later delete would wipe every game in it.
    extractedTopLevels.delete(path.basename(filePath));
    let gameFolder = '';
    const tops = [...extractedTopLevels].map((t) => path.join(installPath, t)).filter((p) => fs.existsSync(p));
    const topDirs = tops.filter((p) => fs.statSync(p).isDirectory());
    if (tops.length > 0) gameFolder = (topDirs[0] ?? tops[0]);

    // Remove the archive after successful extraction
    try { fs.unlinkSync(filePath); } catch { /* best effort */ }

    upsertRecord({ romId: rom.id, romName: rom.name, fileName, filePath: gameFolder, platformId: rom.platformId, size: downloaded, downloadedAt: Date.now() });
    emit({ status: 'extracted', percent: 100, path: gameFolder || installPath });
  } catch (err) {
    if (userCancelled) {
      // User cancelled: throw everything away, including the resume state
      try { fs.unlinkSync(resumeMetaPath); } catch { /* absent */ }
      try { if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* best effort */ }
      // Best-effort cleanup of partially extracted content
      if (extract && installPath) {
        for (const top of extractedTopLevels) {
          const target = safeJoin(installPath, top);
          if (target && !isProtected(target)) {
            try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
      }
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
  const record = loadRecords().find((r) => r.romId === romId);
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
 */
export function syncPlatform(
  platformId: number,
  roms: { id: number; name: string; fsName: string }[]
): { added: number; removed: number } {
  const setup = platformSetup(platformId);
  const records = loadRecords();
  const recordedIds = new Set(records.filter((r) => r.platformId === platformId).map((r) => r.romId));
  let added = 0;
  let removed = 0;

  // Drop stale records
  for (const record of records) {
    if (record.platformId !== platformId) continue;
    if (record.filePath && !fs.existsSync(record.filePath)) {
      removeRecord(record.romId);
      recordedIds.delete(record.romId);
      removed++;
    }
  }

  const byFsName = new Map<string, { id: number; name: string; fsName: string }>();
  const byCleanName = new Map<string, { id: number; name: string; fsName: string }>();
  for (const rom of roms) {
    if (rom.fsName) {
      byFsName.set(rom.fsName.toLowerCase(), rom);
      byCleanName.set(sanitizeForMatch(rom.fsName.replace(/\.[^.]+$/, '')), rom);
    }
    if (rom.name) byCleanName.set(sanitizeForMatch(rom.name), rom);
  }

  // Adopt loose files in the platform folder
  if (setup.folder && fs.existsSync(setup.folder)) {
    for (const item of fs.readdirSync(setup.folder)) {
      const rom = byFsName.get(item.toLowerCase());
      if (rom && !recordedIds.has(rom.id)) {
        const full = path.join(setup.folder, item);
        upsertRecord({
          romId: rom.id, romName: rom.name, fileName: item, filePath: full,
          platformId, size: fs.statSync(full).size, downloadedAt: Date.now(),
        });
        recordedIds.add(rom.id);
        added++;
      }
    }
  }

  // Adopt extracted game folders in install paths
  for (const installPath of setup.installPaths) {
    if (!installPath || !fs.existsSync(installPath)) continue;
    for (const item of fs.readdirSync(installPath)) {
      const full = path.join(installPath, item);
      if (!fs.statSync(full).isDirectory()) continue;
      const rom = byCleanName.get(sanitizeForMatch(item));
      if (rom && !recordedIds.has(rom.id)) {
        upsertRecord({
          romId: rom.id, romName: rom.name, fileName: item, filePath: full,
          platformId, size: 0, downloadedAt: Date.now(),
        });
        recordedIds.add(rom.id);
        added++;
      }
    }
  }

  return { added, removed };
}
