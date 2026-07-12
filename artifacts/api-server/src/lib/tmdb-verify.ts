import { logger } from "./logger.js";
import { findBestMatch, type MatchCandidate } from "../utils/match.js";

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

    interface TmdbSearchResult {
      id: number;
      name?: string;          // tv
      title?: string;         // movie
      first_air_date?: string; // tv
      release_date?: string;   // movie
    }
    const searchData = (await searchRes.json()) as { results?: TmdbSearchResult[] };
    const results = searchData.results ?? [];
    if (results.length === 0) return set(null);

    // TMDB's search endpoint ranks by relevance/popularity, NOT title similarity —
    // for a generic/short title (e.g. "Brown", "Don", "Race") a much more popular,
    // unrelated show/movie routinely outranks the exact title we're verifying.
    // Blindly taking results[0] (the old behavior) turned this verification step
    // into a false-positive-mismatch generator: it would "confirm" the wrong IMDB
    // ID and cause the correct provider candidate to be rejected outright, even
    // though the provider's own search had found the right title.
    //
    // Score every candidate against the query title (+year when known) with the
    // same shared matcher every provider uses, and only trust a match that clears
    // the normal threshold. If nothing clears it, this lookup is inconclusive —
    // return null so callers pass the candidate through rather than reject it on
    // a bad guess.
    const candidates: MatchCandidate<TmdbSearchResult>[] = results.slice(0, 10).map((r) => {
      const dateStr = r.first_air_date ?? r.release_date;
      const candidateYear = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;
      return {
        title: r.name ?? r.title ?? "",
        year: Number.isFinite(candidateYear) ? candidateYear : undefined,
        type,
        raw: r,
      };
    });

    const { best } = findBestMatch(
      { title, year, type },
      candidates,
      { provider: "tmdb-verify", query: title, quiet: true },
    );
    if (!best) return set(null);
    const topId = best.raw.id;

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
