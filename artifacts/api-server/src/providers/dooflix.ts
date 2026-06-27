import { logger } from "../lib/logger.js";

const XPASS_BASE = "https://play.xpass.top";
const STREAM_REFERER = "https://streamsrcs.2embed.cc/";
const EMBED_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: STREAM_REFERER,
};

// Segment CDNs that are geo-blocked in India or that block cloud IPs.
// Identified by probing master.m3u8 → variant.m3u8 → first segment URL.
const BANNED_SEGMENT_CDN = /tiktokcdn\.com/i;

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

/**
 * Probe a source's HLS chain to determine the segment CDN hostname.
 * Returns null if the chain is broken (non-200, non-M3U8, redirect to HTML, etc.).
 * Returns "relative" if segments are relative URLs.
 * Returns the hostname string if segments are absolute URLs.
 *
 * We use this to exclude sources whose segments come from TikTok CDN
 * (banned in India) or sources with broken redirect chains.
 */
async function probeSegmentCdn(srcFile: string, embedUrl: string): Promise<string | null> {
  try {
    const mr = await fetchWithTimeout(srcFile, {
      headers: { ...EMBED_HEADERS, Referer: embedUrl },
      redirect: "follow",
    }, 8000);
    if (!mr.ok) return null;
    const masterText = await mr.text();
    if (!masterText.includes("#EXTM3U")) return null;

    // Find first variant URL line (non-comment, non-empty)
    const lines = masterText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    if (!lines.length) return null;
    const firstVariantRaw = lines[0]!;

    const base = new URL(srcFile);
    const variantUrl = firstVariantRaw.startsWith("http")
      ? firstVariantRaw
      : `${base.origin}${base.pathname.replace(/[^/]+$/, "")}${firstVariantRaw}`;

    const vr = await fetchWithTimeout(variantUrl, {
      headers: { ...EMBED_HEADERS, Referer: srcFile },
      redirect: "follow",
    }, 8000);
    if (!vr.ok) return null;
    const variantText = await vr.text();
    if (!variantText.includes("#EXTM3U")) return null;

    const segLines = variantText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    if (!segLines.length) return "relative";
    const firstSeg = segLines[0]!;
    if (firstSeg.startsWith("http")) return new URL(firstSeg).hostname;
    return "relative";
  } catch {
    return null;
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
  const candidates: Array<{ src: PlaylistSource; label: string }> = [];

  for (const item of json.playlist ?? []) {
    for (const src of item.sources ?? []) {
      if (!src.file) continue;
      if (/\/video\/error\b/i.test(src.file) || src.file.trim() === "/video/error") continue;
      const exp = src.file.match(/[?&]e=(\d+)/);
      if (exp && parseInt(exp[1]!, 10) < now) {
        logger.debug({ file: src.file }, "DooFlix: skipping expired stream");
        continue;
      }
      candidates.push({ src, label: src.label ?? sourceLabel ?? "HD" });
    }
  }

  if (!candidates.length) return [];

  // Probe all candidate sources in parallel to detect segment CDN.
  const probes = await Promise.allSettled(
    candidates.map(c => probeSegmentCdn(c.src.file, embedUrl)),
  );

  const streams: DooflixStream[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { src, label } = candidates[i]!;
    const probe = probes[i];
    const segCdn = probe?.status === "fulfilled" ? probe.value : null;

    if (segCdn === null) {
      logger.debug({ file: src.file }, "DooFlix: skipping — probe failed (broken chain)");
      continue;
    }
    if (BANNED_SEGMENT_CDN.test(segCdn)) {
      logger.debug({ file: src.file, segCdn }, "DooFlix: skipping — TikTok CDN banned in India");
      continue;
    }

    logger.debug({ file: src.file, segCdn }, "DooFlix: source passes probe");
    // Return the M3U8 URL directly — user's player fetches segments from their own IP.
    streams.push({
      name: `DooFlix\n${label}`,
      title: `▶ ${label} · HLS`,
      url: src.file,
      behaviorHints: { notWebReady: true },
    });
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

  // Fetch all backup playlist.json files in parallel.
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
