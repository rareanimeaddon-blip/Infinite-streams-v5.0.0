import axios from "axios";
import { logger } from "../lib/logger.js";

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";

export interface CinemetaMeta {
  id: string;
  type: string;
  name: string;
  year?: number;
  description?: string;
  poster?: string;
  imdbRating?: string;
  genres?: string[];
  cast?: string[];
  director?: string[];
}

const metaCache = new Map<string, { data: CinemetaMeta; ts: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchCinemetaMeta(
  type: string,
  imdbId: string,
): Promise<CinemetaMeta | null> {
  const cacheKey = `${type}:${imdbId}`;
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
    const res = await axios.get<{ meta: CinemetaMeta }>(url, { timeout: 10000 });
    const meta = res.data?.meta;
    if (!meta) return null;
    metaCache.set(cacheKey, { data: meta, ts: Date.now() });
    return meta;
  } catch (err) {
    logger.warn({ err, imdbId }, "cinemeta fetch failed");
    return null;
  }
}

export function isImdbId(id: string): boolean {
  return /^tt\d+/.test(id);
}

export function parseImdbStreamId(id: string): {
  imdbId: string;
  season: number | null;
  episode: number | null;
} {
  const parts = id.split(":");
  const imdbId = parts[0]!;
  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  return { imdbId, season, episode };
}

export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}
