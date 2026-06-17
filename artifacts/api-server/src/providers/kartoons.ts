import axios from "axios";
import { logger } from "../lib/logger.js";

const KARTOONS_API = "https://api.kartoons.me/api";

const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
    Origin: "https://kartoons.me",
  },
});

export interface KartoonsItem {
  id: string;
  title: string;
  type: "movie" | "series";
  poster?: string;
  year?: number;
  category?: string;
}

interface ApiShow {
  _id: string;
  title: string;
  image?: string;
  startYear?: number;
  category?: string;
  slug: string;
}

interface ApiMovie {
  _id: string;
  title: string;
  image?: string;
  releaseYear?: number;
  category?: string;
  slug: string;
}

// Simple in-process cache (avoids adding a separate cache dep)
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

async function apiGet<T>(path: string): Promise<{ data: T; total: number } | null> {
  try {
    const res = await http.get<{
      success: boolean;
      data?: T;
      pagination?: { total: number };
    }>(`${KARTOONS_API}${path}`);
    if (res.data?.success && res.data.data !== undefined) {
      return { data: res.data.data, total: res.data.pagination?.total ?? 0 };
    }
    return null;
  } catch (err) {
    logger.debug({ err, path }, "kartoons api request failed");
    return null;
  }
}

export async function getKartoonsCatalog(
  type: "movie" | "series",
  skip = 0,
  category?: "Anime" | "Cartoon",
): Promise<KartoonsItem[]> {
  const page = Math.floor(skip / 20) + 1;
  const catParam = category ? `&category=${category}` : "";
  const cacheKey = `kartoons:catalog:v3:${type}:${page}:${category ?? "all"}`;
  const cached = getCache<KartoonsItem[]>(cacheKey);
  if (cached) return cached;

  let items: KartoonsItem[] = [];

  if (type === "movie") {
    const result = await apiGet<ApiMovie[]>(`/movies?page=${page}&limit=20${catParam}`);
    if (Array.isArray(result?.data)) {
      items = result.data.map((m) => ({
        id: m._id,
        title: m.title,
        type: "movie" as const,
        poster: m.image,
        year: m.releaseYear,
        category: m.category,
      }));
    }
  } else {
    const result = await apiGet<ApiShow[]>(`/shows?page=${page}&limit=20${catParam}`);
    if (Array.isArray(result?.data)) {
      items = result.data.map((s) => ({
        id: s._id,
        title: s.title,
        type: "series" as const,
        poster: s.image,
        year: s.startYear,
        category: s.category,
      }));
    }
  }

  logger.info({ type, page, category, count: items.length }, "kartoons catalog from API");
  setCache(cacheKey, items, 3600);
  return items;
}

export async function searchKartoonsRest(
  title: string,
  type: "movie" | "series",
): Promise<KartoonsItem | null> {
  const cacheKey = `kartoons:search:v3:${type}:${title.toLowerCase().trim()}`;
  const cached = getCache<KartoonsItem | null>(cacheKey);
  if (cached !== undefined) return cached;

  const path =
    type === "movie"
      ? `/movies?search=${encodeURIComponent(title)}&limit=10`
      : `/shows?search=${encodeURIComponent(title)}&limit=10`;

  const result = await apiGet<(ApiShow | ApiMovie)[]>(path);
  const list = Array.isArray(result?.data) ? result.data : [];

  if (!list.length) {
    setCache(cacheKey, null, 1800);
    return null;
  }

  const scored = list.map((item) => {
    const t = item.title.toLowerCase();
    const q = title.toLowerCase();
    let score = 0;
    if (t === q) score = 100;
    else if (t.includes(q) || q.includes(t)) score = 80;
    else {
      const tw = t.split(/\s+/);
      const qw = q.split(/\s+/);
      score =
        (tw.filter((w) => qw.includes(w)).length /
          Math.max(tw.length, qw.length)) *
        60;
    }
    return { item, score };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 30) {
    setCache(cacheKey, null, 1800);
    return null;
  }

  const raw = best.item;
  const isMovie = type === "movie";
  const res: KartoonsItem = {
    id: raw._id,
    title: raw.title,
    type: isMovie ? "movie" : "series",
    poster: raw.image,
    year: isMovie
      ? (raw as ApiMovie).releaseYear
      : (raw as ApiShow).startYear,
    category: raw.category,
  };

  setCache(cacheKey, res, 3600);
  return res;
}
