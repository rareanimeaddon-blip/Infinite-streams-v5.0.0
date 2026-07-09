/**
 * HDGharTV provider
 * API: https://hdghartv.cc/api
 *
 * Title-search provider: searches by resolved title, then fetches the
 * matched movie/series detail for fresh streaming links.
 */

import { logger } from "../lib/logger.js";
import { findBestMatch, findBestMatchWithRetry, type MatchCandidate } from "../utils/match.js";
import { tmdbTitleToImdbId } from "../lib/tmdb-verify.js";

const HDGHARTV_API = "https://hdghartv.cc/api";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Referer: "https://hdghartv.cc/",
};

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ url, err }, "HDGharTV: fetch failed");
    return null;
  }
}

interface HdgSearchResult {
  movies: Array<{ _id: string; title: string; tmdbId?: number }>;
  series: Array<{ _id: string; title: string; tmdbId?: number }>;
}

interface HdgMatch {
  id: string;
  title: string;
}

async function searchHdghartv(
  title: string,
  kind: "movie" | "series",
  variants: string[] = [title],
): Promise<HdgMatch | null> {
  const searchByVariant = async (
    variantTitle: string,
  ): Promise<Array<MatchCandidate<{ _id: string; title: string; tmdbId?: number }>>> => {
    const encoded = encodeURIComponent(variantTitle);
    const data = await fetchJson<HdgSearchResult>(`${HDGHARTV_API}/search?q=${encoded}`);
    if (!data) return [];
    const results = kind === "movie" ? data.movies : data.series;
    return (results ?? []).map((r) => ({ title: r.title, type: kind, raw: r }));
  };

  // Retry across every known title variant — streaming-site listings for regionally
  // re-titled releases frequently don't match whichever title was searched first.
  const { best } = await findBestMatchWithRetry(
    { title, type: kind },
    variants,
    searchByVariant,
    { provider: "HDGharTV" },
  );
  if (!best) return null;
  return { id: best.raw._id, title: best.raw.title };
}

interface HdgStreamingLink {
  quality: string;
  url: string;
  type: string;
  isActive: boolean;
}

const QUALITY_RANK: Record<string, number> = {
  "4K": 0,
  "1080p": 1,
  "720p": 2,
  "480p": 3,
  "360p": 4,
};

function sortLinks(links: HdgStreamingLink[]): HdgStreamingLink[] {
  return [...links].sort((a, b) => (QUALITY_RANK[a.quality] ?? 99) - (QUALITY_RANK[b.quality] ?? 99));
}

function linksToStreams(
  links: HdgStreamingLink[],
  labelSuffix = "",
  bingeGroup?: string,
): Record<string, unknown>[] {
  return sortLinks(links.filter((l) => l.isActive && l.url)).map((l) => ({
    name: "HDGharTV",
    title: `HDGharTV${labelSuffix ? " " + labelSuffix : ""} · ${l.quality}`,
    url: l.url,
    behaviorHints: bingeGroup ? { bingeGroup } : {},
  }));
}

interface HdgMovie {
  _id: string;
  title: string;
  streamingLinks?: HdgStreamingLink[];
  enableWatch?: boolean;
}

export async function getHdghartvMovieStreams(
  title: string,
  imdbId?: string,
  variants: string[] = [title],
  year?: number,
): Promise<Record<string, unknown>[]> {
  const match = await searchHdghartv(title, "movie", variants);
  if (!match) {
    logger.info({ title, imdbId }, "HDGharTV: movie not found");
    return [];
  }

  // Layer 2 — IMDB ID cross-check (see HDHub4U for rationale). Only rejects on a
  // CONFIRMED mismatch; an inconclusive TMDB lookup (null) always passes through.
  // Pass undefined for year: we only know the requested content's year, not the
  // matched show's year. A year-constrained lookup for the wrong title and the
  // wrong year returns null (inconclusive) and misses the mismatch. Title-only
  // lookup lets TMDB find the correct show and flag the ID mismatch reliably.
  let idVerified = false;
  if (imdbId?.startsWith("tt")) {
    const resolvedId = await tmdbTitleToImdbId(match.title, undefined, "movie").catch(() => null);
    if (resolvedId && resolvedId !== imdbId) {
      logger.info(
        { title, expectedImdbId: imdbId, resolvedId, matchedTitle: match.title },
        "HDGharTV: IMDB ID mismatch — rejecting match",
      );
      return [];
    }
    idVerified = resolvedId === imdbId;
  }

  const movie = await fetchJson<HdgMovie>(`${HDGHARTV_API}/movies/public/${match.id}`);
  if (!movie?.streamingLinks?.length) {
    logger.info({ internalId: match.id, title }, "HDGharTV: no streaming links for movie");
    return [];
  }

  const streams = linksToStreams(movie.streamingLinks);
  logger.info({ title, count: streams.length }, "HDGharTV: movie streams fetched");
  return streams.map((s) => ({ ...s, _resolvedTitle: match.title, _idVerified: idVerified }));
}

interface HdgEpisode {
  episodeNumber: number;
  streamingLinks?: HdgStreamingLink[];
}

interface HdgSeason {
  seasonNumber: number;
  episodes?: HdgEpisode[];
}

interface HdgSeries {
  _id: string;
  title: string;
  seasons?: HdgSeason[];
  enableWatch?: boolean;
}

export async function getHdghartvSeriesStreams(
  title: string,
  season: number,
  episode: number,
  imdbId?: string,
  variants: string[] = [title],
  year?: number,
): Promise<Record<string, unknown>[]> {
  const match = await searchHdghartv(title, "series", variants);
  if (!match) {
    logger.info({ title, imdbId }, "HDGharTV: series not found");
    return [];
  }

  // Layer 2 — IMDB ID cross-check (see HDHub4U for rationale).
  // We intentionally pass `undefined` for year here: the `year` we have is the
  // REQUESTED content's year (e.g. "House (2004)"), not the matched show's year
  // ("House of Cards" is 2013). A year-constrained TMDB lookup for the wrong title
  // and the wrong year would return null (inconclusive), letting the wrong match
  // pass silently. Without year, TMDB resolves the title by name and returns the
  // right IMDB ID regardless of year — enabling a reliable mismatch detection.
  let idVerified = false;
  if (imdbId?.startsWith("tt")) {
    const resolvedId = await tmdbTitleToImdbId(match.title, undefined, "series").catch(() => null);
    if (resolvedId && resolvedId !== imdbId) {
      logger.info(
        { title, expectedImdbId: imdbId, resolvedId, matchedTitle: match.title },
        "HDGharTV: IMDB ID mismatch — rejecting match",
      );
      return [];
    }
    idVerified = resolvedId === imdbId;
  }

  const series = await fetchJson<HdgSeries>(`${HDGHARTV_API}/series/public/${match.id}`);
  if (!series?.seasons?.length) {
    logger.info({ internalId: match.id, title }, "HDGharTV: no seasons for series");
    return [];
  }

  const seasonData = series.seasons.find((s) => s.seasonNumber === season);
  if (!seasonData) {
    logger.info({ title, season }, "HDGharTV: season not found");
    return [];
  }

  const episodeData = seasonData.episodes?.find((e) => e.episodeNumber === episode);
  if (!episodeData?.streamingLinks?.length) {
    logger.info({ title, season, episode }, "HDGharTV: episode or links not found");
    return [];
  }

  const bingeGroup = imdbId ? `${imdbId}:s${season}` : `hdghartv:${title}:s${season}`;
  const streams = linksToStreams(episodeData.streamingLinks, `S${season}E${episode}`, bingeGroup);
  logger.info({ title, season, episode, count: streams.length }, "HDGharTV: episode streams fetched");
  return streams.map((s) => ({ ...s, _resolvedTitle: match.title, _idVerified: idVerified }));
}
