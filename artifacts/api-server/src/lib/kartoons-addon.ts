import axios from "axios";
import { getAddonConfig } from "./kartoons-config.js";
import { logger } from "./logger.js";

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

export async function searchKartoonsAddon(
  title: string,
  type: "movie" | "series",
): Promise<string | null> {
  const { kartoonsToken } = getAddonConfig();
  const cacheKey = `kartoons:addon:search:id:${type}:${kartoonsToken.slice(-8)}:${title.toLowerCase().trim()}`;
  const cached = getCache<string | null>(cacheKey);
  if (cached !== undefined) return cached;

  const catalogId = type === "movie" ? "kartoons_movies" : "kartoons_shows";
  const stremioType = type === "movie" ? "movie" : "series";
  const q = encodeURIComponent(title);

  const data = await addonGet<{ metas?: AddonMeta[] }>(
    `/catalog/${stremioType}/${catalogId}/search=${q}.json`,
  );
  const metas = data?.metas ?? [];

  if (!metas.length) {
    setCache(cacheKey, null, 1800);
    return null;
  }

  const lower = title.toLowerCase();
  const best = metas
    .map((m) => {
      const t = m.name.toLowerCase();
      let score = 0;
      if (t === lower) score = 100;
      else if (t.includes(lower) || lower.includes(t)) score = 80;
      else {
        const tw = t.split(/\s+/);
        const qw = lower.split(/\s+/);
        score =
          (tw.filter((w) => qw.includes(w)).length /
            Math.max(tw.length, qw.length)) *
          60;
      }
      return { id: m.id, score };
    })
    .sort((a, b) => b.score - a.score)[0];

  const result = best && best.score >= 30 ? best.id : null;
  setCache(cacheKey, result, 3600);
  return result;
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

  const ep = videos.find((v) => v.season === season && v.episode === episode);
  return ep?.id ?? null;
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
