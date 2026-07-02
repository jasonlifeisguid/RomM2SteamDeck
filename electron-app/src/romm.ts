/**
 * RomM API client.
 *
 * Uses HTTP Basic auth on every request (RomM supports this natively).
 * All list endpoints paginate with limit/offset until the server-reported
 * total is reached, so libraries of any size load completely.
 */

export interface RommPlatform {
  id: number;
  name: string;
  fs_slug: string;
  rom_count: number;
}

export interface RommRom {
  id: number;
  name: string;
  platform_id: number;
  fs_name: string;
  fs_size_bytes: number;
  path_cover_small?: string;
  path_cover_large?: string;
  url_cover?: string;
  summary?: string;
  first_release_date?: number | string | null;
  genres?: unknown[];
  [key: string]: unknown;
}

const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/** Normalize whatever the user typed into a server root URL (no trailing slash, no /api). */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  url = url.replace(/\/api$/, '');
  return url;
}

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

  /** Open a streaming download of a rom's content. Caller owns the body stream. */
  async openDownloadStream(romId: number, fsName: string, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/api/roms/${romId}/content/${encodeURIComponent(fsName)}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  async heartbeat(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const data = (await this.get('/heartbeat')) as { SYSTEM?: { VERSION?: string } };
      return { ok: true, version: data?.SYSTEM?.VERSION };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPlatforms(): Promise<RommPlatform[]> {
    const data = await this.get('/platforms/');
    return Array.isArray(data) ? (data as RommPlatform[]) : [];
  }

  private async getRomsPage(platformId: number, offset: number, extraQuery = ''): Promise<{ items: RommRom[]; total: number } | RommRom[]> {
    // char_index and filter_values are extra server work we never use
    return (await this.get(
      `/roms?platform_ids=${platformId}&order_by=name&order_dir=asc&limit=${PAGE_SIZE}&offset=${offset}` +
      `&with_char_index=false&with_filter_values=false${extraQuery}`
    )) as { items: RommRom[]; total: number } | RommRom[];
  }

  /**
   * Fetch ALL roms for a platform, paging past the server page-size cap.
   *
   * RomM serves requests serially (measured: 2 parallel page requests each
   * take twice as long), so pages are fetched sequentially and reported via
   * onPage so the UI can render progressively during a long cold load.
   */
  async getRomsByPlatform(
    platformId: number,
    onPage?: (page: RommRom[], loaded: number, total: number) => void
  ): Promise<RommRom[]> {
    const roms: RommRom[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const data = await this.getRomsPage(platformId, offset);

      // Older RomM versions returned a plain list (no pagination envelope)
      if (Array.isArray(data)) {
        roms.push(...data);
        onPage?.(data, roms.length, roms.length);
        break;
      }

      const items = data.items ?? [];
      total = data.total ?? 0;
      roms.push(...items);
      onPage?.(items, roms.length, total);
      if (items.length === 0) break;
      offset += items.length;
    }

    return roms;
  }

  /**
   * Delta sync: fetch only roms updated after the given time (measured ~1s
   * against a 5,000-game platform vs ~60s for a full fetch). Note this does
   * NOT reveal deletions — callers must reconcile counts separately.
   */
  async getRomsUpdatedAfter(platformId: number, since: Date): Promise<RommRom[]> {
    const iso = encodeURIComponent(since.toISOString());
    const roms: RommRom[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const data = await this.getRomsPage(platformId, offset, `&updated_after=${iso}`);
      if (Array.isArray(data)) {
        roms.push(...data);
        break;
      }
      const items = data.items ?? [];
      total = data.total ?? 0;
      roms.push(...items);
      if (items.length === 0) break;
      offset += items.length;
    }

    return roms;
  }
}
