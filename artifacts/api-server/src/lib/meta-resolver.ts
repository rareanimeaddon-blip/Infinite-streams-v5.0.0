import { logger } from "./logger.js";

const TMDB_API_KEY = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";
const TMDB_API = "https://api.themoviedb.org/3";

export interface ResolvedMeta {
  imdbId: string;
  type: "movie" | "series";
  title: string;
  originalTitle?: string;
  /** ISO 639-1 language code for the title's original language, e.g. "en", "hi", "ta". */
  originalLanguage?: string;
  year?: number;
  aliases: string[];
}

const cache = new Map<string, ResolvedMeta>();
const MAX_CACHE = 500;

function cacheSet(key: string, value: ResolvedMeta): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, value);
}

interface CinemetaMeta {
  name?: string;
  year?: number;
  /** Cinemeta often returns the year as a string in this field instead of `year` */
  releaseInfo?: string;
  aliases?: string[];
}

async function fromCinemeta(
  type: string,
  imdbId: string,
): Promise<Partial<ResolvedMeta> | null> {
  for (const base of [
    "https://cinemeta-live.strem.io",
    "https://v3-cinemeta.strem.io",
  ]) {
    try {
      const res = await fetch(`${base}/meta/${type}/${imdbId}.json`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { meta?: CinemetaMeta };
      const m = json.meta;
      if (!m?.name) continue;
      // Cinemeta returns year as `releaseInfo` (string) rather than `year` (number)
      const rawYear = m.year ?? (m.releaseInfo ? parseInt(m.releaseInfo, 10) : undefined);
      const year = rawYear && !isNaN(rawYear) ? rawYear : undefined;
      logger.debug({ imdbId, source: base, title: m.name, year }, "MetaResolver: Cinemeta hit");
      return { title: m.name, year, aliases: m.aliases ?? [] };
    } catch {
      /* try next */
    }
  }
  return null;
}

interface TmdbFindItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
}

async function fromTmdb(
  type: "movie" | "series",
  imdbId: string,
): Promise<Partial<ResolvedMeta> | null> {
  try {
    const findRes = await fetch(
      `${TMDB_API}/find/${imdbId}?external_source=imdb_id&api_key=${TMDB_API_KEY}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!findRes.ok) return null;

    const findJson = (await findRes.json()) as {
      movie_results?: TmdbFindItem[];
      tv_results?: TmdbFindItem[];
    };

    // Try the requested type first, then fall back to the other type.
    // Some IDs are cross-listed (e.g. a long-running anime series TMDB knows
    // as a TV entry but the caller asked for "movie" or vice-versa).
    const primary   = type === "movie" ? findJson.movie_results : findJson.tv_results;
    const secondary = type === "movie" ? findJson.tv_results    : findJson.movie_results;
    const item = primary?.[0] ?? secondary?.[0];
    if (!item) return null;

    const title = item.title ?? item.name ?? "";
    if (!title) return null;

    const originalTitle = item.original_title ?? item.original_name;
    const originalLanguage = item.original_language;
    const dateStr = item.release_date ?? item.first_air_date ?? "";
    const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;

    const tmdbType = type === "movie" ? "movie" : "tv";
    const aliases: string[] = [];
    try {
      const altRes = await fetch(
        `${TMDB_API}/${tmdbType}/${item.id}/alternative_titles?api_key=${TMDB_API_KEY}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (altRes.ok) {
        const altJson = (await altRes.json()) as {
          titles?: Array<{ iso_3166_1: string; title: string }>;
          results?: Array<{ iso_3166_1: string; title: string }>;
        };
        const titleList = altJson.titles ?? altJson.results ?? [];
        titleList
          .filter((t) => ["US", "GB", "IN", "AU"].includes(t.iso_3166_1))
          .forEach((t) => {
            if (t.title && t.title !== title) aliases.push(t.title);
          });
      }
    } catch {
      /* aliases are optional */
    }

    logger.debug({ imdbId, title, year, aliases, originalLanguage }, "MetaResolver: TMDB hit");
    return {
      title,
      originalTitle: originalTitle && originalTitle !== title ? originalTitle : undefined,
      originalLanguage,
      year,
      aliases,
    };
  } catch {
    return null;
  }
}

export async function resolveMetaFromTmdbId(
  rawTmdbId: string,
  type: "movie" | "series",
): Promise<ResolvedMeta | null> {
  const tmdbId = rawTmdbId.replace(/^tmdb:/i, "");
  const cacheKey = `tmdb:${tmdbId}:${type}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.debug({ tmdbId, type }, "MetaResolver: TMDB cache hit");
    return cached;
  }

  logger.info({ tmdbId, type }, "MetaResolver: resolving from TMDB ID");

  try {
    const tmdbType = type === "movie" ? "movie" : "tv";
    const res = await fetch(
      `${TMDB_API}/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids,alternative_titles`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      logger.warn({ tmdbId, status: res.status }, "MetaResolver: TMDB ID lookup failed");
      return null;
    }

    const d = (await res.json()) as {
      id: number;
      title?: string;
      name?: string;
      original_title?: string;
      original_name?: string;
      original_language?: string;
      release_date?: string;
      first_air_date?: string;
      external_ids?: { imdb_id?: string };
      alternative_titles?: {
        titles?: Array<{ iso_3166_1: string; title: string }>;
        results?: Array<{ iso_3166_1: string; title: string }>;
      };
    };

    const title = d.title ?? d.name ?? "";
    if (!title) return null;

    const originalTitle = d.original_title ?? d.original_name;
    const dateStr = d.release_date ?? d.first_air_date ?? "";
    const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;
    const imdbId = d.external_ids?.imdb_id ?? `tmdb:${tmdbId}`;

    const aliasRaw = d.alternative_titles?.titles ?? d.alternative_titles?.results ?? [];
    const aliases: string[] = [];
    aliasRaw
      .filter((t) => ["US", "GB", "IN", "AU"].includes(t.iso_3166_1))
      .forEach((t) => { if (t.title && t.title !== title) aliases.push(t.title); });
    if (originalTitle && originalTitle !== title) aliases.push(originalTitle);

    const resolved: ResolvedMeta = {
      imdbId,
      type,
      title,
      originalTitle: originalTitle !== title ? originalTitle : undefined,
      originalLanguage: d.original_language,
      year,
      aliases: [...new Set(aliases)].slice(0, 12),
    };

    logger.info(
      { tmdbId, imdbId, title, year, aliasCount: resolved.aliases.length },
      "MetaResolver: TMDB ID resolved",
    );

    cacheSet(cacheKey, resolved);
    if (imdbId.startsWith("tt")) cacheSet(`${imdbId}:${type}`, resolved);
    return resolved;
  } catch (err) {
    logger.error({ err, tmdbId }, "MetaResolver: TMDB ID resolution failed");
    return null;
  }
}

export async function resolveMeta(
  imdbId: string,
  type: "movie" | "series",
): Promise<ResolvedMeta | null> {
  const cacheKey = `${imdbId}:${type}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.debug({ imdbId, type }, "MetaResolver: cache hit");
    return cached;
  }

  logger.info({ imdbId, type }, "MetaResolver: resolving");

  const [cinemetaResult, tmdbResult] = await Promise.allSettled([
    fromCinemeta(type, imdbId),
    fromTmdb(type, imdbId),
  ]);

  const cineData =
    cinemetaResult.status === "fulfilled" ? cinemetaResult.value : null;
  const tmdbData =
    tmdbResult.status === "fulfilled" ? tmdbResult.value : null;

  const title = cineData?.title ?? tmdbData?.title;
  if (!title) {
    logger.warn({ imdbId }, "MetaResolver: could not resolve title from any source");
    return null;
  }

  const aliasSet = new Set<string>([
    ...(cineData?.aliases ?? []),
    ...(tmdbData?.aliases ?? []),
  ]);
  if (tmdbData?.originalTitle) aliasSet.add(tmdbData.originalTitle);
  // Cross-alias Cinemeta <-> TMDB titles. These two sources sometimes diverge for
  // regionally re-titled releases (e.g. a Punjabi film indexed by Cinemeta under its
  // pre-release working title "Panjab '95" while TMDB already reflects the theatrical
  // title "Satluj"). Streaming-site listings almost always match the newer/regional
  // title, so both names must be tried during provider search, not just whichever one
  // happened to win the `title` field here.
  if (cineData?.title) aliasSet.add(cineData.title);
  if (tmdbData?.title) aliasSet.add(tmdbData.title);
  aliasSet.delete(title);

  const resolved: ResolvedMeta = {
    imdbId,
    type,
    title,
    originalTitle: tmdbData?.originalTitle,
    originalLanguage: tmdbData?.originalLanguage,
    year: cineData?.year ?? tmdbData?.year,
    aliases: [...aliasSet].slice(0, 12),
  };

  logger.info(
    { imdbId, title: resolved.title, year: resolved.year, aliasCount: resolved.aliases.length },
    "MetaResolver: resolved",
  );

  cacheSet(cacheKey, resolved);
  return resolved;
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "at", "to", "with", "and", "or", "for",
  "on", "is", "are", "was", "its", "be", "by", "as", "it", "his", "her",
  "my", "we", "you", "they", "this", "that", "from", "up",
]);

export function titleSimilarity(query: string, candidate: string): number {
  const nq = normalizeTitle(query);
  const nc = normalizeTitle(candidate);

  if (!nq || !nc) return 0;
  if (nq === nc) return 1.0;

  // Only use substring shortcuts for long enough strings to avoid false positives
  if (nq.length >= 8 && nc.includes(nq)) return 0.9;
  if (nc.length >= 8 && nq.includes(nc)) return 0.85;

  const qAll = nq.split(" ").filter(Boolean);
  const cAll = nc.split(" ").filter(Boolean);

  // Significant words: non-stopword tokens longer than 2 chars
  const qSig = qAll.filter((w) => !STOP_WORDS.has(w) && w.length > 2);
  const cSig = new Set(cAll.filter((w) => !STOP_WORDS.has(w) && w.length > 2));

  // If no significant words, fall back to full-word overlap
  if (qSig.length === 0) {
    const cSet = new Set(cAll);
    const overlap = qAll.filter((w) => cSet.has(w)).length;
    return overlap / Math.max(qAll.length, 1);
  }

  const sigOverlap = qSig.filter((w) => cSig.has(w)).length;

  // Zero significant-word overlap → very low score (avoids stopword-only matches)
  if (sigOverlap === 0) return 0.04;

  // Recall: fraction of query's significant words that appear in candidate
  const sigRatio = sigOverlap / qSig.length;

  // Jaccard over significant words
  const union = new Set([...qSig, ...cSig]);
  const jaccard = sigOverlap / union.size;

  // Length-ratio penalty: prevent short queries from matching much-longer titles
  // via a single shared word. E.g. "The Boys" (1 sig word) vs "Walter Boys Season 1"
  // (4 sig words) shares "boys" → 100% recall but Jaccard 0.25 → penalty squashes it.
  const qSigCount = qSig.length;
  const cSigCount = cSig.size;
  const lengthRatioPenalty =
    qSigCount < cSigCount
      ? Math.max(0, (1 - qSigCount / cSigCount) * 0.5)
      : 0;

  return Math.min(0.95, Math.max(0, sigRatio * 0.65 + jaccard * 0.35 - lengthRatioPenalty));
}
