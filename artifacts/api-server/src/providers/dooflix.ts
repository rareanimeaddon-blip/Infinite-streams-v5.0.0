import { logger } from "../lib/logger.js";

const XPASS_BASE = "https://play.xpass.top";
const STREAM_REFERER = "https://streamsrcs.2embed.cc/";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: STREAM_REFERER,
};

export interface DooflixStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: { notWebReady?: boolean };
}

function encodeHlsProxyUrl(proxyBase: string, targetUrl: string, referer: string): string {
  let origin = referer;
  try { origin = new URL(referer).origin; } catch { /* use referer as-is */ }
  return (
    `${proxyBase}/m3u8` +
    `?url=${encodeURIComponent(targetUrl)}` +
    `&referer=${encodeURIComponent(referer)}` +
    `&origin=${encodeURIComponent(origin)}`
  );
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

function extractPlaylistPath(html: string): string | null {
  const m = html.match(/"playlist"\s*:\s*"(\/mdata\/[^"]+)"/);
  return m?.[1] ?? null;
}

interface PlaylistSource {
  file: string;
  type?: string;
  label?: string;
}

async function fetchPlaylistStreams(
  proxyBase: string,
  playlistUrl: string,
  embedUrl: string,
): Promise<DooflixStream[]> {
  const res = await fetchWithTimeout(playlistUrl, {
    headers: { ...HEADERS, Referer: embedUrl },
    redirect: "follow",
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { playlist?: { sources?: PlaylistSource[] }[] };
  const now = Math.floor(Date.now() / 1000);
  const streams: DooflixStream[] = [];

  for (const item of json.playlist ?? []) {
    for (const src of item.sources ?? []) {
      if (!src.file) continue;
      // DooFlix returns /video/error (or similar) when they don't have the content.
      // Serving this URL produces a broken stream that plays for <1 s then crashes.
      if (/\/video\/error\b/i.test(src.file) || src.file.trim() === "/video/error") {
        logger.debug({ file: src.file }, "DooFlix: skipping error-placeholder stream");
        continue;
      }
      const exp = src.file.match(/[?&]e=(\d+)/);
      if (exp && parseInt(exp[1]!, 10) < now) {
        logger.debug({ file: src.file }, "DooFlix: skipping expired stream");
        continue;
      }
      const label = src.label ?? "HD";
      streams.push({
        name: `DooFlix\n${label}`,
        title: `▶ ${label} · HLS`,
        url: encodeHlsProxyUrl(proxyBase, src.file, embedUrl),
        behaviorHints: { notWebReady: false },
      });
    }
  }
  return streams;
}

async function getXpassStreams(
  proxyBase: string,
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

  const embedRes = await fetchWithTimeout(embedUrl, {
    headers: HEADERS,
    redirect: "follow",
  });
  if (!embedRes.ok) {
    logger.warn({ embedUrl, status: embedRes.status }, "DooFlix: embed fetch failed");
    return [];
  }

  const html = await embedRes.text();
  const playlistPath = extractPlaylistPath(html);
  if (!playlistPath) {
    logger.warn({ embedUrl }, "DooFlix: no playlist path in embed HTML");
    return [];
  }

  const streams = await fetchPlaylistStreams(proxyBase, `${XPASS_BASE}${playlistPath}`, embedUrl).catch((err) => {
    logger.warn({ err, embedUrl }, "DooFlix: playlist fetch error");
    return [];
  });

  logger.info({ embedUrl, count: streams.length }, "DooFlix: streams fetched");
  return streams;
}

export async function getDooflixMovieStreams(proxyBase: string, imdbId: string): Promise<DooflixStream[]> {
  return getXpassStreams(proxyBase, imdbId, "movie");
}

export async function getDooflixSeriesStreams(
  proxyBase: string,
  imdbId: string,
  season: number,
  episode: number,
): Promise<DooflixStream[]> {
  return getXpassStreams(proxyBase, imdbId, "tv", season, episode);
}
