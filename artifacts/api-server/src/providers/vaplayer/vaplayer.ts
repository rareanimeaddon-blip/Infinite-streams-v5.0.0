/**
 * VaPlayer provider
 * API: https://streamdata.vaplayer.ru/api.php
 * Accepts IMDB IDs directly — no title lookup needed.
 *
 * Movie:  GET /api.php?imdb=tt4154796&type=movie
 * Series: GET /api.php?imdb=tt0903747&type=tv&season=1&episode=1
 */

import { logger } from "../../lib/logger.js";

const STREAM_API = "https://streamdata.vaplayer.ru/api.php";
const PLAYER_ORIGIN = "https://nextgencloudfabric.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface StreamApiData {
  title?: string;
  imdb_id?: string;
  season?: string;
  episode?: string;
  file_name?: string;
  backdrop?: string;
  stream_urls?: string[];
  default_subs?: unknown[];
}

interface StreamApiResponse {
  status_code: string | number;
  data?: StreamApiData;
  error?: string;
}

async function fetchStreamUrls(
  imdb: string,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
): Promise<string[]> {
  const params = new URLSearchParams({ imdb, type });
  if (type === "tv" && season != null && episode != null) {
    params.set("season", String(season));
    params.set("episode", String(episode));
  }

  const url = `${STREAM_API}?${params.toString()}`;
  const referer =
    type === "tv"
      ? `${PLAYER_ORIGIN}/embed/tv/${imdb}/${season}/${episode}`
      : `${PLAYER_ORIGIN}/embed/movie/${imdb}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer,
        Origin: PLAYER_ORIGIN,
      },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`VaPlayer API HTTP ${resp.status}`);
    }

    const json = (await resp.json()) as StreamApiResponse;

    if (json.status_code !== "200" && json.status_code !== 200) {
      throw new Error(`VaPlayer API error: ${json.error ?? `status_code=${json.status_code}`}`);
    }

    return json.data?.stream_urls ?? [];
  } catch (err) {
    logger.warn({ err, imdb, type }, "VaPlayer: fetch failed");
    return [];
  }
}

function toStreams(
  streamUrls: string[],
  labelSuffix = "",
  bingeGroup?: string,
): Record<string, unknown>[] {
  return streamUrls.map((url, i) => ({
    name: "VaPlayer",
    title: `VaPlayer${labelSuffix ? " " + labelSuffix : ""} · HLS ${i + 1}`,
    url,
    behaviorHints: {
      ...(bingeGroup ? { bingeGroup } : {}),
      proxyHeaders: {
        request: {
          Referer: `${PLAYER_ORIGIN}/`,
          Origin: PLAYER_ORIGIN,
          "User-Agent": USER_AGENT,
        },
      },
    },
  }));
}

export async function getVaPlayerMovieStreams(imdbId: string): Promise<Record<string, unknown>[]> {
  if (!imdbId.startsWith("tt")) return [];
  const urls = await fetchStreamUrls(imdbId, "movie");
  const streams = toStreams(urls);
  logger.info({ imdbId, count: streams.length }, "VaPlayer: movie streams fetched");
  return streams;
}

export async function getVaPlayerSeriesStreams(
  imdbId: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  if (!imdbId.startsWith("tt")) return [];
  const urls = await fetchStreamUrls(imdbId, "tv", season, episode);
  const streams = toStreams(urls, `S${season}E${episode}`, `${imdbId}:s${season}`);
  logger.info({ imdbId, season, episode, count: streams.length }, "VaPlayer: series streams fetched");
  return streams;
}
