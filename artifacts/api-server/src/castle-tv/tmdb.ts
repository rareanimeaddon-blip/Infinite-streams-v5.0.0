import axios from "axios";
import { logger } from "../lib/logger.js";

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE = "https://api.themoviedb.org/3";

export interface TmdbInfo {
  tmdbId: number;
  title: string;
  year: string | null;
}

const cache = new Map<string, { data: TmdbInfo | null; ts: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

type FindResult = {
  movie_results: Array<{ id: number; title?: string; release_date?: string }>;
  tv_results: Array<{ id: number; name?: string; first_air_date?: string }>;
};

type SearchResult = {
  results: Array<{ id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }>;
};

const titleSearchCache = new Map<string, { data: number | null; ts: number }>();

export async function searchTmdbByTitle(
  title: string,
  year: number | undefined,
  type: "movie" | "series",
): Promise<number | null> {
  const key = `search:${type}:${title}:${year ?? ""}`;
  const cached = titleSearchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const endpoint = type === "movie" ? "search/movie" : "search/tv";
    const params: Record<string, string | number> = {
      api_key: TMDB_API_KEY,
      query: title,
      include_adult: "false",
    };
    if (year) {
      if (type === "movie") params["year"] = year;
      else params["first_air_date_year"] = year;
    }
    const res = await axios.get<SearchResult>(`${TMDB_BASE}/${endpoint}`, {
      params,
      timeout: 8000,
    });
    const results = res.data.results ?? [];
    const id = results[0]?.id ?? null;
    titleSearchCache.set(key, { data: id, ts: Date.now() });
    return id;
  } catch (err) {
    logger.warn({ err, title }, "tmdb: search by title failed");
    return null;
  }
}

export async function getTmdbInfo(
  imdbId: string,
  type: "movie" | "series",
): Promise<TmdbInfo | null> {
  const key = `${type}:${imdbId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const res = await axios.get<FindResult>(`${TMDB_BASE}/find/${imdbId}`, {
      params: { api_key: TMDB_API_KEY, external_source: "imdb_id" },
      timeout: 8000,
    });

    const results =
      type === "movie" ? res.data.movie_results : res.data.tv_results;
    if (!results?.length) {
      cache.set(key, { data: null, ts: Date.now() });
      return null;
    }

    const item = results[0]!;
    const isTv = type === "series";
    const title = isTv
      ? (item as { name?: string }).name ?? ""
      : (item as { title?: string }).title ?? "";
    const dateStr = isTv
      ? (item as { first_air_date?: string }).first_air_date ?? ""
      : (item as { release_date?: string }).release_date ?? "";
    const year = dateStr.substring(0, 4) || null;

    const info: TmdbInfo = { tmdbId: item.id, title, year };
    cache.set(key, { data: info, ts: Date.now() });
    return info;
  } catch (err) {
    logger.warn({ err, imdbId }, "tmdb: find failed");
    return null;
  }
}
