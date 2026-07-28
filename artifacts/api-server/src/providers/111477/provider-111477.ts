/**
 * 111477 Directory provider
 *
 * Scrapes the a.111477.xyz open-directory index and wraps each video file
 * through the pengu.uk → dark-moon Cloudflare Worker proxy chain, which
 * 307-redirects to a CORS+Range-enabled endpoint that Stremio can play.
 *
 * Fully self-contained — no imports from other providers or shared lib/utils.
 * Based on: attached_assets/111477-stremio-addon (addon.js)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const INDEX_BASE = "https://a.111477.xyz";
const PENGU_BASE = "https://pengu.uk/direct/111477-directory";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts)$/i;

const FETCH_TIMEOUT_MS = 12_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  path: string;   // absolute path from site root, e.g. "/tvs/Young Sheldon/"
  size: number;
  isDir: boolean;
}

interface StreamResult {
  name: string;
  title: string;
  url: string;
  behaviorHints: {
    bingeGroup: string;
    notWebReady: boolean;
  };
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry<T> { at: number; ttl: number; val: T }
const _cache = new Map<string, CacheEntry<unknown>>();

function cget<T>(k: string): T | null {
  const e = _cache.get(k) as CacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > e.ttl) { _cache.delete(k); return null; }
  return e.val;
}
function cset<T>(k: string, val: T, ttlMs: number): void {
  _cache.set(k, { at: Date.now(), ttl: ttlMs, val });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function buildStreamUrl(fileUrlAbsolute: string, fileName: string): string {
  const payload = Buffer.from(JSON.stringify({ url: fileUrlAbsolute })).toString("base64");
  const safeName = encodeURIComponent(fileName).replace(/%20/g, "-");
  return `${PENGU_BASE}/${payload}/${safeName}`;
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Directory scraping ───────────────────────────────────────────────────────
// The autoindex HTML embeds each entry as:
//   <tr data-entry="true" data-name="..." data-url="..."> ... <td class="size" data-sort="12345">

async function listDir(path: string): Promise<DirEntry[]> {
  const key = "111477:list:" + path;
  const hit = cget<DirEntry[]>(key);
  if (hit) return hit;

  const url = INDEX_BASE + path;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`111477 listDir ${path} → ${res.status}`);
  const html = await res.text();

  const entries: DirEntry[] = [];
  const re = /<tr\s+data-entry="true"\s+data-name="([^"]+)"\s+data-url="([^"]+)"[^>]*>[\s\S]*?data-sort="(-?\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = m[1]!
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    const rel = m[2]!;
    const size = parseInt(m[3]!, 10);
    const isDir = rel.endsWith("/");
    entries.push({ name, path: rel, size, isDir });
  }
  cset(key, entries, 10 * 60 * 1000); // 10 min
  return entries;
}

// ─── Fuzzy directory match ─────────────────────────────────────────────────────

function findBestDir(
  entries: DirEntry[],
  wanted: string,
  year?: string | number,
): DirEntry | null {
  const wn = normTitle(wanted);
  const dirs = entries.filter(e => e.isDir);
  const scored = dirs
    .map(d => {
      const dn = normTitle(d.name.replace(/\/$/, ""));
      let score = 0;
      if (dn === wn) score = 100;
      else if (dn.startsWith(wn + " ")) score = 90;
      else if (dn.startsWith(wn)) score = 80;
      else if (dn.includes(wn)) score = 60;
      if (year && d.name.includes(String(year))) score += 5;
      return { d, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0]!.d : null;
}

// ─── Stream label helpers ──────────────────────────────────────────────────────

interface FileTags {
  q: string; src: string; vcodec: string; acodec: string; ch: string; group: string;
}

function parseTags(fname: string): FileTags {
  const q     = (fname.match(/\b(2160p|1080p|720p|480p)\b/i)                               ?? [])[1] ?? "";
  const src   = (fname.match(/\b(Bluray|BluRay|WEB[-. ]?DL|WEBRip|WEB|HDTV|DVDRip|BDRip|Remux)\b/i) ?? [])[1] ?? "";
  const vcodec = (fname.match(/\b(x265|x264|HEVC|AVC|H\.?264|H\.?265)\b/i)                ?? [])[1] ?? "";
  const acodec = (fname.match(/\b(DTS-HD MA|DTS-HD|DTS|EAC3|AC3|AAC|Atmos|TrueHD|FLAC|Opus)\b/i) ?? [])[1] ?? "";
  const ch    = (fname.match(/\b(7\.1|5\.1|2\.0)\b/)                                       ?? [])[1] ?? "";
  const group = (fname.match(/-([A-Za-z0-9]+)\.[a-z0-9]+$/)                                ?? [])[1] ?? "";
  return { q, src, vcodec, acodec, ch, group };
}

function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

function toStream(file: DirEntry): StreamResult {
  const abs = INDEX_BASE + file.path;
  const t = parseTags(file.name);
  const parts = [
    t.q, t.src, t.vcodec,
    [t.acodec, t.ch].filter(Boolean).join(" "),
  ].filter(Boolean);
  const label = [
    parts.join(" • "),
    humanSize(file.size),
    t.group ? `-${t.group}` : "",
  ].filter(Boolean).join("\n");
  return {
    name: "111477" + (t.q ? " " + t.q : ""),
    title: label || file.name,
    url: buildStreamUrl(abs, file.name),
    behaviorHints: {
      bingeGroup: `_111477_${t.q}_${t.src}_${t.vcodec}`,
      notWebReady: false,
    },
  };
}

// ─── Series resolver ──────────────────────────────────────────────────────────

async function seriesStreams(
  title: string,
  year: string | number | undefined,
  season: number,
  episode: number,
): Promise<StreamResult[]> {
  const roots = ["/tvs/", "/asiandrama/", "/kdrama/"];
  let showDir: string | null = null;

  for (const root of roots) {
    const entries = await listDir(root).catch(() => [] as DirEntry[]);
    const hit = findBestDir(entries, title, year);
    if (hit) { showDir = hit.path; break; }
  }
  if (!showDir) return [];

  const seasonEntries = await listDir(showDir).catch(() => [] as DirEntry[]);
  const seasonDir = seasonEntries.find(
    e =>
      e.isDir &&
      /season/i.test(e.name) &&
      (new RegExp(`\\b0*${season}\\b`).test(e.name) ||
        e.name.toLowerCase().includes(`season ${season}`)),
  );

  // Candidate files can live in the season subdir OR flat under the show dir.
  const pools: DirEntry[][] = [];
  if (seasonDir) pools.push(await listDir(seasonDir.path).catch(() => []));
  pools.push(seasonEntries);

  const epRe = new RegExp(
    `(s0*${season}[ ._-]?e0*${episode}\\b)|(\\b${season}x0*${episode}\\b)`,
    "i",
  );
  const files: DirEntry[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    for (const f of pool) {
      if (f.isDir) continue;
      if (!VIDEO_EXT.test(f.name)) continue;
      if (!epRe.test(f.name)) continue;
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
  }
  files.sort((a, b) => (b.size || 0) - (a.size || 0));
  return files.map(toStream);
}

// ─── Movie resolver ───────────────────────────────────────────────────────────

async function movieStreams(
  title: string,
  year: string | number | undefined,
): Promise<StreamResult[]> {
  const entries = await listDir("/movies/").catch(() => [] as DirEntry[]);
  const hit = findBestDir(entries, title, year);
  if (!hit) return [];

  const inside = await listDir(hit.path).catch(() => [] as DirEntry[]);
  let files = inside.filter(e => !e.isDir && VIDEO_EXT.test(e.name));
  if (!files.length) {
    const sub = inside.find(e => e.isDir);
    if (sub) {
      const sub2 = await listDir(sub.path).catch(() => [] as DirEntry[]);
      files = sub2.filter(e => !e.isDir && VIDEO_EXT.test(e.name));
    }
  }
  files.sort((a, b) => (b.size || 0) - (a.size || 0));
  return files.map(toStream);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Returns Stremio-compatible stream objects for the given title.
 *
 * @param type     "movie" | "series"
 * @param title    Primary title (from TMDB/IMDB meta)
 * @param alias    Alternate title to try when primary finds nothing (may be undefined)
 * @param year     Release year for tighter directory matching (may be undefined)
 * @param season   Season number (series only)
 * @param episode  Episode number (series only)
 */
export async function get111477Streams(
  type: "movie" | "series",
  title: string,
  alias: string | undefined,
  year: number | undefined,
  season?: number,
  episode?: number,
): Promise<StreamResult[]> {
  try {
    if (type === "series") {
      if (season === undefined || episode === undefined) return [];
      let streams = await seriesStreams(title, year, season, episode);
      // Retry with alias if primary title found nothing
      if (!streams.length && alias && alias !== title) {
        streams = await seriesStreams(alias, year, season, episode);
      }
      return streams;
    }

    // movie
    let streams = await movieStreams(title, year);
    if (!streams.length && alias && alias !== title) {
      streams = await movieStreams(alias, year);
    }
    return streams;
  } catch (err) {
    console.error("[111477] stream error", type, title, (err as Error).message);
    return [];
  }
}
