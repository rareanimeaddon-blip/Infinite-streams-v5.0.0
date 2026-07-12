import { logger } from "../../lib/logger.js";

const XPASS_BASE = "https://play.xpass.top";
const STREAM_REFERER = "https://streamsrcs.2embed.cc/";
const EMBED_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: STREAM_REFERER,
};

// Only sources from this hostname are known to work reliably (non-TikTok CDN).
// All other DooFlix sources are dead or geo-blocked.
const ALLOWED_SOURCE_HOSTNAMES = new Set([
  "vip.1x2.space",
]);

export interface DooflixStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: { notWebReady?: boolean };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

function extractPrimaryPath(html: string): string | null {
  const m = html.match(/"playlist"\s*:\s*"(\/[^"]+)"/);
  return m?.[1] ?? null;
}

interface BackupEntry { name: string; url: string; }

function extractBackups(html: string): BackupEntry[] {
  const si = html.indexOf("var backups=");
  if (si < 0) return [];
  const ai = html.indexOf("[", si);
  if (ai < 0) return [];
  let depth = 0, ae = -1;
  for (let i = ai; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]" && --depth === 0) { ae = i; break; }
  }
  if (ae < 0) return [];
  try {
    const arr = JSON.parse(html.slice(ai, ae + 1)) as Array<{ name?: string; url?: string; dl?: boolean }>;
    return arr.filter(b => !b.dl && typeof b.url === "string" && typeof b.name === "string" && b.url.length > 0)
      .map(b => ({ name: b.name!, url: b.url! }));
  } catch { return []; }
}

interface PlaylistSource { file: string; type?: string; label?: string; }

function isAllowedSource(srcFile: string): boolean {
  try {
    const { hostname } = new URL(srcFile);
    return ALLOWED_SOURCE_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

async function fetchPlaylistStreams(
  playlistUrl: string,
  embedUrl: string,
  sourceLabel?: string,
): Promise<DooflixStream[]> {
  const res = await fetchWithTimeout(playlistUrl, {
    headers: { ...EMBED_HEADERS, Referer: embedUrl },
    redirect: "follow",
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { playlist?: { sources?: PlaylistSource[] }[] };
  const now = Math.floor(Date.now() / 1000);
  const streams: DooflixStream[] = [];

  for (const item of json.playlist ?? []) {
    for (const src of item.sources ?? []) {
      if (!src.file) continue;
      if (/\/video\/error\b/i.test(src.file) || src.file.trim() === "/video/error") continue;

      const exp = src.file.match(/[?&]e=(\d+)/);
      if (exp && parseInt(exp[1]!, 10) < now) {
        logger.debug({ file: src.file }, "DooFlix: skipping expired stream");
        continue;
      }

      if (!isAllowedSource(src.file)) {
        logger.debug({ file: src.file }, "DooFlix: skipping non-allowlisted source");
        continue;
      }

      const label = src.label ?? sourceLabel ?? "HD";
      streams.push({
        name: `DooFlix\n${label}`,
        title: `▶ ${label} · HLS`,
        url: src.file,
        behaviorHints: { notWebReady: true },
      });
    }
  }

  return streams;
}

async function getXpassStreams(
  imdbId: string,
  kind: "movie" | "tv",
  season?: number,
  episode?: number,
): Promise<DooflixStream[]> {
  const embedUrl =
    kind === "movie"
      ? `${XPASS_BASE}/e/movie/${imdbId}`
      : `${XPASS_BASE}/e/tv/${imdbId}/${season}/${episode}`;

  logger.info({ embedUrl }, "DooFlix: fetching embed");

  const embedRes = await fetchWithTimeout(embedUrl, { headers: EMBED_HEADERS, redirect: "follow" });
  if (!embedRes.ok) {
    logger.warn({ embedUrl, status: embedRes.status }, "DooFlix: embed fetch failed");
    return [];
  }

  const html = await embedRes.text();
  const tried = new Set<string>();
  const toFetch: Array<{ path: string; label?: string }> = [];

  const primaryPath = extractPrimaryPath(html);
  if (primaryPath) { tried.add(primaryPath); toFetch.push({ path: primaryPath }); }

  for (const b of extractBackups(html)) {
    if (tried.has(b.url)) continue;
    tried.add(b.url);
    toFetch.push({ path: b.url, label: b.name });
    if (toFetch.length >= 8) break;
  }

  if (toFetch.length === 0) {
    logger.warn({ embedUrl }, "DooFlix: no playlist paths found in embed HTML");
    return [];
  }

  // Fetch all playlist.json files in parallel.
  const results = await Promise.allSettled(
    toFetch.map(({ path, label }) =>
      fetchPlaylistStreams(`${XPASS_BASE}${path}`, embedUrl, label).catch(err => {
        logger.warn({ err, path }, "DooFlix: playlist fetch error");
        return [] as DooflixStream[];
      }),
    ),
  );

  // Deduplicate streams by URL.
  const seen = new Set<string>();
  const streams: DooflixStream[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const s of r.value) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      streams.push(s);
    }
  }

  logger.info({ embedUrl, count: streams.length }, "DooFlix: streams fetched");
  return streams;
}

export async function getDooflixMovieStreams(_proxyBase: string, imdbId: string): Promise<DooflixStream[]> {
  return getXpassStreams(imdbId, "movie");
}

export async function getDooflixSeriesStreams(
  _proxyBase: string,
  imdbId: string,
  season: number,
  episode: number,
): Promise<DooflixStream[]> {
  return getXpassStreams(imdbId, "tv", season, episode);
}
