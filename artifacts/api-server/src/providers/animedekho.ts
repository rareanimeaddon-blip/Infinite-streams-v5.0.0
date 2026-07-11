import * as cheerio from "cheerio";
import { fetchDoc, fetchText } from "../utils/fetch.js";
import { logger } from "../lib/logger.js";

const BASE_URL = "https://animedekho.app";

export interface SearchResult {
  id: string;
  title: string;
  poster: string | null;
  background: string | null;
  url: string;
  type: "movie" | "series";
  year: string | null;
  description: string | null;
  genres: string[];
}

export interface Episode {
  id: string;
  title: string;
  poster: string | null;
  url: string;
  season: number | null;
  episode: number | null;
}

export interface MediaMeta {
  id: string;
  title: string;
  poster: string | null;
  plot: string | null;
  year: number | null;
  type: "movie" | "series";
  url: string;
  mediaType: number;
  genres: string[];
  episodes?: Episode[];
}

function encodeId(url: string, mediaType: number): string {
  return "animedekho:" + Buffer.from(JSON.stringify({ url, mediaType })).toString("base64url");
}

function decodeId(id: string): { url: string; mediaType: number } | null {
  try {
    return JSON.parse(Buffer.from(id.replace("animedekho:", ""), "base64url").toString("utf8"));
  } catch { return null; }
}

export { encodeId, decodeId };

function fixImageUrl(src: string | undefined, fallback: string | null = null): string | null {
  if (!src) return fallback;
  if (src.startsWith("data:")) return fallback;
  if (src.startsWith("http")) return src;
  if (src.startsWith("//")) return "https:" + src;
  return fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArticle($: ReturnType<typeof cheerio.load>, el: any): SearchResult | null {
  const href = $(el).find("a.lnk-blk").attr("href");
  // Only accept URLs that are actual animedekho.app series or movie pages
  if (!href || !href.includes("animedekho.app")) return null;
  if (
    !href.includes("/serie/") && !href.includes("/series-hindi/") &&
    !href.includes("/movies/") && !href.includes("/movie/") && !href.includes("/movie-hindi/")
  ) return null;
  const rawTitle =
    $(el).find("header h2").text().trim() ||
    $(el).find("h2.entry-title").text().trim() ||
    $(el).find("h2").text().trim() ||
    "Unknown";
  const title = cleanTitle(rawTitle);
  let poster =
    $(el).find("div.post-thumbnail figure img").attr("src") ||
    $(el).find(".post-thumbnail figure img").attr("src") ||
    $(el).find("figure img").attr("src") ||
    $(el).find("img").attr("src");
  if (poster?.startsWith("data:")) {
    poster =
      $(el).find("figure img").attr("data-lazy-src") ||
      $(el).find("img").attr("data-lazy-src") ||
      $(el).find("figure img").attr("data-src") ||
      $(el).find("img").attr("data-src");
  }
  const isMovie = href.includes("/movies/") || href.includes("/movie/") || href.includes("/movie-hindi/");
  const mediaType = isMovie ? 1 : 2;
  const posterUrl = fixImageUrl(poster);

  const yearRaw = $(el).find("span.year").first().text().trim();
  const year = yearRaw || null;

  const description = $(el).find("div.entry-content p").first().text().trim() || null;

  const genres: string[] = [];
  $(el).find(".details-lst li").each((_, li) => {
    const label = $(li).find("span").first().text().trim();
    if (label === "Genres") {
      $(li).find("a").each((_, a) => {
        const g = $(a).text().trim();
        if (g) genres.push(g);
      });
    }
  });

  return {
    id: encodeId(href, mediaType),
    title,
    poster: posterUrl,
    background: posterUrl,
    url: href,
    type: isMovie ? "movie" : "series",
    year,
    description,
    genres,
  };
}

export async function search(query: string): Promise<SearchResult[]> {
  logger.info({ query }, "AnimeDekho search");
  try {
    const $ = await fetchDoc(`${BASE_URL}/search/${encodeURIComponent(query)}`);
    const results: SearchResult[] = [];
    // Only look inside ul[data-results] — the generic "article" fallback
    // grabs sidebar/related-posts content and returns wrong items
    const $results = $("ul[data-results] article");
    if ($results.length > 0) {
      $results.each((_, el) => {
        const r = parseArticle($, el);
        if (r) results.push(r);
      });
    } else {
      // Some page variants wrap results differently — try common content containers only
      $(".site-main article, #main article, .search-results article").each((_, el) => {
        const r = parseArticle($, el);
        if (r) results.push(r);
      });
    }
    logger.info({ query, count: results.length }, "search results");
    return results;
  } catch (err) { logger.error({ query, err }, "search error"); return []; }
}

const CATALOG_PATH_MAP: Record<string, string> = {
  "animedekho-series": "/series-hindi/",
  "animedekho-movies": "/movie-hindi/",
  "animedekho-anime": "/category/anime/",
  "animedekho-cartoon": "/category/cartoon/",
  "animedekho-crunchyroll": "/category/crunchyroll/",
  "animedekho-hindi-dub": "/category/hindi-dub/",
  "animedekho-tamil": "/category/tamil/",
  "animedekho-telugu": "/category/telugu/",
  "animedekho-action": "/category/action/",
  "animedekho-adventure": "/category/adventure/",
  "animedekho-comedy": "/category/comedy/",
  "animedekho-drama": "/category/drama/",
  "animedekho-fantasy": "/category/fantasy/",
  "animedekho-romance": "/category/romance/",
  "animedekho-horror": "/category/horror/",
  "animedekho-mystery": "/category/mystery/",
  "animedekho-supernatural": "/category/supernatural/",
  "animedekho-isekai": "/category/isekai/",
  "animedekho-slice-of-life": "/category/slice-of-life/",
  "animedekho-shounen": "/category/shounen/",
  "animedekho-mecha": "/category/mecha/",
  "animedekho-kids": "/category/kids/",
};

const GENRE_PATH_MAP: Record<string, string> = {
  "Anime": "/category/anime/",
  "Cartoon": "/category/cartoon/",
  "Animation": "/category/animation/",
  "Crunchyroll": "/category/crunchyroll/",
  "Hindi Dub": "/category/hindi-dub/",
  "Tamil": "/category/tamil/",
  "Telugu": "/category/telugu/",
  "Action": "/category/action/",
  "Adventure": "/category/adventure/",
  "Comedy": "/category/comedy/",
  "Drama": "/category/drama/",
  "Fantasy": "/category/fantasy/",
  "Romance": "/category/romance/",
  "Horror": "/category/horror/",
  "Mystery": "/category/mystery/",
  "Sci-Fi": "/category/sci-fi/",
  "Thriller": "/category/thriller/",
  "Supernatural": "/category/supernatural/",
  "Isekai": "/category/isekai/",
  "Slice of Life": "/category/slice-of-life/",
  "Shounen": "/category/shounen/",
  "Mecha": "/category/mecha/",
  "Kids": "/category/kids/",
  "Family": "/category/family/",
};

interface CacheEntry<T> { data: T; expires: number; }
const catalogCache = new Map<string, CacheEntry<SearchResult[]>>();
const CATALOG_TTL = 10 * 60 * 1000;

export async function catalog(catalogId: string, genre?: string, skip = 0, type?: string): Promise<SearchResult[]> {
  let path = CATALOG_PATH_MAP[catalogId] || "/serie/";
  if (genre && GENRE_PATH_MAP[genre]) path = GENRE_PATH_MAP[genre];
  const page = Math.floor(skip / 20) + 1;
  const cacheKey = `${path}::${page}::${type || ""}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logger.debug({ cacheKey }, "catalog cache hit");
    return cached.data;
  }
  const url = page > 1 ? `${BASE_URL}${path}page/${page}/` : `${BASE_URL}${path}`;
  logger.info({ catalogId, genre, skip, page, url }, "catalog fetch");
  try {
    const $ = await fetchDoc(url);
    let results: SearchResult[] = [];
    $("article").each((_, el) => { const r = parseArticle($, el); if (r) results.push(r); });
    if (type === "movie") results = results.filter((r) => r.type === "movie");
    if (type === "series") results = results.filter((r) => r.type === "series");
    logger.info({ catalogId, type, count: results.length }, "catalog results");
    catalogCache.set(cacheKey, { data: results, expires: Date.now() + CATALOG_TTL });
    return results;
  } catch (err) { logger.error({ catalogId, err }, "catalog error"); return []; }
}

function parseSeasonEpisodeFromUrl(url: string): { season: number; episode: number } | null {
  const match = url.match(/[-\/](\d+)x(\d+)\/?(?:[?#]|$)/);
  if (match) {
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  }
  return null;
}

function cleanTitle(raw: string): string {
  return (
    raw
      .replace(/^Watch\s+Online\s+/i, "")
      .split(/\s*[–|]\s*/)[0]!
      .replace(/\s+(?:Movie\s+)?(?:in\s+)?(?:Hindi|Tamil|Telugu|English|Dual)\s+(?:Dubbed?|Sub(?:bed)?|Audio)(?:\s+Free)?.*$/i, "")
      .replace(/\s+\([^)]*(?:Dubbed?|Dub|Sub(?:bed)?|Audio)[^)]*\)\s*$/i, "")
      .replace(/\s+Movie\s+\([^)]+\)\s*$/i, "")
      .replace(/\s*–\s*Watch\s+Online.*$/i, "")
      .replace(/\s*\|\s*AnimeDekho.*$/i, "")
      .trim() || raw.trim()
  );
}

const metaCache = new Map<string, CacheEntry<MediaMeta>>();
const META_TTL = 30 * 60 * 1000;

export async function getMeta(stremioId: string): Promise<MediaMeta | null> {
  const cached = metaCache.get(stremioId);
  if (cached && cached.expires > Date.now()) {
    logger.debug({ stremioId }, "getMeta cache hit");
    return cached.data;
  }
  const decoded = decodeId(stremioId);
  if (!decoded) { logger.warn({ stremioId }, "getMeta: invalid id"); return null; }
  const { url, mediaType } = decoded;
  logger.info({ url, mediaType }, "getMeta fetch");
  try {
    const $ = await fetchDoc(url);
    const rawTitle =
      $("h1.entry-title").text().trim() ||
      $("meta[property='og:title']").attr("content") ||
      "Unknown";
    const title = cleanTitle(rawTitle);
    let poster =
      $("div.post-thumbnail figure img").attr("src") ||
      $(".post-thumbnail img").first().attr("src") ||
      $("meta[property='og:image']").attr("content") ||
      null;
    if (poster?.startsWith("data:")) poster = $("meta[property='og:image']").attr("content") || null;

    const plot =
      $("div.entry-content p").first().text().trim() ||
      $("meta[name='description']").attr("content") ||
      $("meta[name='twitter:description']").attr("content") ||
      null;

    const yearStr =
      $("span.year").first().text().trim() ||
      $("meta[property='og:updated_time']").attr("content")?.split("-")[0];
    const year = yearStr ? parseInt(yearStr) || null : null;

    const genreSet = new Set<string>();
    $(".details-lst li, .single-details li").each((_, li) => {
      const label = $(li).find("span").first().text().trim();
      if (label === "Genres" || label === "Genre") {
        $(li).find("a").each((_, a) => {
          const g = $(a).text().trim();
          if (g) genreSet.add(g);
        });
      }
    });
    const genres = Array.from(genreSet);

    // Determine type from URL path — most reliable signal
    const isSeriesPage = url.includes("/serie/") || url.includes("/series/") || url.includes("/series-hindi/");
    const isMoviePage  = url.includes("/movies/") || url.includes("/movie/") || url.includes("/movie-hindi/");
    // mediaType in the decoded stremio id is also a reliable hint
    const mediaTypeHint = decoded.mediaType; // 1=movie, 2=series

    // Try multiple selectors for episode lists — AnimeDekho layout varies
    const seasonItems =
      $("ul.seasons-lst li").length > 0 ? $("ul.seasons-lst li") :
      $(".epiitem li, .episodes-list li, .episode-list li, .eplist li, .eps-list li").length > 0
        ? $(".epiitem li, .episodes-list li, .episode-list li, .eplist li, .eps-list li")
        : $([]);

    const hasEpisodes = seasonItems.length > 0;

    // Decide final content type
    const contentType: "movie" | "series" =
      isSeriesPage ? "series" :
      isMoviePage  ? "movie"  :
      mediaTypeHint === 1 ? "movie" :
      mediaTypeHint === 2 ? "series" :
      hasEpisodes  ? "series" : "movie";

    if (!hasEpisodes) {
      const result: MediaMeta = {
        id: stremioId, title, poster, plot, year,
        type: contentType,
        url,
        mediaType: contentType === "series" ? 2 : 1,
        genres,
        episodes: [],
      };
      metaCache.set(stremioId, { data: result, expires: Date.now() + META_TTL });
      return result;
    }

    const episodes: Episode[] = [];
    const episodeCountPerSeason: Record<number, number> = {};
    seasonItems.each((_, el) => {
      const episodeHref = $(el).find("a").attr("href");
      if (!episodeHref) return;
      const epTitle = $(el).find("h3.title").clone().children().remove().end().text().trim()
        || $(el).find("h3, .ep-title, .title").first().text().trim();
      const epPoster = fixImageUrl(
        $(el).find("div > div > figure > img").attr("src") ||
        $(el).find("figure img").attr("src") ||
        $(el).find("img").attr("src")
      );
      const seasonSpanText = $(el).find("h3.title > span, .season-label, [class*='season']").text();
      const seasonMatch = seasonSpanText.match(/S(\d+)/i);

      const urlParsed = parseSeasonEpisodeFromUrl(episodeHref);

      let season: number;
      let episodeNum: number;

      if (urlParsed) {
        // AnimeDekho sometimes uses season=0 — treat 0 as season 1
        season = urlParsed.season === 0 ? 1 : urlParsed.season;
        episodeNum = urlParsed.episode;
      } else {
        season = seasonMatch ? parseInt(seasonMatch[1]) : 1;
        episodeCountPerSeason[season] = (episodeCountPerSeason[season] || 0) + 1;
        episodeNum = episodeCountPerSeason[season];
      }

      const episodeId = encodeId(episodeHref, 2);
      episodes.push({
        id: episodeId,
        title: epTitle || `Episode ${episodeNum}`,
        poster: epPoster,
        url: episodeHref,
        season,
        episode: episodeNum,
      });
    });

    const result: MediaMeta = {
      id: stremioId, title, poster, plot, year,
      type: "series", url, mediaType: 2, genres, episodes,
    };
    metaCache.set(stremioId, { data: result, expires: Date.now() + META_TTL });
    return result;
  } catch (err) {
    logger.error({ url, err }, "getMeta error");
    return null;
  }
}

export async function getBodyTermId(url: string): Promise<{ term: string; mediaType: number; text: string } | null> {
  // Primary: scrape body class for postid/term
  try {
    const text = await fetchText(url, { timeout: 7000 });
    const $ = cheerio.load(text);
    const bodyClass = $("body").attr("class") || "";
    const match = bodyClass.match(/(?:term|postid)-(\d+)/);
    if (match) {
      const isMovie = url.includes("/movie/") || url.includes("/movies/") || url.includes("/movie-hindi/") || bodyClass.includes("single-movie");
      logger.info({ url, term: match[1] }, "getBodyTermId: found via body class");
      return { term: match[1], mediaType: isMovie ? 1 : 2, text };
    }
    logger.warn({ url, bodyClass }, "no postid/term found in body class");
  } catch (err) {
    logger.warn({ url, err }, "getBodyTermId: page fetch failed, trying WP REST API");
  }

  // Fallback: WordPress REST API — works even when Cloudflare blocks the page
  try {
    const slug = url.replace(/\/$/, "").split("/").pop() || "";
    if (!slug) return null;
    // Try both 'posts' (episodes/movies) endpoint types
    for (const wpType of ["posts", "pages"]) {
      const apiUrl = `${BASE_URL}/wp-json/wp/v2/${wpType}?slug=${encodeURIComponent(slug)}&_fields=id,type,link`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(apiUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const data = await res.json() as Array<{ id: number; type?: string; link?: string }>;
        if (Array.isArray(data) && data[0]?.id) {
          const postId = String(data[0].id);
          const isMovie = url.includes("/movie/") || url.includes("/movies/") || url.includes("/movie-hindi/") || data[0].type === "movie";
          logger.info({ url, slug, postId }, "getBodyTermId: found via WP REST API");
          return { term: postId, mediaType: isMovie ? 1 : 2, text: "" };
        }
      } catch (innerErr) {
        clearTimeout(timer);
        logger.debug({ apiUrl, err: innerErr }, "getBodyTermId WP REST API attempt failed");
      }
    }
  } catch (err) {
    logger.error({ url, err }, "getBodyTermId WP REST API fallback error");
  }

  return null;
}

const EMBED_ERROR_MARKERS = ["Server Error (Link)", "server error", "Report to Admin", "File Not Found", "file not found", "Video Not Found", "This video has been removed"];
function isEmbedErrorPage(html: string): boolean { return EMBED_ERROR_MARKERS.some((m) => html.includes(m)); }

function decodeServerButtons(html: string): Array<{ url: string; name: string }> {
  const results: Array<{ url: string; name: string }> = [];
  const $doc = cheerio.load(html);
  // Primary selector: server tab buttons with data-src and data-option
  $doc("a[data-src][data-option]").each((_, el) => {
    const b64 = $doc(el).attr("data-src") || "";
    const name = $doc(el).find("span.num").text().trim() || $doc(el).text().trim() || "";
    if (!b64) return;
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (decoded.startsWith("https://animedekho.app/") || decoded.startsWith("http://animedekho.app/")) {
        results.push({ url: decoded, name });
      }
    } catch {}
  });
  return results;
}

/**
 * Parses the episode/movie page HTML to determine which servers are listed.
 * Returns the NeoCDN flag, the exact myth player URL (with the correct trdekho slot
 * for this page — varies per show), and the trdekho= indices present on the page
 * (excluding HydraX/abyssplayer). Use this to avoid blind 0-24 trdekho scanning
 * which causes wrong CDN content from non-existent slots.
 *
 * IMPORTANT: neoCdnMythUrl must be passed directly to getNeoCdnStreams — it contains
 * the HydraX trdekho slot index for this specific show (e.g. trdekho=0 for Liar Game,
 * trdekho=1 for Shinchan). Using a hardcoded trdekho=1 breaks NeoCDN for any show
 * where HydraX is mapped to a different slot.
 */
export function parsePageServers(html: string): { hasNeocdn: boolean; neoCdnMythUrl: string | null; trdekhoIndices: number[] } {
  const buttons = decodeServerButtons(html);
  let hasNeocdn = false;
  let neoCdnMythUrl: string | null = null;
  const trdekhoIndices: number[] = [];
  for (const { url, name } of buttons) {
    if (url.includes("/aaa/myth/play.php")) {
      hasNeocdn = true;
      neoCdnMythUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
      continue;
    }
    const lname = name.toLowerCase();
    if (url.includes("abyssplayer.com") || url.includes("abysscdn.com") || lname.includes("hydrax") || lname.includes("abyss")) continue;
    if (url.includes("?trdekho=")) {
      const m = url.match(/[?&]trdekho=(\d+)/);
      if (m) trdekhoIndices.push(parseInt(m[1]!, 10));
    }
  }
  return { hasNeocdn, neoCdnMythUrl, trdekhoIndices };
}

export async function getVidStreamIframes(episodeUrl: string): Promise<{ iframes: string[]; hasNeocdn: boolean; neoCdnMythUrl: string | null; trdekhoIndices: number[] }> {
  const empty = { iframes: [] as string[], hasNeocdn: false, neoCdnMythUrl: null as string | null, trdekhoIndices: [] as number[] };
  try {
    const html = await fetchText(episodeUrl, { timeout: 7000, headers: { Cookie: "toronites_server=vidstream" } });
    const $ = cheerio.load(html);
    const providerUrls: string[] = [];
    const seen = new Set<string>();

    // Collect any static server iframe already rendered on the page (active server embed)
    $("iframe.serversel[src], iframe[src]").each((_, el) => {
      const src = ($(el).attr("src") || "").trim();
      if (!src) return;
      const normalized = src.startsWith("//") ? "https:" + src : src;
      if (normalized.includes("animedekho.app/embed/") && !seen.has(normalized)) { seen.add(normalized); providerUrls.push(normalized); }
    });

    // Parse server buttons — the ground truth of what players exist on this page.
    // We use this to build the exact trdekho= index list and detect NeoCDN,
    // instead of blindly scanning trdekho=0..24 (which causes wrong CDN content
    // from slots that don't exist for this episode).
    const { hasNeocdn, neoCdnMythUrl, trdekhoIndices } = parsePageServers(html);
    const serverButtons = decodeServerButtons(html);
    logger.info(
      { episodeUrl, servers: serverButtons.map((s) => s.name), trdekhoIndices, hasNeocdn, neoCdnMythUrl },
      "AnimeDekho: page server buttons",
    );

    // Add non-trdekho, non-NeoCDN embed URLs from the server button list
    for (const { url, name } of serverButtons) {
      if (seen.has(url)) continue;
      if (url.includes("/aaa/myth/play.php")) continue; // NeoCDN: handled by getNeoCdnStreams
      const lname = name.toLowerCase();
      if (url.includes("abyssplayer.com") || url.includes("abysscdn.com") || lname.includes("hydrax") || lname.includes("abyss")) continue;
      if (url.includes("?trdekho=")) continue; // trdekho slots: handled by getTrdekhoIframes
      seen.add(url);
      providerUrls.push(url);
    }

    const innerIframes: string[] = [];
    const innerSeen = new Set<string>();
    await Promise.allSettled(providerUrls.map(async (providerUrl) => {
      try {
        const pageHtml = await fetchText(providerUrl, { timeout: 8000, headers: { Referer: episodeUrl, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
        if (isEmbedErrorPage(pageHtml)) return;
        const $page = cheerio.load(pageHtml);
        $page("iframe[src]").each((_, el) => {
          const src = ($page(el).attr("src") || "").trim();
          if (!src.startsWith("http")) return;
          if (src.includes("youtube.com") || src.includes("youtu.be") || src.includes("vimeo.com") || src.includes("animedekho.app/aaa/")) return;
          if (src.includes("abyssplayer.com") || src.includes("abysscdn.com")) return;
          if (!innerSeen.has(src)) { innerSeen.add(src); innerIframes.push(src); }
        });
        if (!innerSeen.size) {
          const cdnPattern = /["'](https?:\/\/[^"'\s]+(?:as-cdn21\.top|zephyrflick\.top|awstream\.net)[^"'\s]*?)["']/g;
          for (const m of pageHtml.matchAll(cdnPattern)) {
            if (!innerSeen.has(m[1])) { innerSeen.add(m[1]); innerIframes.push(m[1]); }
          }
        }
      } catch (err) { logger.debug({ providerUrl, err }, "VidStream provider fetch error"); }
    }));
    return { iframes: innerIframes, hasNeocdn, neoCdnMythUrl, trdekhoIndices };
  } catch (err) { logger.error({ episodeUrl, err }, "getVidStreamIframes error"); return empty; }
}

/**
 * Fetches iframes for the given trdekho slot indices.
 * Pass only the indices explicitly found on the episode/movie page via parsePageServers()
 * to avoid fetching non-existent slots that return wrong CDN content.
 */
export async function getTrdekhoIframes(term: string, mediaType: number, indices: number[]): Promise<string[]> {
  if (indices.length === 0) return [];
  const results = await Promise.allSettled(
    indices.map((i) => {
      const url = `${BASE_URL}/?trdekho=${i}&trid=${term}&trtype=${mediaType}`;
      return fetchDoc(url, { timeout: 8000 }).then(($) => {
        const src = $("iframe[src]").first().attr("src")?.trim() || $("iframe[data-src]").first().attr("data-src")?.trim();
        if (src && (src.startsWith("http") || src.startsWith("//"))) return src.startsWith("//") ? "https:" + src : src;
        return null;
      });
    })
  );
  const seen = new Set<string>();
  const iframes: string[] = [];
  results.forEach((r, pos) => {
    if (r.status === "fulfilled" && r.value) {
      if (!seen.has(r.value)) { seen.add(r.value); iframes.push(r.value); logger.info({ i: indices[pos], src: r.value }, "trdekho iframe found"); }
    }
  });
  return iframes;
}

export interface NeoCdnSource {
  /** Worker-wrapped URL (primary). Uses AnimeDekho's Cloudflare Worker to proxy the raw trycloudflare URL. */
  url: string;
  /** Raw trycloudflare.com URL before worker wrapping. Provided as a fallback for when the
   *  Cloudflare Worker throws Error 1101. Residential IPs (user devices) can usually access
   *  trycloudflare URLs directly even if data-center IPs (our server) get 403. */
  rawUrl?: string;
  size: string;
  type: string;
}

/**
 * Fetches NeoCDN streams for an episode via animedekho.app/aaa/myth/play.php.
 *
 * Flow:
 *  1. Build myth/play.php URL wrapping the trdekho=1 endpoint for the given term.
 *  2. Fetch with toronites_server=vidstream cookie (same unlock mechanism as VidStream).
 *  3. Extract the /aaa/myth/fetch.php?id=... from the inline script.
 *  4. Fetch that endpoint — returns JSON { sources: [{url, size, type}] }.
 *  5. Sources are direct Cloudflare Tunnel MP4 URLs (360p, 720p).
 *
 * Fetches NeoCDN (myth player) streams using the full myth URL parsed directly
 * from the page's NeoCDN server button. The myth URL encodes the HydraX trdekho
 * slot for this specific show — do NOT reconstruct it with a hardcoded trdekho=1,
 * as the HydraX slot varies per show (e.g. trdekho=0 for Liar Game).
 */
export async function getNeoCdnStreams(
  mythUrl: string,
  referer: string,
): Promise<NeoCdnSource[]> {
  try {
    const mythHtml = await fetchText(mythUrl, {
      timeout: 12000,
      headers: {
        Cookie: "toronites_server=vidstream",
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const fetchId = mythHtml.match(/myth\/fetch\.php\?id=([^"'\s\\]+)/)?.[1];
    if (!fetchId) {
      logger.warn({ mythUrl }, "getNeoCdnStreams: no fetch ID in myth player");
      return [];
    }

    // Always use the hardcoded known-good worker to proxy trycloudflare.com source URLs.
    //
    // The myth player MUST proxy raw trycloudflare.com URLs through a Cloudflare Worker —
    // direct trycloudflare.com URLs error when played in Stremio.
    //
    // We do NOT probe the page's embedded worker URL because HEAD probes are unreliable:
    // a dead CF Worker can respond 2xx/3xx to HEAD while still returning 530 on actual
    // GET playback requests (CF handles HEAD at the edge before the Worker script runs).
    // The hardcoded fallback is user-verified working; update it here if it ever rotates.
    const ACTIVE_WORKER_URL = "https://jolly-salad-69ad.zenhashi.workers.dev/?url=";

    // Log the page's worker URL for future reference / debugging, but don't use it.
    const pageWorkerUrl = mythHtml.match(/const\s+worker\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
    logger.info({ mythUrl, pageWorkerUrl: pageWorkerUrl || "(none)", activeWorker: ACTIVE_WORKER_URL }, "getNeoCdnStreams: using hardcoded worker");

    const fetchEndpoint = `${BASE_URL}/aaa/myth/fetch.php?id=${fetchId}`;
    const fetchRaw = await fetchText(fetchEndpoint, {
      timeout: 12000,
      headers: {
        Referer: mythUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const data = JSON.parse(fetchRaw) as { sources?: NeoCdnSource[] };
    if (!data.sources?.length) {
      logger.warn({ mythUrl, fetchId }, "getNeoCdnStreams: empty sources from fetch.php");
      return [];
    }

    // Wrap every source URL through the active worker so Stremio can play it.
    // Also preserve the original trycloudflare.com URL as `rawUrl` — residential IP
    // devices (phones, home routers) can often reach trycloudflare URLs directly.
    const sources: NeoCdnSource[] = data.sources.map((s) => ({
      ...s,
      rawUrl: s.url,
      url: ACTIVE_WORKER_URL + encodeURIComponent(s.url),
    }));

    logger.info({ mythUrl, count: sources.length, activeWorker: ACTIVE_WORKER_URL }, "getNeoCdnStreams: success");
    return sources;
  } catch (err) {
    logger.warn({ mythUrl, err }, "getNeoCdnStreams error");
    return [];
  }
}

export async function getEpisodePageIframes(episodeUrl: string): Promise<string[]> {
  try {
    const html = await fetchText(episodeUrl, { timeout: 8000 });
    const $ = cheerio.load(html);
    const iframes: string[] = [];
    const seen = new Set<string>();
    $("iframe[src], iframe[data-src]").each((_, el) => {
      const raw = ($(el).attr("src") || $(el).attr("data-src") || "").trim();
      if (!raw) return;
      const src = raw.startsWith("//") ? "https:" + raw : raw;
      if (!src.startsWith("http")) return;
      if (src.includes("animedekho.app/aaa/") || src === "about:blank" || src === "javascript:void(0)") return;
      if (src.includes("youtube.com/embed") || src.includes("youtu.be/") || src.includes("player.vimeo.com") || src.includes("facebook.com/plugins") || src.includes("twitter.com/") || src.includes("dailymotion.com/embed")) return;
      if (!seen.has(src)) { seen.add(src); iframes.push(src); }
    });
    return iframes;
  } catch (err) { logger.warn({ episodeUrl, err }, "getEpisodePageIframes error"); return []; }
}
