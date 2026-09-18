/**
 * "Is there a newer release?" — one unauthenticated request to the GitHub
 * releases API, compared against the running version. R2SD never downloads
 * or installs anything by itself; it points at the release page. Off-able in
 * Settings. No electron imports.
 */

export const RELEASES_API = 'https://api.github.com/repos/jasonlifeisguid/RomM2SteamDeck/releases/latest';
export const RELEASES_PAGE = 'https://github.com/jasonlifeisguid/RomM2SteamDeck/releases/latest';

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  publishedAt: string | null;
  notes: string;
  checkedAt: number;
}

/** Numeric dotted compare ("2.2.19" vs "v2.2.20"); suffixes like "-beta" sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(.*)$/);
    return { nums: (m ? m[1] : '0').split('.').map(Number), pre: m ? m[2] : '' };
  };
  const pa = parse(a); const pb = parse(b);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export type FetchJson = (url: string) => Promise<{ status: number; json: unknown }>;

const defaultFetch: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RomM2SteamDeck' } });
  return { status: res.status, json: res.ok ? await res.json() : null };
};

export async function checkForUpdate(current: string, fetchJson: FetchJson = defaultFetch): Promise<UpdateInfo> {
  const { status, json } = await fetchJson(RELEASES_API);
  if (status !== 200 || !json || typeof json !== 'object') throw new Error(`GitHub returned ${status}`);
  const rel = json as { tag_name?: string; html_url?: string; published_at?: string; body?: string; draft?: boolean; prerelease?: boolean };
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  if (!latest) throw new Error('No release tag in the response');
  return {
    current, latest,
    newer: compareVersions(latest, current) > 0,
    url: rel.html_url || RELEASES_PAGE,
    publishedAt: rel.published_at || null,
    notes: String(rel.body || '').slice(0, 4000),
    checkedAt: Date.now(),
  };
}
