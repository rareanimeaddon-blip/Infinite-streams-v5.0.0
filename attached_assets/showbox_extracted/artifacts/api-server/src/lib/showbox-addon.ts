const SHOWBOX = "https://showbox.media";
const FEBBOX = "https://www.febbox.com";
const TMDB = "https://api.themoviedb.org/3";
const DEFAULT_TMDB_KEY = "8265bd1679663a7ea12ac168da84d2e8";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36";

export const SHOWBOX_MANIFEST = {
  id: "community.showbox",
  version: "1.0.0",
  name: "ShowBox",
  description:
    "Streams from ShowBox / FebBox. Movies and series, direct MP4 links playable inside the Stremio app.",
  logo: "https://showbox.media/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: [
    {
      type: "movie",
      id: "showbox_movie_trending",
      name: "ShowBox Trending Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "movie",
      id: "showbox_movie_popular",
      name: "ShowBox Popular Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "series",
      id: "showbox_series_trending",
      name: "ShowBox Trending Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "series",
      id: "showbox_series_popular",
      name: "ShowBox Popular Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
} as const;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "public, max-age=60",
};

export const addonCorsHeaders = jsonHeaders;

export function addonJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...jsonHeaders },
  });
}

type MediaType = "movie" | "series";
type TmdbType = "movie" | "tv";

interface TmdbItem {
  id: number;
  title?: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
}

interface TmdbMovie extends TmdbItem {
  title: string;
  imdb_id?: string;
  runtime?: number;
  genres?: Array<{ name: string }>;
}

interface TmdbTv extends TmdbItem {
  name: string;
  external_ids?: { imdb_id?: string };
  genres?: Array<{ name: string }>;
  seasons?: Array<{ season_number: number }>;
}

interface TmdbEpisode {
  name: string;
  overview: string;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  still_path: string | null;
}

function tmdbKey(): string {
  return process.env.TMDB_API_KEY || DEFAULT_TMDB_KEY;
}

async function tmdbGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${TMDB}${path}`);
  url.searchParams.set("api_key", tmdbKey());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`TMDB ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

function poster(path: string | null | undefined): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

function backdrop(path: string | null | undefined): string | undefined {
  return path ? `https://image.tmdb.org/t/p/original${path}` : undefined;
}

function toPreview(item: TmdbItem, type: MediaType) {
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

export async function buildAddonCatalog(
  type: string,
  id: string,
  extra: Record<string, string>,
) {
  const tmdbType: TmdbType = type === "series" ? "tv" : "movie";
  const stremioType: MediaType = type === "series" ? "series" : "movie";
  if (extra.search) {
    const data = await tmdbGet<{ results: TmdbItem[] }>(
      `/search/${tmdbType}`,
      { query: extra.search },
    );
    return (data.results || []).map((item) => toPreview(item, stremioType));
  }

  const kind = id.includes("popular") ? "popular" : "trending";
  const page = extra.skip ? Math.floor(Number(extra.skip) / 20) + 1 : 1;
  const path = kind === "trending" ? `/trending/${tmdbType}/week` : `/${tmdbType}/${kind}`;
  const data = await tmdbGet<{ results: TmdbItem[] }>(path, {
    page: String(page),
  });
  return (data.results || []).map((item) => toPreview(item, stremioType));
}

async function imdbToTmdb(
  imdbId: string,
  type: MediaType,
): Promise<number | null> {
  const data = await tmdbGet<{
    movie_results?: Array<{ id: number }>;
    tv_results?: Array<{ id: number }>;
  }>(`/find/${imdbId}`, { external_source: "imdb_id" });
  const result = type === "movie" ? data.movie_results?.[0] : data.tv_results?.[0];
  return result?.id ?? null;
}

async function getMetaId(id: string, type: MediaType): Promise<number | null> {
  if (id.startsWith("tmdb:")) {
    const parsed = Number(id.slice(5));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (id.startsWith("tt")) return imdbToTmdb(id, type);
  return null;
}

export async function buildAddonMeta(id: string, type: MediaType) {
  const tmdbId = await getMetaId(id, type);
  if (!tmdbId) return null;

  if (type === "movie") {
    const movie = await tmdbGet<TmdbMovie>(`/movie/${tmdbId}`, {
      append_to_response: "external_ids",
    });
    return {
      id,
      type,
      name: movie.title,
      poster: poster(movie.poster_path),
      background: backdrop(movie.backdrop_path),
      description: movie.overview,
      releaseInfo: (movie.release_date || "").slice(0, 4),
      imdbRating: movie.vote_average ? movie.vote_average.toFixed(1) : undefined,
      runtime: movie.runtime ? `${movie.runtime} min` : undefined,
      genres: movie.genres?.map((genre) => genre.name),
    };
  }

  const tv = await tmdbGet<TmdbTv>(`/tv/${tmdbId}`, {
    append_to_response: "external_ids",
  });
  const videos: Array<Record<string, unknown>> = [];
  for (const season of tv.seasons || []) {
    if (season.season_number === 0) continue;
    const data = await tmdbGet<{ episodes: TmdbEpisode[] }>(
      `/tv/${tmdbId}/season/${season.season_number}`,
    );
    for (const episode of data.episodes || []) {
      videos.push({
        id: `${id}:${episode.season_number}:${episode.episode_number}`,
        title: episode.name,
        season: episode.season_number,
        episode: episode.episode_number,
        released: episode.air_date || undefined,
        overview: episode.overview,
        thumbnail: episode.still_path
          ? `https://image.tmdb.org/t/p/w300${episode.still_path}`
          : undefined,
      });
    }
  }
  return {
    id,
    type,
    name: tv.name,
    poster: poster(tv.poster_path),
    background: backdrop(tv.backdrop_path),
    description: tv.overview,
    releaseInfo: (tv.first_air_date || "").slice(0, 4),
    imdbRating: tv.vote_average ? tv.vote_average.toFixed(1) : undefined,
    genres: tv.genres?.map((genre) => genre.name),
    videos,
  };
}

interface ShowboxStream {
  url: string;
  quality: string;
  size?: string;
}

interface FebFile {
  fid: string | number;
  is_dir: 0 | 1 | boolean;
  file_name: string;
  file_size?: string;
}

function addonHeaders(extra: Record<string, string> = {}) {
  return {
    "user-agent": USER_AGENT,
    accept: "application/json, text/html, */*",
    "accept-language": "en",
    ...extra,
  };
}

function febboxCookie(): string {
  const token = process.env.FEBBOX_TOKEN?.trim();
  if (!token) return "";
  return token.startsWith("ui=") ? token : `ui=${token}`;
}

async function showboxJson<T>(url: string, extra: Record<string, string> = {}) {
  const response = await fetch(url, { headers: addonHeaders(extra) });
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function searchShowbox(imdbId: string): Promise<number | null> {
  const search = await fetch(
    `${SHOWBOX}/search?keyword=${encodeURIComponent(imdbId)}`,
    { headers: addonHeaders() },
  );
  if (!search.ok) return null;
  const html = await search.text();
  const linkMatch =
    html.match(/class="film-name[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i) ||
    html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*film-name[^"]*"/i);
  if (!linkMatch) return null;
  const detail = await fetch(`${SHOWBOX}${linkMatch[1]}`, {
    headers: addonHeaders(),
  });
  if (!detail.ok) return null;
  const detailHtml = await detail.text();
  const headingMatch = detailHtml.match(
    /class="heading-name[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i,
  );
  if (!headingMatch) return null;
  const parts = headingMatch[1].split("/");
  const mediaId = Number(parts[parts.length - 1]);
  return Number.isFinite(mediaId) ? mediaId : null;
}

async function shareKey(mediaId: number, type: 1 | 2): Promise<string | null> {
  const data = await showboxJson<{ data?: { link?: string } }>(
    `${SHOWBOX}/index/share_link?id=${mediaId}&type=${type}`,
  );
  const link = data?.data?.link;
  return link?.split("/").pop() || null;
}

async function shareFiles(
  key: string,
  parentId?: string | number,
): Promise<FebFile[]> {
  const cookie = febboxCookie();
  let url = `${FEBBOX}/file/file_share_list?share_key=${encodeURIComponent(key)}`;
  if (parentId) url += `&parent_id=${encodeURIComponent(String(parentId))}&page=1`;
  const data = await showboxJson<{ data?: { file_list?: FebFile[] } }>(url, cookie ? { cookie } : {});
  return data?.data?.file_list || [];
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pickSeason(files: FebFile[], season: number): FebFile | null {
  const seasonText = pad2(season);
  return (
    files.filter((file) => file.is_dir).find((file) => {
      const name = file.file_name.toLowerCase();
      return (
        name.includes(`season ${season}`) ||
        name.includes(`s${seasonText}`) ||
        name === `season ${season}` ||
        name === `s${seasonText}`
      );
    }) ||
    files.find((file) => file.is_dir) ||
    null
  );
}

function pickEpisode(files: FebFile[], episode: number): FebFile | null {
  const episodeText = pad2(episode);
  return (
    files.filter((file) => !file.is_dir).find((file) => {
      const name = file.file_name.toLowerCase();
      return (
        name.includes(`e${episodeText}`) ||
        name.includes(`ep${episodeText}`) ||
        name.includes(`episode ${episode}`) ||
        name.includes(`- ${episodeText} `) ||
        name.includes(`.${episodeText}.`)
      );
    }) ||
    files.find((file) => !file.is_dir) ||
    null
  );
}

async function qualities(
  fid: string | number,
  key: string,
): Promise<ShowboxStream[]> {
  const cookie = febboxCookie();
  if (!cookie) return [];
  const data = await showboxJson<{ html?: string }>(
    `${FEBBOX}/console/video_quality_list?fid=${encodeURIComponent(String(fid))}&share_key=${encodeURIComponent(key)}`,
    { cookie },
  );
  const html = data?.html || "";
  const streams: ShowboxStream[] = [];
  const tagPattern = /<div[^>]*class="[^"]*file_quality[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    const tag = match[0];
    const url = tag.match(/data-url="([^"]+)"/);
    const quality = tag.match(/data-quality="([^"]+)"/);
    const size = tag.match(/data-size="([^"]+)"/);
    if (url && quality) {
      streams.push({
        url: url[1].replace(/\\\//g, "/"),
        quality: quality[1],
        size: size?.[1],
      });
    }
  }
  return streams;
}

async function resolveShowboxStreams(
  imdbId: string,
  type: MediaType,
  season?: number,
  episode?: number,
): Promise<ShowboxStream[]> {
  const mediaId = await searchShowbox(imdbId);
  if (!mediaId) return [];
  const key = await shareKey(mediaId, type === "series" ? 2 : 1);
  if (!key) return [];
  const rootFiles = await shareFiles(key);
  if (!rootFiles.length) return [];

  let target: FebFile | null;
  if (type === "series" && season && episode) {
    const seasonFolder = pickSeason(rootFiles, season);
    if (!seasonFolder) return [];
    target = pickEpisode(await shareFiles(key, seasonFolder.fid), episode);
  } else {
    target = rootFiles.find((file) => !file.is_dir) || null;
  }
  return target ? qualities(target.fid, key) : [];
}

function qualityRank(quality: string): number {
  const resolution = quality.match(/(\d{3,4})/);
  if (resolution) return Number(resolution[1]);
  return quality.toUpperCase() === "ORG" ? 10000 : 0;
}

export async function buildAddonStreams(id: string, type: MediaType) {
  if (!process.env.FEBBOX_TOKEN) {
    return {
      streams: [
        {
          name: "ShowBox",
          title: "FEBBOX_TOKEN is not configured on the server.",
          externalUrl: "https://www.febbox.com/",
        },
      ],
    };
  }

  const parts = id.split(":");
  const baseId = parts[0];
  const season = parts[1] ? Number(parts[1]) : undefined;
  const episode = parts[2] ? Number(parts[2]) : undefined;
  let imdbId = baseId;
  if (!baseId.startsWith("tt")) {
    const tmdbId = await getMetaId(baseId, type);
    if (!tmdbId) return { streams: [] };
    if (type === "movie") {
      const movie = await tmdbGet<TmdbMovie>(`/movie/${tmdbId}`);
      if (!movie.imdb_id) return { streams: [] };
      imdbId = movie.imdb_id;
    } else {
      const tv = await tmdbGet<TmdbTv>(`/tv/${tmdbId}`, {
        append_to_response: "external_ids",
      });
      if (!tv.external_ids?.imdb_id) return { streams: [] };
      imdbId = tv.external_ids.imdb_id;
    }
  }

  try {
    const streams = await resolveShowboxStreams(imdbId, type, season, episode);
    streams.sort((left, right) => qualityRank(right.quality) - qualityRank(left.quality));
    return {
      streams: streams.map((stream) => ({
        name: `ShowBox ${stream.quality}`,
        title: stream.size ? `${stream.quality} • ${stream.size}` : stream.quality,
        url: stream.url,
        behaviorHints: {
          bingeGroup: `showbox-${stream.quality}`,
          notWebReady: true,
          proxyHeaders: {
            request: {
              "User-Agent": USER_AGENT,
              Referer: "https://www.febbox.com/",
              Accept: "*/*",
            },
          },
        },
      })),
    };
  } catch {
    return { streams: [] };
  }
}