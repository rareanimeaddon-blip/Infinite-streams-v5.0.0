import { logger } from "../lib/logger.js";
import { setPlayerApiResult } from "../lib/animesalt-player-cache.js";

const TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";
const BASE = "https://animesalt.ac";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function httpGet(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: Object.assign({ "User-Agent": UA }, headers ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function httpPost(
  url: string,
  body: string,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign(
      { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      headers ?? {},
    ),
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function cleanTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

interface SearchResult {
  url: string;
  type: string;
  slug: string;
  title: string;
  year: number | null;
}

function parseLiResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const liRegex = /<li id="post-\d+" class="([^"]+)">([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const classes = liMatch[1];
    const content = liMatch[2];
    const type = classes.includes("type-series")
      ? "series"
      : classes.includes("type-movies")
        ? "movies"
        : null;
    if (!type) continue;
    const linkMatch = content.match(
      /href="(https:\/\/animesalt\.ac\/(series|movies)\/([^\/\"]+)\/?)"/,
    );
    const titleMatch = content.match(/entry-title[^>]*>([^<]+)</);
    const yearMatch = content.match(/class="year[^"]*">(\d{4})/);
    if (linkMatch && titleMatch) {
      const slug = linkMatch[3];
      const itemTitle = titleMatch[1].trim();
      const itemYear = yearMatch ? parseInt(yearMatch[1]) : null;
      if (!results.some((r) => r.slug === slug) && slug && slug !== "page") {
        results.push({ url: linkMatch[1], type, slug, title: itemTitle, year: itemYear });
      }
    }
  }
  return results;
}

async function searchSite(
  title: string,
  mediaType: string,
  year: number | null,
): Promise<SearchResult[]> {
  const url = `${BASE}/?s=${encodeURIComponent(title)}`;
  const html = await httpGet(url, { Referer: `${BASE}/` });

  let results = parseLiResults(html);

  if (results.length === 0 && html.includes('class="navigation pagination"')) {
    try {
      const html2 = await httpGet(`${BASE}/page/2/?s=${encodeURIComponent(title)}`, {
        Referer: `${BASE}/`,
      });
      results = parseLiResults(html2);
    } catch { /* ignore */ }
  }

  const filtered =
    mediaType === "movie"
      ? results.filter((r) => r.type === "movies")
      : results.filter((r) => r.type === "series");

  if (filtered.length === 0) return [];

  let candidates: SearchResult[];
  if (year) {
    const withYear = filtered.filter((r) => r.year && Math.abs(r.year - year) <= 1);
    const withoutYear = filtered.filter((r) => !r.year);
    candidates =
      withYear.length > 0 ? withYear : withoutYear.length > 0 ? withoutYear : filtered;
  } else {
    candidates = filtered;
  }

  const cleanSearch = cleanTitle(title);

  function sigWords(s: string): string[] {
    const stops = new Set(["the", "a", "an", "of", "in", "to", "and", "or", "with"]);
    return s.split(" ").filter((w) => w.length > 2 && !stops.has(w));
  }

  function titleScore(candidate: string): number {
    const cleanC = cleanTitle(candidate);
    if (cleanC === cleanSearch) return 1.0;
    if (cleanC.includes(cleanSearch) && cleanSearch.length >= 5) return 0.9;
    if (cleanSearch.includes(cleanC) && cleanC.length >= 5) return 0.85;
    const qSig = sigWords(cleanSearch);
    const cSig = new Set(sigWords(cleanC));
    if (qSig.length === 0) return cleanC.includes(cleanSearch) ? 0.5 : 0;
    const overlap = qSig.filter((w) => cSig.has(w)).length;
    if (overlap === 0) return 0;
    const union = new Set([...qSig, ...cSig]);
    return (overlap / qSig.length) * 0.65 + (overlap / union.size) * 0.35;
  }

  const scored = candidates
    .map((r) => ({ r, score: titleScore(r.title) }))
    .filter(({ score }) => score >= 0.35)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    logger.info({ title, candidateCount: candidates.length }, "AnimeSalt: no candidate passed title similarity threshold");
    return [];
  }

  return scored.map(({ r }) => r);
}

function getEpisodeUrlFromHtml(
  html: string,
  season: number,
  episode: number,
): string | null {
  const epRegex = new RegExp(
    `href="(https://animesalt\\.ac/episode/[^"]*${season}x${episode}[^"]*)"`,
  );
  const epMatch = html.match(epRegex);
  return epMatch ? epMatch[1] : null;
}

async function getEpisodeUrl(
  seriesUrl: string,
  season: number,
  episode: number,
): Promise<string | null> {
  const html = await httpGet(seriesUrl, { Referer: `${BASE}/` });

  const seasons: { post: string; season: number }[] = [];
  const seasonRegex = /data-post="(\d+)"\s+data-season="(\d+)"/g;
  let m;
  while ((m = seasonRegex.exec(html)) !== null) {
    seasons.push({ post: m[1], season: parseInt(m[2]) });
  }

  if (seasons.length === 0) {
    return getEpisodeUrlFromHtml(html, season, episode);
  }

  const target = seasons.find((s) => s.season === season);
  if (!target) return null;

  const ajaxUrl = `${BASE}/wp-admin/admin-ajax.php?action=action_select_season&season=${season}&post=${target.post}`;
  const epHtml = await httpGet(ajaxUrl, { Referer: seriesUrl });
  return getEpisodeUrlFromHtml(epHtml, season, episode);
}

interface StreamData {
  url: string;
  subtitle: string | null;
  referer: string;
  origin: string;
  hash: string;
  playerCdn: string;
}

async function getStreamFromPage(pageUrl: string): Promise<StreamData | null> {
  const html = await httpGet(pageUrl, { Referer: `${BASE}/` });

  // Primary pattern: as-cdn<N>.top/video/<hash>
  let iframeMatch = html.match(
    /src="(https?:\/\/as-cdn\d+\.top\/video\/([a-f0-9]+))"/,
  );
  // Fallback: any CDN /video/<hash> path (AnimeSalt may rotate CDN hostnames)
  if (!iframeMatch) {
    iframeMatch = html.match(
      /src="(https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}\/video\/([a-f0-9]{16,}))"/,
    );
  }
  // Further fallback: iframe with ?data=<hash> query param
  if (!iframeMatch) {
    iframeMatch = html.match(
      /src="(https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}[^"]*[?&]data=([a-f0-9]{16,})[^"]*)"/,
    );
  }
  if (!iframeMatch) return null;

  const playerUrl = iframeMatch[1]!;
  const hash = iframeMatch[2]!;
  const playerCdn = playerUrl.includes("/video/")
    ? playerUrl.split("/video/")[0]!
    : (() => { try { return new URL(playerUrl).origin; } catch { return playerUrl; } })();

  let m3u8: string | undefined;

  try {
    const data = await httpPost(
      `${playerCdn}/player/index.php?data=${hash}&do=getVideo`,
      `hash=${hash}&r=${encodeURIComponent(`${BASE}/`)}`,
      {
        Referer: `${BASE}/`,
        Origin: playerCdn,
        "X-Requested-With": "XMLHttpRequest",
      },
    );
    m3u8 = (
      data["videoSource"] || data["securedLink"] || data["file"] ||
      data["url"] || data["hls"] || data["src"]
    ) as string | undefined;
    // Cache immediately so the relay can skip calling the player API again.
    if (m3u8) setPlayerApiResult(hash, playerCdn, m3u8);
  } catch (err) {
    logger.warn({ playerUrl, err }, "AnimeSalt: POST API failed, falling back to page scrape");
  }

  // If POST API failed or returned nothing, try scraping the player page HTML for an m3u8
  if (!m3u8) {
    try {
      const playerHtml = await httpGet(playerUrl, {
        Referer: `${BASE}/`,
        Origin: playerCdn,
      });
      const m3u8Match = playerHtml.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/);
      if (m3u8Match) {
        m3u8 = m3u8Match[1];
        logger.info({ playerUrl, m3u8 }, "AnimeSalt: found m3u8 via page scrape fallback");
      }
    } catch (err) {
      logger.warn({ playerUrl, err }, "AnimeSalt: page scrape fallback also failed");
    }
  }

  if (!m3u8) return null;

  const contentHashMatch = m3u8.match(/\/hls\/([a-f0-9]+)\//);
  const contentHash = contentHashMatch ? contentHashMatch[1] : hash;
  const cdnBase = m3u8.includes("/cdn/hls/") ? m3u8.split("/cdn/hls/")[0] : null;
  const subtitle = cdnBase
    ? `${cdnBase}/cdn/down/${contentHash}/Subtitle/subtitle_eng.srt`
    : null;

  return { url: m3u8, subtitle, referer: playerUrl, origin: playerCdn, hash, playerCdn };
}

const TMDB_ANIMATION_GENRE = 16;

async function imdbToTitle(
  imdbId: string,
  mediaType: "movie" | "series",
): Promise<{ title: string; year: number | null; isAnimation: boolean } | null> {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<
    string,
    { id: number; title?: string; name?: string; release_date?: string; first_air_date?: string; genre_ids?: number[]; origin_country?: string[] }[]
  >;
  const results = mediaType === "movie" ? data["movie_results"] : data["tv_results"];
  if (!results?.length) return null;
  const item = results[0];
  const releaseDate = item.release_date ?? item.first_air_date ?? "";
  const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
  const title = item.title ?? item.name ?? "";
  const genreIds = item.genre_ids ?? [];
  const originCountry = item.origin_country ?? [];
  const isAnimation = genreIds.includes(TMDB_ANIMATION_GENRE) || originCountry.includes("JP");
  return { title, year, isAnimation };
}

async function tryDirectUrl(title: string, mediaType: string): Promise<SearchResult | null> {
  const pathPrefix = mediaType === "movie" ? "movies" : "series";
  const slugs: string[] = [
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title.toLowerCase().replace(/[^a-z0-9]/g, ""),
    title.split(" ")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "",
  ];
  for (const slug of [...new Set(slugs)]) {
    if (!slug) continue;
    const url = `${BASE}/${pathPrefix}/${slug}/`;
    try {
      const html = await httpGet(url, { Referer: `${BASE}/` });
      if (html.length > 5000) {
        return { url, type: pathPrefix, slug, title, year: null };
      }
    } catch { /* 404 */ }
  }
  return null;
}

export interface AnimeSaltStream {
  name: string;
  title: string;
  url: string;
  referer: string;
  origin: string;
  hash?: string;
  playerCdn?: string;
  subtitles?: { url: string; lang: string; id: string }[];
}

async function fetchStreamsForTarget(
  target: SearchResult,
  mediaType: "movie" | "series",
  season?: number,
  episode?: number,
  logKey?: string,
): Promise<AnimeSaltStream[]> {
  let streamData: StreamData | null = null;
  if (mediaType === "movie") {
    streamData = await getStreamFromPage(target.url);
  } else if (season !== undefined && episode !== undefined) {
    const epUrl = await getEpisodeUrl(target.url, season, episode);
    if (epUrl) streamData = await getStreamFromPage(epUrl);
  }

  if (!streamData) {
    logger.info({ key: logKey, targetUrl: target.url }, "AnimeSalt: no stream data");
    return [];
  }

  logger.info({ key: logKey, m3u8: streamData.url }, "AnimeSalt: stream found");

  return [
    {
      name: "ALLINONE | AnimeSalt",
      title: "AnimeSalt • Multi-Audio (Hindi/English/Japanese)",
      url: streamData.url,
      referer: streamData.referer,
      origin: streamData.origin,
      hash: streamData.hash,
      playerCdn: streamData.playerCdn,
      subtitles: streamData.subtitle
        ? [{ url: streamData.subtitle, lang: "eng", id: "en" }]
        : [],
    },
  ];
}

export async function getStreams(
  imdbId: string,
  mediaType: "movie" | "series",
  season?: number,
  episode?: number,
): Promise<AnimeSaltStream[]> {
  logger.info({ imdbId, mediaType, season, episode }, "AnimeSalt: getStreams");
  const tmdbResult = await imdbToTitle(imdbId, mediaType);
  if (!tmdbResult) return [];

  const { title, year, isAnimation } = tmdbResult;
  if (!title) return [];

  if (!isAnimation) {
    logger.debug({ imdbId, title }, "AnimeSalt: skipping — not anime/animation");
    return [];
  }

  const titleVariants: string[] = [title];
  const beforePunct = title.split(/[:\-,]/)[0].trim();
  if (beforePunct && beforePunct !== title) titleVariants.push(beforePunct);
  const firstTwo = title.split(" ").slice(0, 2).join(" ");
  if (firstTwo && firstTwo !== title && firstTwo !== beforePunct) titleVariants.push(firstTwo);
  const firstWord = title.split(" ")[0];
  if (firstWord && firstWord !== firstTwo && firstWord.length > 3) titleVariants.push(firstWord);

  let results: SearchResult[] = [];
  for (const variant of titleVariants) {
    results = await searchSite(variant, mediaType, year);
    if (results.length > 0) break;
  }

  if (!results.length) {
    const direct = await tryDirectUrl(title, mediaType);
    if (direct) results = [direct];
  }

  if (!results.length) {
    logger.info({ imdbId, title }, "AnimeSalt: no results found");
    return [];
  }

  const target = results[0]!;
  logger.info({ imdbId, title, targetUrl: target.url }, "AnimeSalt: found target");
  return fetchStreamsForTarget(target, mediaType, season, episode, imdbId);
}

export async function getStreamsByTitle(
  title: string,
  mediaType: "movie" | "series",
  season?: number,
  episode?: number,
): Promise<AnimeSaltStream[]> {
  logger.info({ title, mediaType, season, episode }, "AnimeSalt: getStreamsByTitle");
  if (!title) return [];

  const titleVariants: string[] = [title];
  const beforePunct = title.split(/[:\-,]/)[0].trim();
  if (beforePunct && beforePunct !== title) titleVariants.push(beforePunct);
  const firstTwo = title.split(" ").slice(0, 2).join(" ");
  if (firstTwo && firstTwo !== title && firstTwo !== beforePunct) titleVariants.push(firstTwo);
  const firstWord = title.split(" ")[0];
  if (firstWord && firstWord !== firstTwo && firstWord.length > 3) titleVariants.push(firstWord);

  let results: SearchResult[] = [];
  for (const variant of titleVariants) {
    results = await searchSite(variant, mediaType, null);
    if (results.length > 0) break;
  }

  if (!results.length) {
    const direct = await tryDirectUrl(title, mediaType);
    if (direct) results = [direct];
  }

  if (!results.length) {
    logger.info({ title }, "AnimeSalt: getStreamsByTitle — no results");
    return [];
  }

  const target = results[0]!;
  logger.info({ title, targetUrl: target.url }, "AnimeSalt: getStreamsByTitle — found target");
  return fetchStreamsForTarget(target, mediaType, season, episode, title);
}
