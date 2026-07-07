/**
 * Live edits to non-Steam shortcuts via Steam's own `SteamClient` API, driven
 * over the CEF debugger — the same mechanism Decky / steam-rom-manager use.
 *
 * Why this exists: editing shortcuts.vdf / config.vdf directly is unreliable —
 * Steam owns those files, rewrites them, and re-syncs from Steam Cloud on
 * startup (so a file edit gets reverted, especially across two devices on one
 * account). Going through SteamClient makes STEAM apply the change to its live
 * state, which is persisted and cloud-synced correctly — while Steam is running,
 * no restart. Verified on a Steam Deck: SetShortcutLaunchOptions round-tripped
 * to shortcuts.vdf within seconds.
 *
 * Requirements: Steam's CEF remote debugging must be enabled (a zero-byte file
 * ~/.steam/steam/.cef-enable-remote-debugging, which Decky Loader creates). When
 * it's not available this module reports unavailable and callers fall back to
 * the manual-instructions path. Linux/SteamOS only.
 *
 * NOTE: SteamClient is an internal, undocumented API that can change between
 * Steam updates — every call is wrapped so a failure degrades gracefully.
 */
import * as steam from './steam';

const CEF_ENDPOINT = 'http://localhost:8080/json';

export interface SteamClientResult { ok: boolean; error?: string; unavailable?: boolean; }

interface Conn { evaluate: (expr: string) => Promise<unknown>; close: () => void; }

/** Only meaningful on Linux with the CEF debugger reachable. */
export async function isAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const res = await fetch(`${CEF_ENDPOINT}/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function connect(): Promise<Conn | null> {
  try {
    const res = await fetch(CEF_ENDPOINT, { signal: AbortSignal.timeout(3000) });
    const targets = (await res.json()) as Array<{ title: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.title === 'SharedJSContext');
    if (!target || !target.webSocketDebuggerUrl) return null;

    // Node 22 (Electron 43) has a global WebSocket.
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CEF socket error')), { once: true });
      setTimeout(() => reject(new Error('CEF socket timeout')), 5000);
    });

    let id = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    ws.addEventListener('message', (e: MessageEvent) => {
      const m = JSON.parse(String(e.data));
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        if (m.result?.exceptionDetails) {
          p.reject(new Error(m.result.exceptionDetails.exception?.description || 'SteamClient call threw'));
        } else {
          p.resolve(m.result?.result?.value);
        }
      }
    });

    const evaluate = (expression: string) => new Promise<unknown>((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('SteamClient call timeout')); } }, 8000);
    });

    return { evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
  } catch {
    return null;
  }
}

/** Unsigned 32-bit shortcut appid for the entry whose Exe is `exePath`, read from
 *  shortcuts.vdf (works regardless of which tool created the shortcut). */
export function shortcutAppIdForExe(exePath: string): number | null {
  return steam.readShortcutAppId(exePath);
}

async function withConnection<T>(fn: (c: Conn) => Promise<T>): Promise<T | null> {
  const conn = await connect();
  if (!conn) return null;
  try { return await fn(conn); } finally { conn.close(); }
}

async function callApp(method: string, appId: number, arg: string): Promise<SteamClientResult> {
  if (process.platform !== 'linux') return { ok: false, unavailable: true };
  const result = await withConnection(async (c) => {
    const ok = await c.evaluate(
      `(async()=>{ try { await SteamClient.Apps.${method}(${appId}, ${JSON.stringify(arg)}); return true; } catch(e){ return 'ERR:'+e.message; } })()`
    );
    return ok;
  });
  if (result === null) return { ok: false, unavailable: true, error: 'Steam CEF debugger not reachable' };
  if (result === true) return { ok: true };
  return { ok: false, error: String(result) };
}

/** Set a shortcut's Launch Options live (our overlay-strip fix). */
export function setLaunchOptions(appId: number, launchOptions: string): Promise<SteamClientResult> {
  return callApp('SetShortcutLaunchOptions', appId, launchOptions);
}

/** Force a Steam Play compatibility tool live, e.g. "proton_experimental". */
export function specifyCompatTool(appId: number, toolName: string): Promise<SteamClientResult> {
  return callApp('SpecifyCompatTool', appId, toolName);
}

/** Rename a shortcut live. */
export function setShortcutName(appId: number, name: string): Promise<SteamClientResult> {
  return callApp('SetShortcutName', appId, name);
}

/**
 * Set custom artwork for a shortcut live. `assetType` is Steam's library asset
 * slot (0 = portrait capsule / grid — the main library tile; verified on-device).
 * `imageType` is "png" or "jpg". Steam writes the image to
 * userdata/<id>/config/grid/ and shows it immediately.
 */
export async function setArtwork(appId: number, base64: string, imageType: string, assetType: number): Promise<SteamClientResult> {
  if (process.platform !== 'linux') return { ok: false, unavailable: true };
  const result = await withConnection((c) => c.evaluate(
    `(async()=>{ try { await SteamClient.Apps.SetCustomArtworkForApp(${appId}, ${JSON.stringify(base64)}, ${JSON.stringify(imageType)}, ${assetType}); return true; } catch(e){ return 'ERR:'+e.message; } })()`
  ));
  if (result === null) return { ok: false, unavailable: true, error: 'Steam CEF debugger not reachable' };
  if (result === true) return { ok: true };
  return { ok: false, error: String(result) };
}
