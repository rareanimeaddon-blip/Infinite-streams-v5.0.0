import { logger } from "./logger.js";

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const FETCH_TIMEOUT_MS = 8000;

// Simple cache
const metaCache = new Map<string, { data: MediaInfo | null; ts: number }>();
const episodeCountCache = new Map<string, { data: number[]; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface MediaInfo {
  id: string;
  name: string;
  year?: string;
  type: "movie" | "series";
  /** Country of origin as reported by Cinemeta, e.g. "United States", "South Korea" */
  country?: string;
  /** TMDB / MovieDB ID — used by VidLink */
  moviedbId?: string;
}

export interface CinemetaVideo {
  name?: string;
  season: number;
  number: number;
  episode?: number;
}

async function fetchMeta(
  type: "movie" | "series",
  imdbId: string
): Promise<MediaInfo | null> {
  const cacheKey = `${type}:${imdbId}`;
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Stremio Addon" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn({ imdbId, type, status: res.status }, "Cinemeta fetch failed");
      metaCache.set(cacheKey, { data: null, ts: Date.now() });
      return null;
    }

    const json = (await res.json()) as {
      meta?: {
        id?: string;
        name?: string;
        year?: string | number;
        type?: string;
        country?: string;
        moviedb_id?: number;
      };
    };

    if (!json.meta?.name) {
      metaCache.set(cacheKey, { data: null, ts: Date.now() });
      return null;
    }

    const info: MediaInfo = {
      id: imdbId,
      name: json.meta.name,
      year: json.meta.year?.toString(),
      type,
      country: json.meta.country ?? undefined,
      moviedbId: json.meta.moviedb_id ? String(json.meta.moviedb_id) : undefined,
    };

    metaCache.set(cacheKey, { data: info, ts: Date.now() });
    return info;
  } catch (err) {
    logger.error({ err, imdbId, type }, "Cinemeta error");
    metaCache.set(cacheKey, { data: null, ts: Date.now() });
    return null;
  }
}

/**
 * Returns the episode count per season as an array.
 * episodesPerSeason[0] = number of episodes in season 1, etc.
 */
export async function getEpisodesPerSeason(imdbId: string): Promise<number[]> {
  const cacheKey = `eps:${imdbId}`;
  const cached = episodeCountCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `${CINEMETA_BASE}/meta/series/${imdbId}.json`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Stremio Addon" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const json = (await res.json()) as {
      meta?: { videos?: CinemetaVideo[] };
    };

    const videos = json.meta?.videos ?? [];
    if (videos.length === 0) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const seasonMaxEp = new Map<number, number>();
    for (const v of videos) {
      if (!v.season || v.season <= 0) continue;
      const ep = v.number ?? v.episode ?? 0;
      if (ep > 0) {
        const prev = seasonMaxEp.get(v.season) ?? 0;
        seasonMaxEp.set(v.season, Math.max(prev, ep));
      }
    }

    if (seasonMaxEp.size === 0) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const maxSeason = Math.max(...seasonMaxEp.keys());
    const result: number[] = [];
    for (let s = 1; s <= maxSeason; s++) {
      result.push(seasonMaxEp.get(s) ?? 0);
    }

    episodeCountCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    logger.error({ err, imdbId }, "Cinemeta getEpisodesPerSeason error");
    episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
    return [];
  }
}

export async function getMovieMeta(imdbId: string): Promise<MediaInfo | null> {
  return fetchMeta("movie", imdbId);
}

export async function getSeriesMeta(imdbId: string): Promise<MediaInfo | null> {
  return fetchMeta("series", imdbId);
}

/**
 * Returns the TMDB/MovieDB ID for a given IMDB ID.
 * Used by VidLink — wraps getMovieMeta/getSeriesMeta to avoid a duplicate fetch.
 */
export async function getTmdbId(
  imdbId: string,
  type: "movie" | "series"
): Promise<string | null> {
  const meta = await fetchMeta(type, imdbId);
  return meta?.moviedbId ?? null;
}
