import { poster, tmdbList, tmdbSearch, type TmdbListItem } from "./tmdb.js";

interface MetaPreview {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
}

function toMeta(item: TmdbListItem, type: "movie" | "series"): MetaPreview {
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  return {
    id: `tmdb:${item.id}`,
    type,
    name: item.title || item.name || "Untitled",
    poster: poster(item.poster_path),
    description: item.overview,
    releaseInfo: year || undefined,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
  };
}

export async function buildCatalog(
  type: string,
  id: string,
  extra: Record<string, string>,
): Promise<MetaPreview[]> {
  const tmdbType: "movie" | "tv" = type === "series" ? "tv" : "movie";
  const stremioType: "movie" | "series" = type === "series" ? "series" : "movie";

  if (extra.search) {
    const results = await tmdbSearch(tmdbType, extra.search);
    return results.map((r) => toMeta(r, stremioType));
  }

  const kind = id.includes("popular") ? "popular" : "trending";
  const page = extra.skip ? Math.floor(Number(extra.skip) / 20) + 1 : 1;
  const results = await tmdbList(tmdbType, kind, page);
  return results.map((r) => toMeta(r, stremioType));
}
