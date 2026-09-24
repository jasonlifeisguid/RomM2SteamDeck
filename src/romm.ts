/**
 * RomM API client.
 *
 * Uses HTTP Basic auth on every request (RomM supports this natively).
 * All list endpoints paginate with limit/offset until the server-reported
 * total is reached, so libraries of any size load completely.
 *
 * Rom objects are trimmed to the fields the app actually uses (see slimRom):
 * the server's SimpleRomSchema carries igdb/moby/ss metadata, file lists,
 * per-user state and sibling links — measured at ~4.7 KB per rom, of which the
 * UI reads ~0.9 KB. Trimming cuts the on-disk cache, the JSON parse on every
 * platform select, and the IPC structured-clone to the renderer by ~5x.
 */

export interface RommPlatform {
  id: number;
  name: string;
  fs_slug: string;
  rom_count: number;
}

export interface RommMetadatum {
  first_release_date?: number | string | null;
  genres?: string[];
  average_rating?: number | null;
  companies?: string[];
  player_count?: string | null;
}

export interface RommRom {
  id: number;
  name: string;
  platform_id: number;
  fs_name: string;
  fs_size_bytes: number;
  path_cover_small?: string;
  path_cover_large?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  merged_screenshots?: string[];
  metadatum?: RommMetadatum;
}

/** Project a raw server rom onto the fields the app uses. Idempotent, so it is
 *  safe to run over already-slim cached data. */
export function slimRom(raw: Record<string, unknown>): RommRom {
  const md = (raw.metadatum && typeof raw.metadatum === 'object' ? raw.metadatum : {}) as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const rom: RommRom = {
    id: Number(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    platform_id: Number(raw.platform_id),
    fs_name: typeof raw.fs_name === 'string' ? raw.fs_name : '',
    fs_size_bytes: Number(raw.fs_size_bytes) || 0,
  };
  if (typeof raw.path_cover_small === 'string' && raw.path_cover_small) rom.path_cover_small = raw.path_cover_small;
  if (typeof raw.path_cover_large === 'string' && raw.path_cover_large) rom.path_cover_large = raw.path_cover_large;
  if (typeof raw.summary === 'string' && raw.summary) rom.summary = raw.summary;
  if (typeof raw.created_at === 'string') rom.created_at = raw.created_at;
  if (typeof raw.updated_at === 'string') rom.updated_at = raw.updated_at;
  const shots = strArr(raw.merged_screenshots);
  if (shots && shots.length) rom.merged_screenshots = shots;
  if (raw.metadatum) {
    const m: RommMetadatum = {};
    if (md.first_release_date !== undefined) m.first_release_date = md.first_release_date as RommMetadatum['first_release_date'];
    const genres = strArr(md.genres);
    if (genres && genres.length) m.genres = genres;
    if (typeof md.average_rating === 'number') m.average_rating = md.average_rating;
    const companies = strArr(md.companies);
    if (companies && companies.length) m.companies = companies;
    if (typeof md.player_count === 'string' && md.player_count) m.player_count = md.player_count;
    rom.metadatum = m;
  }
  return rom;
}

export interface RommSave {
  id: number;
  rom_id: number;
  user_id: number;
  file_name: string;
  file_size_bytes: number;
  emulator: string | null;
  slot: string | null;
  content_hash: string | null; // MD5 of the file
  is_public: boolean;
  origin_device_id: string | null;
  created_at: string;
  updated_at: string;
  device_syncs?: { device_id: string; device_name: string; last_synced_at: string }[];
}

const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/** Normalize whatever the user typed into a server root URL (no trailing slash, no /api). */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  url = url.replace(/\/api$/, '');
  return url;
}

type RomsPage = { items: Record<string, unknown>[]; total: number } | Record<string, unknown>[];

export class RommClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      headers: { accept: 'application/json', Authorization: this.authHeader },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`RomM API ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /** Fetch a binary resource (e.g. cover art) with auth. Returns null on failure. */
  async getBinary(serverPath: string): Promise<Buffer | null> {
    const sep = serverPath.startsWith('/') ? '' : '/';
    try {
      const response = await fetch(`${this.baseUrl}${sep}${serverPath}`, {
        headers: { Authorization: this.authHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Open a streaming download of a rom's content. Caller owns the body stream.
   *  Pass `resume` to request the remainder of a partial download; the caller
   *  must check `response.status === 206` to know the server honored the range
   *  (RomM serves single-file roms with range support, but zips multi-file roms
   *  on the fly, which ignores Range and sends the full body). `ifRange` guards
   *  against resuming across a changed file: on ETag mismatch the server sends
   *  the whole file (200) instead of a mismatched tail. */
  async openDownloadStream(
    romId: number,
    fsName: string,
    signal?: AbortSignal,
    resume?: { from: number; ifRange?: string }
  ): Promise<Response> {
    const url = `${this.baseUrl}/api/roms/${romId}/content/${encodeURIComponent(fsName)}`;
    const headers: Record<string, string> = { Authorization: this.authHeader };
    if (resume && resume.from > 0) {
      headers.Range = `bytes=${resume.from}-`;
      if (resume.ifRange) headers['If-Range'] = resume.ifRange;
    }
    const response = await fetch(url, { headers, signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  // ── Saves (RomM ≥ 3.x; devices ≥ 5.x) ──────────────────────────────────

  private async json(method: string, path: string, body?: BodyInit, ctype?: string): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json', Authorization: this.authHeader };
    if (ctype) headers['Content-Type'] = ctype;
    const response = await fetch(`${this.baseUrl}/api${path}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4) });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data };
  }

  /** Latest save per slot for a rom (the current user's own saves). */
  async savesSummary(romId: number): Promise<{ total_count: number; slots: { slot: string | null; count: number; latest: RommSave }[] }> {
    const r = await this.json('GET', `/saves/summary?rom_id=${romId}`);
    if (r.status !== 200) throw new Error(`RomM saves summary failed: ${r.status}`);
    return r.data as { total_count: number; slots: { slot: string | null; count: number; latest: RommSave }[] };
  }

  /** Upload a save file for a rom. Each upload is a new, timestamped version;
   *  `autocleanupLimit` keeps only that many in the slot. */
  async uploadSave(romId: number, fileName: string, content: Buffer, opts: { emulator: string; slot: string; deviceId?: string; autocleanupLimit?: number }): Promise<RommSave> {
    const q = new URLSearchParams({ rom_id: String(romId), emulator: opts.emulator, slot: opts.slot });
    if (opts.deviceId) q.set('device_id', opts.deviceId);
    if (opts.autocleanupLimit) { q.set('autocleanup', 'true'); q.set('autocleanup_limit', String(opts.autocleanupLimit)); }
    const form = new FormData();
    form.append('saveFile', new Blob([new Uint8Array(content)]), fileName);
    const r = await this.json('POST', `/saves?${q}`, form);
    if (r.status !== 200 && r.status !== 201) throw new Error(`RomM save upload failed: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    return r.data as RommSave;
  }

  async downloadSave(saveId: number, deviceId?: string): Promise<Buffer> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    const response = await fetch(`${this.baseUrl}/api/saves/${saveId}/content${q}`, {
      headers: { Authorization: this.authHeader }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
    });
    if (!response.ok) throw new Error(`RomM save download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Tell RomM this device now has the save (shows up in the save's device list). Best-effort. */
  async confirmSaveDownloaded(saveId: number, deviceId: string): Promise<void> {
    await this.json('POST', `/saves/${saveId}/downloaded`, JSON.stringify({ device_id: deviceId }), 'application/json');
  }

  /** Register this machine as a RomM device. Returns null on servers without the devices API. */
  async registerDevice(info: { name: string; platform: string; client: string; client_version: string; hostname: string }): Promise<string | null> {
    const r = await this.json('POST', '/devices', JSON.stringify({ ...info, allow_existing: true }), 'application/json');
    if (r.status === 404 || r.status === 405) return null;
    if (r.status !== 200 && r.status !== 201) throw new Error(`RomM device registration failed: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    const d = r.data as { device_id?: string };
    return d?.device_id || null;
  }

  /** The user's registered devices (id → name), for labelling where a save came from. Empty on old servers. */
  async listDevices(): Promise<{ id: string; name: string }[]> {
    try {
      const data = await this.get('/devices');
      const list = Array.isArray(data) ? data : [];
      return (list as { id?: unknown; name?: unknown; hostname?: unknown }[])
        .filter((d) => !!d && typeof d.id === 'string')
        .map((d) => ({ id: d.id as string, name: String(d.name || d.hostname || d.id) }));
    } catch { return []; }
  }

  async heartbeat(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const data = (await this.get('/heartbeat')) as { SYSTEM?: { VERSION?: string } };
      return { ok: true, version: data?.SYSTEM?.VERSION };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Does the server accept these credentials? /heartbeat needs no login, so it
   *  can't tell; the platform list does (and is small). */
  async verifyLogin(): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      await this.get('/platforms/');
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = Number(msg.match(/failed: (\d{3})/)?.[1]) || undefined;
      return { ok: false, status, error: msg };
    }
  }

  async getPlatforms(): Promise<RommPlatform[]> {
    const data = await this.get('/platforms/');
    return Array.isArray(data) ? (data as RommPlatform[]) : [];
  }

  private async getRomsPage(platformId: number, offset: number, extraQuery = ''): Promise<RomsPage> {
    // char_index and filter_values are extra server work we never use
    return (await this.get(
      `/roms?platform_ids=${platformId}&order_by=name&order_dir=asc&limit=${PAGE_SIZE}&offset=${offset}` +
      `&with_char_index=false&with_filter_values=false${extraQuery}`
    )) as RomsPage;
  }

  /**
   * Page through a rom list until the server-reported total is reached.
   *
   * RomM serves requests serially (measured: 2 parallel page requests each
   * take twice as long), so pages are fetched sequentially and reported via
   * onPage so the UI can render progressively during a long cold load.
   */
  private async pageAll(
    platformId: number,
    extraQuery: string,
    onPage?: (page: RommRom[], loaded: number, total: number) => void
  ): Promise<RommRom[]> {
    const roms: RommRom[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const data = await this.getRomsPage(platformId, offset, extraQuery);

      // Older RomM versions returned a plain list (no pagination envelope)
      if (Array.isArray(data)) {
        const page = data.map(slimRom);
        roms.push(...page);
        onPage?.(page, roms.length, roms.length);
        break;
      }

      const page = (data.items ?? []).map(slimRom);
      total = data.total ?? 0;
      roms.push(...page);
      onPage?.(page, roms.length, total);
      if (page.length === 0) break;
      offset += page.length;
    }

    return roms;
  }

  /** Fetch ALL roms for a platform, paging past the server page-size cap. */
  getRomsByPlatform(
    platformId: number,
    onPage?: (page: RommRom[], loaded: number, total: number) => void
  ): Promise<RommRom[]> {
    return this.pageAll(platformId, '', onPage);
  }

  /**
   * Delta sync: fetch only roms updated after the given time (measured ~1s
   * against a 5,000-game platform vs ~60s for a full fetch). Note this does
   * NOT reveal deletions — callers must reconcile counts separately.
   */
  getRomsUpdatedAfter(platformId: number, since: Date): Promise<RommRom[]> {
    return this.pageAll(platformId, `&updated_after=${encodeURIComponent(since.toISOString())}`);
  }
}
