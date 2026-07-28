import { fetchAllSources, SOURCE_LABELS, type SourceKey } from "./vidsrc";
import { imdbToTmdb } from "./tmdb";

export interface Stream {
  name: string;
  title: string;
  url?: string;
  externalUrl?: string;
  subtitles?: Array<{ id: string; url: string; lang: string }>;
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
    notWebReady?: boolean;
    proxyHeaders?: {
      request?: Record<string, string>;
      response?: Record<string, string>;
    };
  };
}

const ADDON = "VidSrc";

export function b64url(input: string): string {
  const b64 = Buffer.from(input).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Route ALL sources through our own proxy so Stremio's built-in browser
// player gets clean CORS headers and any required Referer is attached
// server-side. Without this, Stremio's web player can't play the streams.
function urlFor(key: SourceKey, upstream: string, baseUrl: string): string {
  void key; // every source goes through proxy regardless
  return `${baseUrl}/api/public/proxy/${b64url(upstream)}.m3u8`;
}

async function build(
  type: "movie" | "tv",
  imdbId: string,
  baseUrl: string,
  season?: number,
  episode?: number,
): Promise<Stream[]> {
  const hit = await imdbToTmdb(type, imdbId);
  if (!hit) return [];
  const list = await fetchAllSources(type, hit.tmdbId, season, episode);
  const binge =
    type === "movie"
      ? `vidsrc-movie-${imdbId}`
      : `vidsrc-tv-${imdbId}-s${season}`;

  return list.map(({ key, source, subtitles }) => {
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
      url: urlFor(key, source.url, baseUrl),
      subtitles: subs.length ? subs : undefined,
      behaviorHints: {
        bingeGroup: `${binge}-${key}`,
      },
    };
  });
}

export function resolveMovie(imdbId: string, baseUrl: string): Promise<Stream[]> {
  return build("movie", imdbId, baseUrl);
}

export function resolveSeries(
  imdbId: string,
  season: number,
  episode: number,
  baseUrl: string,
): Promise<Stream[]> {
  return build("tv", imdbId, baseUrl, season, episode);
}
