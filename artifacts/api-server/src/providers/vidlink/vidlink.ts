/**
 * VidLink provider — self-contained, no external dependencies beyond Node fetch.
 *
 * Fetches HLS/MP4 streams from vidlink.pro via their JSON API:
 *   Movie: GET https://vidlink.pro/api/b/movie/{tmdbId}
 *   TV:    GET https://vidlink.pro/api/b/tv/{tmdbId}/{season}/{episode}
 *
 * Requires a TMDB numeric ID. Pass null to skip (returns []).
 */

import { logger } from "../../lib/logger.js";

const VIDLINK_BASE = "https://vidlink.pro";
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface VidlinkSource {
  file?: string;
  url?: string;
  label?: string;
  type?: string;
}

interface VidlinkSubtitle {
  url?: string;
  file?: string;
  lang?: string;
  language?: string;
  label?: string;
}

interface VidlinkStream {
  playlist?: string;
  sources?: VidlinkSource[];
  subtitles?: VidlinkSubtitle[];
}

interface VidlinkResponse {
  stream?: VidlinkStream;
  sources?: VidlinkSource[];
  playlist?: string;
  url?: string;
  // Some responses wrap everything in a "data" key
  data?: {
    stream?: VidlinkStream;
    sources?: VidlinkSource[];
    playlist?: string;
  };
}

function extractStreamUrls(data: VidlinkResponse): string[] {
  const urls: string[] = [];

  const push = (v: string | undefined) => {
    if (v && /https?:\/\//.test(v)) urls.push(v);
  };

  const root = data.data ?? data;

  // stream.playlist
  push(root.stream?.playlist);

  // stream.sources[]
  for (const s of root.stream?.sources ?? []) {
    push(s.file);
    push(s.url);
  }

  // top-level sources[]
  for (const s of (root as VidlinkResponse).sources ?? []) {
    push(s.file);
    push(s.url);
  }

  // top-level playlist / url
  push((root as VidlinkResponse).playlist);
  push((root as VidlinkResponse).url);

  return [...new Set(urls)];
}

function detectQuality(url: string): string {
  if (/2160|4k|uhd/i.test(url)) return "4K";
  if (/1080/i.test(url)) return "1080p";
  if (/720/i.test(url)) return "720p";
  if (/480/i.test(url)) return "480p";
  if (/360/i.test(url)) return "360p";
  return "HD";
}

export async function getVidlinkStreams(
  tmdbId: string | null,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  if (!tmdbId) return [];

  const apiUrl =
    type === "series"
      ? `${VIDLINK_BASE}/api/b/tv/${tmdbId}/${season}/${episode}`
      : `${VIDLINK_BASE}/api/b/movie/${tmdbId}`;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(apiUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: `${VIDLINK_BASE}/`,
          Origin: VIDLINK_BASE,
          Accept: "application/json, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    if (!resp.ok) {
      logger.warn({ url: apiUrl, status: resp.status }, "VidLink: API returned non-200");
      return [];
    }

    const data = (await resp.json()) as VidlinkResponse;
    const streamUrls = extractStreamUrls(data);

    if (!streamUrls.length) {
      logger.info({ tmdbId, type }, "VidLink: no stream URLs in API response");
      return [];
    }

    logger.info({ tmdbId, type, count: streamUrls.length }, "VidLink: streams found");

    return streamUrls.map((url, i) => {
      const quality = detectQuality(url);
      return {
        name: "🔗 VidLink",
        title: `VidLink · ${quality}${i > 0 ? ` (${i + 1})` : ""}\nvidlink.pro`,
        url,
        behaviorHints: { notWebReady: false },
        _idVerified: true,
      };
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      logger.warn({ tmdbId, type }, "VidLink: request timed out");
    } else {
      logger.error({ err: err?.message, tmdbId, type }, "VidLink: error");
    }
    return [];
  }
}
