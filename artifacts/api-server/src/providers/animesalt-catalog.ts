import { logger } from "../lib/logger.js";

const TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";
const ANIME_KEYWORD = 210024;
const ANIMATION_GENRE = 16;
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

const imdbCache = new Map<number, string | null>();

async function tmdbExternalId(
  tmdbId: number,
  tmdbType: "tv" | "movie",
): Promise<string | null> {
  if (imdbCache.has(tmdbId)) return imdbCache.get(tmdbId)!;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) { imdbCache.set(tmdbId, null); return null; }
    const data = (await res.json()) as { imdb_id?: string };
    const id = data.imdb_id ?? null;
    imdbCache.set(tmdbId, id);
    return id;
  } catch {
    imdbCache.set(tmdbId, null);
    return null;
  }
}

interface TmdbItem {
  id: number;
  name?: string;
  title?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  first_air_date?: string;
  release_date?: string;
  genre_ids?: number[];
}

export interface AnimeSaltMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
}

async function resolveItems(
  items: TmdbItem[],
  tmdbType: "tv" | "movie",
  stremioType: string,
): Promise<AnimeSaltMeta[]> {
  const resolved = await Promise.all(
    items.map(async (item) => {
      const imdbId = await tmdbExternalId(item.id, tmdbType);
      if (!imdbId) return null;
      const date = item.first_air_date ?? item.release_date ?? "";
      return {
        id: imdbId,
        type: stremioType,
        name: item.name ?? item.title ?? "",
        poster: item.poster_path ? `${TMDB_IMG}${item.poster_path}` : undefined,
        background: item.backdrop_path
          ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
          : undefined,
        description: item.overview ?? undefined,
        releaseInfo: date ? date.split("-")[0] : undefined,
      } satisfies AnimeSaltMeta;
    }),
  );
  return resolved.filter(Boolean) as AnimeSaltMeta[];
}

export async function getAnimeCatalog(
  type: "movie" | "series",
  skip: number,
  search?: string,
): Promise<AnimeSaltMeta[]> {
  const tmdbType = type === "movie" ? "movie" : "tv";
  const stremioType = type === "movie" ? "movie" : "series";
  const page = Math.floor(skip / 20) + 1;

  let url: string;
  if (search && search.trim()) {
    url = `https://api.themoviedb.org/3/search/${tmdbType}?api_key=${TMDB_KEY}&query=${encodeURIComponent(search.trim())}&page=${page}`;
  } else {
    url = `https://api.themoviedb.org/3/discover/${tmdbType}?api_key=${TMDB_KEY}&with_genres=${ANIMATION_GENRE}&with_keywords=${ANIME_KEYWORD}&sort_by=popularity.desc&page=${page}`;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: TmdbItem[] };
    let items = data.results ?? [];

    // When searching, TMDB returns all genres — filter to animation only so
    // non-anime results (e.g. live-action shows with a matching title) are excluded.
    if (search && search.trim()) {
      items = items.filter(
        (item) =>
          item.genre_ids?.includes(ANIMATION_GENRE) ?? false,
      );
    }

    return resolveItems(items, tmdbType, stremioType);
  } catch (e) {
    logger.error({ err: e }, "AnimeSalt catalog: TMDB fetch error");
    return [];
  }
}
