import { createDecipheriv } from "crypto";
import { logger } from "./logger.js";
import { getEpisodesPerSeason } from "./cinemeta.js";
import { findBestMatch, type MatchCandidate, type ContentType } from "../utils/match.js";

const MAIN_URL = "https://api3.devcorp.me";
// 32-byte AES key and 16-byte IV (extracted from the original obfuscated plugin)
const AES_KEY = Buffer.from("im72charPasswordofdInitVectorStm", "utf8");
const AES_IV = Buffer.from("im72charPassword", "utf8");
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://onetouchtv.xyz/",
};
const FETCH_TIMEOUT_MS = 10000;

// Simple in-memory cache
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function fromCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function toCache(key: string, data: unknown): void {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Decrypt an AES-256-CBC encrypted payload from OneTouchTV.
 * The API returns a custom base64 variant where '/' is replaced by '-_.'
 * and '+' is replaced by '@'.
 */
function decrypt(encoded: string): unknown {
  // Restore standard base64
  let s = encoded
    .replace(/-_\./g, "/")
    .replace(/@/g, "+")
    .replace(/\s+/g, "");
  // Pad to multiple of 4
  const pad = s.length % 4;
  if (pad !== 0) s += "=".repeat(4 - pad);

  const buf = Buffer.from(s, "base64");
  const decipher = createDecipheriv("aes-256-cbc", AES_KEY, AES_IV);
  const dec = Buffer.concat([decipher.update(buf), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

async function fetchEncrypted<T>(path: string, cacheTtlMs = CACHE_TTL_MS): Promise<T> {
  const url = path.startsWith("https://") ? path : `${MAIN_URL}${path}`;

  if (cacheTtlMs > 0) {
    const cached = fromCache<T>(url);
    if (cached !== null) return cached;
  }

  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  const parsed = decrypt(text) as { result: T };
  const data = parsed.result;
  if (cacheTtlMs > 0) toCache(url, data);
  return data;
}

// ------- Types -------

export interface SearchResult {
  id: string;
  title: string;
  image: string;
  country: string;
  /** OneTouchTV type: "movie" | "drama" | "variety" | etc. */
  type: string;
  year: string;
  isSub: boolean;
  status: string;
}

export interface Episode {
  id: string;
  episode: string;
  rating?: string;
  identifier: string;
  playId: string;
  isSub: boolean;
  released_at?: string;
}

export interface DetailResult {
  id: string;
  title: string;
  type: string;
  year: string;
  episodes: Episode[];
  description?: string;
  image?: string;
  poster?: string;
  genres?: string[];
}

export interface EpisodeStreamSource {
  type?: string;    // "hls", "mp4"
  contentId?: string;
  id?: string;
  name?: string;    // e.g. "loklok"
  quality?: string; // e.g. "auto", "720p", "1080p"
  url?: string;
}

export interface EpisodeStreamTrack {
  file?: string;
  kind?: string;
  default?: boolean;
  name?: string;
  format?: string;
  code?: string;
}

export interface EpisodeStreamData {
  sources?: EpisodeStreamSource[];
  track?: EpisodeStreamTrack[];
  ads?: number;
}

export interface StreamSource {
  name: string;
  title: string;
  url: string;
  quality: string;
  subtitles?: Array<{ url: string; lang: string }>;
  headers?: Record<string, string>;
  /** Actual title OneTouchTV resolved to — used by downstream content verification. */
  _resolvedTitle?: string;
}

// ------- Type compatibility -------

/** Map Stremio type → OneTouchTV types that are valid matches */
const TYPE_MAP: Record<string, Set<string>> = {
  movie: new Set(["movie"]),
  series: new Set(["drama", "variety", "anime"]),
};

function isTypeCompatible(
  stremioType: "movie" | "series",
  onetouchType: string
): boolean {
  const allowed = TYPE_MAP[stremioType];
  if (!allowed) return true;
  return allowed.has(onetouchType.toLowerCase());
}

// ------- Scoring / Matching -------

function contentRegion(country: string): string {
  const c = country.toLowerCase();
  if (c.includes("korea")) return "korean";
  if (c.includes("china") || c.includes("chinese") || c.includes("taiwan") || c.includes("hong kong")) return "chinese";
  if (c.includes("japan")) return "japanese";
  if (c.includes("thai")) return "thai";
  if (c.includes("filip") || c.includes("philip")) return "filipino";
  if (c.includes("indonesi")) return "indonesian";
  if (c.includes("vietnam") || c.includes("viet nam")) return "vietnamese";
  if (
    c.includes("united states") || c.includes("united kingdom") ||
    c.includes("australia") || c.includes("canada") ||
    c.includes("ireland") || c.includes("new zealand")
  ) return "english";
  return "other";
}

function findBestOttMatch(
  results: SearchResult[],
  title: string,
  year: number | null,
  stremioType: "movie" | "series",
  targetSeason?: number | null,
  requestedCountry?: string | null
): SearchResult | null {
  if (results.length === 0) return null;

  const requestedRegion = requestedCountry ? contentRegion(requestedCountry) : null;

  // Filter by type compatibility and region before passing to shared matcher
  const filtered = results.filter((r) => {
    if (!isTypeCompatible(stremioType, r.type)) return false;
    if (requestedRegion && requestedRegion !== "other" && r.country) {
      const candidateRegion = contentRegion(r.country);
      if (candidateRegion !== "other" && candidateRegion !== requestedRegion) {
        logger.debug(
          { title, candidate: r.title, requestedRegion, candidateRegion },
          "OneTouchTV: skipping cross-region candidate"
        );
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) return null;

  const candidates: MatchCandidate<SearchResult>[] = filtered.map((r) => ({
    title: r.title,
    year: parseInt(r.year, 10) || undefined,
    type: stremioType as ContentType,
    season: targetSeason ?? undefined,
    raw: r,
  }));

  const { best } = findBestMatch(
    {
      title,
      year: year ?? undefined,
      type: stremioType,
      season: targetSeason ?? undefined,
    },
    candidates,
    { provider: "OneTouchTV" },
  );

  return best ? best.raw : null;
}

// ------- Public API -------

export async function searchContent(keyword: string): Promise<SearchResult[]> {
  const path = `/vod/search?keyword=${encodeURIComponent(keyword)}`;
  try {
    const results = await fetchEncrypted<SearchResult[]>(path);
    return Array.isArray(results) ? results : [];
  } catch (err) {
    logger.error({ err, keyword }, "OneTouchTV search failed");
    return [];
  }
}

export async function getDetail(id: string): Promise<DetailResult | null> {
  try {
    const result = await fetchEncrypted<DetailResult>(`/vod/${id}/detail`);
    return result ?? null;
  } catch (err) {
    logger.error({ err, id }, "OneTouchTV detail failed");
    return null;
  }
}

export async function getEpisodeStreams(
  id: string,
  playId: string
): Promise<EpisodeStreamData | null> {
  try {
    const result = await fetchEncrypted<EpisodeStreamData>(
      `/vod/${id}/episode/${playId}`,
      0
    );
    return result ?? null;
  } catch (err) {
    logger.error({ err, id, playId }, "OneTouchTV episode fetch failed");
    return null;
  }
}

function resolveQuality(quality?: string): string {
  if (!quality) return "Unknown";
  const q = quality.toLowerCase();
  if (q === "auto") return "Auto";
  if (q.includes("1080")) return "1080p";
  if (q.includes("720")) return "720p";
  if (q.includes("480")) return "480p";
  if (q.includes("360")) return "360p";
  return quality;
}

async function resolveAbsoluteEpisode(
  imdbId: string,
  season: number,
  episode: number
): Promise<number | null> {
  if (season <= 1) return episode;

  const episodesPerSeason = await getEpisodesPerSeason(imdbId);
  if (episodesPerSeason.length < season - 1) return null;

  let offset = 0;
  for (let s = 0; s < season - 1; s++) {
    const count = episodesPerSeason[s] ?? 0;
    if (count === 0) return null;
    offset += count;
  }
  return offset + episode;
}

export async function getStreams(
  title: string,
  type: "movie" | "series",
  year: number | null,
  season: number | null,
  episode: number | null,
  imdbId?: string,
  country?: string | null
): Promise<StreamSource[]> {
  logger.info({ title, type, year, season, episode, country }, "OneTouchTV getStreams");

  const searchKeywords: string[] = [title];
  if (type === "series" && season && season > 1) {
    searchKeywords.unshift(`${title} Season ${season}`);
  }

  let matchResult: SearchResult | null = null;

  for (const keyword of searchKeywords) {
    const results = await searchContent(keyword);
    const searchYear = keyword !== title && season && season > 1 ? null : year;
    const match = findBestOttMatch(results, keyword, searchYear, type, season, country);
    if (match) {
      matchResult = match;
      break;
    }
  }

  if (!matchResult) return [];

  const detail = await getDetail(matchResult.id);
  if (!detail || !detail.episodes || detail.episodes.length === 0) {
    logger.info({ id: matchResult.id }, "OneTouchTV: no episodes in detail");
    return [];
  }

  let targetEpisode: Episode | null = null;

  if (type === "movie") {
    targetEpisode = detail.episodes[0] ?? null;
  } else {
    const ep = episode ?? 1;
    const s = season ?? 1;

    const targetSeasonInTitle = new RegExp(`\\bseason\\s+${s}\\b`, "i");
    const anySeasonInTitle = /\bseason\s+(\d+)\b/i;
    const matchedSeasonNum = anySeasonInTitle.exec(matchResult.title);
    const entryIsForTargetSeason =
      s === 1 ||
      targetSeasonInTitle.test(matchResult.title);

    if (
      s > 1 &&
      matchedSeasonNum !== null &&
      parseInt(matchedSeasonNum[1], 10) !== s
    ) {
      logger.warn(
        { matchedTitle: matchResult.title, requestedSeason: s },
        "OneTouchTV: matched title names a different season — aborting"
      );
      return [];
    }

    if (entryIsForTargetSeason) {
      targetEpisode =
        detail.episodes.find((e) => parseInt(e.episode, 10) === ep) ?? null;
      logger.info(
        { matchedTitle: matchResult.title, s, ep },
        "OneTouchTV: season-specific entry — using direct episode index"
      );
    } else {
      let absEp: number | null = null;
      if (imdbId) {
        absEp = await resolveAbsoluteEpisode(imdbId, s, ep);
      }
      logger.info(
        { matchedTitle: matchResult.title, s, ep, absEp },
        "OneTouchTV: combined entry — using absolute episode offset"
      );

      if (absEp !== null) {
        targetEpisode =
          detail.episodes.find((e) => parseInt(e.episode, 10) === absEp) ??
          null;
      }

      if (!targetEpisode && s === 1) {
        targetEpisode =
          detail.episodes.find((e) => parseInt(e.episode, 10) === ep) ?? null;
      }
    }
  }

  if (!targetEpisode) {
    logger.info(
      { season, episode, episodeCount: detail.episodes.length },
      "OneTouchTV: episode not found"
    );
    return [];
  }

  logger.info(
    { playId: targetEpisode.playId, episode: targetEpisode.episode },
    "OneTouchTV: fetching streams"
  );

  const streamData = await getEpisodeStreams(matchResult.id, targetEpisode.playId);
  if (!streamData) return [];

  const sources = streamData.sources ?? [];
  if (sources.length === 0) {
    logger.info(
      { id: matchResult.id, playId: targetEpisode.playId },
      "OneTouchTV: no sources in episode"
    );
    return [];
  }

  const subtitles: Array<{ url: string; lang: string }> = [];
  for (const track of streamData.track ?? []) {
    if (track.file && track.name) {
      subtitles.push({ url: track.file, lang: track.name });
    }
  }

  const out: StreamSource[] = [];
  for (const src of sources) {
    if (!src.url) continue;
    const quality = resolveQuality(src.quality);
    const sourceName = src.name ? ` | ${src.name}` : "";
    out.push({
      name: `📺 OneTouchTV${sourceName}`,
      title: `${matchResult.title}\n🎬 ${quality} · ${(src.type ?? "HLS").toUpperCase()}`,
      url: src.url,
      quality,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://api3.devcorp.me/",
      },
      // Propagate the actual matched title so filterVerifiedStreams compares
      // the provider's resolved title against the requested title — not the query
      // echoed back against itself (which is always trivially a perfect match).
      _resolvedTitle: matchResult.title,
    });
  }

  const seen = new Set<string>();
  return out.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
