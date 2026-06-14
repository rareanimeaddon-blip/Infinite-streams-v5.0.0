import { logger } from "./logger.js";

const TMDB_KEY  = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";
const TMDB_BASE = "https://api.themoviedb.org/3";

// title|year|type → IMDB ID — stable data, cache 24 h
const cache = new Map<string, { imdbId: string | null; ts: number }>();
const TTL   = 24 * 60 * 60 * 1000;

/**
 * Resolve the IMDB ID that TMDB associates with a given matched title + year.
 * Used to cross-check provider title-matches against the expected IMDB ID:
 *   - Returns the IMDB ID string ("ttXXXXXXX") if TMDB found a clear result.
 *   - Returns null if the TMDB lookup failed or returned no results — callers
 *     MUST treat null as "unverified, pass through" (never reject on null).
 *
 * Results are cached 24 h so repeated episode requests within a series cost
 * zero extra network round-trips.
 */
export async function tmdbTitleToImdbId(
  title: string,
  year: number | undefined,
  type: "movie" | "series",
): Promise<string | null> {
  const key = `${title.toLowerCase()}|${year ?? ""}|${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.imdbId;

  const set = (v: string | null): string | null => {
    cache.set(key, { imdbId: v, ts: Date.now() });
    return v;
  };

  try {
    const tmdbType  = type === "series" ? "tv" : "movie";
    const yearParam = year
      ? `&${type === "series" ? "first_air_date_year" : "year"}=${year}`
      : "";
    const searchUrl =
      `${TMDB_BASE}/search/${tmdbType}` +
      `?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}${yearParam}&page=1`;

    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (!searchRes.ok) return set(null);

    const searchData = (await searchRes.json()) as { results?: Array<{ id: number }> };
    const topId = searchData.results?.[0]?.id;
    if (!topId) return set(null);

    const extUrl = `${TMDB_BASE}/${tmdbType}/${topId}/external_ids?api_key=${TMDB_KEY}`;
    const extRes = await fetch(extUrl, { signal: AbortSignal.timeout(8000) });
    if (!extRes.ok) return set(null);

    const extData = (await extRes.json()) as { imdb_id?: string | null };
    return set(extData.imdb_id ?? null);
  } catch (err) {
    logger.warn({ err, title, year, type }, "tmdb-verify: lookup failed");
    return set(null);
  }
}
