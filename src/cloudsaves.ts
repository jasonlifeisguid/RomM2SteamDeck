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
 *
 * The target can be a Proton prefix (Linux) or the real Windows profile as a
 * SaveLayout; the latter only lists the game's known save locations (its
 * scope, see savepaths.ts), and a restore teaches the scope via `onRestored`.
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
  /** Windows: no save locations known for this game, so nothing local was looked at. */
  unscoped?: boolean;
}

/** Everything the sync needs from the host app, injected so this stays testable. */
export interface CloudDeps {
  client: RommClient;
  /** Static, or a getter — the scope can change after a restore (see onRestored). */
  rules: saves.SaveRules | (() => saves.SaveRules);
  deviceId: string | null;
  getRecord: () => CloudRecord | null;
  setRecord: (rec: CloudRecord) => void;
  /** Called with the restored zip's file entries, before the post-restore listing (learn a scope). */
  onRestored?: (entries: string[]) => void;
  tmpDir?: string;
}

const rulesOf = (deps: CloudDeps): saves.SaveRules => (typeof deps.rules === 'function' ? deps.rules() : deps.rules);

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

/** Device id → name, cached briefly (one list request per status burst). */
const deviceNames = new Map<RommClient, { at: number; names: Map<string, string> }>();
async function deviceName(client: RommClient, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  let cached = deviceNames.get(client);
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const names = new Map<string, string>();
    if (typeof client.listDevices === 'function') for (const d of await client.listDevices()) names.set(d.id, d.name);
    cached = { at: Date.now(), names };
    deviceNames.set(client, cached);
  }
  return cached.names.get(id) ?? id;
}

export async function status(deps: CloudDeps, romId: number, target: saves.SaveTarget): Promise<CloudStatus> {
  const local = saves.listSaveFiles(target, rulesOf(deps));
  const rem = await latestRemote(deps.client, romId);
  const rec = deps.getRecord();
  const { state, fingerprint } = computeState(local, rem?.save ?? null, rec);
  const fromDevice = rem?.save.device_syncs?.find((d) => d.device_id === rem.save.origin_device_id)?.device_name
    ?? await deviceName(deps.client, rem?.save.origin_device_id);
  return {
    state,
    remote: rem ? { saveId: rem.save.id, contentHash: hashOf(rem.save), updatedAt: rem.save.updated_at, size: rem.save.file_size_bytes, fromDevice, versions: rem.versions } : null,
    local: local && local.included.length ? { files: local.included.length, bytes: local.totalBytes, excludedConfig: local.excluded.filter((e) => e.reason === 'config').length, fingerprint: fingerprint! } : null,
    lastSyncedAt: rec?.syncedAt ?? null,
    ...(local?.unscoped ? { unscoped: true } : {}),
  };
}

export interface SyncResult { ok: boolean; error?: string; saveId?: number; files?: number; bytes?: number; excludedConfig?: number; }

/** Zip the prefix's saves and upload as a new version. Records the sync point. */
export async function upload(deps: CloudDeps, romId: number, target: saves.SaveTarget, gameName: string): Promise<SyncResult> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'r2sd-cloud-'));
  const file = path.join(tmp, saves.backupFileName(gameName));
  try {
    const z = await saves.zipSaves(target, file, rulesOf(deps));
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
export async function download(deps: CloudDeps, romId: number, target: saves.SaveTarget, opts: { createProfile?: boolean } = {}): Promise<SyncResult> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), 'r2sd-cloud-'));
  try {
    const rem = await latestRemote(deps.client, romId);
    if (!rem) return { ok: false, error: 'No R2SD save for this game on RomM yet' };
    const content = await deps.client.downloadSave(rem.save.id, deps.deviceId || undefined);
    const file = path.join(tmp, 'cloud.zip');
    fs.writeFileSync(file, content);
    const r = await saves.restoreSaves(target, file, opts);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.entries && deps.onRestored) { try { deps.onRestored(r.entries); } catch { /* learning is best effort */ } }
    if (deps.deviceId) { try { await deps.client.confirmSaveDownloaded(rem.save.id, deps.deviceId); } catch { /* best effort */ } }
    const listing = saves.listSaveFiles(target, rulesOf(deps));
    deps.setRecord({ saveId: rem.save.id, contentHash: hashOf(rem.save) || saves.md5File(file), fingerprint: listing ? saves.fingerprint(listing) : '', syncedAt: Date.now() });
    return { ok: true, saveId: rem.save.id, bytes: content.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export type AutoAction = { action: 'none' | 'restored' | 'uploaded' | 'seeded' | 'unscoped'; from?: string | null; at?: string } | { action: 'conflict' } | { action: 'error'; error: string };

/**
 * Before launch: bring the local prefix up to date. Restores when the server
 * is ahead (or seeds a prefix that doesn't exist yet), uploads when local is
 * ahead (the app was closed before the post-game upload), and stops on a
 * conflict. Never throws — the game launches regardless.
 */
export async function beforeLaunch(deps: CloudDeps, romId: number, target: saves.SaveTarget, gameName: string): Promise<AutoAction> {
  try {
    const st = await status(deps, romId, target);
    switch (st.state) {
      case 'remote-only': {
        const r = await download(deps, romId, target, { createProfile: true });
        return r.ok ? { action: 'seeded', from: st.remote?.fromDevice, at: st.remote?.updatedAt } : { action: 'error', error: r.error! };
      }
      case 'remote-newer': {
        const r = await download(deps, romId, target);
        return r.ok ? { action: 'restored', from: st.remote?.fromDevice, at: st.remote?.updatedAt } : { action: 'error', error: r.error! };
      }
      case 'local-newer':
      case 'local-only': {
        const r = await upload(deps, romId, target, gameName);
        return r.ok ? { action: 'uploaded' } : { action: 'error', error: r.error! };
      }
      case 'conflict': return { action: 'conflict' };
      default: return st.unscoped ? { action: 'unscoped' } : { action: 'none' };
    }
  } catch (err) {
    return { action: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * After the game exits: upload if this device's saves changed — but only if
 * RomM hasn't moved on since this device last synced. The game launches even
 * when beforeLaunch stopped on a conflict (or couldn't reach the server), so
 * "local changed" alone is not enough: uploading then would make this device's
 * save the latest and bury the other device's progress, which that device
 * would then restore over its own on its next launch. Same rule as before
 * launch: when both sides changed, nothing is overwritten and the user decides.
 */
export async function afterExit(deps: CloudDeps, romId: number, target: saves.SaveTarget, gameName: string): Promise<AutoAction> {
  try {
    const local = saves.listSaveFiles(target, rulesOf(deps));
    if (local?.unscoped) return { action: 'unscoped' };
    if (!local || !local.included.length) return { action: 'none' };
    const rec = deps.getRecord();
    if (rec && saves.fingerprint(local) === rec.fingerprint) return { action: 'none' };
    const rem = await latestRemote(deps.client, romId);
    const { state } = computeState(local, rem?.save ?? null, rec);
    if (state === 'conflict') return { action: 'conflict' };
    if (state !== 'local-newer' && state !== 'local-only') return { action: 'none' };
    const r = await upload(deps, romId, target, gameName);
    return r.ok ? { action: 'uploaded' } : { action: 'error', error: r.error! };
  } catch (err) {
    return { action: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
