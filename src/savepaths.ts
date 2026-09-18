/**
 * Where does this game keep its saves? (Windows scope discovery.)
 *
 * On Windows every game writes into the one real user profile, so R2SD needs
 * a per-game list of profile-relative save locations ("Documents/My Games/X")
 * before it can back up or sync anything. Sources, most reliable first:
 *
 *  1. A restore: the files of a save made in a per-game Proton prefix show
 *     exactly where the game writes (saves.learnScope). Deck → desktop needs
 *     nothing else.
 *  2. Goldberg / GSE Steam emulators: `steam_appid.txt` next to the exe →
 *     "AppData/Roaming/Goldberg SteamEmu Saves/<appid>" (and the GSE variant).
 *  3. The Ludusavi manifest (MIT; compiled from PCGamingWiki): ~40k games with
 *     placeholder paths like "<winDocuments>/My Games/X" and Steam ids. It is
 *     17 MB of YAML, so it is streamed once into a small JSON index (title →
 *     profile-relative paths) cached in userData and refreshed weekly.
 *  4. The user, in "What syncs…".
 *
 * No electron imports; fetch/paths are injected.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Readable } from 'stream';

export const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
export const MANIFEST_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface ManifestGame { title: string; steam?: number; paths: string[]; }
export interface ManifestIndex {
  fetchedAt: number;
  etag: string | null;
  /** normalized title → game */
  games: Record<string, ManifestGame>;
  /** steam app id → normalized title */
  bySteam: Record<string, string>;
}

// ── Titles ─────────────────────────────────────────────────────────────────

/** "Assassin's Creed® Shadows" → "assassinscreedshadows" (the manifest's own key style). */
export function normalizeTitle(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

/** Title candidates for a rom: its RomM name, the file name without tags/extension, the install folder. */
export function titleCandidates(parts: { name?: string; fsName?: string; folder?: string }): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => { const n = s ? normalizeTitle(s) : ''; if (n && !out.includes(n)) out.push(n); };
  push(parts.name);
  if (parts.fsName) push(parts.fsName.replace(/\.[a-z0-9]{1,4}$/i, '').replace(/[[(][^\])]*[\])]/g, ''));
  if (parts.folder) push((parts.folder.split(/[\\/]/).filter(Boolean).pop() || '').replace(/[[(][^\])]*[\])]/g, ''));
  return out;
}

// ── Manifest paths ─────────────────────────────────────────────────────────

/** Manifest placeholders that live inside the user profile → profile-relative roots. */
const PLACEHOLDERS: Record<string, string> = {
  '<winDocuments>': 'Documents',
  '<winAppData>': 'AppData/Roaming',
  '<winLocalAppData>': 'AppData/Local',
  '<winLocalAppDataLow>': 'AppData/LocalLow',
  '<home>/Documents': 'Documents',
  '<home>/Saved Games': 'Saved Games',
  '<home>/AppData/Roaming': 'AppData/Roaming',
  '<home>/AppData/Local': 'AppData/Local',
  '<home>/AppData/LocalLow': 'AppData/LocalLow',
};

/**
 * "<winDocuments>/My Games/X/Saves/*.sav" → "Documents/My Games/X/Saves".
 * Paths outside the profile (<base>, <root>, <storeUserId>…) → null. Anything
 * from the first wildcard or unknown placeholder on is dropped, and a result
 * that is only a root folder is rejected (a scope must name the game's folder).
 */
export function convertManifestPath(p: string): string | null {
  const norm = p.replace(/\\/g, '/').trim();
  const key = Object.keys(PLACEHOLDERS).sort((a, b) => b.length - a.length).find((k) => norm === k || norm.startsWith(k + '/'));
  if (!key) return null;
  const rest = norm.slice(key.length).replace(/^\/+/, '');
  const segs: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.' ) continue;
    if (seg.includes('*') || seg.includes('<') || seg === '..') break;
    segs.push(seg);
  }
  if (!segs.length) return null;
  return `${PLACEHOLDERS[key]}/${segs.join('/')}`;
}

/** YAML scalar key as the manifest writes them: bare, "double-quoted" (JSON escapes) or 'single-quoted'. */
function unquoteKey(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * Reduce the manifest (a line iterator) to the index. The file is generated
 * with a fixed 2-space layout, so a small state machine over indentation is
 * enough — no YAML parser (and no 17 MB object) needed:
 *
 *   Game Title:
 *     files:
 *       "<winDocuments>/X":
 *         tags: [- save | - config]
 *         when: [- os: windows / store: steam …]
 *     steam:
 *       id: 123
 */
export async function buildIndex(lines: AsyncIterable<string> | Iterable<string>, fetchedAt = Date.now(), etag: string | null = null): Promise<ManifestIndex> {
  const index: ManifestIndex = { fetchedAt, etag, games: {}, bySteam: {} };
  let title = ''; let section = ''; let sub = '';
  let files: { p: string; tags: string[]; oses: string[] }[] = [];
  let steam: number | undefined;
  let cur: { p: string; tags: string[]; oses: string[] } | null = null;

  const flush = () => {
    if (!title) return;
    const paths: string[] = [];
    for (const f of files) {
      if (f.oses.length && !f.oses.includes('windows')) continue;
      if (f.tags.length && !f.tags.includes('save')) continue;
      const c = convertManifestPath(f.p);
      if (c && !paths.some((x) => x.toLowerCase() === c.toLowerCase())) paths.push(c);
    }
    if (paths.length) {
      const key = normalizeTitle(title);
      if (key && !index.games[key]) {
        index.games[key] = { title, ...(steam ? { steam } : {}), paths };
        if (steam) index.bySteam[String(steam)] = key;
      }
    }
    title = ''; files = []; steam = undefined; cur = null; section = ''; sub = '';
  };

  for await (const line of lines as AsyncIterable<string>) {
    if (!line || line.startsWith('#') || line === '---') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      flush();
      if (body.endsWith(':')) title = unquoteKey(body.slice(0, -1));
      continue;
    }
    if (!title) continue;
    if (indent === 2) { section = body.replace(/:$/, ''); sub = ''; cur = null; continue; }
    if (section === 'files') {
      if (indent === 4 && body.endsWith(':')) { cur = { p: unquoteKey(body.slice(0, -1)), tags: [], oses: [] }; files.push(cur); sub = ''; continue; }
      if (!cur) continue;
      if (indent === 6) { sub = body.replace(/:$/, ''); continue; }
      if (sub === 'tags' && indent === 8 && body.startsWith('- ')) { cur.tags.push(body.slice(2).trim()); continue; }
      if (sub === 'when' && (indent === 8 || indent === 10)) {
        const m = body.replace(/^- /, '').match(/^os:\s*(\S+)/);
        if (m) cur.oses.push(m[1]);
      }
      continue;
    }
    if (section === 'steam' && indent === 4) {
      const m = body.match(/^id:\s*(\d+)/);
      if (m) steam = Number(m[1]);
    }
  }
  flush();
  return index;
}

// ── Fetch + cache ──────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;

export function loadIndex(file: string): ManifestIndex | null {
  try {
    const idx = JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestIndex;
    return idx && idx.games && idx.bySteam ? idx : null;
  } catch { return null; }
}

let inflight: Promise<ManifestIndex | null> | null = null;

/**
 * The cached index, refreshed from GitHub when older than a week (ETag-aware,
 * so an unchanged manifest costs one small request). A failed refresh keeps
 * the stale copy; with no copy at all, null.
 */
export async function getIndex(cacheFile: string, opts: { fetch?: FetchLike; maxAgeMs?: number; force?: boolean } = {}): Promise<ManifestIndex | null> {
  const cached = loadIndex(cacheFile);
  const maxAge = opts.maxAgeMs ?? MANIFEST_MAX_AGE_MS;
  if (cached && !opts.force && Date.now() - cached.fetchedAt < maxAge) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
      const headers: Record<string, string> = { 'User-Agent': 'RomM2SteamDeck' };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      const res = await doFetch(MANIFEST_URL, { headers });
      if (res.status === 304 && cached) {
        cached.fetchedAt = Date.now();
        fs.writeFileSync(cacheFile, JSON.stringify(cached));
        return cached;
      }
      if (!res.ok || !res.body) return cached;
      const rl = readline.createInterface({ input: Readable.fromWeb(res.body as never), crlfDelay: Infinity });
      const idx = await buildIndex(rl, Date.now(), res.headers.get('etag'));
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(idx));
      return idx;
    } catch {
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ── Lookup ─────────────────────────────────────────────────────────────────

/** `steam_appid.txt` next to the exe or in the game folder (Goldberg/GSE convention). */
export function goldbergAppId(exePath: string | null, gameFolder: string | null, exists = fs.existsSync, read = (p: string) => fs.readFileSync(p, 'utf8')): string | null {
  const dirs = [exePath ? path.dirname(exePath) : null, gameFolder].filter((d): d is string => !!d);
  for (const d of dirs) {
    const f = path.join(d, 'steam_appid.txt');
    try {
      if (!exists(f)) continue;
      const id = read(f).trim().match(/^\d+/)?.[0];
      if (id) return id;
    } catch { /* next */ }
  }
  return null;
}

export function goldbergPaths(appId: string): string[] {
  return [`AppData/Roaming/Goldberg SteamEmu Saves/${appId}`, `AppData/Roaming/GSE Saves/${appId}`];
}

export interface Detected { paths: string[]; notes: string[]; }

/** Combine Goldberg + manifest paths for a game. `notes` say where each came from. */
export function detectPaths(index: ManifestIndex | null, game: { name?: string; fsName?: string; folder?: string | null; exe?: string | null; steamAppId?: string | null }): Detected {
  const paths: string[] = []; const notes: string[] = [];
  const add = (p: string) => { if (!paths.some((x) => x.toLowerCase() === p.toLowerCase())) paths.push(p); };
  const appId = game.steamAppId ?? goldbergAppId(game.exe ?? null, game.folder ?? null);
  if (appId) { goldbergPaths(appId).forEach(add); notes.push(`Steam emulator saves (app ${appId})`); }
  if (index) {
    let hit: ManifestGame | undefined;
    if (appId && index.bySteam[appId]) hit = index.games[index.bySteam[appId]];
    if (!hit) for (const c of titleCandidates({ name: game.name, fsName: game.fsName, folder: game.folder ?? undefined })) { if (index.games[c]) { hit = index.games[c]; break; } }
    if (hit) { hit.paths.forEach(add); notes.push(`PCGamingWiki: ${hit.title}`); }
  }
  return { paths, notes };
}
