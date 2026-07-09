import axios from "axios";
import { getAddonConfig } from "./kartoons-config.js";
import { logger } from "./logger.js";
import { findBestMatch, type MatchCandidate } from "../utils/match.js";

// Simple in-process cache
const _cache = new Map<string, { data: unknown; expiresAt: number }>();

function getCache<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return undefined; }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlSeconds: number): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json",
  },
});

function addonUrl(path: string) {
  const { kartoonsBase, kartoonsToken } = getAddonConfig();
  const sep = path.includes("?") ? "&" : "?";
  return `${kartoonsBase}${path}${sep}token=${kartoonsToken}`;
}

export interface AddonMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  genres?: string[];
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
}

export interface KartoonsStream {
  name: string;
  title: string;
  url: string;
  subtitles?: { id: string; lang: string; url: string }[];
  behaviorHints?: Record<string, unknown>;
}

interface EpisodeVideo {
  id: string;
  season: number;
  episode: number;
  title?: string;
}

async function addonGet<T>(path: string): Promise<T | null> {
  try {
    const res = await http.get<T>(addonUrl(path));
    return res.data;
  } catch (err) {
    logger.debug({ err, path }, "kartoons addon request failed");
    return null;
  }
}

export async function testAddonConnection(): Promise<{
  ok: boolean;
  catalogCount?: number;
  error?: string;
}> {
  try {
    const data = await addonGet<{ catalogs?: unknown[] }>("/manifest.json");
    if (data && Array.isArray(data.catalogs)) {
      return { ok: true, catalogCount: data.catalogs.length };
    }
    return { ok: false, error: "Invalid manifest response" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function getAddonCatalogMap(
  stremioType: "series" | "movie",
  catalogId: string,
): Promise<Map<string, AddonMeta>> {
  const { kartoonsToken } = getAddonConfig();
  const cacheKey = `kartoons:addon:catalog:map:${catalogId}:${kartoonsToken.slice(-8)}`;
  const cached = getCache<Map<string, AddonMeta>>(cacheKey);
  if (cached) return cached;

  const data = await addonGet<{ metas?: AddonMeta[] }>(
    `/catalog/${stremioType}/${catalogId}.json`,
  );
  const metas = data?.metas ?? [];

  const map = new Map<string, AddonMeta>();
  for (const m of metas) {
    map.set(m.id, m);
  }

  logger.info(
    { catalogId, count: metas.length },
    "cached kartoons addon catalog map",
  );
  setCache(cacheKey, map, 3600);
  return map;
}

export async function searchAddonCatalog(
  stremioType: "series" | "movie",
  catalogId: string,
  query: string,
): Promise<AddonMeta[]> {
  const { kartoonsToken } = getAddonConfig();
  const cacheKey = `kartoons:addon:search:catalog:${catalogId}:${kartoonsToken.slice(-8)}:${query.toLowerCase().trim()}`;
  const cached = getCache<AddonMeta[]>(cacheKey);
  if (cached) return cached;

  const q = encodeURIComponent(query);
  const data = await addonGet<{ metas?: AddonMeta[] }>(
    `/catalog/${stremioType}/${catalogId}/search=${q}.json`,
  );
  const metas = data?.metas ?? [];
  setCache(cacheKey, metas, 1800);
  return metas;
}

// The addon's /catalog/.../search=... endpoint returns 0 results for everything.
// We use the Kartoons REST API directly for title search instead.
const KARTOONS_REST = "https://api.kartoons.me/api";

interface RestSearchItem {
  _id: string;
  title: string;
  releaseYear?: number;
  startYear?: number;
}

async function restSearch(
  title: string,
  type: "movie" | "series",
): Promise<RestSearchItem[]> {
  try {
    const endpoint = type === "movie" ? "/movies" : "/shows";
    const q = encodeURIComponent(title);
    const res = await http.get<{
      success: boolean;
      data?: RestSearchItem[];
    }>(`${KARTOONS_REST}${endpoint}?search=${q}&limit=15`, { timeout: 12000 });
    return res.data?.data ?? [];
  } catch (err) {
    logger.debug({ err, title }, "kartoons REST search failed");
    return [];
  }
}

export interface KartoonsSearchMatch {
  id: string;
  title: string;
  year?: number;
}

export async function searchKartoonsAddonMatch(
  title: string,
  type: "movie" | "series",
  year?: number,
): Promise<KartoonsSearchMatch | null> {
  const cacheKey = `kartoons:addon:search:match:v3:${type}:${title.toLowerCase().trim()}:${year ?? ""}`;
  const cached = getCache<KartoonsSearchMatch | null>(cacheKey);
  if (cached !== undefined) return cached;

  const list = await restSearch(title, type);

  if (!list.length) {
    setCache(cacheKey, null, 1800);
    return null;
  }

  // Kartoons' own search endpoint frequently returns loosely "closest" results
  // instead of an empty list when there's no real match (e.g. searching "House"
  // can return "Mickey Mouse Clubhouse"). Route through the shared matcher —
  // which uses word-boundary/whole-title similarity plus a year signal — rather
  // than a naive substring `includes()` check, which previously treated any
  // candidate title merely *containing* the query as a match (e.g. "House" is
  // a substring of "Clubhouse").
  const candidates: MatchCandidate<RestSearchItem>[] = list.map((item) => ({
    title: item.title,
    year: type === "movie" ? item.releaseYear : item.startYear,
    type,
    raw: item,
  }));

  const { best } = findBestMatch(
    { title, year, type },
    candidates,
    { provider: "Kartoons", query: title },
  );

  if (!best) {
    setCache(cacheKey, null, 1800);
    return null;
  }

  const result: KartoonsSearchMatch = {
    id: `kartoons:${best.raw._id}`,
    title: best.raw.title,
    year: type === "movie" ? best.raw.releaseYear : best.raw.startYear,
  };
  logger.info({ title, type, result }, "kartoons REST search result");
  setCache(cacheKey, result, 3600);
  return result;
}

/** @deprecated Use `searchKartoonsAddonMatch` — kept for any lingering callers. */
export async function searchKartoonsAddon(
  title: string,
  type: "movie" | "series",
): Promise<string | null> {
  const match = await searchKartoonsAddonMatch(title, type);
  return match?.id ?? null;
}

export async function getEpisodeId(
  showKartoonsId: string,
  season: number,
  episode: number,
): Promise<string | null> {
  const cacheKey = `kartoons:addon:meta:${showKartoonsId}`;
  let videos = getCache<EpisodeVideo[]>(cacheKey);

  if (!videos) {
    const data = await addonGet<{ meta?: { videos?: EpisodeVideo[] } }>(
      `/meta/series/${showKartoonsId}.json`,
    );
    videos = data?.meta?.videos ?? [];
    setCache(cacheKey, videos, 3600);
  }

  // Try exact match first (used by native kartoons: ID path where Stremio
  // passes the exact episode number from the meta response).
  const exact = videos.find((v) => v.season === season && v.episode === episode);
  if (exact) return exact.id;

  // Index-based fallback for IMDB/TMDB paths: Stremio sends relative episode
  // numbers (1, 2, 3...) within a season, but some Kartoons seasons use
  // absolute/cumulative numbering (e.g. season 10 episodes start at 464).
  // Sort the season's episodes by their stored number and treat episode N as
  // the Nth entry (1-based index).
  const seasonEps = videos
    .filter((v) => v.season === season)
    .sort((a, b) => a.episode - b.episode);

  const byIndex = seasonEps[episode - 1]; // episode is 1-based
  if (byIndex) {
    logger.info(
      { showKartoonsId, season, requestedEp: episode, resolvedEp: byIndex.episode, id: byIndex.id },
      "kartoons: resolved episode by index fallback",
    );
    return byIndex.id;
  }

  logger.info({ showKartoonsId, season, episode, seasonEpCount: seasonEps.length }, "kartoons: episode not found");
  return null;
}

export async function getStreamsFromAddon(
  kartoonsId: string,
  type: "movie" | "series",
): Promise<KartoonsStream[]> {
  const cacheKey = `kartoons:addon:streams:${kartoonsId}`;
  const cached = getCache<KartoonsStream[]>(cacheKey);
  if (cached) return cached;

  const data = await addonGet<{ streams?: KartoonsStream[] }>(
    `/stream/${type}/${kartoonsId}.json`,
  );
  const streams = data?.streams ?? [];

  logger.info({ kartoonsId, count: streams.length }, "streams from kartoons addon");
  setCache(cacheKey, streams, 1800);
  return streams;
}
