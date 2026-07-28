// Convert an IMDb id (tt...) to a TMDB id via the public TMDB Find API.

const TMDB_API_KEY = "7e53a84e3ad881782767da80a6027472";

interface FindResult {
  movie_results?: Array<{ id: number; title?: string; release_date?: string }>;
  tv_results?: Array<{ id: number; name?: string; first_air_date?: string }>;
}

export interface TmdbHit {
  tmdbId: number;
  title: string;
  year?: string;
}

const cache = new Map<string, { hit: TmdbHit | null; expires: number }>();
const TTL = 24 * 60 * 60 * 1000;

export async function imdbToTmdb(
  type: "movie" | "tv",
  imdbId: string,
): Promise<TmdbHit | null> {
  const key = `${type}:${imdbId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.hit;
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as FindResult;
    let out: TmdbHit | null = null;
    if (type === "movie" && json.movie_results?.length) {
      const m = json.movie_results[0];
      out = { tmdbId: m.id, title: m.title ?? "", year: m.release_date?.slice(0, 4) };
    } else if (type === "tv" && json.tv_results?.length) {
      const t = json.tv_results[0];
      out = { tmdbId: t.id, title: t.name ?? "", year: t.first_air_date?.slice(0, 4) };
    }
    cache.set(key, { hit: out, expires: Date.now() + TTL });
    return out;
  } catch {
    return null;
  }
}
