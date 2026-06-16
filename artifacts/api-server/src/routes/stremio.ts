import { Router, type Request, type Response, type NextFunction } from "express";
import { manifest } from "../manifest.js";
import { PROVIDER_LIST, maskToConfig, type ProviderKey } from "../lib/provider-config.js";
import {
  getAllCatalogItems as raGetAllCatalogItems,
  buildAtoonCatalog as raBuildAtoonCatalog,
  getEpisodeLinks as raGetEpisodeLinks,
  resolveCodedewToArgonId,
  getPageMeta as raGetPageMeta,
  getSeasonSlugs,
  discoverAllSeasons,
  buildCrossSourceMerge,
  getAtoonArchiveMeta,
  getAtoonEpisodeLinks,
  getAtoonShowSeasons,
  findAndScrapeAtoonEpisodes,
  mergedAtoonSlugs,
  rareBaseToAtoonSlug,
  getAtoonEpsForBaseSlug,
  slugFromUrl as raSlugFromUrl,
  type CatalogMeta as RACatalogMeta,
  type EpisodeLink as RAEpisodeLink,
  type SeasonEntry as RASeasonEntry,
} from "../providers/rareanime/scraper.js";
import { extractStreamFromArgon } from "../providers/rareanime/argon-extractor.js";
import { fetchNetmirrorStreams } from "../providers/netmirror.js";
import { getStreams as hindmoviezGetStreams, getCatalog as hindmoviezGetCatalog } from "../providers/hindmovies.js";
import { getCastleTvImdbStreams } from "../castle-tv/handlers.js";
import * as hdhub4u from "../providers/hdhub4u.js";
import * as fourkdhub from "../providers/fourkdhub.js";
import { fetchDahmerStreams } from "../castle-tv/dahmermovies.js";
import { fetchStreamflixStreams } from "../castle-tv/streamflix.js";
import { getDooflixMovieStreams, getDooflixSeriesStreams, type DooflixStream } from "../providers/dooflix.js";
import { getMeowTvStreams } from "../providers/meowtv.js";
import { getStreams as animesaltGetStreams, getStreamsByTitle as animesaltGetStreamsByTitle } from "../providers/animesalt.js";
import { getAnimeCatalog } from "../providers/animesalt-catalog.js";
import {
  catalog as animeDekhoGetCatalog,
  search as animeDekhoSearch,
  getMeta as animeDekhoGetMeta,
  getBodyTermId,
  getVidStreamIframes,
  getTrdekhoIframes,
  getEpisodePageIframes,
  getNeoCdnStreams,
  parsePageServers,
  type NeoCdnSource,
  decodeId as animeDekhoDecodeId,
} from "../providers/animedekho.js";
import { resolveExtractor, type Stream as ADStream } from "../extractors/animedekho/index.js";
import { titleSimilarityScore } from "../utils/title-score.js";
import { tmdbTitleToImdbId } from "../lib/tmdb-verify.js";
import {
  resolveMeta,
  resolveMetaFromTmdbId,
  type ResolvedMeta,
} from "../lib/meta-resolver.js";
import {
  searchMovieBox,
  getSubjectDetails,
  getPlayInfo,
  getExtCaptions,
  type Stream as MBStream,
  type Subject as MBSubject,
} from "../lib/moviebox-api.js";
import { encodeParam, prewarmAsRelay } from "./proxy.js";
import { searchSubtitles } from "../lib/opensubtitles.js";
import { BASE_PATH } from "../lib/base-path.js";
import { logger } from "../lib/logger.js";
import { logResolve, getResolveEvents } from "../lib/debug-log.js";
import {
  getStreamCache,
  setStreamCache,
  streamCacheKey,
  streamCacheStats,
  TTL_MS_DEFAULT,
  setProviderSubtitles,
  getProviderSubtitles,
} from "../lib/stream-cache.js";
import type { Stream } from "../extractors/types.js";

const router = Router();

// ─── Provider config middleware ───────────────────────────────────────────────
// Intercepts any request whose path starts with a 9-char 0/1 mask prefix,
// e.g. /111100110/stream/...
// Parses the mask, stores the enabled provider set on req, then strips the
// prefix so all existing route handlers match as normal.
interface RequestWithConfig extends Request {
  enabledProviders?: Set<ProviderKey>;
}
router.use((req: RequestWithConfig, _res: Response, next: NextFunction) => {
  const m = req.path.match(/^\/([01]{9,})(\/|$)/);
  if (m) {
    req.enabledProviders = maskToConfig(m[1]!);
    // Strip the mask prefix so downstream route handlers see the original path
    req.url = req.url.replace(`/${m[1]}`, "") || "/";
  }
  next();
});

function getEnabledProviders(req: RequestWithConfig): Set<ProviderKey> {
  return req.enabledProviders ?? new Set<ProviderKey>(PROVIDER_LIST);
}

const TMDB_API_KEY = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";

const CATALOG_CACHE = new Map<string, { data: Record<string, unknown>[]; ts: number }>();
const CATALOG_TTL = 1000 * 60 * 30;

function stremioHeaders(res: import("express").Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "max-age=3600, stale-while-revalidate=3600");
}

// ─── TMDB catalog helper ──────────────────────────────────────────────────────

async function getTMDBCatalog(type: "movie" | "series", skip = 0): Promise<Record<string, unknown>[]> {
  const cacheKey = `${type}-${skip}`;
  const cached = CATALOG_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data;

  const tmdbType = type === "series" ? "tv" : "movie";
  const page = Math.floor(skip / 20) + 1;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${tmdbType}/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`,
    );
    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    const items: Record<string, unknown>[] = (data.results ?? [])
      .map((item) => ({
        id: (item["imdb_id"] as string | undefined) || `tmdb:${item["id"]}`,
        type,
        name: (item["title"] as string | undefined) || (item["name"] as string | undefined),
        poster: item["poster_path"]
          ? `https://image.tmdb.org/t/p/w300${item["poster_path"]}`
          : undefined,
        background: item["backdrop_path"]
          ? `https://image.tmdb.org/t/p/w1280${item["backdrop_path"]}`
          : undefined,
        description: item["overview"],
        releaseInfo: ((item["release_date"] as string | undefined) ||
          (item["first_air_date"] as string | undefined) || "").split("-")[0],
        imdbRating: (item["vote_average"] as number | undefined)?.toFixed(1),
      }))
      .filter((m) => !!m.name);
    CATALOG_CACHE.set(cacheKey, { data: items, ts: Date.now() });
    return items;
  } catch (e) {
    logger.error({ err: e }, "TMDB catalog error");
    return [];
  }
}

// ─── IMDb → TMDB ID resolver ──────────────────────────────────────────────────

async function imdbToTmdbId(imdbId: string, type: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
    );
    const data = (await res.json()) as {
      movie_results?: Array<{ id: number }>;
      tv_results?: Array<{ id: number }>;
    };
    const results = type === "series" ? data.tv_results : data.movie_results;
    if (results?.[0]) return String(results[0].id);
  } catch (e) {
    logger.warn({ err: e, imdbId }, "imdbToTmdbId: failed");
  }
  return null;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

router.get("/manifest.json", (req, res) => {
  stremioHeaders(res);
  // Build a dynamic base URL so logo + configurationURL always point back to
  // this server regardless of whether it's running on Replit, Vercel, or locally.
  const domains = process.env["REPLIT_DOMAINS"];
  const base = domains
    ? `https://${domains.split(",")[0]}`
    : (() => {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
        const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
        return `${proto}://${host}`;
      })();
  res.json({
    ...manifest,
    logo: `${base}${BASE_PATH}/logo.png`,
    configurationURL: `${base}${BASE_PATH}/configure`,
  });
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

router.get(
  ["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"],
  async (req, res) => {
    stremioHeaders(res);
    const { type, id } = req.params;
    const extra = req.params["extra"] as string | undefined;

    let search = "";
    let skip = 0;
    let page = 1;
    let genre = "";

    if (extra) {
      for (const part of extra.split("&")) {
        if (part.startsWith("search="))
          search = decodeURIComponent(part.replace("search=", ""));
        if (part.startsWith("skip=")) {
          skip = parseInt(part.replace("skip=", "")) || 0;
          page = Math.floor(skip / 20) + 1;
        }
        if (part.startsWith("genre="))
          genre = decodeURIComponent(part.replace("genre=", ""));
      }
    }

    const skipQuery = parseInt((req.query["skip"] as string | undefined) ?? "0") || 0;
    if (!skip && skipQuery) {
      skip = skipQuery;
      page = Math.floor(skip / 20) + 1;
    }

    logger.info({ type, id, search, page, genre }, "Stremio: catalog request");

    try {
      if (id === "infinitestreams_movies" || id === "infinitestreams_series" || id === "allinone_movies" || id === "allinone_series") {
        const metas = await getTMDBCatalog(type as "movie" | "series", skip);
        res.json({ metas });
        return;
      }

      if (id === "animesalt-anime" || id === "animesalt-anime-movies") {
        const catalogType = id === "animesalt-anime" ? "series" : "movie";
        const metas = await getAnimeCatalog(catalogType, skip, search || undefined);
        res.json({ metas });
        return;
      }

      // HindMoviez catalogs
      if (id === "hindmoviez-movies" || id === "hindmoviez-series") {
        const catalogType = id === "hindmoviez-movies" ? "movie" : "series";
        try {
          const extraMap: Record<string, string> = {};
          if (search) extraMap["search"] = search;
          if (skip) extraMap["skip"] = String(skip);
          const metas = await hindmoviezGetCatalog(catalogType, id, extraMap);
          res.json({ metas });
        } catch (e) {
          logger.error({ err: e }, "HindMoviez: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // RareAnime catalogs
      if (id === "rareanime-series" || id === "rareanime-movies") {
        try {
          let metas = (await withTimeoutRA(raGetAllCatalogItems(), 8_000)) ?? [];
          if (search.trim().length > 1) {
            const q = search.trim().toLowerCase();
            metas = metas.filter((m: RACatalogMeta) => m.name.toLowerCase().includes(q));
          }
          metas = metas.filter((m: RACatalogMeta) => m.type === type);
          const paged = metas.slice(skip, skip + 200);
          res.json({ metas: paged.map((m: RACatalogMeta) => ({ id: m.id, type: m.type, name: m.name, poster: m.poster, genres: ["Anime", "Hindi Dubbed"] })) });
        } catch (e) {
          logger.error({ err: e }, "RareAnime: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // Atoon catalogs
      if (id === "atoon-series" || id === "atoon-movies") {
        try {
          let items = (await withTimeoutRA(raBuildAtoonCatalog(), 8_000)) ?? [];
          buildCrossSourceMerge();
          if (search.trim().length > 1) {
            const q = search.trim().toLowerCase();
            items = items.filter((m) => m.name.toLowerCase().includes(q));
          }
          const filtered = items.filter((m) => m.type === type);
          const paged = filtered.slice(skip, skip + 200);
          res.json({ metas: paged.map((m) => ({ id: m.id, type: m.type, name: m.name, poster: m.poster, genres: ["Anime", "Hindi Dubbed"] })) });
        } catch (e) {
          logger.error({ err: e }, "AnimeToon: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // AnimeDekho catalogs
      if (id === "animedekho-series" || id === "animedekho-movies") {
        const catalogType = id === "animedekho-movies" ? "movie" : "series";
        let results;
        if (search) {
          results = await animeDekhoSearch(search);
          results = results.filter((r) => r.type === catalogType);
          // Relevance filter to suppress unrelated results
          const scored = results.map((r) => ({
            r,
            score: titleSimilarityScore(search, r.title),
          }));
          results = scored
            .filter(({ score }) => score >= 0.2)
            .sort((a, b) => b.score - a.score)
            .map(({ r }) => r);
        } else {
          results = await animeDekhoGetCatalog(id, genre || undefined, skip, catalogType);
        }
        const metas = results.map((r) => {
          const m: Record<string, unknown> = {
            id: r.id,
            type: catalogType,
            name: r.title,
          };
          if (r.poster) m["poster"] = r.poster;
          if (r.background) m["background"] = r.background;
          if (r.year) m["releaseInfo"] = r.year;
          if (r.description) m["description"] = r.description;
          if (r.genres?.length) m["genres"] = r.genres;
          return m;
        });
        res.json({ metas });
        return;
      }

      res.json({ metas: [] });
    } catch (e) {
      logger.error({ err: e }, "Stremio: catalog error");
      res.json({ metas: [] });
    }
  },
);

// ─── Meta ─────────────────────────────────────────────────────────────────────

router.get("/meta/:type/:id.json", async (req, res) => {
  stremioHeaders(res);
  const { type, id } = req.params;
  logger.info({ type, id }, "Stremio: meta request");

  try {
    // RareAnime / Atoon native IDs — meta
    if (id.startsWith("rareanime:")) {
      await withTimeoutRA(raGetAllCatalogItems(), 8_000);
      const baseSlug = id.replace(/^rareanime:/, "");
      const pageUrl = `https://www.rareanimes.buzz/hindi/${baseSlug}/`;
      const pageMeta = await withTimeoutRA(raGetPageMeta(pageUrl), 8_000);
      const knownSeasons = getSeasonSlugs(baseSlug);
      const seasons = await withTimeoutRA(discoverAllSeasons(baseSlug, knownSeasons), 12_000) ?? knownSeasons;
      const displayName = pageMeta?.title || baseSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const isSeries = type === "series";
      const stremioMeta: Record<string, unknown> = {
        id,
        type: isSeries ? "series" : "movie",
        name: displayName,
        poster: pageMeta?.poster || undefined,
        description: pageMeta?.description || undefined,
        genres: ["Anime", "Hindi Dubbed"],
      };
      if (isSeries && seasons.length > 0) {
        const videos: Record<string, unknown>[] = [];
        const BASE_DATE = Date.now() - 365 * 24 * 60 * 60 * 1000;
        for (const s of seasons) {
          const sPageUrl = `https://www.rareanimes.buzz/hindi/${s.slug}/`;
          const eps = await withTimeoutRA(raGetEpisodeLinks(sPageUrl), 10_000) ?? [];
          const norm = normaliseRAEpisodeNumbers(eps);
          for (const ep of norm) {
            videos.push({
              id: `${id}:${s.season}:${ep.episodeNumber}`,
              title: ep.title || `Episode ${ep.episodeNumber}`,
              season: s.season,
              episode: ep.episodeNumber,
              released: new Date(BASE_DATE + (ep.episodeNumber - 1) * 86400000).toISOString(),
            });
          }
        }
        if (videos.length > 0) stremioMeta["videos"] = videos;
      } else if (!isSeries) {
        stremioMeta["videos"] = [{ id: `${id}:1:1`, title: displayName, season: 1, episode: 1 }];
      }
      res.json({ meta: stremioMeta });
      return;
    }

    if (id.startsWith("atoon:")) {
      await withTimeoutRA(raBuildAtoonCatalog(), 8_000);
      const showSlug = id.replace(/^atoon:/, "").split(":")[0];
      const showSeasons = getAtoonShowSeasons(showSlug);
      const archiveMeta = showSeasons.length > 0 ? await withTimeoutRA(getAtoonArchiveMeta(showSeasons[0].archiveId), 8_000) : null;
      const displayName = archiveMeta?.title || showSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const isSeries = type === "series";
      const stremioMeta: Record<string, unknown> = {
        id,
        type: isSeries ? "series" : "movie",
        name: displayName,
        poster: archiveMeta?.poster || undefined,
        genres: ["Anime", "Hindi Dubbed"],
      };
      if (isSeries && showSeasons.length > 0) {
        const videos: Record<string, unknown>[] = [];
        const BASE_DATE = Date.now() - 365 * 24 * 60 * 60 * 1000;
        for (const s of showSeasons) {
          const eps = await withTimeoutRA(getAtoonEpisodeLinks(s.archiveId), 10_000) ?? [];
          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            videos.push({
              id: `atoon:${showSlug}:${s.season}:${i + 1}`,
              title: ep.title || `Episode ${i + 1}`,
              season: s.season,
              episode: i + 1,
              released: new Date(BASE_DATE + i * 86400000).toISOString(),
            });
          }
        }
        if (videos.length > 0) stremioMeta["videos"] = videos;
      }
      res.json({ meta: stremioMeta });
      return;
    }

    // AnimeDekho native IDs
    if (id.startsWith("animedekho:")) {
      const meta = await animeDekhoGetMeta(id);
      if (!meta) { res.json({ meta: null }); return; }

      // Ground-truth type: prefer URL-derived mediaType from the decoded id,
      // then meta.type, then fall back to the Stremio URL param.
      const decodedId = animeDekhoDecodeId(id);
      const authorativeType: "movie" | "series" =
        decodedId?.mediaType === 1 ? "movie" :
        decodedId?.mediaType === 2 ? "series" :
        meta.type === "series" ? "series" :
        meta.type === "movie" ? "movie" :
        (type === "series" ? "series" : "movie");

      const stremioMeta: Record<string, unknown> = {
        id: meta.id,
        type: authorativeType,
        name: meta.title,
        poster: meta.poster || undefined,
        posterShape: "poster",
        description: meta.plot || undefined,
        year: meta.year || undefined,
        background: meta.poster || undefined,
        genres: meta.genres.length ? meta.genres : undefined,
        links: meta.genres.map((g) => ({
          name: g,
          category: "Genres",
          url: `stremio:///discover//${encodeURIComponent(g)}`,
        })),
      };

      if (authorativeType === "series" && meta.episodes?.length) {
        const totalEps = meta.episodes.length;
        const BASE_DATE = Date.now() - totalEps * 7 * 24 * 60 * 60 * 1000;
        stremioMeta["videos"] = meta.episodes.map((ep, idx) => ({
          id: ep.id,
          title: ep.title || `Episode ${ep.episode}`,
          season: ep.season ?? 1,
          episode: ep.episode ?? idx + 1,
          thumbnail: ep.poster || undefined,
          released: new Date(BASE_DATE + idx * 7 * 24 * 60 * 60 * 1000).toISOString(),
          overview: ep.title || undefined,
        }));
      }

      res.json({ meta: stremioMeta });
      return;
    }

    res.json({ meta: null });
  } catch (e) {
    logger.error({ err: e, id }, "Stremio: meta error");
    res.json({ meta: null });
  }
});

// ─── Proxy base URL ───────────────────────────────────────────────────────────

function publicOrigin(req: Request): string {
  const publicUrl = process.env["PUBLIC_URL"];
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  return `${proto}://${host}`;
}

function apiBase(req: Request): string {
  return `${publicOrigin(req)}${BASE_PATH}`;
}

function hdhub4uStreamToStremio(
  entry: hdhub4u.StreamEntry,
  sourceName: string,
): Record<string, unknown> {
  const server = entry.server ?? "HubCloud";
  const sizePart = entry.size ? ` · 📁 ${entry.size}` : "";
  return {
    name: `${sourceName}\n${entry.quality} | ${server}`,
    title: `🔊 ${entry.language}${sizePart}`,
    url: entry.url,
    behaviorHints: { notWebReady: true },
  };
}

// Returns true when titleA and titleB share at least one meaningful word (3+ chars).
// Used as a secondary match gate after prefix check fails — prevents completely
// unrelated titles (e.g. "Kabir Singh" ↔ "The Ransom") while still accepting
// translated/alternate-titled shows (e.g. "Crayon Shin-chan" ↔ "Shin Chan").
function titleWordOverlap(titleA: string, titleB: string): boolean {
  // Strip hyphens BEFORE splitting so "Shin-chan" → "shinchan" (one token),
  // which then directly matches the compound spelling "Shinchan".
  const norm = (s: string) =>
    s.toLowerCase().replace(/-/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const wordsA = norm(titleA).split(" ").filter((w) => w.length >= 3);
  const setB   = new Set(norm(titleB).split(" ").filter((w) => w.length >= 3));
  return wordsA.some((w) => setB.has(w));
}

async function getHDHub4UStreams(
  title: string,
  type: string,
  imdbId?: string,
): Promise<Record<string, unknown>[]> {
  try {
    const results = await hdhub4u.searchSite(title);
    if (!results.length) {
      logger.info({ title, type }, "HDHub4U: no search results");
      return [];
    }
    logger.info({ title, type, count: results.length, titles: results.map((r) => `${r.title}[${r.type}]`) }, "HDHub4U: search results");
    // Only match results of the correct content type — never serve a series page for a movie request or vice versa.
    // Catalog mismatch fallback: if type detection in the HDHub4U catalog is wrong (e.g. a movie
    // tagged under a web-series category), typed list will be empty — in that case fall back to
    // all results but require a higher similarity score (0.7) to avoid false matches.
    const typed = results.filter((r) => r.type === (type as "movie" | "series"));
    const pool = typed.length > 0 ? typed : results;
    const minScore = typed.length > 0 ? 0.5 : 0.7;
    // Score all candidates with word-overlap gate + similarity ranking.
    const withOverlap = pool.filter((r) => titleWordOverlap(title, r.title));
    const scored = withOverlap
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    logger.info({
      title, type, typed: typed.length, pool: pool.length, withOverlap: withOverlap.length,
      best: best ? `${best.r.title}[${best.r.type}] score=${best.score.toFixed(2)}` : "none", minScore,
    }, "HDHub4U: scoring");
    if (!best || best.score < minScore) return [];
    if (typed.length === 0) {
      logger.info({ title, type, bestType: best.r.type, score: best.score }, "HDHub4U: type-fallback match");
    }
    // Pass imdbId so extractStreams can verify the page's embedded IMDB ID matches
    const streams = await hdhub4u.extractStreams(best.r.url, undefined, undefined, imdbId);
    logger.info({ title, url: best.r.url, streams: streams.length }, "HDHub4U: streams extracted");
    return streams.map((s) => hdhub4uStreamToStremio(s, "📡 HDHub4U"));
  } catch (err) {
    logger.error({ err, title }, "HDHub4U: crashed");
    return [];
  }
}

async function getHDHub4USeriesStreams(
  title: string,
  season: number,
  episode: number,
  imdbId?: string,
): Promise<Record<string, unknown>[]> {
  try {
    // Try season-specific query first; fall back to plain title if it returns nothing
    let results = await hdhub4u.searchSite(`${title} season ${season}`);
    if (!results.length) results = await hdhub4u.searchSite(title);
    if (!results.length) {
      logger.info({ title, season, episode }, "HDHub4U series: no search results");
      return [];
    }
    logger.info({ title, season, episode, count: results.length, titles: results.map((r) => `${r.title}[${r.type}]`) }, "HDHub4U series: search results");
    // Only use series-typed results — never serve a movie page for a series request.
    // Catalog mismatch fallback: if the HDHub4U catalog wrongly typed this as a movie,
    // fall back to all results but require a higher similarity score (0.7).
    const typed = results.filter((r) => r.type === "series");
    const pool = typed.length > 0 ? typed : results;
    const minScore = typed.length > 0 ? 0.5 : 0.7;
    // Pick the best-matching result (highest similarity, word-overlap gated)
    const withOverlap = pool.filter((r) => titleWordOverlap(title, r.title));
    const scored = withOverlap
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    logger.info({
      title, season, episode, typed: typed.length, pool: pool.length, withOverlap: withOverlap.length,
      best: best ? `${best.r.title}[${best.r.type}] score=${best.score.toFixed(2)}` : "none", minScore,
    }, "HDHub4U series: scoring");
    if (!best || best.score < minScore) return [];
    if (typed.length === 0) {
      logger.info({ title, season, episode, bestType: best.r.type, score: best.score }, "HDHub4U: series type-fallback match");
    }
    // Pass imdbId so extractStreams can verify the page's embedded IMDB ID matches
    const streams = await hdhub4u.extractStreams(best.r.url, season, episode, imdbId);
    logger.info({ title, season, episode, url: best.r.url, streams: streams.length }, "HDHub4U series: streams extracted");
    return streams.map((s) => hdhub4uStreamToStremio(s, "📡 HDHub4U"));
  } catch (err) {
    logger.error({ err, title, season, episode }, "HDHub4U: series crashed");
    return [];
  }
}

async function getFourkdHubStreams(
  title: string,
  type: string,
  imdbId?: string,
): Promise<Record<string, unknown>[]> {
  try {
    const results = await fourkdhub.searchSite(title);
    if (!results.length) return [];
    // Only match results of the correct content type — never serve a series page for a movie request or vice versa
    const typed = results.filter((r) => r.type === (type as "movie" | "series"));
    if (!typed.length) return [];
    // Pick the best-scoring match (similarity-ranked, word-overlap gated) rather than
    // the first result — search results can surface loosely-related titles first.
    const scored = typed
      .filter((r) => titleWordOverlap(title, r.title))
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 0.5) return [];
    // Pass imdbId so extractStreams can verify the page's embedded IMDB ID matches
    const streams = await fourkdhub.extractStreams(best.r.url, undefined, undefined, imdbId);
    return streams.map((s) => hdhub4uStreamToStremio(s, "🔵 4KHDHub"));
  } catch (err) {
    logger.error({ err, title }, "4KHDHub: crashed");
    return [];
  }
}

async function getFourkdHubSeriesStreams(
  title: string,
  season: number,
  episode: number,
  imdbId?: string,
): Promise<Record<string, unknown>[]> {
  try {
    // Try season-specific query first; fall back to plain title if it returns nothing
    let results = await fourkdhub.searchSite(`${title} season ${season}`);
    if (!results.length) results = await fourkdhub.searchSite(title);
    if (!results.length) return [];
    // Only use series-typed results — never serve a movie page for a series request
    const typed = results.filter((r) => r.type === "series");
    if (!typed.length) return [];
    // Pick the best-scoring match (similarity-ranked, word-overlap gated).
    const scored = typed
      .filter((r) => titleWordOverlap(title, r.title))
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 0.5) return [];
    // Pass imdbId so extractStreams can verify the page's embedded IMDB ID matches
    const streams = await fourkdhub.extractStreams(best.r.url, season, episode, imdbId);
    return streams.map((s) => hdhub4uStreamToStremio(s, "🔵 4KHDHub"));
  } catch (err) {
    logger.error({ err, title, season, episode }, "4KHDHub: series crashed");
    return [];
  }
}

async function getAnimeSaltStreams(
  imdbId: string,
  type: string,
  season?: number,
  episode?: number,
  req?: Request,
): Promise<Record<string, unknown>[]> {
  try {
    const mediaType = type === "series" ? "series" : "movie";
    const streams = await animesaltGetStreams(imdbId, mediaType, season, episode);
    if (!streams.length) return [];
    const base = req ? apiBase(req) : "";
    return streams.map((s) => {
      if (!base) return { name: s.name, title: s.title, url: s.url, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };

      // Preferred path: use the fresh-relay endpoint.
      // /api/as-relay re-calls the AnimeSalt player API fresh on every playback
      // start so the signed CDN token is always brand-new and bound to our
      // server IP.  It then immediately fetches and proxies the m3u8 from the
      // same IP, bypassing the timing window where the old approach could fail.
      if (s.hash && s.playerCdn) {
        const relayUrl = `${base}/as-relay?hash=${encodeURIComponent(s.hash)}&player=${encodeParam(s.playerCdn)}`;
        // Kick off relay computation in the background immediately so the cache
        // is hot by the time Stremio actually calls the relay URL (~1-3 s later).
        prewarmAsRelay(s.hash, s.playerCdn, base);
        return { name: s.name, title: s.title, url: relayUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
      }

      // Fallback: direct proxied m3u8 (used when hash wasn't extracted, e.g.
      // page-scrape fallback path in animesalt.ts).
      const proxiedUrl = `${base}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}&origin=${encodeURIComponent(s.origin)}`;
      return { name: s.name, title: s.title, url: proxiedUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
    });
  } catch (err) {
    logger.error({ err, imdbId }, "AnimeSalt: provider error");
    return [];
  }
}

// ─── Castle TV / DahmerMovies / StreamFlix helpers ───────────────────────────

async function getCastleTvStreams(
  imdbId: string,
  type: string,
  title: string,
  year: number | undefined,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  try {
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await getCastleTvImdbStreams(type, imdbId, title, year, s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, imdbId }, "CastleTV: provider error");
    return [];
  }
}

async function getDahmerMoviesStreams(
  title: string,
  year: number | undefined,
  type: string,
  season: number,
  episode: number,
  req: Request,
  imdbId?: string,
): Promise<Record<string, unknown>[]> {
  try {
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await fetchDahmerStreams(title, year ?? null, s, e, apiBase(req), imdbId);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, title }, "DahmerMovies: provider error");
    return [];
  }
}

async function getStreamflixStreams(
  tmdbId: string | null,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  if (!tmdbId) return [];
  try {
    const numTmdbId = parseInt(tmdbId, 10);
    if (Number.isNaN(numTmdbId)) return [];
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await fetchStreamflixStreams(numTmdbId, type as "movie" | "series", s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, tmdbId }, "StreamFlix: provider error");
    return [];
  }
}

// ─── AnimeDekho stream helpers ────────────────────────────────────────────────

const AD_REFERER = "https://animedekho.app/";

function adEnsurePlayable(stream: ADStream): ADStream {
  const existingReferer =
    stream.behaviorHints?.proxyHeaders?.request?.["Referer"] ||
    AD_REFERER;
  let existingOrigin = AD_REFERER;
  try { existingOrigin = new URL(existingReferer).origin; } catch {}
  return {
    ...stream,
    behaviorHints: {
      ...stream.behaviorHints,
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: existingReferer,
          Origin: existingOrigin,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      },
    },
  };
}

// CDN hostnames that block all datacenter/cloud IPs at the TCP/HTTP level.
// These cannot be proxied through our server at all; the user's device must
// fetch directly. All other CDNs (StreamRuby, StreamWish, FileMoon, etc.) may
// embed our server IP in their signed tokens — those MUST go through our proxy.
const DIRECT_CDN_HOSTS = [
  "cdn-centaurus.com",
  "centaurus.com",
];

function isDirectCdn(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DIRECT_CDN_HOSTS.some(h => host.endsWith(h));
  } catch { return false; }
}

const AD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function adStreamToStremio(s: ADStream, req?: Request): Record<string, unknown> {
  const isHls = s.type === "hls" || s.url.includes(".m3u8");
  const base = req ? apiBase(req) : "";

  if (isHls) {
    const referer =
      s.behaviorHints?.proxyHeaders?.request?.["Referer"] ||
      s.behaviorHints?.headers?.["Referer"] ||
      AD_REFERER;
    let origin = referer;
    try { origin = new URL(referer).origin; } catch {}

    // Specific CDNs that flat-out block datacenter IPs: serve directly with
    // proxyHeaders so Stremio's player adds the required Referer/Origin.
    const adSubs = s.subtitles?.length ? s.subtitles : undefined;

    if (isDirectCdn(s.url)) {
      return {
        name: s.name,
        title: s.title,
        url: s.url,
        subtitles: adSubs,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: { request: { Referer: referer, Origin: origin, "User-Agent": AD_UA } },
        },
      };
    }

    // All other CDNs (StreamRuby, StreamWish, FileMoon, as-cdn*.top, etc.):
    // route through our server proxy.  Many of these embed our server's IP in
    // the signed token (e.g. StreamRuby's `i=34.93` param).  A request from
    // any other IP is rejected 403.  The proxy also correctly handles
    // AES-128 key requests via /api/seg with the right Referer/Origin.
    if (base) {
      const proxiedUrl = `${base}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
      return {
        name: s.name,
        title: s.title,
        url: proxiedUrl,
        subtitles: adSubs,
        behaviorHints: { notWebReady: true },
      };
    }
  }

  // Non-HLS (MP4, etc.) — pass through with original headers
  return {
    name: s.name,
    title: s.title,
    url: s.url,
    type: s.type,
    subtitles: s.subtitles?.length ? s.subtitles : undefined,
    behaviorHints: s.behaviorHints,
  };
}

// ─── HindMoviez proxy wrapper ─────────────────────────────────────────────────
// GDShine streams come via Cloudflare Worker URLs (*.workers.dev).
// Cloudflare Workers have a hard 1 GB response-body limit, so any file
// larger than 1 GB stalls the player immediately.  Routing the URL
// through our /api/proxy endpoint fixes this because:
//   1. Our Node.js proxy forwards the HTTP Range header so the player can
//      fetch the file in chunks without having to buffer the whole thing.
//   2. Range requests are small (a few MB each), so no single response
//      ever hits the Cloudflare 1 GB ceiling.
// We also proxy any other HindMoviez direct-download URLs to ensure
// consistent range-request behaviour regardless of file size.
function proxyHindMoviezStreams(
  streams: import("../providers/hindmovies.js").StremioStream[],
  req: Request,
): Record<string, unknown>[] {
  const base = apiBase(req);
  return streams.map((s) => {
    const isHls = s.url.includes(".m3u8");
    if (isHls) {
      return {
        name: s.name,
        title: s.title,
        url: s.url,
        behaviorHints: { notWebReady: true },
      };
    }
    const proxiedUrl = `${base}/hmproxy?u=${encodeParam(s.url)}`;
    return {
      name: s.name,
      title: s.title,
      url: proxiedUrl,
      behaviorHints: { notWebReady: false },
    };
  });
}

function neoCdnSourceToStream(src: NeoCdnSource): ADStream[] {
  return [
    {
      name: "AnimeDekho | NeoCDN",
      title: `${src.type} [${src.size}]`,
      url: src.url,
      type: "url",
      behaviorHints: { notWebReady: false },
    },
  ];
}

async function collectAnimeDekhoEpisodeStreams(
  episodeUrl: string,
): Promise<ADStream[]> {
  // getVidStreamIframes now parses the server button list to return exact trdekho
  // indices present on the page — no more blind 0-24 scanning.
  const [{ iframes: vidIframes, hasNeocdn: pageHasNeocdn, neoCdnMythUrl, trdekhoIndices }, extraIframes, bodyInfo] = await Promise.all([
    getVidStreamIframes(episodeUrl),
    getEpisodePageIframes(episodeUrl),
    getBodyTermId(episodeUrl),
  ]);

  // Only fetch the trdekho slots actually listed on the episode page.
  // Fetching non-existent slots (old 0-24 approach) returned wrong CDN content
  // (e.g. FileMoon for a completely different episode).
  const trdekhoIframes = (bodyInfo && trdekhoIndices.length > 0)
    ? await getTrdekhoIframes(bodyInfo.term, bodyInfo.mediaType, trdekhoIndices)
    : [];

  // Pass the myth URL directly from the page — it encodes the correct HydraX trdekho
  // slot for this show. Different shows map HydraX to different trdekho indices.
  const neoCdnSources = (pageHasNeocdn && neoCdnMythUrl)
    ? await getNeoCdnStreams(neoCdnMythUrl, episodeUrl)
    : [];

  // Filter HydraX (abyssplayer) from trdekho results
  const filteredTrdekho = trdekhoIframes.filter(
    (u) => !u.includes("abyssplayer.com") && !u.includes("abysscdn.com"),
  );

  const allIframes = [...new Set([...vidIframes, ...extraIframes, ...filteredTrdekho])];
  logger.info(
    { count: allIframes.length, neoCdn: neoCdnSources.length, pageHasNeocdn, trdekhoIndices, episodeUrl },
    "AnimeDekho: resolving iframes",
  );
  const results = await Promise.allSettled(
    allIframes.map((u) => resolveExtractor(u, episodeUrl))
  );
  const streams: ADStream[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const s of r.value) streams.push(adEnsurePlayable(s));
    }
  }
  for (const src of neoCdnSources) streams.push(...neoCdnSourceToStream(src));
  return streams;
}

async function collectAnimeDekhoPageStreams(pageUrl: string): Promise<ADStream[]> {
  const bodyInfo = await getBodyTermId(pageUrl);
  if (!bodyInfo) return [];

  // getBodyTermId returns the full page HTML in bodyInfo.text.
  // Parse server buttons from it to get exact trdekho indices and NeoCDN flag —
  // same page-aware approach used for episode pages.
  const { hasNeocdn, neoCdnMythUrl, trdekhoIndices } = bodyInfo.text
    ? parsePageServers(bodyInfo.text)
    : { hasNeocdn: false, neoCdnMythUrl: null as string | null, trdekhoIndices: [] as number[] };

  logger.info({ pageUrl, hasNeocdn, neoCdnMythUrl, trdekhoIndices }, "AnimeDekho page servers");

  const [iframes, neoCdnSources] = await Promise.all([
    trdekhoIndices.length > 0
      ? getTrdekhoIframes(bodyInfo.term, bodyInfo.mediaType, trdekhoIndices)
      : Promise.resolve<string[]>([]),
    // Pass myth URL directly from the page (encodes the correct HydraX trdekho slot).
    // Fall back to attempting if page HTML was unavailable and we cannot determine servers.
    (hasNeocdn && neoCdnMythUrl)
      ? getNeoCdnStreams(neoCdnMythUrl, pageUrl)
      : Promise.resolve<NeoCdnSource[]>([]),
  ]);

  const filteredIframes = iframes.filter(
    (u) => !u.includes("abyssplayer.com") && !u.includes("abysscdn.com"),
  );

  const results = await Promise.allSettled(filteredIframes.map((u) => resolveExtractor(u, pageUrl)));
  const streams: ADStream[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const s of r.value) streams.push(adEnsurePlayable(s));
    }
  }
  for (const src of neoCdnSources) streams.push(...neoCdnSourceToStream(src));
  return streams;
}

function isEpisodeUrl(url: string): boolean {
  return url.includes("/epi/") || /[-/]\d+x\d+\/?(?:[?#]|$)/.test(url);
}

function buildTitleVariants(title: string): string[] {
  const words = title.trim().split(/\s+/);
  // "Shin Chan" → "Shinchan" (collapsed) — handles anime/Bollywood one-word spellings
  const collapsed = title.replace(/[-\s]+/g, "").trim();
  // "Shin-chan" → "Shin chan" (hyphen→space)
  const hyphenToSpace = title.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  // "Crayon Shin-chan" → "Shin-chan" (drop first word, only if title has 3+ words)
  const dropFirst = words.length >= 3 ? words.slice(1).join(" ") : "";
  // "Shin-chan: Me and the Professor" → "Shin-chan"
  const beforeColon = title.split(":")[0]!.trim();
  // Only include single-word variants if the collapsed form equals them (avoid noise like "Chan")
  const candidates = [title, collapsed, hyphenToSpace, dropFirst, beforeColon];
  return [...new Set(candidates)].filter((v) => v && v.length > 2);
}

async function getAnimeDekhoStreams(
  title: string,
  type: string,
  season: number,
  episode: number,
): Promise<ADStream[]> {
  logger.info({ title, type, season, episode }, "AnimeDekho: title-based stream lookup");
  try {
    const targetType = type === "movie" ? "movie" : "series";
    const variants = buildTitleVariants(title);
    let bestPool: Awaited<ReturnType<typeof animeDekhoSearch>> = [];

    for (const variant of variants) {
      const results = await animeDekhoSearch(variant);
      if (!results.length) continue;
      const typed = results.filter((r) => r.type === targetType);
      if (typed.length > 0) {
        bestPool = typed;
        break;
      }
    }
    if (!bestPool.length) return [];

    const scored = bestPool
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    // Threshold 0.45: spinoffs score below this due to length penalty.
    // Collapsed-form matching (e.g. "Shin Chan" ↔ "Shinchan") returns 0.96,
    // so same-title one-word/two-word variants still pass.
    if (!best || best.score < 0.45) {
      logger.warn({ title, score: best?.score }, "AnimeDekho: no close title match");
      return [];
    }

    const match = best.r;
    logger.info({ title, matched: match.title, score: best.score }, "AnimeDekho: matched");

    if (targetType === "series") {
      const meta = await animeDekhoGetMeta(match.id);
      if (!meta?.episodes?.length) return [];

      // 1. Exact match
      let ep = meta.episodes.find((e) => e.season === season && e.episode === episode);

      // 2. Some AnimeDekho series list all eps under season=1 regardless of actual season
      //    Try matching just by episode number within the whole list
      if (!ep) {
        ep = meta.episodes.find((e) => e.episode === episode);
        if (ep) logger.warn({ title, season, episode, foundSeason: ep.season }, "AnimeDekho: season mismatch, matched by episode number only");
      }

      // 3. Linear position fallback — treat the whole ep list as a flat ordered array
      //    Episode = (season-1)*maxEpPerSeason + episode, but simpler: index = episode-1
      if (!ep) {
        const idx = episode - 1;
        if (idx >= 0 && idx < meta.episodes.length) {
          ep = meta.episodes[idx];
          if (ep) logger.warn({ title, season, episode, idx }, "AnimeDekho: fell back to linear episode index");
        }
      }

      if (!ep) {
        logger.warn({ title, season, episode, totalEps: meta.episodes.length }, "AnimeDekho: episode not found in meta");
        return [];
      }
      return collectAnimeDekhoEpisodeStreams(ep.url);
    } else {
      return collectAnimeDekhoPageStreams(match.url);
    }
  } catch (err) {
    logger.error({ title, err }, "AnimeDekho: getAnimeDekhoStreams error");
    return [];
  }
}

async function getAnimeDekhoNativeStreams(
  stremioId: string,
  type: string,
  season: number,
  episode: number,
): Promise<ADStream[]> {
  logger.info({ stremioId, type, season, episode }, "AnimeDekho: native ID stream");
  try {
    const decoded = animeDekhoDecodeId(stremioId);
    if (!decoded) return [];

    // Use decoded.mediaType (from the encoded ID) as ground truth.
    // Stremio's `type` URL param can be wrong if getMeta previously mis-classified the content.
    // Also treat explicit episode URLs as series regardless of type param.
    const isEpUrl = isEpisodeUrl(decoded.url);
    const effectiveType: "movie" | "series" =
      isEpUrl ? "series" :
      decoded.mediaType === 1 ? "movie" :
      decoded.mediaType === 2 ? "series" :
      (type === "series" ? "series" : "movie");

    logger.info({ stremioId, type, effectiveType, decodedMediaType: decoded.mediaType, isEpUrl }, "AnimeDekho: effective type resolved");

    if (effectiveType === "series") {
      // Direct episode URL → stream it immediately
      if (isEpUrl) {
        return collectAnimeDekhoEpisodeStreams(decoded.url);
      }
      // Series index page → look up episode list and find the right episode
      const meta = await animeDekhoGetMeta(stremioId);
      if (!meta?.episodes?.length) {
        logger.warn({ stremioId, season, episode }, "AnimeDekho: series has no episodes in meta");
        return [];
      }

      // 1. Exact season + episode match
      let ep = meta.episodes.find((e) => e.season === season && e.episode === episode);

      // 2. Episode number only (AnimeDekho sometimes lists all eps as season 1)
      if (!ep) {
        ep = meta.episodes.find((e) => e.episode === episode);
        if (ep) logger.warn({ stremioId, season, episode, foundSeason: ep.season }, "AnimeDekho: native season mismatch, matched by ep num");
      }

      // 3. Linear index fallback
      if (!ep) {
        const idx = episode - 1;
        if (idx >= 0 && idx < meta.episodes.length) {
          ep = meta.episodes[idx];
          if (ep) logger.warn({ stremioId, season, episode, idx }, "AnimeDekho: native fell back to linear ep index");
        }
      }

      if (!ep) {
        logger.warn({ stremioId, season, episode, total: meta.episodes.length }, "AnimeDekho: native episode not found");
        return [];
      }
      return collectAnimeDekhoEpisodeStreams(ep.url);
    } else {
      return collectAnimeDekhoPageStreams(decoded.url);
    }
  } catch (err) {
    logger.error({ stremioId, err }, "AnimeDekho: native stream error");
    return [];
  }
}

// ─── MovieBox helpers ─────────────────────────────────────────────────────────

function detectStreamType(url: string, format: string) {
  if (url.startsWith("magnet:") || url.endsWith(".torrent")) return "skip";
  const fmt = format.toUpperCase();
  // Check format field first (API-declared type is more reliable than URL extension)
  if (fmt === "DASH" || url.includes(".mpd")) return "dash";
  if (fmt === "HLS" || url.includes(".m3u8")) return "hls";
  if (fmt === "MP4" || fmt === "MKV" || url.includes(".mp4") || url.includes(".mkv")) return "mp4";
  return "unknown";
}

function mbQualityLabel(resolutions: string): string {
  for (const q of ["2160", "1440", "1080", "720", "480", "360", "240"]) {
    if (resolutions.includes(q)) return `${q}p`;
  }
  return resolutions || "HD";
}

function mbStreamToStremio(
  stream: MBStream,
  language: string,
  req: Request,
  subtitles?: Array<{ url: string; lang: string }>,
): Record<string, unknown> | null {
  if (!stream.url) return null;
  const sType = detectStreamType(stream.url, stream.format);
  if (sType === "skip") return null;

  const qLabel = mbQualityLabel(stream.resolutions);
  // Use stream-level lang if the API provides it, otherwise fall back to the dub label
  const rawLang = stream.lang ?? language;
  // Normalize BCP-47 codes (e.g. "pt-BR", "es-ES") to readable language names so
  // premiumFormat's audio regex can match them and users see "🔊 Audio: Portuguese"
  // instead of a blank label or an opaque "pt-BR" tag.
  const BCP47_NAMES: Record<string, string> = {
    // ISO 639-1 two-letter codes (MovieBox often returns these bare)
    "en": "English",
    "pt": "Portuguese", "pt-br": "Portuguese", "pt-pt": "Portuguese",
    // MovieBox lanName variants: no hyphen, e.g. "ptbr", "eses"
    "ptbr": "Portuguese", "ptpt": "Portuguese",
    "es": "Spanish",    "es-la": "Spanish",    "es-es": "Spanish",    "es-419": "Spanish",
    "esla": "Spanish",  "eses": "Spanish",
    "fr": "French",     "fr-fr": "French",     "fr-ca": "French",
    "frfr": "French",   "frca": "French",
    "de": "German",     "de-de": "German",     "dede": "German",
    "it": "Italian",    "it-it": "Italian",    "itit": "Italian",
    "ar": "Arabic",     "ar-sa": "Arabic",     "arsa": "Arabic",
    "ru": "Russian",    "ru-ru": "Russian",    "ruru": "Russian",
    "zh": "Chinese",    "zh-cn": "Chinese",    "zh-tw": "Chinese",
    "zhcn": "Chinese",  "zhtw": "Chinese",
    "ja": "Japanese",   "ja-jp": "Japanese",   "jajp": "Japanese",
    "ko": "Korean",     "ko-kr": "Korean",     "kokr": "Korean",
    "hi": "Hindi",      "hi-in": "Hindi",      "hiin": "Hindi",
    "bn": "Bengali",    "ta": "Tamil",         "te": "Telugu",
    "tr": "Turkish",    "tr-tr": "Turkish",    "trtr": "Turkish",
    "nl": "Dutch",      "nl-nl": "Dutch",      "nlnl": "Dutch",
    "pl": "Polish",     "pl-pl": "Polish",     "plpl": "Polish",
    "id": "Indonesian", "ms": "Malay",
    "th": "Thai",       "vi": "Vietnamese",
    "sv": "Swedish",    "no": "Norwegian",     "da": "Danish",
    "fi": "Finnish",    "hu": "Hungarian",     "cs": "Czech",
    "ro": "Romanian",   "uk": "Ukrainian",
  };
  // Strip trailing " dub" / " audio" / " dubbed" variants BEFORE lookup so
  // MovieBox lanName values like "ptbr dub" → "ptbr" → "Portuguese".
  const strippedLang = rawLang.replace(/\s*(dub(bed)?|audio)\s*$/i, "").trim();
  const normalizedLang = BCP47_NAMES[strippedLang.toLowerCase()] ?? strippedLang;
  // Final label: if it still contains "dub" (e.g. a custom label) replace it with "Audio"
  const langLabel = normalizedLang.replace(/\bdub\b/i, "Audio").trim();
  const base = apiBase(req);
  const params = `u=${encodeParam(stream.url)}` + (stream.signCookie ? `&c=${encodeParam(stream.signCookie)}` : "");

  const proxyUrl = sType === "dash"
    ? `${base}/stream.m3u8?${params}`
    : `${base}/proxy?${params}`;

  const stremioSubs = (subtitles ?? []).map((s) => ({
    url: s.url,
    lang: s.lang,
    id: s.lang,
  }));

  // Detect HEVC/H.265 — MovieBox CDN only serves H.265 DASH (no H.264 fallback).
  // Label it so users on clients that cannot decode HEVC (LG WebOS, older web players)
  // know why playback fails. "hev1" / "hvc1" in the MPD and "hevc" in codecName both
  // indicate H.265. Set notWebReady so Stremio web/TV clients skip these by default.
  const codec = stream.codecName?.toLowerCase() ?? "";
  const isHevc = codec === "hevc" || codec === "h265" || codec === "hvc1" || codec === "hev1";
  const codecLabel = isHevc ? "HEVC" : "";
  const titleParts = [qLabel, codecLabel, langLabel].filter(Boolean);

  return {
    name: "MovieBox",
    title: titleParts.join(" · "),
    url: proxyUrl,
    subtitles: stremioSubs,
    behaviorHints: { notWebReady: false },
  };
}

function titleVariants(title: string, year?: number): string[] {
  const variants: string[] = [title];
  const t = title.trim();

  // Article stripping: "The Detour" → "Detour"
  const noArticle = t.replace(/^(the|a|an)\s+/i, "");
  if (noArticle !== t) variants.push(noArticle);

  // Subtitle stripping: "Title: Subtitle" → "Title"
  const noSubtitle = t.replace(/\s*[:\-–]\s+.+$/, "");
  if (noSubtitle !== t && noSubtitle.length > 2) variants.push(noSubtitle);

  const noSubNoArt = noSubtitle.replace(/^(the|a|an)\s+/i, "");
  if (noSubNoArt !== noSubtitle && noSubNoArt !== noArticle && noSubNoArt.length > 2)
    variants.push(noSubNoArt);

  // First 3 words of long titles
  const words = t.split(/\s+/);
  if (words.length > 3) variants.push(words.slice(0, 3).join(" "));

  // Collapsed form: remove ALL spaces and hyphens → "Shin Chan" → "ShinChan"
  // Catches providers that store "Shin Chan" as "Shinchan" (one compound word).
  const collapsed = t.replace(/[-\s]+/g, "");
  if (collapsed !== t && collapsed.length > 3) variants.push(collapsed);

  // Hyphen removal: "Crayon Shin-chan" → "Crayon Shinchan", "Spider-Man" → "SpiderMan"
  const noHyphens = t.replace(/-/g, "");
  if (noHyphens !== t && noHyphens !== collapsed && noHyphens.length > 2) variants.push(noHyphens);

  // Hyphen-to-space: "Spider-Man" → "Spider Man" (some sites store it with a space)
  const hyphenToSpace = t.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (hyphenToSpace !== t && hyphenToSpace !== noHyphens && hyphenToSpace.length > 2)
    variants.push(hyphenToSpace);

  // Drop first word — helps "Crayon Shin-chan" (2 words, has hyphen) → "Shin-chan" → "Shinchan".
  // For non-hyphenated titles, require 3+ words so "Shin Chan" never produces the junk variant "Chan".
  const minWordsForDrop = t.includes("-") ? 2 : 3;
  if (words.length >= minWordsForDrop) {
    const dropFirst = words.slice(1).join(" ");
    if (dropFirst.length > 2 && !variants.includes(dropFirst)) variants.push(dropFirst);
    // drop-first + no hyphens: "Crayon Shin-chan" → "Shinchan"
    const dropFirstNoHyphen = dropFirst.replace(/-/g, "");
    if (dropFirstNoHyphen !== dropFirst && dropFirstNoHyphen.length > 2 && !variants.includes(dropFirstNoHyphen))
      variants.push(dropFirstNoHyphen);
  }

  // Year-qualified search — helps disambiguate common titles
  if (year && year > 1900) variants.push(`${t} ${year}`);

  return [...new Set(variants)];
}

function scoreResults(
  results: MBSubject[],
  title: string,
  query: string,
  targetType: number,
  year: number | undefined,
): Array<MBSubject & { score: number }> {
  return results.map((r) => {
    let score = 0;
    const rTitle = r.title.toLowerCase().trim();
    const qTitle = title.toLowerCase().trim();
    const qQuery = query.toLowerCase().trim();
    if (rTitle === qTitle) score += 60;
    else if (rTitle === qQuery) score += 50;
    // Collapsed-form: "Shinchan" ↔ "Shin Chan" / "Shin-chan" — remove spaces/hyphens and compare
    else if (rTitle.replace(/[\s-]/g, "") === qTitle.replace(/[\s-]/g, "")) score += 55;
    else if (rTitle.replace(/[\s-]/g, "") === qQuery.replace(/[\s-]/g, "")) score += 45;
    else if (rTitle.includes(qTitle) || qTitle.includes(rTitle)) score += 25;
    else if (rTitle.includes(qQuery) || qQuery.includes(rTitle)) score += 15;
    // Type match is critical — correct type gets a bonus, wrong type gets a penalty.
    // Without this, an exact-title movie would outscore a partial-title series (60 vs 40).
    if (r.subjectType === targetType) score += 15;
    else score -= 25;
    if (year && r.imdbRating) score += 2;
    return { ...r, score };
  }).sort((a, b) => b.score - a.score);
}

// Returns an ordered list of candidate subjects (best score first, deduplicated).
// Each entry carries its score so callers can apply a score-gap filter and prevent
// the "Detour → Office" class of mismatch: if the correct title is a MovieBox stub
// with no streams, we must NOT fall through to a low-scored unrelated title.
async function resolveSubjectCandidates(
  title: string,
  year: number | undefined,
  isSeries: boolean,
  logKey: string,
): Promise<Array<{subjectId: string; score: number; title: string}>> {
  const targetType = isSeries ? 2 : 1;
  const variants = titleVariants(title, year);
  // Map subjectId → {best score, title} — title is preserved for IMDB cross-checking
  const seen = new Map<string, {score: number; title: string}>();

  for (let vi = 0; vi < variants.length; vi++) {
    const query = variants[vi]!;
    // Search up to 3 pages for the primary (un-transformed) query; 1 page for variants
    const pagesToSearch = vi === 0 ? [1, 2, 3] : [1];

    for (const page of pagesToSearch) {
      const results = await searchMovieBox(query, page);
      if (!results.length) break;

      const scored = scoreResults(results as MBSubject[], title, query, targetType, year);
      // Only collect candidates with score ≥ 10 (type-only match = 15, so this keeps plausible entries)
      const candidates = scored.filter((s) => s.score >= 10);
      if (candidates.length > 0) {
        for (const c of candidates) {
          // Keep the highest score for each id in case we see it via multiple queries
          const prev = seen.get(c.subjectId);
          if (!prev || c.score > prev.score) seen.set(c.subjectId, { score: c.score, title: c.title });
          if (seen.size >= 8) break;
        }
        logResolve({
          imdbId: logKey,
          step: "moviebox-search",
          status: "ok",
          detail: `top="${candidates[0]!.title}" id=${candidates[0]!.subjectId} score=${candidates[0]!.score} candidates=${seen.size} query="${query}" page=${page}`,
        });
        // Strong match found — no need to try further variant queries
        if (candidates[0]!.score >= 50) {
          return [...seen.entries()]
            .map(([subjectId, {score, title: t}]) => ({ subjectId, score, title: t }))
            .sort((a, b) => b.score - a.score);
        }
        // Found some candidates from this page; stop paging this variant but keep trying other variants
        break;
      }
    }
  }

  if (seen.size === 0) {
    logResolve({ imdbId: logKey, step: "moviebox-search", status: "fail", detail: `No match for "${title}" after ${variants.length} variants` });
    return [];
  }

  return [...seen.entries()]
    .map(([subjectId, {score, title: t}]) => ({ subjectId, score, title: t }))
    .sort((a, b) => b.score - a.score);
}

async function fetchMovieBoxById(
  subjectId: string,
  season: number,
  episode: number,
  req: Request,
  logKey: string,
): Promise<Record<string, unknown>[]> {
  const { token, dubs } = await getSubjectDetails(subjectId);
  logResolve({ imdbId: logKey, step: "subject-details", status: "ok", detail: `token=${!!token} dubs=${dubs.map((d) => d.lanName).join(",") || "none"}` });

  const allSubjects = [
    { subjectId, language: "Original" },
    ...dubs.map((d) => ({ subjectId: d.subjectId, language: d.lanName })),
  ];

  const results: Record<string, unknown>[] = [];
  for (const { subjectId: sid, language } of allSubjects) {
    const streams = await getPlayInfo(sid, season, episode, token);
    logResolve({ imdbId: logKey, step: "play-info", status: streams.length ? "ok" : "fail", detail: `lang=${language} streams=${streams.length}` });

    // Fetch captions in parallel for all streams in this language track
    const captionResults = await Promise.allSettled(
      streams.map((stream) => getExtCaptions(sid, stream.id, token))
    );

    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i]!;
      const capResult = captionResults[i];
      const caps = capResult?.status === "fulfilled" ? capResult.value : [];
      const s = mbStreamToStremio(stream, language, req, caps);
      if (s) results.push(s);
    }
  }

  return results;
}

async function getMovieBoxStreams(
  meta: ResolvedMeta,
  season: number,
  episode: number,
  req: Request,
  logKey: string,
): Promise<Record<string, unknown>[]> {
  try {
    const isSeries = meta.type === "series";
    const mbSeason = isSeries ? season : 0;
    const mbEpisode = isSeries ? episode : 0;

    let candidates = await resolveSubjectCandidates(meta.title, meta.year, isSeries, logKey);

    if (!candidates.length && meta.aliases.length) {
      for (const alias of meta.aliases.slice(0, 3)) {
        const altCandidates = await resolveSubjectCandidates(alias, meta.year, isSeries, logKey);
        if (altCandidates.length) { candidates = altCandidates; break; }
      }
    }

    if (!candidates.length) {
      logger.warn({ title: meta.title }, "MovieBox: subject not found");
      return [];
    }

    // ── Score-gap filter ─────────────────────────────────────────────────────
    // Prevent the "Detour → Office" class of mismatch:
    //   When the top candidate is the correct title (e.g. "Detour", score 75)
    //   but is a MovieBox stub with no streams, we must NOT fall through to a
    //   low-scored unrelated title (e.g. "The Office", score 15 — only type pts).
    //
    // Rule: never try a candidate whose score is more than 40 points below the
    // top AND whose absolute score is below 35.  This still allows legitimate
    // stub→playable fallbacks like "Shin Chan" (70) → "Shinchan" (75) because
    // both are above the floor, while blocking type-only matches (15) entirely.
    const topScore = candidates[0].score;
    // Absolute floor: candidates below 35 are type-only or weak partial matches.
    // Gap floor: never drop more than 40 points from the top to avoid lateral mismatches.
    const minScore = Math.max(35, topScore - 40);
    const filteredCandidates = candidates.filter((c) => c.score >= minScore);

    logger.info(
      { title: meta.title, topScore, minScore, total: candidates.length, filtered: filteredCandidates.length },
      "MovieBox: candidate filter",
    );

    // Try each candidate in score order — stop on the first that returns streams.
    for (const { subjectId, title: candidateTitle } of filteredCandidates) {
      // IMDB ID cross-check: verify this candidate's title maps to the expected IMDB ID
      // via TMDB. Skips on confirmed mismatch; passes through on unknown (null) safely.
      if (meta.imdbId.startsWith("tt")) {
        const resolvedId = await tmdbTitleToImdbId(
          candidateTitle,
          meta.year ?? undefined,
          isSeries ? "series" : "movie",
        ).catch(() => null);
        if (resolvedId && resolvedId !== meta.imdbId) {
          logger.info(
            { expectedImdbId: meta.imdbId, resolvedId, candidateTitle },
            "MovieBox: IMDB ID mismatch — skipping candidate",
          );
          continue;
        }
      }
      const streams = await fetchMovieBoxById(subjectId, mbSeason, mbEpisode, req, logKey);
      if (streams.length > 0) return streams;
    }
    return [];
  } catch (err) {
    logger.error({ err, imdbId: meta.imdbId }, "MovieBox: provider error");
    return [];
  }
}

// ─── RareAnime helpers ────────────────────────────────────────────────────────

async function withTimeoutRA<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function normaliseRAEpisodeNumbers(eps: RAEpisodeLink[]): RAEpisodeLink[] {
  if (eps.length === 0) return eps;
  const sorted = [...eps].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const minEp = sorted[0].episodeNumber;
  if (minEp > 100) {
    return sorted.map((ep, idx) => ({ ...ep, episodeNumber: idx + 1, title: `Episode ${idx + 1}` }));
  }
  return sorted;
}

function parseRareanimeStreamId(rawId: string): { baseSlug: string; season: number; episodeNum: number } | null {
  const without = rawId.replace(/^rareanime:/, "");
  const parts = without.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])) {
    const episodeNum = parseInt(parts[parts.length - 1], 10);
    const season = parseInt(parts[parts.length - 2], 10);
    const baseSlug = parts.slice(0, -2).join(":");
    return { baseSlug, season, episodeNum };
  }
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    const episodeNum = parseInt(parts[parts.length - 1], 10);
    const baseSlug = parts.slice(0, -1).join(":");
    return { baseSlug, season: 1, episodeNum };
  }
  return { baseSlug: without, season: 1, episodeNum: 1 };
}

async function resolveRAEpisodeStream(
  episodes: RAEpisodeLink[],
  episodeNum: number,
  pageUrl: string,
  addonBase: string
): Promise<Record<string, unknown> | null> {
  let candidates = episodes.filter((e) => e.episodeNumber === episodeNum);
  if (candidates.length === 0 && episodeNum >= 1 && episodeNum <= episodes.length) {
    candidates = [episodes[episodeNum - 1]];
  }
  if (candidates.length === 0) return null;

  let argonId: string | null = null;
  let resolvedEp = candidates[0];

  for (const candidate of candidates) {
    const id = await resolveCodedewToArgonId(candidate.codedewUrl);
    if (id) { argonId = id; resolvedEp = candidate; break; }
  }

  if (!argonId) return null;

  const streamResult = await extractStreamFromArgon(argonId, pageUrl);
  if (!streamResult?.url) return null;

  // Encode session cookies so the HLS proxy can forward them to the CDN.
  // The argon embed sets cookies that groovy.monster's CDN validates on
  // every m3u8 and segment request — without them the CDN returns 403.
  const ckEncoded = streamResult.cookies
    ? Buffer.from(streamResult.cookies, "utf8").toString("base64url")
    : "";

  const proxyUrl =
    `${addonBase}${BASE_PATH}/hls/master.m3u8` +
    `?url=${encodeURIComponent(streamResult.url)}` +
    `&ref=${encodeURIComponent("https://groovy.monster/")}` +
    (ckEncoded ? `&ck=${encodeURIComponent(ckEncoded)}` : "");

  return {
    url: proxyUrl,
    title: resolvedEp.title || `Episode ${episodeNum}`,
    name: "🌙 RareAnime [HLS]",
    behaviorHints: {
      notWebReady: false,
      bingeGroup: `rareanime-${raSlugFromUrl(pageUrl)}`,
    },
  };
}

async function getRareAnimeNativeStreams(
  rawId: string,
  type: string,
  req: Request
): Promise<Record<string, unknown>[]> {
  const addonBase = publicOrigin(req);

  // ── Atoon stream ─────────────────────────────────────────────────────────
  if (rawId.startsWith("atoon:")) {
    const parts = rawId.replace(/^atoon:/, "").split(":");
    const isOldFormat = /^\d+$/.test(parts[0]);
    let archiveId: number;
    let episodeNum: number;

    if (isOldFormat) {
      archiveId = parseInt(parts[0], 10);
      episodeNum = parts.length >= 2 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 1;
    } else {
      const showSlug = parts[0];
      const season = parts.length >= 3 ? parseInt(parts[1], 10) : 1;
      episodeNum = parts.length >= 3 ? parseInt(parts[2], 10) : (parts.length >= 2 ? parseInt(parts[1], 10) : 1);
      await raBuildAtoonCatalog();
      const showSeasons = getAtoonShowSeasons(showSlug);
      const seasonEntry = showSeasons.find((s) => s.season === season);
      if (!seasonEntry) {
        logger.info({ showSlug, requestedSeason: season, availableSeasons: showSeasons.map((s) => s.season) }, "RareAnime/Atoon: requested season not available, skipping");
        return [];
      }
      archiveId = seasonEntry.archiveId;
    }

    const episodes = await getAtoonEpisodeLinks(archiveId);
    if (episodes.length === 0) return [];
    const archiveUrl = `https://store.animetoonhindi.com/archives/${archiveId}`;
    const stream = await resolveRAEpisodeStream(episodes, episodeNum, archiveUrl, addonBase);
    return stream ? [stream] : [];
  }

  // ── RareAnime stream ─────────────────────────────────────────────────────
  await raGetAllCatalogItems();
  const parsed = parseRareanimeStreamId(rawId);
  if (!parsed) return [];
  const { baseSlug, season, episodeNum } = parsed;

  const knownSeasons = getSeasonSlugs(baseSlug);
  const seasons = await withTimeoutRA(discoverAllSeasons(baseSlug, knownSeasons), 12_000) ?? knownSeasons;

  let targetSlug: string;
  if (seasons.length === 0) {
    targetSlug = baseSlug;
  } else {
    const entry = seasons.find((s: RASeasonEntry) => s.season === season);
    if (!entry) {
      // Requested season not found in RareAnime — return nothing rather than
      // silently falling back to season 1 and serving wrong episode content.
      logger.info({ baseSlug, requestedSeason: season, availableSeasons: seasons.map((s: RASeasonEntry) => s.season) }, "RareAnime: requested season not available, skipping");
      return [];
    }
    targetSlug = entry.slug;
  }

  const pageUrl = `https://www.rareanimes.buzz/hindi/${targetSlug}/`;
  const rawEps = await withTimeoutRA(raGetEpisodeLinks(pageUrl), 10_000) ?? [];
  const targetEp = type === "movie" ? 1 : episodeNum;
  const epInRare = rawEps.some((e: RAEpisodeLink) => e.episodeNumber === targetEp) || (targetEp >= 1 && targetEp <= rawEps.length);
  const needAtoon = rawEps.length === 0 || rawEps.length < 10 || !epInRare || rareBaseToAtoonSlug.has(baseSlug);

  let normAtoon: RAEpisodeLink[] = [];
  if (needAtoon) {
    let atoonRaw = await withTimeoutRA(findAndScrapeAtoonEpisodes(targetSlug), 12_000) ?? [];
    if (atoonRaw.length === 0) {
      atoonRaw = await withTimeoutRA(getAtoonEpsForBaseSlug(baseSlug, season), 12_000) ?? [];
    }
    if (atoonRaw.length > 0) normAtoon = normaliseRAEpisodeNumbers(atoonRaw);
  }

  const atoonIsBetter = (rawEps.length < 5 && normAtoon.length > rawEps.length) || !epInRare;

  if (normAtoon.length > 0 && atoonIsBetter) {
    const stream = await resolveRAEpisodeStream(normAtoon, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  if (rawEps.length > 0) {
    const normalised = normaliseRAEpisodeNumbers(rawEps);
    const stream = await resolveRAEpisodeStream(normalised, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  if (normAtoon.length > 0 && !atoonIsBetter) {
    const stream = await resolveRAEpisodeStream(normAtoon, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  return [];
}

/**
 * Strip every non-alphanumeric character so titles like "Crayon Shin-chan"
 * and "Shinchan" collapse to the same token string ("crayonshinchan" ⊃ "shinchan").
 * This handles hyphens, colons, apostrophes and other punctuation differences
 * between Cinemeta/TMDB titles and the short names used on rareanimes.buzz.
 */
function tokeniseRA(s: string): string {
  // Normalize accents (é→e, ō→o, etc.) before stripping so "Pokémon" → "pokemon"
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Title-based lookup: try to match a resolved title against the rareanime catalog and return streams */
async function getRareAnimeStreamsByTitle(
  title: string,
  type: string,
  season: number,
  episode: number,
  req: Request,
  aliases: string[] = [],
): Promise<Record<string, unknown>[]> {
  try {
    const titleTok = tokeniseRA(title);
    const aliasToks = aliases.map(tokeniseRA).filter(Boolean);

    /** Returns true if the catalog entry name matches this request's title or any alias */
    const isMatch = (catName: string): boolean => {
      const catTok = tokeniseRA(catName);
      if (!catTok) return false;
      // catTok.startsWith(titleTok): "narutoallseasonhindi".startsWith("naruto") ✓
      //   but NOT "borutonarutonext...".startsWith("naruto") — prevents wrong matches
      // titleTok.includes(catTok): "crayonshinchan".includes("shinchan") ✓ — title is more specific
      if (catTok === titleTok || catTok.startsWith(titleTok) || titleTok.includes(catTok)) return true;
      for (const aTok of aliasToks) {
        if (aTok && (catTok === aTok || catTok.startsWith(aTok) || aTok.includes(catTok))) return true;
      }
      return false;
    };

    const [allMetas, atoonItems] = await Promise.all([
      withTimeoutRA(raGetAllCatalogItems(), 15_000),
      withTimeoutRA(raBuildAtoonCatalog(), 15_000),
    ]);

    // "All movies" collection entries (e.g. "Doraemon All Movies") must NOT be matched
    // for series episode requests.  Both catalog types can be "series" on rareanimes.buzz,
    // so we rely on name content rather than the type field.
    const isMovieColl = (name: string) => /\ball\s*movies?\b|\bmovies?\s*collection\b/i.test(name);
    const notMovieColl = (name: string) => type !== "series" || !isMovieColl(name);

    // Pass 1: exact token match (skip movie-collections for series); Pass 2: same without skip;
    // Pass 3: fuzzy startsWith match (skip movie-collections for series); Pass 4: fuzzy no-skip.
    const rareMatch =
      (allMetas ?? []).find((m: RACatalogMeta) => tokeniseRA(m.name) === titleTok && notMovieColl(m.name)) ||
      (allMetas ?? []).find((m: RACatalogMeta) => tokeniseRA(m.name) === titleTok) ||
      (allMetas ?? []).find((m: RACatalogMeta) => isMatch(m.name) && notMovieColl(m.name)) ||
      (allMetas ?? []).find((m: RACatalogMeta) => isMatch(m.name));
    const atoonMatch =
      (atoonItems ?? []).find((m) => tokeniseRA(m.name) === titleTok && notMovieColl(m.name)) ||
      (atoonItems ?? []).find((m) => tokeniseRA(m.name) === titleTok) ||
      (atoonItems ?? []).find((m) => isMatch(m.name) && notMovieColl(m.name)) ||
      (atoonItems ?? []).find((m) => isMatch(m.name));

    const matchedId = rareMatch?.id || atoonMatch?.id;
    if (!matchedId) {
      logger.info({ title, titleTok, aliasCount: aliasToks.length }, "RareAnime: no title match in catalog");
      return [];
    }

    const newId = type === "series" ? `${matchedId}:${season}:${episode}` : matchedId;
    logger.info({ title, matchedId, newId }, "RareAnime: title match found");
    return getRareAnimeNativeStreams(newId, type, req);
  } catch (err) {
    logger.error({ err, title }, "RareAnime: title-based stream error");
    return [];
  }
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function dedup(streams: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return streams.filter((s) => {
    const url = s["url"] as string;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// ─── Cross-provider subtitle merge ───────────────────────────────────────────
// After all providers are queried, collect every subtitle track that any stream
// returned and attach them to ALL streams.  A stream's own subtitles appear
// first (= Stremio default), then every other provider's tracks are appended
// so users can switch regardless of which video source they picked.

interface SubEntry { url: string; lang: string; id: string }

function mergeSubtitles(streams: Record<string, unknown>[]): Record<string, unknown>[] {
  // Step 1 — gather every unique subtitle across all streams
  const globalSubs: SubEntry[] = [];
  const seenUrls = new Set<string>();

  for (const s of streams) {
    const subs = s["subtitles"] as Array<Partial<SubEntry>> | undefined;
    if (!subs?.length) continue;
    for (const sub of subs) {
      if (!sub.url || seenUrls.has(sub.url)) continue;
      seenUrls.add(sub.url);
      globalSubs.push({
        url:  sub.url,
        lang: sub.lang ?? "Unknown",
        id:   sub.id   ?? `sub-${globalSubs.length}`,
      });
    }
  }

  if (!globalSubs.length) return streams; // no subtitles in any stream — nothing to do

  // Step 2 — for every stream: own subs first (default), rest appended
  return streams.map((s) => {
    const ownRaw = (s["subtitles"] as Array<Partial<SubEntry>> | undefined) ?? [];
    const ownUrls = new Set(ownRaw.filter((x) => x.url).map((x) => x.url!));
    const own: SubEntry[] = ownRaw
      .filter((x) => x.url)
      .map((x, i) => ({ url: x.url!, lang: x.lang ?? "Unknown", id: x.id ?? `own-${i}` }));
    const rest = globalSubs.filter((sub) => !ownUrls.has(sub.url));
    return { ...s, subtitles: [...own, ...rest] };
  });
}

// ─── Premium stream formatter ─────────────────────────────────────────────────
// Applies rich emoji-formatted titles to all streams before returning them.
// Preserves the provider's stream `name` (badge) and rewrites `title` with
// structured metadata so Stremio's popover shows nicely formatted info.
// Also removes the legacy `description` field so Stremio only uses `title`.
function premiumFormat(
  streams: Record<string, unknown>[],
  contentName: string,
  contentType: string,
  season: number,
  episode: number,
): Record<string, unknown>[] {
  return streams.map((s) => {
    const rawName  = String(s["name"]        ?? "");
    const rawTitle = String(s["title"]       ?? "");
    const rawDesc  = String(s["description"] ?? "");
    // Scan all text fields so providers that store quality in `description`
    // (e.g. NetMirror: "1080p · server proxy") are correctly extracted.
    const combined = rawName + " " + rawTitle + " " + rawDesc;

    // Extract quality
    const qMatch = combined.match(/\b(2160p|4K|1080p|720p|480p|360p|SD)\b/i);
    const quality = qMatch ? qMatch[1]!.toUpperCase() : "";

    // Extract codec (HEVC/H.265 or H.264/AVC — HEVC matters for device compat)
    const isHevcTitle = /\b(HEVC|H\.265|x265|hvc1|hev1)\b/i.test(combined);
    const isAvcTitle  = /\b(H\.264|x264|AVC)\b/i.test(combined);
    const codecSuffix = isHevcTitle ? " HEVC" : isAvcTitle ? " H.264" : "";

    // Extract audio languages.
    // Scan rawTitle + rawDesc only — NOT rawName — because the badge name is
    // provider identity (e.g. "MeowTV — Hindi v2") not metadata, and scanning
    // it causes the greedy regex to incorrectly capture "Hindi v2 Hindi v2".
    const audioSearch = rawTitle + " " + rawDesc;
    const audioMatch = audioSearch.match(
      /\b(Hindi|English|Tamil|Telugu|Japanese|Bengali|Korean|Portuguese|Spanish|French|German|Italian|Arabic|Russian|Chinese|Turkish|Dutch|Polish|Indonesian|Malay|Thai|Vietnamese|Swedish|Norwegian|Danish|Finnish|Hungarian|Czech|Romanian|Ukrainian|Original(?:\s+Audio)?|Multi(?:[-\s]?Audio)?|Dual[-\s]?Audio)[^|·\n,]*/i,
    );
    const audio = audioMatch ? audioMatch[0].trim() : "";

    // Extract file size (e.g. "1.4 GB", "700 MB", "2.3 TB")
    const sizeMatch = combined.match(/\b([\d.]+\s*[KMGT]B)\b/i);
    const size = sizeMatch ? sizeMatch[1]!.trim() : "";

    // ── Extract server name ─────────────────────────────────────────────────
    // Priority order:
    //   1. "Provider — Server" pattern (MeowTV: "MeowTV — Lynx", "MeowTV — Hindi v2")
    //   2. Second line "Quality | Server" pattern (HDHub4U: "HDHub4U\n1080p | HubCloud")
    //   3. "Provider | Server" in name, right side (AnimeDekho: "AnimeDekho | Voe HLS")
    //   4. First word/phrase of title before a bracket/size (HindMoviez: "GDShine [850MB]")
    let server = "";

    // 1. " — Server" suffix in the stream badge name
    const dashMatch = rawName.match(/\s—\s(.+)$/);
    if (dashMatch) server = dashMatch[1]!.trim();

    // 2. Second line of multi-line name: "Quality | Server"
    if (!server) {
      const nameLines = rawName.split("\n");
      if (nameLines.length > 1) {
        const secondPart = nameLines.slice(1).join(" ");
        const pipeRight = secondPart.match(/\|\s*(.+)$/);
        if (pipeRight) server = pipeRight[1]!.trim();
      }
    }

    // 3. Single-line "Provider | Server" — take the right side
    if (!server) {
      const pipeParts = rawName.split(" | ");
      if (pipeParts.length >= 2) {
        // Right side may be "Voe HLS" or "BlakiteAPI 1080p" — use as-is
        server = pipeParts.slice(1).join(" | ").trim();
      }
    }

    // 4. Title's leading word/phrase before a size tag "[...]" or "(" — e.g. "GDShine [850MB]"
    if (!server && rawTitle) {
      const leadMatch = rawTitle.match(/^([A-Za-z][A-Za-z0-9\s\-]{1,30}?)\s*[\[(]/);
      if (leadMatch) server = leadMatch[1]!.trim();
    }

    // Build multi-line title
    const lines: string[] = [];
    if (contentName) {
      lines.push(`🎬 ${contentType === "series" ? "Series" : "Movie"}: ${contentName}`);
    }
    if (contentType === "series" && season && episode) {
      lines.push(`📺 Episode: S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
    }
    if (server)  lines.push(`🖥️ Server: ${server}`);
    if (audio)   lines.push(`🔊 Audio: ${audio}`);
    if (quality) lines.push(`🎥 Quality: ${quality}${codecSuffix}`);
    if (size)    lines.push(`💾 Size: ${size}`);
    lines.push("⚡ By @Master_si");

    // Remove `description` — it's the legacy Stremio field superseded by `title`.
    // Having both simultaneously can cause the stream to be hidden in some
    // Stremio clients (they treat it as a conflicting/malformed object).
    const { description: _drop, ...rest } = s;
    return { ...rest, title: lines.join("\n") };
  });
}

// ─── Subtitles endpoint ───────────────────────────────────────────────────────
// Searches OpenSubtitles.org (no API key required) by IMDB ID.
// Returns SRT files proxied through /subtitle-proxy so CORS + .gz decompression
// are handled server-side.

// Subtitle handler — shared by both route forms:
//   2-segment: /subtitles/:type/:id.json          (Stremio Android / desktop)
//   3-segment: /subtitles/:type/:id/*             (Stremio LG TV WebOS — appends stream URL as extra path)
// In both cases `:id` is already the bare IMDB/Stremio ID without .json suffix.
async function subtitlesHandler(req: import("express").Request, res: import("express").Response): Promise<void> {
  stremioHeaders(res);
  res.setHeader("Cache-Control", "max-age=21600"); // 6 h — subtitle lists are stable

  const { type, id } = req.params as { type: string; id: string };

  // Parse Stremio's ID format:
  //   movie  → "tt1234567"
  //   series → "tt1234567:season:episode"
  const parts = id.split(":");
  const imdbId = parts[0] as string;
  const season = parts[1] !== undefined ? parseInt(parts[1]!, 10) : null;
  const episode = parts[2] !== undefined ? parseInt(parts[2]!, 10) : null;

  if (!imdbId.startsWith("tt")) {
    res.json({ subtitles: [] });
    return;
  }

  try {
    // Provider subtitles: collected when stream endpoint ran (works for all Stremio clients)
    // YIFYsubtitles: searched on demand (additional SRT sources)
    const [providerSubs, yifyResults] = await Promise.all([
      Promise.resolve(getProviderSubtitles(imdbId)),
      searchSubtitles(
        imdbId,
        type === "series" ? season : null,
        type === "series" ? episode : null,
      ),
    ]);

    // Pick top 2 per language from YIFY to avoid overwhelming the subtitle menu
    const byLang = new Map<string, typeof yifyResults>();
    for (const r of yifyResults) {
      if (!byLang.has(r.langCode)) byLang.set(r.langCode, []);
      byLang.get(r.langCode)!.push(r);
    }

    const base = apiBase(req);
    const yifySubs = [...byLang.values()].flatMap((group) =>
      group.slice(0, 2).map((r, i) => ({
        id: `os-${r.fileId}-${i}`,
        url: `${base}/subtitle-proxy?url=${Buffer.from(r.downloadUrl).toString("base64url")}`,
        lang: r.language,
      })),
    );

    // Provider subs first (from MovieBox, DooFlix, etc.), YIFY subs appended.
    // De-duplicate by URL so the same sub doesn't appear twice.
    const seenUrls = new Set(providerSubs.map((s) => s.url));
    const uniqueYify = yifySubs.filter((s) => !seenUrls.has(s.url));
    const subtitles = [...providerSubs, ...uniqueYify];

    logger.info({ imdbId, season, episode, provider: providerSubs.length, yify: yifySubs.length, total: subtitles.length }, "Stremio: subtitles");
    res.json({ subtitles });
  } catch (err) {
    logger.error({ err, id }, "Stremio: subtitle error");
    res.json({ subtitles: [] });
  }
}

// 2-segment form: /subtitles/:type/:id.json  (Android / desktop / web)
router.get("/subtitles/:type/:id.json", subtitlesHandler);
// 3-segment form: /subtitles/:type/:id/:extra.json
// LG TV WebOS appends the playing stream URL as a 3rd path segment ending in .json,
// e.g. /subtitles/movie/tt16431404/filename=m3u8%3Furl%3D...master.m3u8....json
// `:extra` captures and discards the stream-context info; `:id` is still the IMDB ID.
router.get("/subtitles/:type/:id/:extra.json", subtitlesHandler);

// ─── Stream endpoint ──────────────────────────────────────────────────────────

router.get("/stream/:type/:id.json", async (req, res) => {
  stremioHeaders(res);
  res.setHeader("Cache-Control", "max-age=60");
  const { type, id } = req.params;
  logger.info({ type, id }, "Stremio: stream request");

  try {
    // ── Native rareanime: / atoon: IDs ───────────────────────────────────────
    if (id.startsWith("rareanime:") || id.startsWith("atoon:")) {
      try {
        const streams = await getRareAnimeNativeStreams(id, type, req);
        logger.info({ id, count: streams.length }, "Stremio: rareanime native streams");
        res.json({ streams });
      } catch (err) {
        logger.error({ err, id }, "RareAnime: native stream error");
        res.json({ streams: [] });
      }
      return;
    }

    // ── Native animedekho: IDs — AnimeDekho native + AnimeSalt by title ──────
    if (id.startsWith("animedekho:")) {
      const seMatch = id.match(/:(\d+):(\d+)$/);
      const season = seMatch ? parseInt(seMatch[1]!) : 1;
      const episode = seMatch ? parseInt(seMatch[2]!) : 1;
      const bareId = seMatch ? id.slice(0, id.lastIndexOf(`:${seMatch[1]}:`)) : id;

      const [adResult, saltResult] = await Promise.allSettled([
        getAnimeDekhoNativeStreams(bareId, type, season, episode),
        animeDekhoGetMeta(bareId).then(async (meta) => {
          if (!meta?.title) return [];
          const mediaType = type === "series" ? "series" : "movie";
          // Use title-based lookup — animedekho: IDs have no IMDB ID to pass to getStreams
          const saltStreams = await animesaltGetStreamsByTitle(String(meta.title), mediaType, season, episode).catch(() => []);
          const saltBase = apiBase(req);
          return saltStreams.map((s) => {
            if (!saltBase) return { name: s.name, title: s.title, url: s.url, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
            if (s.hash && s.playerCdn) {
              const relayUrl = `${saltBase}/as-relay?hash=${encodeURIComponent(s.hash)}&player=${encodeParam(s.playerCdn)}`;
              prewarmAsRelay(s.hash, s.playerCdn, saltBase);
              return { name: s.name, title: s.title, url: relayUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
            }
            const proxiedUrl = `${saltBase}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}&origin=${encodeURIComponent(s.origin)}`;
            return { name: s.name, title: s.title, url: proxiedUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
          });
        }),
      ]);

      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const saltStreams = saltResult.status === "fulfilled" ? saltResult.value : [];

      if (adResult.status === "rejected") logger.error({ err: adResult.reason, id }, "AnimeDekho: native crashed");
      if (saltResult.status === "rejected") logger.error({ err: saltResult.reason, id }, "AnimeSalt (from animedekho): crashed");

      const combined = mergeSubtitles(dedup([...adStreams, ...saltStreams]));
      logger.info({ id, ad: adStreams.length, salt: saltStreams.length, combined: combined.length }, "Stremio: animedekho combined");
      res.json({ streams: combined });
      return;
    }

    // ── IMDB IDs — all 6 providers ────────────────────────────────────────────
    if (id.startsWith("tt")) {
      const parts = id.split(":");
      const imdbId = parts[0]!;
      const contentType = type as "movie" | "series";
      const season = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;

      const ckey = streamCacheKey(imdbId, type, season, episode);
      const cached = getStreamCache(ckey);
      if (cached) { res.json({ streams: cached }); return; }

      const meta = await resolveMeta(imdbId, contentType);
      if (!meta) {
        logger.warn({ imdbId }, "Stremio: meta resolution failed");
        res.json({ streams: [] });
        return;
      }

      logger.info({ imdbId, title: meta.title, year: meta.year }, "Stremio: IMDB — querying 13 providers");
      logResolve({ imdbId, step: "resolve", status: "ok", detail: `${meta.title} (${meta.year})` });

      const sfTmdbId = await imdbToTmdbId(imdbId, type).catch(() => null);

      const ep = getEnabledProviders(req as RequestWithConfig);
      const isSeries = type === "series" && season !== undefined && episode !== undefined;
      const [asResult, raResult, adResult, nmResult, sfResult, dfResult, ctResult, mbResult, mwResult, dmResult, hmResult, fkResult, hdResult] = await Promise.allSettled([
        ep.has("animesalt") ? getAnimeSaltStreams(imdbId, type, season, episode, req) : Promise.resolve([]),
        ep.has("rareanime") ? getRareAnimeStreamsByTitle(meta.title, type, season, episode, req, meta.aliases) : Promise.resolve([]),
        ep.has("animedekho") ? getAnimeDekhoStreams(meta.title, type, season, episode) : Promise.resolve([]),
        ep.has("netmirror") ? fetchNetmirrorStreams(type as "movie" | "series", imdbId, season, episode, req) : Promise.resolve([]),
        ep.has("streamflix") ? getStreamflixStreams(sfTmdbId, type, season, episode) : Promise.resolve([]),
        ep.has("dooflix") ? getDooflixStreams(apiBase(req), imdbId, type, season, episode) : Promise.resolve([]),
        ep.has("castletv") ? getCastleTvStreams(imdbId, type, meta.title, meta.year, season, episode) : Promise.resolve([]),
        ep.has("moviebox") ? getMovieBoxStreams(meta, season, episode, req, imdbId) : Promise.resolve([]),
        ep.has("meowtv") ? getMeowTvStreams(type as "movie" | "series", imdbId, season, episode, apiBase(req)) : Promise.resolve([]),
        ep.has("dahmermovies") ? getDahmerMoviesStreams(meta.title, meta.year, type, season, episode, req, imdbId) : Promise.resolve([]),
        ep.has("hindmovies") ? hindmoviezGetStreams(type as "movie" | "series", imdbId, season, episode) : Promise.resolve([]),
        ep.has("fourkdhub") ? (isSeries ? getFourkdHubSeriesStreams(meta.title, season!, episode!, imdbId) : getFourkdHubStreams(meta.title, type, imdbId)) : Promise.resolve([]),
        ep.has("hdhub4u") ? (isSeries ? getHDHub4USeriesStreams(meta.title, season!, episode!, imdbId) : getHDHub4UStreams(meta.title, type, imdbId)) : Promise.resolve([]),
      ]);

      const asStreams = asResult.status === "fulfilled" ? asResult.value : [];
      const raStreams = raResult.status === "fulfilled" ? raResult.value : [];
      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const nmStreams = nmResult.status === "fulfilled" ? nmResult.value : [];
      const sfStreams = sfResult.status === "fulfilled" ? sfResult.value : [];
      const dfStreams = (dfResult.status === "fulfilled" ? dfResult.value : []) as DooflixStream[];
      const ctStreams = ctResult.status === "fulfilled" ? ctResult.value : [];
      const mbStreams = mbResult.status === "fulfilled" ? mbResult.value : [];
      const mwStreams = mwResult.status === "fulfilled" ? mwResult.value : [];
      const dmStreams = dmResult.status === "fulfilled" ? dmResult.value : [];
      const hmStreams = hmResult.status === "fulfilled" ? proxyHindMoviezStreams(hmResult.value, req) : [];
      const fkStreams = fkResult.status === "fulfilled" ? fkResult.value : [];
      const hdStreams = hdResult.status === "fulfilled" ? hdResult.value : [];

      if (asResult.status === "rejected") logger.error({ err: asResult.reason, imdbId }, "AnimeSalt: crashed");
      if (raResult.status === "rejected") logger.error({ err: raResult.reason, imdbId }, "RareAnime: crashed");
      if (adResult.status === "rejected") logger.error({ err: adResult.reason, imdbId }, "AnimeDekho: crashed");
      if (nmResult.status === "rejected") logger.error({ err: nmResult.reason, imdbId }, "NetMirror: crashed");
      if (sfResult.status === "rejected") logger.error({ err: sfResult.reason, imdbId }, "StreamFlix: crashed");
      if (dfResult.status === "rejected") logger.error({ err: dfResult.reason, imdbId }, "DooFlix: crashed");
      if (ctResult.status === "rejected") logger.error({ err: ctResult.reason, imdbId }, "CastleTV: crashed");
      if (mbResult.status === "rejected") logger.error({ err: mbResult.reason, imdbId }, "MovieBox: crashed");
      if (mwResult.status === "rejected") logger.error({ err: mwResult.reason, imdbId }, "MeowTV: crashed");
      if (dmResult.status === "rejected") logger.error({ err: dmResult.reason, imdbId }, "DahmerMovies: crashed");
      if (hmResult.status === "rejected") logger.error({ err: hmResult.reason, imdbId }, "HindMoviez: crashed");
      if (fkResult.status === "rejected") logger.error({ err: fkResult.reason, imdbId }, "4KHDHub: crashed");
      if (hdResult.status === "rejected") logger.error({ err: hdResult.reason, imdbId }, "HDHub4U: crashed");

      const raw = mergeSubtitles(dedup(([...asStreams, ...raStreams, ...adStreams, ...nmStreams, ...sfStreams, ...ctStreams, ...dfStreams, ...mbStreams, ...mwStreams, ...dmStreams, ...hmStreams, ...fkStreams, ...hdStreams]) as Record<string, unknown>[]));
      const combined = premiumFormat(raw, meta.title, contentType, season, episode);
      logger.info(
        { imdbId, title: meta.title, as: asStreams.length, ra: raStreams.length, ad: adStreams.length, nm: nmStreams.length, sf: sfStreams.length, df: dfStreams.length, ct: ctStreams.length, mb: mbStreams.length, mw: mwStreams.length, dm: dmStreams.length, hm: hmStreams.length, fk: fkStreams.length, hd: hdStreams.length, combined: combined.length },
        "Stremio: 13 providers aggregated",
      );
      logResolve({ imdbId, step: "done", status: combined.length ? "ok" : "fail", detail: `as=${asStreams.length} ra=${raStreams.length} ad=${adStreams.length} nm=${nmStreams.length} sf=${sfStreams.length} df=${dfStreams.length} ct=${ctStreams.length} mb=${mbStreams.length} mw=${mwStreams.length} dm=${dmStreams.length} hm=${hmStreams.length} fk=${fkStreams.length} hd=${hdStreams.length} total=${combined.length}` });

      // Cache provider subtitles for LG TV (uses /subtitles/ endpoint, not stream.subtitles[])
      const firstSubs = (combined[0]?.["subtitles"] as Array<{url:string;lang:string;id:string}> | undefined) ?? [];
      setProviderSubtitles(imdbId, firstSubs);

      setStreamCache(ckey, combined, TTL_MS_DEFAULT);
      res.json({ streams: combined });
      return;
    }

    // ── TMDB numeric IDs — all 6 providers ───────────────────────────────────
    if (id.startsWith("tmdb:")) {
      const parts = id.split(":");
      const numericTmdbId = parts[1]!;
      const contentType = type as "movie" | "series";
      const season = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;
      const episode = parts[3] !== undefined ? parseInt(parts[3], 10) : 1;

      const ckey = streamCacheKey(id, type, season, episode);
      const cached = getStreamCache(ckey);
      if (cached) { res.json({ streams: cached }); return; }

      const meta = await resolveMetaFromTmdbId(numericTmdbId, contentType);
      if (!meta) {
        logger.warn({ tmdbId: numericTmdbId }, "Stremio: TMDB meta resolution failed");
        res.json({ streams: [] });
        return;
      }

      logger.info({ tmdbId: numericTmdbId, imdbId: meta.imdbId, title: meta.title }, "Stremio: TMDB — querying 13 providers");
      logResolve({ imdbId: id, step: "resolve", status: "ok", detail: `${meta.title} (${meta.year}) imdb=${meta.imdbId}` });

      const hasImdb = meta.imdbId.startsWith("tt");
      const nmId = hasImdb ? meta.imdbId : id;

      const ep2 = getEnabledProviders(req as RequestWithConfig);
      const isSeries2 = type === "series" && season !== undefined && episode !== undefined;
      const [asResult, raResult, adResult, nmResult, sfResult, dfResult, ctResult, mbResult, mwResult, dmResult, hmResult, fkResult, hdResult] = await Promise.allSettled([
        (ep2.has("animesalt") && hasImdb) ? getAnimeSaltStreams(meta.imdbId, type, season, episode, req) : Promise.resolve([]),
        ep2.has("rareanime") ? getRareAnimeStreamsByTitle(meta.title, type, season, episode, req, meta.aliases) : Promise.resolve([]),
        ep2.has("animedekho") ? getAnimeDekhoStreams(meta.title, type, season, episode) : Promise.resolve([]),
        ep2.has("netmirror") ? fetchNetmirrorStreams(type as "movie" | "series", nmId, season, episode, req) : Promise.resolve([]),
        ep2.has("streamflix") ? getStreamflixStreams(numericTmdbId, type, season, episode) : Promise.resolve([]),
        (ep2.has("dooflix") && hasImdb) ? getDooflixStreams(apiBase(req), meta.imdbId, type, season, episode) : Promise.resolve([]),
        (ep2.has("castletv") && hasImdb) ? getCastleTvStreams(meta.imdbId, type, meta.title, meta.year, season, episode) : Promise.resolve([]),
        ep2.has("moviebox") ? getMovieBoxStreams(meta, season, episode, req, id) : Promise.resolve([]),
        (ep2.has("meowtv") && hasImdb) ? getMeowTvStreams(type as "movie" | "series", meta.imdbId, season, episode, apiBase(req)) : Promise.resolve([]),
        ep2.has("dahmermovies") ? getDahmerMoviesStreams(meta.title, meta.year, type, season, episode, req, hasImdb ? meta.imdbId : undefined) : Promise.resolve([]),
        (ep2.has("hindmovies") && hasImdb) ? hindmoviezGetStreams(type as "movie" | "series", meta.imdbId, season, episode) : Promise.resolve([]),
        ep2.has("fourkdhub") ? (isSeries2 ? getFourkdHubSeriesStreams(meta.title, season!, episode!, hasImdb ? meta.imdbId : undefined) : getFourkdHubStreams(meta.title, type, hasImdb ? meta.imdbId : undefined)) : Promise.resolve([]),
        ep2.has("hdhub4u") ? (isSeries2 ? getHDHub4USeriesStreams(meta.title, season!, episode!, hasImdb ? meta.imdbId : undefined) : getHDHub4UStreams(meta.title, type, hasImdb ? meta.imdbId : undefined)) : Promise.resolve([]),
      ]);

      const asStreams = asResult.status === "fulfilled" ? asResult.value : [];
      const raStreams = raResult.status === "fulfilled" ? raResult.value : [];
      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const nmStreams = nmResult.status === "fulfilled" ? nmResult.value : [];
      const sfStreams = sfResult.status === "fulfilled" ? sfResult.value : [];
      const dfStreams = (dfResult.status === "fulfilled" ? dfResult.value : []) as DooflixStream[];
      const ctStreams = ctResult.status === "fulfilled" ? ctResult.value : [];
      const mbStreams = mbResult.status === "fulfilled" ? mbResult.value : [];
      const mwStreams = mwResult.status === "fulfilled" ? mwResult.value : [];
      const dmStreams = dmResult.status === "fulfilled" ? dmResult.value : [];
      const hmStreams = hmResult.status === "fulfilled" ? proxyHindMoviezStreams(hmResult.value, req) : [];
      const fkStreams = fkResult.status === "fulfilled" ? fkResult.value : [];
      const hdStreams = hdResult.status === "fulfilled" ? hdResult.value : [];

      if (asResult.status === "rejected") logger.error({ err: asResult.reason, tmdbId: numericTmdbId }, "AnimeSalt: crashed");
      if (raResult.status === "rejected") logger.error({ err: raResult.reason, tmdbId: numericTmdbId }, "RareAnime: crashed");
      if (adResult.status === "rejected") logger.error({ err: adResult.reason, tmdbId: numericTmdbId }, "AnimeDekho: crashed");
      if (nmResult.status === "rejected") logger.error({ err: nmResult.reason, tmdbId: numericTmdbId }, "NetMirror: crashed");
      if (sfResult.status === "rejected") logger.error({ err: sfResult.reason, tmdbId: numericTmdbId }, "StreamFlix: crashed");
      if (dfResult.status === "rejected") logger.error({ err: dfResult.reason, tmdbId: numericTmdbId }, "DooFlix: crashed");
      if (ctResult.status === "rejected") logger.error({ err: ctResult.reason, tmdbId: numericTmdbId }, "CastleTV: crashed");
      if (mbResult.status === "rejected") logger.error({ err: mbResult.reason, tmdbId: numericTmdbId }, "MovieBox: crashed");
      if (mwResult.status === "rejected") logger.error({ err: mwResult.reason, tmdbId: numericTmdbId }, "MeowTV: crashed");
      if (dmResult.status === "rejected") logger.error({ err: dmResult.reason, tmdbId: numericTmdbId }, "DahmerMovies: crashed");
      if (hmResult.status === "rejected") logger.error({ err: hmResult.reason, tmdbId: numericTmdbId }, "HindMoviez: crashed");
      if (fkResult.status === "rejected") logger.error({ err: fkResult.reason, tmdbId: numericTmdbId }, "4KHDHub: crashed");
      if (hdResult.status === "rejected") logger.error({ err: hdResult.reason, tmdbId: numericTmdbId }, "HDHub4U: crashed");

      const raw2 = mergeSubtitles(dedup(([...asStreams, ...raStreams, ...adStreams, ...nmStreams, ...sfStreams, ...ctStreams, ...dfStreams, ...mbStreams, ...mwStreams, ...dmStreams, ...hmStreams, ...fkStreams, ...hdStreams]) as Record<string, unknown>[]));
      const combined = premiumFormat(raw2, meta.title, contentType, season, episode);
      logger.info(
        { tmdbId: numericTmdbId, title: meta.title, as: asStreams.length, ra: raStreams.length, ad: adStreams.length, nm: nmStreams.length, sf: sfStreams.length, df: dfStreams.length, ct: ctStreams.length, mb: mbStreams.length, mw: mwStreams.length, dm: dmStreams.length, hm: hmStreams.length, fk: fkStreams.length, hd: hdStreams.length, combined: combined.length },
        "Stremio: TMDB 13 providers aggregated",
      );
      logResolve({ imdbId: id, step: "done", status: combined.length ? "ok" : "fail", detail: `as=${asStreams.length} ra=${raStreams.length} ad=${adStreams.length} nm=${nmStreams.length} sf=${sfStreams.length} df=${dfStreams.length} ct=${ctStreams.length} mb=${mbStreams.length} mw=${mwStreams.length} dm=${dmStreams.length} hm=${hmStreams.length} fk=${fkStreams.length} hd=${hdStreams.length} total=${combined.length}` });

      // Cache provider subtitles for LG TV using the resolved IMDB ID
      if (meta.imdbId?.startsWith("tt")) {
        const firstSubs2 = (combined[0]?.["subtitles"] as Array<{url:string;lang:string;id:string}> | undefined) ?? [];
        setProviderSubtitles(meta.imdbId, firstSubs2);
      }

      setStreamCache(ckey, combined, TTL_MS_DEFAULT);
      res.json({ streams: combined });
      return;
    }

    logger.warn({ id }, "Stremio: unrecognised ID format");
    res.json({ streams: [] });
  } catch (e) {
    logger.error({ err: e, id }, "Stremio: stream error");
    res.json({ streams: [] });
  }
});

// ─── DooFlix stream helper ─────────────────────────────────────────────────────

async function getDooflixStreams(
  proxyBase: string,
  imdbId: string,
  type: string,
  season: number,
  episode: number,
): Promise<DooflixStream[]> {
  if (!imdbId.startsWith("tt")) return [];
  if (type === "movie") return getDooflixMovieStreams(proxyBase, imdbId);
  return getDooflixSeriesStreams(proxyBase, imdbId, season, episode);
}

// ─── HLS proxy for DooFlix M3U8 rewriting ─────────────────────────────────────

router.get(["/hlsproxy", "/hlsproxy/playlist.m3u8"], async (req, res) => {
  try {
    const u = req.query["u"] as string | undefined;
    const r = req.query["r"] as string | undefined;
    if (!u) { res.status(400).send("Missing u param"); return; }

    const targetUrl = Buffer.from(u, "base64url").toString("utf8");
    const referer = r ? Buffer.from(r, "base64url").toString("utf8") : "https://streamsrcs.2embed.cc/";

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 30000);

    // Build fetch headers — forward Range so the upstream can respond with 206
    // for byte-range segment requests from the LG WebOS / Chromium-based player.
    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: referer,
      Origin: new URL(referer).origin,
      Accept: "*/*",
    };
    const rangeHeader = req.headers["range"];
    if (rangeHeader) fetchHeaders["Range"] = String(rangeHeader);

    const upstreamRes = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: ctrl.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(tid));

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      res.status(upstreamRes.status).send("Upstream error");
      return;
    }

    const upstreamCT = upstreamRes.headers.get("content-type") ?? "";
    const urlPath = targetUrl.split("?")[0]!.toLowerCase();

    // Treat as a playlist candidate when the URL or content-type clearly indicates M3U8.
    // Also include .txt — some CDNs (e.g. Dooflix VID source) serve obfuscated m3u8
    // playlists under a .txt extension with content-type text/plain.
    const isPlaylistCandidate =
      upstreamCT.includes("mpegurl") ||
      upstreamCT.includes("x-mpegurl") ||
      urlPath.endsWith(".m3u8") ||
      urlPath.endsWith(".m3u") ||
      urlPath.endsWith(".txt");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");

    if (isPlaylistCandidate) {
      // ── M3U8 playlist: rewrite all non-comment URI lines to go through our proxy ──
      const base = `${apiBase(req)}/hlsproxy/playlist.m3u8`;
      const text = await upstreamRes.text();

      // Content-sniff: if the body isn't a real M3U8 (e.g. CDN served binary data
      // with text/plain), fall through to the binary segment path below.
      const isRealPlaylist =
        text.trimStart().startsWith("#EXTM3U") ||
        text.includes("#EXT-X-STREAM-INF") ||
        text.includes("#EXTINF");

      if (isRealPlaylist) {
        const rewritten = text
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;
            try {
              const absUrl = new URL(trimmed, targetUrl).href;
              const eu = Buffer.from(absUrl).toString("base64url");
              const er = Buffer.from(referer).toString("base64url");
              return `${base}?u=${eu}&r=${er}`;
            } catch {
              return line;
            }
          })
          .join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(rewritten);
        return;
      }

      // Not a real playlist — fall through to serve as binary segment
      const isKnownMediaCT =
        upstreamCT.includes("video") ||
        upstreamCT.includes("audio") ||
        upstreamCT.includes("octet-stream") ||
        upstreamCT.includes("mp4") ||
        upstreamCT.includes("mpeg");
      const ct = isKnownMediaCT ? upstreamCT : "video/MP2T";
      res.setHeader("Content-Type", ct);
      res.setHeader("Accept-Ranges", "bytes");
      const cl2 = upstreamRes.headers.get("content-length");
      if (cl2) res.setHeader("Content-Length", cl2);
      const cr2 = upstreamRes.headers.get("content-range");
      if (cr2) res.setHeader("Content-Range", cr2);
      res.status(upstreamRes.status).send(Buffer.from(text, "binary"));
    } else {
      // ── Binary segment (TS / fMP4 / key): pipe straight through ──
      // Force video/MP2T when CDN returns a wrong content-type (e.g. image/png from TikTok CDN).
      // Forward Content-Range + Accept-Ranges so browser players can perform byte-range seeks.
      const isKnownMediaCT =
        upstreamCT.includes("video") ||
        upstreamCT.includes("audio") ||
        upstreamCT.includes("octet-stream") ||
        upstreamCT.includes("mp4") ||
        upstreamCT.includes("mpeg");
      const ct = isKnownMediaCT ? upstreamCT : "video/MP2T";
      res.setHeader("Content-Type", ct);
      res.setHeader("Accept-Ranges", "bytes");

      const cl = upstreamRes.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);

      // Forward Content-Range so 206 Partial Content responses are transparent
      const cr = upstreamRes.headers.get("content-range");
      if (cr) res.setHeader("Content-Range", cr);

      res.status(upstreamRes.status);

      if (upstreamRes.body) {
        const { Readable } = await import("node:stream");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Readable.fromWeb(upstreamRes.body as any).pipe(res);
      } else {
        const buf = await upstreamRes.arrayBuffer();
        res.send(Buffer.from(buf));
      }
    }
  } catch (e) {
    logger.error({ err: e }, "HLS proxy: error");
    if (!res.headersSent) res.status(500).send("Proxy error");
  }
});

// ─── Debug endpoints ──────────────────────────────────────────────────────────

router.get("/debug/cache", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(streamCacheStats());
});

router.get("/debug/resolve", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(getResolveEvents());
});

// HDHub4U search debug: /api/debug/hdhub4u?title=Project+Hail+Mary&type=movie
router.get("/debug/hdhub4u", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const title = String(req.query["title"] ?? "");
  const type  = String(req.query["type"]  ?? "movie") as "movie" | "series";
  const season = Number(req.query["season"] ?? 1);
  if (!title) { res.status(400).json({ error: "Missing title param" }); return; }
  try {
    const query = type === "series" ? `${title} season ${season}` : title;
    const results = await hdhub4u.searchSite(query);
    const typed = results.filter((r) => r.type === type);
    const pool  = typed.length > 0 ? typed : results;
    const scored = pool.map((r) => ({
      title: r.title,
      type: r.type,
      url: r.url,
      wordOverlap: titleWordOverlap(title, r.title),
      score: parseFloat(titleSimilarityScore(title, r.title).toFixed(3)),
    })).sort((a, b) => b.score - a.score);
    res.json({ query, type, total: results.length, typed: typed.length, usedFallback: typed.length === 0, scored });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Direct MovieBox search proxy for diagnostics:
// /api/debug/moviebox-search?q=Shinchan&type=series
router.get("/debug/moviebox-search", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = String(req.query["q"] ?? "");
  const type = String(req.query["type"] ?? "series");
  const page = Number(req.query["page"] ?? 1);
  if (!q) { res.status(400).json({ error: "Missing q param" }); return; }
  try {
    const results = await searchMovieBox(q, page);
    const targetType = type === "movie" ? 1 : 2;
    const scored = scoreResults(results as MBSubject[], q, q, targetType, undefined);
    res.json({ query: q, type, page, count: results.length, results: scored.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Debug: raw MovieBox play-info streams for a given subjectId
// /api/debug/moviebox-playinfo?subjectId=9061059138918203344&season=2&episode=1
router.get("/debug/moviebox-playinfo", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const subjectId = String(req.query["subjectId"] ?? "");
  const season = Number(req.query["season"] ?? 0);
  const episode = Number(req.query["episode"] ?? 0);
  if (!subjectId) { res.status(400).json({ error: "Missing subjectId param" }); return; }
  try {
    const { token, dubs } = await getSubjectDetails(subjectId);
    const allSubjects = [
      { subjectId, language: "Original" },
      ...dubs.map((d) => ({ subjectId: d.subjectId, language: d.lanName })),
    ];
    const result: Record<string, unknown>[] = [];
    for (const { subjectId: sid, language } of allSubjects) {
      const streams = await getPlayInfo(sid, season, episode, token);
      result.push({ subjectId: sid, language, streamCount: streams.length, streams });
    }
    res.json({ subjectId, season, episode, dubs, subjects: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
