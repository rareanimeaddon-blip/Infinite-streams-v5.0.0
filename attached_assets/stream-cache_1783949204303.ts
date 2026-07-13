import { logger } from "./logger.js";

export const TTL_MS_DEFAULT = 30 * 60 * 1000;
const MAX_ENTRIES = 300;

interface CacheEntry {
  streams: Record<string, unknown>[];
  cachedAt: number;
  expiresAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();

export function streamCacheKey(
  id: string,
  type: string,
  season: number | undefined,
  episode: number | undefined,
): string {
  return `${type}:${id}:${season ?? ""}:${episode ?? ""}`;
}

export function getStreamCache(key: string): Record<string, unknown>[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    logger.debug({ key }, "StreamCache: entry expired");
    return null;
  }
  const ageSeconds = Math.round((Date.now() - entry.cachedAt) / 1000);
  logger.info({ key, ageSeconds, count: entry.streams.length, ttlMs: entry.ttlMs }, "StreamCache: HIT");
  return entry.streams;
}

export function setStreamCache(
  key: string,
  streams: Record<string, unknown>[],
  ttlMs: number = TTL_MS_DEFAULT,
): void {
  if (!streams.length) return;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  const now = Date.now();
  cache.set(key, {
    streams,
    cachedAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
  });

  const ttlMin = Math.round(ttlMs / 60_000);
  logger.info({ key, count: streams.length, ttlMin }, "StreamCache: SET");
}

export function streamCacheStats(): { size: number; maxEntries: number } {
  return { size: cache.size, maxEntries: MAX_ENTRIES };
}

// ─── Provider subtitle cache ──────────────────────────────────────────────────
// Populated by the stream endpoint after mergeSubtitles() runs.
// Consumed by the /subtitles/ resource endpoint so LG TV (which only uses
// that endpoint, not the subtitles[] field in stream objects) also gets
// the cross-provider subtitles (e.g. MovieBox SRTs, DooFlix subs, etc.).

export interface ProviderSubEntry { url: string; lang: string; id: string }

const subCache = new Map<string, { subs: ProviderSubEntry[]; expiresAt: number }>();
const SUB_TTL_MS = 60 * 60 * 1000; // 1 h — same content won't change quickly

export function setProviderSubtitles(imdbId: string, subs: ProviderSubEntry[]): void {
  if (!imdbId.startsWith("tt") || !subs.length) return;
  subCache.set(imdbId, { subs, expiresAt: Date.now() + SUB_TTL_MS });
}

export function getProviderSubtitles(imdbId: string): ProviderSubEntry[] {
  const entry = subCache.get(imdbId);
  if (!entry) return [];
  if (Date.now() > entry.expiresAt) { subCache.delete(imdbId); return []; }
  return entry.subs;
}
