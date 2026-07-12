import axios from "axios";
import { logger } from "../../lib/logger.js";

const API_BASE = "https://api.streamflix.app";
const FIREBASE_BASE =
  "https://chilflix-410be-default-rtdb.asia-southeast1.firebasedatabase.app";

const DATA_TTL = 30 * 60 * 1000;
const CONFIG_TTL = 5 * 60 * 1000;
const EPISODES_TTL = 60 * 60 * 1000;

interface StreamflixItem {
  isTV: boolean;
  moviename: string;
  movielink?: string;
  moviekey: string;
  tmdb?: string;
  movieyear?: string;
  movieduration?: string;
}

interface StreamflixConfig {
  movies: string[];
  tv: string[];
  premium: string[];
  download: string[];
}

interface EpisodeData {
  key: number;
  link: string;
  name?: string;
  runtime?: number;
}

let dataCache: { items: StreamflixItem[]; ts: number } | null = null;
let configCache: { config: StreamflixConfig; ts: number } | null = null;
const episodesCache = new Map<
  string,
  { episodes: Record<number, EpisodeData>; ts: number }
>();

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function getData(): Promise<StreamflixItem[]> {
  if (dataCache && Date.now() - dataCache.ts < DATA_TTL) return dataCache.items;
  logger.info("streamflix: fetching data.json");
  const res = await axios.get<{ data: StreamflixItem[] }>(
    `${API_BASE}/data.json`,
    { headers: REQUEST_HEADERS, timeout: 20000 },
  );
  const items = res.data.data ?? [];
  dataCache = { items, ts: Date.now() };
  logger.info({ count: items.length }, "streamflix: data.json cached");
  return items;
}

async function getConfig(): Promise<StreamflixConfig> {
  if (configCache && Date.now() - configCache.ts < CONFIG_TTL)
    return configCache.config;
  const res = await axios.get<StreamflixConfig>(
    `${API_BASE}/config/config-streamflixapp.json`,
    { headers: REQUEST_HEADERS, timeout: 8000 },
  );
  configCache = { config: res.data, ts: Date.now() };
  return res.data;
}

async function getEpisodes(
  movieKey: string,
  season: number,
): Promise<Record<number, EpisodeData>> {
  const cacheKey = `${movieKey}:${season}`;
  const cached = episodesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EPISODES_TTL) return cached.episodes;

  const url = `${FIREBASE_BASE}/Data/${movieKey}/seasons/${season}/episodes.json`;
  const res = await axios.get<Record<string, EpisodeData>>(url, {
    headers: REQUEST_HEADERS,
    timeout: 10000,
  });

  const raw = res.data ?? {};
  const episodes: Record<number, EpisodeData> = {};
  for (const [k, v] of Object.entries(raw)) {
    episodes[parseInt(k, 10)] = v;
  }
  episodesCache.set(cacheKey, { episodes, ts: Date.now() });
  return episodes;
}

function downloadBases(config: StreamflixConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of config.download ?? []) {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function subtitleHint(filename: string): string {
  const f = filename.toLowerCase();
  if (f.includes("esub") || f.includes(".srt") || f.includes(".ass") || f.includes("sub")) {
    return " [Embedded Subs]";
  }
  return "";
}

export interface StreamflixStream {
  url: string;
  name: string;
  title: string;
  behaviorHints?: {
    notWebReady?: boolean;
    headers?: Record<string, string>;
  };
}

export async function fetchStreamflixStreams(
  tmdbId: number,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
): Promise<StreamflixStream[]> {
  try {
    const [items, config] = await Promise.all([getData(), getConfig()]);

    const match = items.find((item) => item.tmdb === String(tmdbId));
    if (!match) {
      logger.info({ tmdbId }, "streamflix: no match found");
      return [];
    }

    logger.info(
      { tmdbId, title: match.moviename, isTV: match.isTV },
      "streamflix: matched item",
    );

    const bases = downloadBases(config);
    if (bases.length === 0) {
      logger.warn({ tmdbId }, "streamflix: no download CDN bases in config");
      return [];
    }

    if (type === "movie") {
      if (!match.movielink) return [];

      const subs = subtitleHint(match.movielink);
      const streams: StreamflixStream[] = bases.map((base, i) => ({
        url: `${base}${match.movielink}`,
        name: "StreamFlix",
        title: `StreamFlix${i > 0 ? ` Mirror ${i}` : ""}${subs} | ${match.moviename}`,
        behaviorHints: { notWebReady: true },
      }));

      logger.info(
        { tmdbId, count: streams.length },
        "streamflix: movie streams ready",
      );
      return streams;
    }

    if (season === null || episode === null) return [];

    try {
      const episodes = await getEpisodes(match.moviekey, season);
      const ep = episodes[episode - 1] ?? episodes[episode];

      if (ep?.link) {
        const subs = subtitleHint(ep.link);
        const streams: StreamflixStream[] = bases.map((base, i) => ({
          url: `${base}${ep.link}`,
          name: "StreamFlix",
          title: `StreamFlix${i > 0 ? ` Mirror ${i}` : ""}${subs} | ${match.moviename} S${season}E${episode}${ep.name ? ` • ${ep.name}` : ""}`,
          behaviorHints: { notWebReady: true },
        }));
        logger.info(
          { tmdbId, season, episode, count: streams.length },
          "streamflix: tv streams via firebase",
        );
        return streams;
      }
    } catch (err) {
      logger.debug(
        { err, movieKey: match.moviekey, season },
        "streamflix: firebase fetch failed — no stream returned",
      );
    }

    // No episode data in Firebase for this season/episode — return nothing.
    // A guessed fallback URL (tv/{key}/s{n}/episode{n}.mkv) produces 404s on
    // the CDN for shows whose season is not yet in the StreamFlix database.
    logger.info(
      { tmdbId, season, episode, movieKey: match.moviekey },
      "streamflix: no firebase episode data for this season — skipping",
    );
    return [];
  } catch (err) {
    logger.warn({ err, tmdbId }, "streamflix: provider error");
    return [];
  }
}
