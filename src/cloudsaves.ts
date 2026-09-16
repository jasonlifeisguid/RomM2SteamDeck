/**
 * Cloud saves through RomM.
 *
 * RomM keeps saves per user and per rom, versioned, with a `slot` label and an
 * MD5 `content_hash`. R2SD stores its save zips (see saves.ts) under slot
 * "r2sd" / emulator "proton", keeping the last few versions, and remembers per
 * game what this device last synced:
 *
 *   record.cloud = { saveId, contentHash, fingerprint, syncedAt }
 *
 * `contentHash` is the MD5 of the zip last uploaded or downloaded (directly
 * comparable to RomM's content_hash, so "is the server ahead?" costs one small
 * request). `fingerprint` is the local files' (path, size, mtime) digest at
 * that moment, so "did I play since?" costs a directory walk. From those two
 * the sync state is unambiguous, and the one rule that matters: when BOTH sides
 * changed, never overwrite silently — leave it to the user.
 *
 * Only a game's own prefix is synced automatically. Faugus's shared `default`
 * prefix holds every game's saves at once, so uploading it under one rom would
 * be wrong; manual upload from it is still allowed (the user can see the label).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RommClient, RommSave } from './romm';
import * as saves from './saves';

export const CLOUD_SLOT = 'r2sd';
export const CLOUD_EMULATOR = 'proton';
export const KEEP_VERSIONS = 5;

export interface CloudRecord { saveId: number; contentHash: string; fingerprint: string; syncedAt: number; }

export type SyncState = 'nothing' | 'remote-only' | 'local-only' | 'in-sync' | 'local-newer' | 'remote-newer' | 'conflict';

export interface CloudStatus {
  state: SyncState;
  remote: { saveId: number; contentHash: string | null; updatedAt: string; size: number; fromDevice: string | null; versions: number } | null;
  local: { files: number; bytes: number; excludedConfig: number; fingerprint: string } | null;
  lastSyncedAt: number | null;
}

/** Everything the sync needs from the host app, injected so this stays testable. */
export interface CloudDeps {
  client: RommClient;
  rules: saves.SaveRules;
  deviceId: string | null;
  getRecord: () => CloudRecord | null;
  setRecord: (rec: CloudRecord) => void;
  tmpDir?: string;
}

function hashOf(s: RommSave): string | null { return s.content_hash ? s.content_hash.toLowerCase() : null; }

async function latestRemote(client: RommClient, romId: number): Promise<{ save: RommSave; versions: number } | null> {
  const summary = await client.savesSummary(romId);
  const slot = summary.slots.find((s) => s.slot === CLOUD_SLOT);
  return slot?.latest ? { save: slot.latest, versions: slot.count } : null;
}

export function computeState(local: saves.SaveListing | null, remote: RommSave | null, rec: CloudRecord | null): { state: SyncState; fingerprint: string | null } {
  const hasLocal = !!local && local.included.length > 0;
  const fp = local ? saves.fingerprint(local) : null;
  if (!hasLocal && !remote) return { state: 'nothing', fingerprint: fp };
  if (!hasLocal) return { state: 'remote-only', fingerprint: fp };
  if (!remote) return { state: 'local-only', fingerprint: fp };
  const localChanged = rec ? fp !== rec.fingerprint : true;
  const remoteChanged = rec ? hashOf(remote) !== rec.contentHash.toLowerCase() : true;
  if (!localChanged && !remoteChanged) return { state: 'in-sync', fingerprint: fp };
  if (localChanged && !remoteChanged) return { state: 'local-newer', fingerprint: fp };
  if (!localChanged && remoteChanged) return { state: 'remote-newer', fingerprint: fp };
  return { state: 'conflict', fingerprint: fp };
}

export async function status(deps: CloudDeps, romId: number, prefixRoot: string): Promise<CloudStatus> {
  const local = saves.listSaveFiles(prefixRoot, deps.rules);
  const rem = await latestRemote(deps.client, romId);
  const rec = deps.getRecord();
  const { state, fingerprint } = computeState(local, rem?.save ?? null, rec);
  const fromDevice = rem?.save.device_syncs?.find((d) => d.device_id === rem.save.origin_device_id)?.device_name
    ?? rem?.save.origin_device_id ?? null;
  return {
    state,
    remote: rem ? { saveId: rem.save.id, contentHash: hashOf(rem.save), updatedAt: rem.save.updated_at, size: rem.save.file_size_bytes, fromDevice, versions: rem.versions } : null,
    local: local && local.included.length ? { files: local.included.length, bytes: local.totalBytes, excludedConfig: local.excluded.filter((e) => e.reason === 'config').length, fingerprint: fingerprint! } : null,
    lastSyncedAt: rec?.syncedAt ?? null,
  };
}

export interface SyncResult { ok: boolean; error?: string; saveId?: number; files?: number; bytes?: number; excludedConfig?: number; }

/** Zip the prefix's saves and upload as a new version. Records the sync point. */
export async function upload(deps: CloudDeps, romId: number, prefixRoot: string, gameName: string): Promise<SyncResult> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'r2sd-cloud-'));
  const file = path.join(tmp, saves.backupFileName(gameName));
  try {
    const z = await saves.zipSaves(prefixRoot, file, deps.rules);
    if (!z.ok || !z.listing) return { ok: false, error: z.error };
    const save = await deps.client.uploadSave(romId, path.basename(file), fs.readFileSync(file), {
      emulator: CLOUD_EMULATOR, slot: CLOUD_SLOT, deviceId: deps.deviceId || undefined, autocleanupLimit: KEEP_VERSIONS,
    });
    deps.setRecord({ saveId: save.id, contentHash: (hashOf(save) || saves.md5File(file)), fingerprint: saves.fingerprint(z.listing), syncedAt: Date.now() });
    return { ok: true, saveId: save.id, files: z.files, bytes: z.bytes, excludedConfig: z.excludedConfig };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Fetch the latest cloud version and restore it into the prefix. Records the sync point. */
export async function download(deps: CloudDeps, romId: number, prefixRoot: string, opts: { createProfile?: boolean } = {}): Promise<SyncResult> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'r2sd-cloud-'));
  try {
    const rem = await latestRemote(deps.client, romId);
    if (!rem) return { ok: false, error: 'No R2SD save for this game on RomM yet' };
    const content = await deps.client.downloadSave(rem.save.id, deps.deviceId || undefined);
    const file = path.join(tmp, 'cloud.zip');
    fs.writeFileSync(file, content);
    const r = await saves.restoreSaves(prefixRoot, file, opts);
    if (!r.ok) return { ok: false, error: r.error };
    if (deps.deviceId) { try { await deps.client.confirmSaveDownloaded(rem.save.id, deps.deviceId); } catch { /* best effort */ } }
    const listing = saves.listSaveFiles(prefixRoot, deps.rules);
    deps.setRecord({ saveId: rem.save.id, contentHash: hashOf(rem.save) || saves.md5File(file), fingerprint: listing ? saves.fingerprint(listing) : '', syncedAt: Date.now() });
    return { ok: true, saveId: rem.save.id, bytes: content.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export type AutoAction = { action: 'none' | 'restored' | 'uploaded' | 'seeded'; from?: string | null; at?: string } | { action: 'conflict' } | { action: 'error'; error: string };

/**
 * Before launch: bring the local prefix up to date. Restores when the server
 * is ahead (or seeds a prefix that doesn't exist yet), uploads when local is
 * ahead (the app was closed before the post-game upload), and stops on a
 * conflict. Never throws — the game launches regardless.
 */
export async function beforeLaunch(deps: CloudDeps, romId: number, prefixRoot: string, gameName: string): Promise<AutoAction> {
  try {
    const st = await status(deps, romId, prefixRoot);
    switch (st.state) {
      case 'remote-only': {
        const r = await download(deps, romId, prefixRoot, { createProfile: true });
        return r.ok ? { action: 'seeded', from: st.remote?.fromDevice, at: st.remote?.updatedAt } : { action: 'error', error: r.error! };
      }
      case 'remote-newer': {
        const r = await download(deps, romId, prefixRoot);
        return r.ok ? { action: 'restored', from: st.remote?.fromDevice, at: st.remote?.updatedAt } : { action: 'error', error: r.error! };
      }
      case 'local-newer':
      case 'local-only': {
        const r = await upload(deps, romId, prefixRoot, gameName);
        return r.ok ? { action: 'uploaded' } : { action: 'error', error: r.error! };
      }
      case 'conflict': return { action: 'conflict' };
      default: return { action: 'none' };
    }
  } catch (err) {
    return { action: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** After the game exits: upload if anything changed. */
export async function afterExit(deps: CloudDeps, romId: number, prefixRoot: string, gameName: string): Promise<AutoAction> {
  try {
    const local = saves.listSaveFiles(prefixRoot, deps.rules);
    if (!local || !local.included.length) return { action: 'none' };
    const rec = deps.getRecord();
    if (rec && saves.fingerprint(local) === rec.fingerprint) return { action: 'none' };
    const r = await upload(deps, romId, prefixRoot, gameName);
    return r.ok ? { action: 'uploaded' } : { action: 'error', error: r.error! };
  } catch (err) {
    return { action: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
