// Thin TMDB API helpers.
const DEFAULT_KEY = "8265bd1679663a7ea12ac168da84d2e8";

function getKey(): string {
  return process.env["TMDB_API_KEY"] || DEFAULT_KEY;
}

const BASE = "https://api.themoviedb.org/3";

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", getKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TMDB ${path} ${res.status}`);
  return (await res.json()) as T;
}

export interface TmdbFindResponse {
  movie_results: Array<{ id: number; title: string }>;
  tv_results: Array<{ id: number; name: string }>;
}

export async function imdbToTmdb(
  imdb: string,
  hint: "movie" | "series",
): Promise<{ tmdbId: number; mediaType: "movie" | "tv" } | null> {
  const data = await tmdbGet<TmdbFindResponse>(`/find/${imdb}`, {
    external_source: "imdb_id",
  });
  if (hint === "movie" && data.movie_results?.[0])
    return { tmdbId: data.movie_results[0].id, mediaType: "movie" };
  if (hint === "series" && data.tv_results?.[0])
    return { tmdbId: data.tv_results[0].id, mediaType: "tv" };
  if (data.movie_results?.[0])
    return { tmdbId: data.movie_results[0].id, mediaType: "movie" };
  if (data.tv_results?.[0]) return { tmdbId: data.tv_results[0].id, mediaType: "tv" };
  return null;
}

export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  imdb_id?: string;
  runtime?: number;
  genres?: Array<{ id: number; name: string }>;
}

export interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  vote_average: number;
  external_ids?: { imdb_id?: string };
  genres?: Array<{ id: number; name: string }>;
  number_of_seasons?: number;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
    name: string;
    overview: string;
  }>;
}

export interface TmdbEpisode {
  id: number;
  name: string;
  overview: string;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  still_path: string | null;
}

export async function getMovie(tmdbId: number): Promise<TmdbMovie> {
  return tmdbGet<TmdbMovie>(`/movie/${tmdbId}`, { append_to_response: "external_ids" });
}

export async function getTv(tmdbId: number): Promise<TmdbTv> {
  return tmdbGet<TmdbTv>(`/tv/${tmdbId}`, { append_to_response: "external_ids" });
}

export async function getSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
): Promise<TmdbEpisode[]> {
  const data = await tmdbGet<{ episodes: TmdbEpisode[] }>(
    `/tv/${tmdbId}/season/${seasonNumber}`,
  );
  return data.episodes ?? [];
}

export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
}

export async function tmdbList(
  type: "movie" | "tv",
  kind: "trending" | "popular" | "top_rated",
  page = 1,
): Promise<TmdbListItem[]> {
  const path =
    kind === "trending" ? `/trending/${type}/week` : `/${type}/${kind}`;
  const data = await tmdbGet<{ results: TmdbListItem[] }>(path, {
    page: String(page),
  });
  return data.results ?? [];
}

export async function tmdbSearch(
  type: "movie" | "tv",
  query: string,
): Promise<TmdbListItem[]> {
  const data = await tmdbGet<{ results: TmdbListItem[] }>(`/search/${type}`, {
    query,
  });
  return data.results ?? [];
}

export function poster(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

export function backdrop(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/original${path}` : undefined;
}
