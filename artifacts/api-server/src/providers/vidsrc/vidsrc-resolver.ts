// VidSrc stream resolver — fully self-contained within the vidsrc provider folder.
// Converts an IMDb ID → TMDB ID → flikhub sources → token-bound proxy stream objects.
//
// Proxy URLs use server-minted tokens (vidsrc-link-store) so only resolver-approved
// URLs can ever be fetched through the proxy — no open SSRF surface.

import { fetchAllSources, SOURCE_LABELS, type SourceKey } from "./vidsrc-core.js";
import { vidsrcImdbToTmdb } from "./vidsrc-tmdb.js";
import { createVidsrcLink } from "./vidsrc-link-store.js";

export interface VidsrcStream {
  name: string;
  title: string;
  url?: string;
  subtitles?: Array<{ id: string; url: string; lang: string }>;
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
  };
}

const ADDON = "VidSrc";

// All flikhub sources use the same player referer for the initial M3U8 fetch.
// Segment-level referer selection happens inside the proxy after following redirects.
const FLIKHUB_REFERER = "https://player.cinezo.live/";

// Mint a server-side token for the upstream URL and return a proxied M3U8 URL.
// baseUrl = apiBase(req) = https://host/api  (already includes BASE_PATH)
function buildProxyUrl(upstreamUrl: string, baseUrl: string): string {
  const token = createVidsrcLink(upstreamUrl, FLIKHUB_REFERER);
  return `${baseUrl}/vidsrc/proxy/m3u8/${token}.m3u8`;
}

async function build(
  type: "movie" | "tv",
  imdbId: string,
  baseUrl: string,
  season?: number,
  episode?: number,
): Promise<VidsrcStream[]> {
  const hit = await vidsrcImdbToTmdb(type, imdbId);
  if (!hit) return [];
  const list = await fetchAllSources(type, hit.tmdbId, season, episode);
  const binge =
    type === "movie"
      ? `vidsrc-movie-${imdbId}`
      : `vidsrc-tv-${imdbId}-s${season}`;

  return list.map(({ key, source, subtitles }: { key: SourceKey; source: { url: string }; subtitles: Array<{ url: string; lang?: string; label?: string }> }) => {
    const label = SOURCE_LABELS[key];
    const subs = subtitles
      .filter((s) => !!s.url)
      .map((s, i) => ({
        id: `${key}-${i}`,
        url: s.url,
        lang: (s.lang || s.label || "und").toLowerCase(),
      }));
    return {
      name: `${ADDON} • ${label}`,
      title: `${label}\nHLS`,
      url: buildProxyUrl(source.url, baseUrl),
      subtitles: subs.length ? subs : undefined,
      behaviorHints: {
        bingeGroup: `${binge}-${key}`,
      },
    };
  });
}

// Main entry point — matches the call signature used by the main stremio route:
//   getVidsrcStreams(type, imdbId, season, episode, proxyBase)
// proxyBase = apiBase(req) = https://host/api
export async function getVidsrcStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  proxyBase: string,
): Promise<VidsrcStream[]> {
  const tmdbType = type === "series" ? "tv" : "movie";
  return build(tmdbType, imdbId, proxyBase, season, episode);
}
