import axios from "axios";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { logger } from "../../lib/logger.js";
import { makeProxiedUrl } from "../../lib/proxy-fetch.js";

const BASE_URL = "https://www.rareanimes.buzz";
const ATOON_BASE = "https://store.animetoonhindi.com";

const axiosClient = axios.create();
axiosClient.interceptors.request.use((config) => {
  const rawUrl = config.url ?? "";
  const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${config.baseURL ?? ""}${rawUrl}`;
  const proxied = makeProxiedUrl(fullUrl);
  if (proxied !== fullUrl) {
    config.url = proxied;
    config.baseURL = "";
  }
  return config;
});
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface CatalogMeta {
  id: string;
  type: "series" | "movie";
  name: string;
  poster?: string;
  description?: string;
  /** The canonical base slug (without season suffix) used for grouping */
  slug: string;
  pageUrl: string;
}

export interface SeasonEntry {
  season: number;
  /** Full slug on rareanimes.buzz  e.g. "shinchan-season-1-hindi-episodes" */
  slug: string;
  poster?: string;
  title?: string;
}

export interface EpisodeLink {
  episodeNumber: number;
  title: string;
  codedewUrl: string;
}

export interface FullMeta {
  title: string;
  poster?: string;
  background?: string;
  description?: string;
  genres?: string[];
  year?: string;
}

export interface AtoonCatalogItem {
  id: string;
  type: "series" | "movie";
  name: string;
  archiveId: number;
  archiveUrl: string;
  archiveTitle: string;
  poster?: string;
}

// ─── Season map: baseSlug → ordered seasons ───────────────────────────────────
// Populated by getAllCatalogItems(); consumed by stremio.ts
export const seasonMap = new Map<string, SeasonEntry[]>();

// ─── Atoon show map: showSlug → ordered seasons (archiveId per season) ────────
// Populated by buildAtoonCatalog(); consumed by stremio.ts
export interface AtoonSeasonEntry {
  season: number;
  archiveId: number;
  archiveTitle: string;
  poster?: string;
}
export const atoonShowMap = new Map<string, AtoonSeasonEntry[]>();

// ─── Episode link cache ───────────────────────────────────────────────────────
const episodeLinkCache = new Map<string, { data: EpisodeLink[]; ts: number }>();
const EP_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// ─── Session management ───────────────────────────────────────────────────────
// animetoonhindi.com blocks direct access — must arrive from rareanimes.buzz.

let rareCookies = "";
let rareCookieTime = 0;
const COOKIE_TTL = 25 * 60 * 1000;

async function getRareCookies(): Promise<string> {
  const now = Date.now();
  if (rareCookies && now - rareCookieTime < COOKIE_TTL) return rareCookies;
  try {
    const res = await axiosClient.get(BASE_URL + "/", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: 15000,
      maxRedirects: 5,
    });
    const sc = res.headers["set-cookie"];
    rareCookies = Array.isArray(sc)
      ? sc.map((c: string) => c.split(";")[0]).join("; ")
      : typeof sc === "string"
        ? (sc as string).split(";")[0]
        : "";
    rareCookieTime = now;
  } catch {
    /* ignore */
  }
  return rareCookies;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await axiosClient.get(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer || BASE_URL + "/",
    },
    timeout: 20000,
    maxRedirects: 6,
  });
  return res.data as string;
}

async function fetchAtoon(url: string): Promise<string> {
  const cookies = await getRareCookies();
  const res = await axiosClient.get(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: BASE_URL + "/",
      Origin: BASE_URL,
      ...(cookies ? { Cookie: cookies } : {}),
    },
    timeout: 20000,
    maxRedirects: 6,
  });
  return res.data as string;
}

// ─── Title / slug helpers ─────────────────────────────────────────────────────

function cleanTitle(title: string): string {
  return title
    .replace(/\s*[-–|]\s*Rare (?:Toons|Animes?) India.*$/i, "")
    .replace(/\s*[-–|]\s*rareanimes\.buzz.*$/i, "")
    .replace(/\s*[-–|]\s*Rare Toons.*$/i, "")
    .replace(/\s*[-–|]\s*Linker.*$/i, "")
    .replace(/\s*Download.*$/i, "")
    .replace(/\s*Episodes?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/[-–](?:hindi|tamil|telugu)(?:[-–].+)?$/i, "")
    .replace(/[-–]episodes?$/i, "")
    .replace(/[-–](?:download|watch|in-hd|hd|fhd|1080p|720p)(?:[-–].+)?$/i, "")
    .replace(/-/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectType(slug: string): "series" | "movie" {
  if (/\b(?:film|movie)\b/i.test(slug) && !/\bseason\b/i.test(slug)) return "movie";
  return "series";
}

export function slugFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.replace(/^\/|\/$/g, "").split("/");
    return parts[parts.length - 1] || "";
  } catch {
    return url.match(/\/([^/]+)\/?$/)?.[1] || "";
  }
}

/**
 * Extract the base show slug and season number from a full slug.
 *
 * Examples:
 *   shinchan-season-1-hindi-episodes  → { base: "shinchan",             season: 1 }
 *   naruto-shippuden-season-2-dubbed  → { base: "naruto-shippuden",     season: 2 }
 *   shinchan-hindi-episodes           → { base: "shinchan",             season: 1 }
 *   doraemon-movie-2020               → { base: "doraemon-movie-2020",  season: 1 }
 */
export function extractShowGroup(slug: string): {
  baseSlug: string;
  season: number;
} {
  // Slug has an explicit season number → strip it to get base show name
  const seasonMatch = slug.match(/^(.*?)-season-?0*(\d+)/i);
  if (seasonMatch) {
    const prefix = seasonMatch[1]
      .replace(/[-–](?:hindi|tamil|telugu|dubbed)$/i, "")
      .replace(/-+$/, "");
    const season = parseInt(seasonMatch[2], 10);
    return { baseSlug: prefix || seasonMatch[1], season };
  }

  // No explicit season — strip common language/episode/download suffixes so
  // e.g. "shinchan-hindi-episodes" → "shinchan" and groups with
  //      "shinchan-season-1-hindi-episodes"
  const baseSlug = slug
    .replace(/[-–](?:all[-–]seasons?|complete[-–]series)(?:[-–].+)?$/i, "")
    .replace(
      /[-–](?:hindi|tamil|telugu)(?:[-–](?:dubbed|episodes?|download))*(?:[-–].+)?$/i,
      ""
    )
    .replace(/[-–](?:dubbed|episodes?)(?:[-–].+)?$/i, "")
    .replace(/[-–](?:download|watch|in[-–]hd|hd|fhd|1080p|720p)(?:[-–].+)?$/i, "")
    .replace(/-+$/, "");

  return { baseSlug: baseSlug || slug, season: 1 };
}

/** Return a human-friendly show name from its base slug + season list */
function deriveShowName(baseSlug: string, seasons: SeasonEntry[]): string {
  // Prefer the first season's page title if available
  const firstTitle =
    seasons.find((s) => s.title)?.title ||
    seasons[0]?.title;

  if (firstTitle) {
    // Strip season / number suffixes from the title
    return cleanTitle(firstTitle)
      .replace(/\s+Season\s+\d+.*/i, "")
      .replace(/\s+S\d+.*/i, "")
      .trim();
  }

  return slugToTitle(baseSlug);
}

// ─── rareanimes.buzz — article parser ─────────────────────────────────────────

function parseArticlesFromPage(
  html: string,
  baseLabel: string
): Array<{ slug: string; poster?: string; title?: string }> {
  const $ = cheerio.load(html);
  const results: Array<{ slug: string; poster?: string; title?: string }> = [];
  const seen = new Set<string>();

  $("article, .hentry, .post, .entry, .herald-post-list-item, .post-item").each(
    (_idx: number, el: AnyNode) => {
      const $el = $(el);
      const linkEl = $el
        .find("a[href]")
        .filter((_i: number, a: AnyNode) => {
          const href = $(a).attr("href") || "";
          return href.includes(BASE_URL) || href.includes("/hindi/");
        })
        .first();

      const href = linkEl.attr("href") || "";
      if (!href) return;
      const slug = slugFromUrl(href);
      if (!slug || slug.length < 4 || seen.has(slug)) return;
      seen.add(slug);

      const imgEl = $el.find("img").first();
      const poster =
        imgEl.attr("src") ||
        imgEl.attr("data-src") ||
        imgEl.attr("data-lazy-src") ||
        imgEl.attr("data-original") ||
        undefined;

      const titleEl = $el
        .find("h2 a, h3 a, .entry-title a, h2, h3, .entry-title")
        .first();
      const title = titleEl.text().trim() || undefined;

      results.push({
        slug,
        poster: poster && poster.startsWith("http") ? poster : undefined,
        title,
      });
    }
  );

  if (results.length === 0) {
    const re = /href="https?:\/\/(?:www\.)?rareanimes\.buzz\/hindi\/([^"/?#]+)\/"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        results.push({ slug: m[1] });
      }
    }
  }

  logger.info({ url: baseLabel, count: results.length }, "[Scraper] Articles parsed");
  return results;
}

async function scrapeAllPages(
  categoryBaseUrl: string,
  seenSlugs: Set<string>,
  maxPages = 200
): Promise<Array<{ slug: string; poster?: string; title?: string }>> {
  const all: Array<{ slug: string; poster?: string; title?: string }> = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      page === 1
        ? categoryBaseUrl
        : `${categoryBaseUrl.replace(/\/$/, "")}/page/${page}/`;
    try {
      const html = await fetchHtml(url);
      const articles = parseArticlesFromPage(html, url);
      if (articles.length === 0) break;

      let added = 0;
      for (const a of articles) {
        if (!seenSlugs.has(a.slug)) {
          seenSlugs.add(a.slug);
          all.push(a);
          added++;
        }
      }
      if (added === 0 && page > 2) break;
    } catch {
      break;
    }
  }
  return all;
}

// ─── rareanimes.buzz — Full Catalog (with season grouping) ───────────────────

let catalogCache: CatalogMeta[] | null = null;
let catalogCacheTime = 0;
const CATALOG_TTL = 30 * 60 * 1000;

// Singleton build promise — prevents concurrent catalog builds from corrupting the seasonMap
let catalogBuildInFlight: Promise<CatalogMeta[]> | null = null;

export async function getAllCatalogItems(): Promise<CatalogMeta[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCacheTime < CATALOG_TTL) return catalogCache;

  // If a build is already running:
  //  - If we have stale cache, return it immediately so requests don't block.
  //  - If we have nothing yet, we must wait for the first build to finish.
  if (catalogBuildInFlight) {
    if (catalogCache) return catalogCache;
    return catalogBuildInFlight;
  }

  catalogBuildInFlight = _buildCatalog().finally(() => { catalogBuildInFlight = null; });

  // If we already have stale data, serve it immediately while the rebuild runs in background.
  if (catalogCache) return catalogCache;
  return catalogBuildInFlight;
}

async function _buildCatalog(): Promise<CatalogMeta[]> {
  const now = Date.now();

  logger.info("[Scraper] Building full catalog from rareanimes.buzz");

  // Clear per-show season discovery cache so fresh probing happens after rebuild
  discoveredSeasonsCache.clear();
  // Allow cross-source merge to run again after this rebuild
  crossSourceMergeBuilt = false;

  const seenSlugs = new Set<string>();
  const allArticles: Array<{ slug: string; poster?: string; title?: string }> = [];

  // Per-section max-page limits:
  //  - anime/series categories can have many pages; cap at 100 (800 items) 
  //  - movies categories are capped at 30 pages (240 items) to keep build fast
  //  - root homepage / hindi-dubbed are small, 20 pages is plenty
  const sections: Array<[string, number]> = [
    [BASE_URL + "/category/hindi-dubbed/", 20],
    [BASE_URL + "/category/anime/", 100],
    [BASE_URL + "/category/cartoons/", 50],
    [BASE_URL + "/category/movies/", 30],
    [BASE_URL + "/category/anime-movies/", 20],
    [BASE_URL + "/", 5],
  ];

  // Popular shows — site-search to catch ALL season slugs regardless of URL pattern
  // This is needed because shows like Shinchan/Doraemon have inconsistent URL suffixes
  // across seasons, which category scraping alone misses.
  const POPULAR_SHOW_SEARCHES = [
    "shinchan season hindi", "doraemon season hindi",
    "naruto season hindi", "naruto shippuden season hindi",
    "pokemon season hindi", "dragon ball season hindi",
    "one piece season hindi", "bleach season hindi",
    "boruto season hindi", "beyblade season hindi",
  ];

  await Promise.allSettled([
    ...sections.map(async ([sectionUrl, maxPages]) => {
      const articles = await scrapeAllPages(sectionUrl, seenSlugs, maxPages);
      allArticles.push(...articles);
    }),
    ...POPULAR_SHOW_SEARCHES.map(async (q) => {
      try {
        const url = `${BASE_URL}/?s=${encodeURIComponent(q)}`;
        for (let p = 1; p <= 10; p++) {
          const pageUrl = p === 1 ? url : `${url}&paged=${p}`;
          const html = await fetchHtml(pageUrl);
          const found = parseArticlesFromPage(html, `search:${q}:p${p}`);
          if (found.length === 0) break;
          for (const a of found) {
            if (!seenSlugs.has(a.slug)) { seenSlugs.add(a.slug); allArticles.push(a); }
          }
        }
      } catch { /* ignore */ }
    }),
  ]);

  // ── Build the seasonMap ────────────────────────────────────────────────────
  seasonMap.clear();
  for (const article of allArticles) {
    if (article.slug.length <= 5) continue;
    const { baseSlug, season } = extractShowGroup(article.slug);
    if (!seasonMap.has(baseSlug)) seasonMap.set(baseSlug, []);
    const existing = seasonMap.get(baseSlug)!;
    if (!existing.some((e) => e.slug === article.slug)) {
      existing.push({
        season,
        slug: article.slug,
        poster: article.poster,
        title: article.title,
      });
    }
  }
  for (const seasons of seasonMap.values()) {
    seasons.sort((a, b) => a.season - b.season);
  }

  // ── Apply hard-coded season slug overrides ─────────────────────────────────
  for (const [baseSlug, overrides] of Object.entries(SEASON_SLUG_OVERRIDES)) {
    if (!seasonMap.has(baseSlug)) seasonMap.set(baseSlug, []);
    const existing = seasonMap.get(baseSlug)!;
    for (const override of overrides) {
      const idx = existing.findIndex((e) => e.season === override.season);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], slug: override.slug };
      } else {
        existing.push({ season: override.season, slug: override.slug, poster: undefined, title: undefined });
      }
    }
    existing.sort((a, b) => a.season - b.season);
  }

  // ── One catalog entry per unique baseSlug ──────────────────────────────────
  const items: CatalogMeta[] = [];
  const seenBase = new Set<string>();

  for (const article of allArticles) {
    if (article.slug.length <= 5) continue;
    const { baseSlug } = extractShowGroup(article.slug);
    if (seenBase.has(baseSlug)) continue;
    seenBase.add(baseSlug);

    const seasons = seasonMap.get(baseSlug) || [];
    const poster = seasons.find((s) => s.poster)?.poster;
    const name = deriveShowName(baseSlug, seasons);

    items.push({
      id: `rareanime:${baseSlug}`,
      type: detectType(baseSlug),
      name,
      poster,
      slug: baseSlug,
      pageUrl: `${BASE_URL}/hindi/${seasons[0]?.slug || baseSlug}/`,
    });
  }

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "series" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // ── Streamability filter ──────────────────────────────────────────────────
  // Remove shows/movies whose first page has zero codedew MQ/zipper links.
  // These are quickcloud-only, mega-only, or gdrive-only — not playable.
  // Run all checks in parallel (capped at 40 concurrent) with a 20s overall budget.
  const streamableItems: CatalogMeta[] = [];
  try {
    await Promise.race([
      runWithConcurrency(items, 40, async (item) => {
        const baseSlug = item.id.replace(/^rareanime:/, "");

        // Apply cached poster if item is missing one
        if (!item.poster && posterCache.has(baseSlug)) {
          item.poster = posterCache.get(baseSlug);
        }

        if (streamabilityCache.has(baseSlug)) {
          if (streamabilityCache.get(baseSlug)) streamableItems.push(item);
          return;
        }
        const seasons = seasonMap.get(baseSlug) || [];
        const firstSlug = seasons[0]?.slug || baseSlug;
        try {
          const html = await Promise.race([
            fetchHtml(`${BASE_URL}/hindi/${firstSlug}/`),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("page timeout")), 4000)),
          ]);
          // Extract and cache poster from page if item has none
          if (!item.poster) {
            const extracted = extractPosterFromHtml(html ?? "");
            if (extracted) {
              item.poster = extracted;
              posterCache.set(baseSlug, extracted);
            }
          } else {
            // Still cache the poster for future builds
            posterCache.set(baseSlug, item.poster);
          }
          const ok = MQ_STREAMABLE_RE.test(html ?? "");
          streamabilityCache.set(baseSlug, ok);
          if (ok) streamableItems.push(item);
          else logger.info({ baseSlug }, "[Scraper] Catalog: removed non-streamable entry");
        } catch {
          // On fetch error, include the item (fail open)
          streamabilityCache.set(baseSlug, true);
          streamableItems.push(item);
        }
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 20_000)),
    ]);
  } catch {
    // Overall timeout — serve whatever was checked so far, include unchecked items
    logger.warn("[Scraper] Streamability check timed out, using partial filter");
    for (const item of items) {
      const baseSlug = item.id.replace(/^rareanime:/, "");
      if (!streamabilityCache.has(baseSlug) || streamabilityCache.get(baseSlug)) {
        if (!streamableItems.some((s) => s.id === item.id)) streamableItems.push(item);
      }
    }
  }

  streamableItems.sort((a, b) => {
    if (a.type !== b.type) return a.type === "series" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  logger.info(
    { total: streamableItems.length, filtered: items.length - streamableItems.length, uniqueShows: seenBase.size },
    "[Scraper] Catalog built"
  );
  catalogCache = streamableItems;
  catalogCacheTime = now;
  // Build cross-source merge (runs only when both catalogs are populated)
  buildCrossSourceMerge();

  // ── Background poster top-up ──────────────────────────────────────────────
  // Items that timed out during the streamability budget may still lack posters.
  // Fill them in asynchronously so it never delays the catalog response.
  const missingPosterItems = streamableItems.filter((item) => !item.poster);
  if (missingPosterItems.length > 0) {
    setImmediate(async () => {
      logger.info({ count: missingPosterItems.length }, "[Scraper] Background poster top-up started");
      await runWithConcurrency(missingPosterItems, 5, async (item) => {
        const baseSlug = item.id.replace(/^rareanime:/, "");
        if (posterCache.has(baseSlug)) { item.poster = posterCache.get(baseSlug); return; }
        const seasons = seasonMap.get(baseSlug) || [];
        const firstSlug = seasons[0]?.slug || baseSlug;
        try {
          const html = await Promise.race([
            fetchHtml(`${BASE_URL}/hindi/${firstSlug}/`),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
          ]);
          const extracted = extractPosterFromHtml(html ?? "");
          if (extracted) {
            item.poster = extracted;
            posterCache.set(baseSlug, extracted);
          }
        } catch { /* ignore */ }
      });
      logger.info("[Scraper] Background poster top-up done");
    });
  }

  return streamableItems;
}

// ─── Cross-source merge ───────────────────────────────────────────────────────
// Identifies atoon shows that have a matching rareanimes show so we can:
//   1. Suppress the atoon entry from the catalog (avoid duplicate show cards)
//   2. Pre-warm atoonPageCache so fallback lookups are instant

/** Slugs in atoonShowMap that are covered by a rareanime entry */
export const mergedAtoonSlugs = new Set<string>();
/** Maps rareanimes base slug → atoon show slug, built by buildCrossSourceMerge */
export const rareBaseToAtoonSlug = new Map<string, string>();
let crossSourceMergeBuilt = false;

/** Normalize a slug for fuzzy cross-source matching (removes separators) */
function normalizeSlugForMatch(s: string): string {
  return s.replace(/[-\s._]+/g, "").toLowerCase();
}

/**
 * Matches atoon shows to rareanime shows by normalized slug comparison.
 * Pre-populates atoonPageCache for every matched season so that
 * findAndScrapeAtoonEpisodes() can skip its network search and immediately
 * return the right archive's episodes.
 * Safe to call multiple times; exits early if already built or if either
 * catalog hasn't been populated yet.
 */
export function buildCrossSourceMerge(): void {
  if (crossSourceMergeBuilt) return;
  if (seasonMap.size === 0 || atoonShowMap.size === 0) return;

  const normAtoonMap = new Map<string, string>(); // normalized → atoonSlug
  for (const atoonSlug of atoonShowMap.keys()) {
    normAtoonMap.set(normalizeSlugForMatch(atoonSlug), atoonSlug);
  }

  mergedAtoonSlugs.clear();
  let matched = 0;

  // Build a quick slug → poster lookup from the rareanimes.buzz catalog
  const rareSlugToPoster = new Map<string, string>();
  if (catalogCache) {
    for (const item of catalogCache) {
      if (item.poster && item.slug) rareSlugToPoster.set(item.slug, item.poster);
    }
  }

  // Build a quick atoonSlug → AtoonCatalogItem lookup so we can inject posters
  const atoonSlugToItem = new Map<string, AtoonCatalogItem>();
  if (atoonCatalogCache) {
    for (const item of atoonCatalogCache) {
      const slug = item.id.replace(/^atoon:/, "");
      atoonSlugToItem.set(slug, item);
    }
  }

  for (const rareSlug of seasonMap.keys()) {
    const normRare = normalizeSlugForMatch(rareSlug);
    const atoonSlug = normAtoonMap.get(normRare);
    if (!atoonSlug) continue;

    mergedAtoonSlugs.add(atoonSlug);
    rareBaseToAtoonSlug.set(rareSlug, atoonSlug);
    matched++;

    // Copy rareanimes.buzz poster to atoon catalog item (which has no own poster)
    const poster = rareSlugToPoster.get(rareSlug);
    if (poster) {
      const atoonItem = atoonSlugToItem.get(atoonSlug);
      if (atoonItem && !atoonItem.poster) {
        atoonItem.poster = poster;
        // Also copy to every season entry in the show map
        const seasons = atoonShowMap.get(atoonSlug);
        if (seasons) seasons.forEach((s) => { if (!s.poster) s.poster = poster; });
      }
    }

    const atoonSeasons = atoonShowMap.get(atoonSlug)!;
    const suffixes = [
      "",
      "-hindi-episodes",
      "-hindi-episodes-download",
      "-hindi-episodes-download-in-hd",
      "-hindi-dubbed-episodes",
      "-hindi-dubbed-episodes-download",
      "-hindi",
    ];

    for (const atoonSeason of atoonSeasons) {
      for (const suffix of suffixes) {
        const key = `${rareSlug}-season-${atoonSeason.season}${suffix}`;
        if (!atoonPageCache.has(key)) {
          atoonPageCache.set(key, `${ATOON_BASE}/archives/${atoonSeason.archiveId}`);
        }
      }
      // Also pre-warm with the plain base-slug key (used by movies / season-less lookups)
      if (!atoonPageCache.has(rareSlug)) {
        atoonPageCache.set(rareSlug, `${ATOON_BASE}/archives/${atoonSeasons[0].archiveId}`);
      }
    }
    logger.info({ rareSlug, atoonSlug, seasons: atoonSeasons.length }, "[Scraper] Cross-source: atoon merged into rareanime");
  }

  crossSourceMergeBuilt = true;
  logger.info({ merged: matched, atoonTotal: atoonShowMap.size }, "[Scraper] Cross-source merge complete");
}

/** Return all season slugs for a base show, sorted by season number */
export function getSeasonSlugs(baseSlug: string): SeasonEntry[] {
  return seasonMap.get(baseSlug) ?? [];
}

// Cache: baseSlug → full discovered season list (catalog + probed)
// Cleared whenever getAllCatalogItems() rebuilds.
const discoveredSeasonsCache = new Map<string, SeasonEntry[]>();

// Common URL suffix patterns used across seasons on rareanimes.buzz.
// Different seasons of the same show often have different suffixes (e.g. S1 uses
// "-hindi-episodes" but S9 uses "-hindi-episodes-download-in-hd").
// We always probe all of these so we never miss a season just because its
// suffix wasn't seen in the already-known slugs.
/**
 * Hard-coded season slug overrides for shows where URL discovery fails
 * (e.g. probe timeouts during catalog build, non-standard URL patterns).
 * These take precedence over anything found by scraping or probing.
 */
const SEASON_SLUG_OVERRIDES: Record<string, Array<{ season: number; slug: string }>> = {
  shinchan: [
    { season: 9,  slug: "shinchan-season-9-hindi-episodes-download-in-hd" },
    { season: 10, slug: "shinchan-season-10-hindi-episodes-download" },
    // season 11 slug 301-redirects to season 16 on rareanimes.buzz — omitted intentionally
    { season: 16, slug: "shinchan-season-16-hindi-episodes-download-in-hd" },
    { season: 18, slug: "shinchan-season-18-hindi-episodes-download-in-hd" },
    { season: 19, slug: "shinchan-season-19-hindi-episodes-download-in-hd" },
  ],
};

/** Cache of per-page streamability checks (slug → has MQ/zipper links) */
const streamabilityCache = new Map<string, boolean>();
const MQ_STREAMABLE_RE = /codedew\.com\/(?:multiquality|zipper)\//i;

/** Cache of poster URLs extracted from show pages (slug → poster URL) */
const posterCache = new Map<string, string>();

/** Extract best poster URL from a show page's HTML */
function extractPosterFromHtml(html: string): string | undefined {
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch && ogMatch[1].startsWith("http")) return ogMatch[1];
  const wpMatch = html.match(/class=["'][^"']*wp-post-image[^"']*["'][^>]+src=["']([^"']+)["']/i)
    || html.match(/class=["'][^"']*wp-post-image[^"']*["'][^>]+data-src=["']([^"']+)["']/i);
  if (wpMatch && wpMatch[1].startsWith("http")) return wpMatch[1];
  return undefined;
}

/** Run `fn` over all items with at most `concurrency` in-flight at a time */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const COMMON_SEASON_SUFFIXES = [
  "",
  "-hindi-episodes",
  "-hindi-episodes-download",
  "-hindi-episodes-download-hd",
  "-hindi-episodes-download-in-hd",
  "-hindi-dubbed-episodes",
  "-hindi-dubbed-episodes-download",
  "-hindi-dubbed-episodes-download-hd",
  "-hindi-dubbed-episodes-download-fhd",
  "-episodes-hindi",
  "-episodes-hindi-dubbed-download",
  "-episodes-hindi-dubbed-download-hd",
  "-all-episodes-hindi",
  "-hindi",
];

/**
 * Probe for missing season pages using ALL URL patterns inferred from
 * known season slugs (not just the first one). This handles shows like
 * Shinchan where different seasons use different URL suffixes.
 * maxRedirects: 0 is critical — non-existent pages 301-redirect to homepage.
 *
 * Even when no season slugs are known at all for a show, we still probe using
 * the base slug + all common suffix patterns so that seasons hosted directly on
 * rareanimes.buzz (e.g. Shinchan S9-S19) are discovered on-demand.
 */
export async function discoverAllSeasons(
  baseSlug: string,
  knownSeasons: SeasonEntry[]
): Promise<SeasonEntry[]> {
  if (discoveredSeasonsCache.has(baseSlug)) {
    return discoveredSeasonsCache.get(baseSlug)!;
  }

  // Extract ALL unique (prefix, suffix) pairs from slugs that contain a season number
  const templateMap = new Map<string, { prefix: string; suffix: string }>();
  for (const ks of knownSeasons) {
    const m = ks.slug.match(/^(.*?)-season-0*(\d+)(.*?)$/i);
    if (!m) continue;
    const prefix = m[1].replace(/[-–](?:hindi|tamil|telugu|dubbed)$/i, "").replace(/-+$/, "");
    const suffix = m[3];
    const key = `${prefix}||${suffix}`;
    if (!templateMap.has(key)) templateMap.set(key, { prefix: prefix || m[1], suffix });
  }

  // Always add common suffix patterns using the baseSlug as prefix.
  // This ensures seasons with URL suffixes not seen in known slugs are discovered.
  // e.g. shinchan-season-9-hindi-episodes-download-in-hd would only be found
  // via the suffix "-hindi-episodes-download-in-hd" which may not appear in S1-S8.
  for (const suffix of COMMON_SEASON_SUFFIXES) {
    const key = `${baseSlug}||${suffix}`;
    if (!templateMap.has(key)) {
      templateMap.set(key, { prefix: baseSlug, suffix });
    }
  }

  const maxKnown = knownSeasons.length > 0 ? Math.max(...knownSeasons.map((s) => s.season)) : 0;
  const foundNums = new Set(knownSeasons.map((s) => s.season));
  const allResults = [...knownSeasons];

  // Probe ALL missing seasons in parallel (gaps + window above max known).
  // Using parallel probes with a short timeout means this completes in ~4s
  // regardless of how many seasons there are, which keeps meta requests fast.
  // Ceiling raised to maxKnown+8 (cap 30) so shows like Shinchan with 19+
  // seasons are fully discovered even when only S1-S8 are in the catalog.
  const probeTasks: Promise<SeasonEntry | null>[] = [];

  // Helper: build one probe task for a single (slug, season) pair
  const makeProbeTask = (slug: string, nLocal: number, label: string) =>
    (async (): Promise<SeasonEntry | null> => {
      try {
        const res = await axiosClient.get(`${BASE_URL}/hindi/${slug}/`, {
          headers: { "User-Agent": UA, Referer: BASE_URL + "/" },
          timeout: 5000,
          maxRedirects: 0,
          validateStatus: () => true,
          responseType: "text",
        });
        if (res.status === 200) {
          logger.info({ slug, season: nLocal }, `[Scraper] Discovered ${label} on rareanimes`);
          return { season: nLocal, slug, poster: undefined, title: undefined };
        }
      } catch { /* skip */ }
      return null;
    })();

  for (const { prefix, suffix } of templateMap.values()) {
    // Gap seasons (below maxKnown that we haven't seen yet)
    for (let n = 1; n < maxKnown; n++) {
      if (foundNums.has(n)) continue;
      const nLocal = n;
      probeTasks.push(makeProbeTask(`${prefix}-season-${nLocal}${suffix}`, nLocal, "gap season"));
      // Also probe zero-padded (e.g. season-01) for single-digit seasons
      if (nLocal < 10) {
        probeTasks.push(makeProbeTask(`${prefix}-season-0${nLocal}${suffix}`, nLocal, "gap season (zero-padded)"));
      }
    }
    // Seasons above maxKnown — probe up to 8 beyond last known, cap at 30
    const ceiling = Math.min(maxKnown + 8, 30);
    for (let n = maxKnown + 1; n <= ceiling; n++) {
      const nLocal = n;
      probeTasks.push(makeProbeTask(`${prefix}-season-${nLocal}${suffix}`, nLocal, "new season"));
      // Also probe zero-padded for single-digit seasons
      if (nLocal < 10) {
        probeTasks.push(makeProbeTask(`${prefix}-season-0${nLocal}${suffix}`, nLocal, "new season (zero-padded)"));
      }
    }
  }

  const probeResults = await Promise.all(probeTasks);
  for (const r of probeResults) {
    if (r && !foundNums.has(r.season)) { foundNums.add(r.season); allResults.push(r); }
  }

  allResults.sort((a, b) => a.season - b.season);
  logger.info(
    { baseSlug, templates: templateMap.size, total: allResults.length, known: knownSeasons.length },
    "[Scraper] Season discovery complete"
  );

  discoveredSeasonsCache.set(baseSlug, allResults);
  return allResults;
}

// ─── rareanimes.buzz — Search ──────────────────────────────────────────────────

export async function searchCatalog(query: string): Promise<CatalogMeta[]> {
  logger.info({ query }, "[Scraper] Searching rareanimes catalog");
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  try {
    const html = await fetchHtml(searchUrl);
    const $ = cheerio.load(html);
    const results: CatalogMeta[] = [];
    const seen = new Set<string>();

    $("article, .hentry, .post, .herald-article-list article").each(
      (_idx: number, el: AnyNode) => {
        const $el = $(el);
        const titleEl = $el.find("h2 a, h3 a, .entry-title a, h1 a").first();
        const title = titleEl.text().trim();
        const href = titleEl.attr("href") || "";
        if (!title || !href) return;
        const slug = slugFromUrl(href);
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        const { baseSlug } = extractShowGroup(slug);
        if (seen.has(baseSlug)) return;
        seen.add(baseSlug);
        const imgEl = $el.find("img").first();
        const poster =
          imgEl.attr("src") || imgEl.attr("data-src") || undefined;
        results.push({
          id: `rareanime:${baseSlug}`,
          type: detectType(slug),
          name: cleanTitle(title)
            .replace(/\s+Season\s+\d+.*/i, "")
            .trim(),
          poster: poster && poster.startsWith("http") ? poster : undefined,
          slug: baseSlug,
          pageUrl: href,
        });
      }
    );
    return results.slice(0, 30);
  } catch (err) {
    logger.error({ err, query }, "[Scraper] Search failed");
    return [];
  }
}

// ─── rareanimes.buzz — Episode links for a single season page ────────────────

export async function getEpisodeLinks(pageUrl: string): Promise<EpisodeLink[]> {
  const cached = episodeLinkCache.get(pageUrl);
  if (cached && Date.now() - cached.ts < EP_CACHE_TTL) {
    return cached.data;
  }
  logger.info({ pageUrl }, "[Scraper] Fetching episode links");
  try {
    const html = await fetchHtml(pageUrl);
    const links = parseEpisodesFromHtml(html);
    logger.info({ pageUrl, count: links.length }, "[Scraper] Episode links (rareanimes)");
    episodeLinkCache.set(pageUrl, { data: links, ts: Date.now() });
    return links;
  } catch (err) {
    logger.error({ err, pageUrl }, "[Scraper] Failed to fetch episode links");
    return [];
  }
}

/**
 * Returns true for codedew URLs that deliver a real HLS stream.
 * - /multiquality/ → direct player
 * - /zipper/       → HTTP-302 redirect to /multiquality/?url=...  (confirmed behaviour)
 * Excludes quickcloud, quickdrive, doodstream, doquality, etc.
 */
function isEpisodeStreamUrl(url: string): boolean {
  return /codedew\.com\/(?:multiquality|zipper)\//i.test(url);
}

/**
 * Batch-download zipper labels like "ZIP – PIXEL", "ZIP – NF", "ZIP File"
 * appear on season-level download pages (all episodes in one ZIP).
 * These are NOT individual episode stream links — skip them.
 */
function isBatchDownloadLabel(label: string): boolean {
  return /^zip\s*[-–]?\s*(pixel|nf|hd|fhd|uhd|sd|4k|all|file|bulk|1080|720|480)\b/i.test(label)
    || /download\s+all\s+episode/i.test(label);
}

function parseEpisodesFromHtml(html: string): EpisodeLink[] {
  const links: EpisodeLink[] = [];

  // Strategy 1: <hr>-delimited sections — each section is one episode block
  const sections = html.split(/<hr\s*\/?>/i);
  for (const section of sections) {
    const epMatch = section.match(/Episode\s+(\d+)/i);
    if (!epMatch) continue;
    const epNum = parseInt(epMatch[1], 10);
    if (isNaN(epNum)) continue;

    const anchorRe = /href="([^"]*codedew\.com[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const anchors: Array<{ url: string; label: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(section)) !== null) {
      anchors.push({ url: m[1], label: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
    }
    if (anchors.length === 0) continue;

    // Accept both /multiquality/ and /zipper/ links (zipper → multiquality redirect).
    // Exclude non-streaming types (quickcloud, doodstream, etc.) and batch-download labels.
    const streamAnchors = anchors.filter(
      (a) => isEpisodeStreamUrl(a.url) && !isBatchDownloadLabel(a.label)
    );
    const pick =
      streamAnchors.find((a) => /watch|multi/i.test(a.label)) ||
      streamAnchors[0];

    if (pick && !links.some((l) => l.episodeNumber === epNum)) {
      links.push({ episodeNumber: epNum, title: `Episode ${epNum}`, codedewUrl: pick.url });
    }
  }

  // Strategy 2: flat scan (fallback when no hr-sections or "Episode N" text).
  // Accepts both /multiquality/ and /zipper/ episode links.
  if (links.length === 0) {
    const re = /href="(https?:\/\/codedew\.com\/(?:multiquality|zipper)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    let fallbackIdx = 0;
    while ((m = re.exec(html)) !== null) {
      const url = m[1];
      const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (isBatchDownloadLabel(label)) continue;
      const epMatch =
        label.match(/Episode\s*(\d+)/i) ||
        label.match(/Ep\.?\s*(\d+)/i) ||
        label.match(/S\d+E(\d+)/i) ||
        label.match(/\b(\d{1,4})\b/);
      const epNum = epMatch ? parseInt(epMatch[1], 10) : ++fallbackIdx;
      if (isNaN(epNum) || epNum <= 0 || epNum > 9999) continue;
      if (!links.some((l) => l.episodeNumber === epNum)) {
        links.push({ episodeNumber: epNum, title: label || `Episode ${epNum}`, codedewUrl: url });
      }
    }
  }

  links.sort((a, b) => a.episodeNumber - b.episodeNumber);
  return links;
}

// ─── rareanimes.buzz — Page meta ──────────────────────────────────────────────

export async function getPageMeta(pageUrl: string): Promise<FullMeta> {
  try {
    const html = await fetchHtml(pageUrl);
    const $ = cheerio.load(html);

    const rawTitle =
      $("meta[property='og:title']").attr("content") ||
      $("h1.entry-title").text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().trim();
    const title = cleanTitle(rawTitle || "");

    const poster =
      $("meta[property='og:image']").attr("content") ||
      $(".wp-post-image").attr("src") ||
      $(".wp-post-image").attr("data-src") ||
      $(".post-thumbnail img").first().attr("src") ||
      $(".entry-content img[src*='wp-content']").first().attr("src") ||
      $("img[class*='attachment']").first().attr("src") ||
      $(".entry-content img").first().attr("src") ||
      undefined;

    const background = $("meta[property='og:image']").attr("content") || poster;
    const description =
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      $(".entry-content p").first().text().trim().slice(0, 300) ||
      undefined;

    const yearMatch = rawTitle?.match(/\b(19|20)\d{2}\b/);
    const genres: string[] = ["Anime", "Hindi Dubbed"];
    if (/action/i.test(rawTitle || "")) genres.push("Action");
    if (/adventure/i.test(rawTitle || "")) genres.push("Adventure");
    if (/comedy/i.test(rawTitle || "")) genres.push("Comedy");
    if (/dragon.?ball|naruto|bleach|one.?piece|fairy.?tail/i.test(rawTitle || ""))
      genres.push("Shonen");
    if (/movie|film/i.test(rawTitle || "")) genres.push("Movie");

    return {
      title,
      poster: poster && poster.startsWith("http") ? poster : undefined,
      background: background && background.startsWith("http") ? background : undefined,
      description,
      genres,
      year: yearMatch ? yearMatch[0] : undefined,
    };
  } catch (err) {
    logger.error({ err, pageUrl }, "[Scraper] Failed to fetch page meta");
    return { title: "" };
  }
}

// ─── Codedew → Argon ID resolution ───────────────────────────────────────────

export async function resolveCodedewToArgonId(
  codedewUrl: string
): Promise<string | null> {
  logger.info({ codedewUrl }, "[Scraper] Resolving codedew → argon ID");
  try {
    if (codedewUrl.includes("/multiquality/")) {
      return extractArgonIdFromMultiquality(codedewUrl);
    }

    if (codedewUrl.includes("/zipper/")) {
      const res = await axiosClient.get(codedewUrl, {
        headers: { "User-Agent": UA, Referer: BASE_URL + "/" },
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 12000,
      });

      const location = res.headers["location"] as string | undefined;
      if (location) {
        if (/mega\.nz|drive\.google|gdrive/i.test(location)) return null;
        const mq = location.startsWith("http")
          ? location
          : `https://codedew.com${location}`;
        return extractArgonIdFromMultiquality(mq);
      }

      const html = res.data as string;
      const direct = html.match(/argon\.razorshell\.space\/embed\/([^"'&\s/]+)/);
      if (direct) return direct[1];

      const btnMatch =
        html.match(/id="goBtn"[^>]*href="([^"]+)"/) ||
        html.match(/href="([^"]*ad_step[^"]*)"/) ||
        html.match(/class="[^"]*btn[^"]*"[^>]*href="([^"]+)"/);

      if (btnMatch) {
        let adUrl = btnMatch[1].replace(/&amp;/g, "&");
        if (!adUrl.startsWith("http")) adUrl = `https://codedew.com${adUrl}`;
        if (/mega\.nz|drive\.google/i.test(adUrl)) return null;
        if (!adUrl.includes("ad_step=2")) adUrl += "&ad_step=2";

        const res2 = await axiosClient.get(adUrl, {
          headers: {
            "User-Agent": UA,
            Referer: "https://codedew.com/",
            Cookie: `zipper_client_id=${Date.now()}`,
          },
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: 12000,
        });

        const loc2 = res2.headers["location"] as string | undefined;
        if (loc2) {
          if (/mega\.nz|drive\.google/i.test(loc2)) return null;
          const mq = loc2.startsWith("http") ? loc2 : `https://codedew.com${loc2}`;
          return extractArgonIdFromMultiquality(mq);
        }

        const argonStep = (res2.data as string).match(
          /argon\.razorshell\.space\/embed\/([^"'&\s/]+)/
        );
        if (argonStep) return argonStep[1];
      }
    }
    return null;
  } catch (err) {
    logger.error({ err, codedewUrl }, "[Scraper] Failed to resolve codedew URL");
    return null;
  }
}

async function extractArgonIdFromMultiquality(
  multiqUrl: string
): Promise<string | null> {
  try {
    const urlObj = new URL(multiqUrl);
    const urlParam = urlObj.searchParams.get("url");
    const html = await fetchHtml(multiqUrl, BASE_URL + "/");
    const $ = cheerio.load(html);

    const argonSrc = $("iframe[src*='argon.razorshell.space']").attr("src");
    if (argonSrc) {
      const m = argonSrc.match(/\/embed\/([^/?#]+)/);
      if (m) return m[1];
    }

    const embedMatch = (html as string).match(
      /argon\.razorshell\.space\/embed\/([^"'&\s/]+)/
    );
    if (embedMatch) return embedMatch[1];

    const dataSrcEl = $("[data-src*='argon'], [src*='argon']").first();
    const dataSrc = dataSrcEl.attr("data-src") || dataSrcEl.attr("src");
    if (dataSrc) {
      const m = dataSrc.match(/\/embed\/([^/?#]+)/);
      if (m) return m[1];
    }

    if (urlParam && !urlParam.startsWith("http") && urlParam.length < 80)
      return urlParam;
    return urlParam || null;
  } catch {
    try {
      return new URL(multiqUrl).searchParams.get("url");
    } catch {
      return null;
    }
  }
}

// ─── animetoonhindi.com ───────────────────────────────────────────────────────

/**
 * Maps derived show slugs to a canonical group slug so that sub-series of the
 * same franchise are grouped under one catalog entry rather than appearing as
 * separate shows.  Key = derived slug, Value = canonical group slug.
 */
const ATOON_SHOW_SLUG_ALIASES: Record<string, string> = {
  // Beyblade sub-series → single "Beyblade" entry
  "beyblade-metal-fusion": "beyblade",
  "beyblade-metal-masters": "beyblade",
  "beyblade-metal-fury": "beyblade",
  "beyblade-shogun-steel": "beyblade",
  "beyblade-zero-g": "beyblade",
  // Beyblade Burst sub-series → single "Beyblade Burst" entry
  "beyblade-burst-evolution": "beyblade-burst",
  "beyblade-burst-turbo": "beyblade-burst",
  "beyblade-burst-rise": "beyblade-burst",
  "beyblade-burst-surge": "beyblade-burst",
  "beyblade-burst-quad": "beyblade-burst",
  // Dragon Ball franchise variants
  "dragon-ball-z": "dragon-ball",
  "dragon-ball-gt": "dragon-ball",
  "dragon-ball-super": "dragon-ball",
  // Naruto variants (these are different shows so keep separate but prevent typos)
  "naruto-shippuuden": "naruto-shippuden",
  // Yu-Gi-Oh sub-series
  "yu-gi-oh-gx": "yu-gi-oh",
  "yu-gi-oh-zexal": "yu-gi-oh",
  "yu-gi-oh-arc-v": "yu-gi-oh",
};

/**
 * Parse archive title into a grouped show entry.
 * Returns null if the archive should be excluded (not MultiQuality, wrong language, etc.)
 */
function parseAtoonShowInfo(rawTitle: string): {
  showName: string;
  showSlug: string;
  season: number;
  isMovie: boolean;
} | null {
  // Only MultiQuality archives have working argon/groovy.monster streams
  if (!/multiquality/i.test(rawTitle)) return null;

  // Skip QuickCloud, DoQuality, DoodStream — these don't have working streams
  if (/quickcloud|quickdrive|quickmega|doquality|doodstream|doqlt|domulti/i.test(rawTitle)) return null;

  // Skip subtitled (Subbed) archives — we only want dubbed
  if (/\bsubbed\b/i.test(rawTitle)) return null;

  // Skip English-only archives (Eng/English without Hindi)
  if (/\b(?:eng|english)\b/i.test(rawTitle) && !/\bhindi\b/i.test(rawTitle)) return null;

  // Skip purely non-Hindi regional language archives
  if (
    /\b(?:telugu|tamil|malayalam|bengali|kannada|marathi)\b/i.test(rawTitle) &&
    !/\bhindi\b/i.test(rawTitle)
  ) return null;
  if (/domulti/i.test(rawTitle)) return null;

  const isMovie = /\bmovie\b|\bfilm\b/i.test(rawTitle) && !/season/i.test(rawTitle);

  const seasonMatch =
    rawTitle.match(/\(season\s+0*(\d+)\)/i) ||
    rawTitle.match(/\bseason\s+0*(\d+)\b/i) ||
    rawTitle.match(/\bpart\s+0*(\d+)\b/i) ||
    rawTitle.match(/\bs0*(\d+)\b(?!\s*e\d)/i);
  const season = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;

  // Build clean show name by stripping season, language, quality, source suffix tokens
  // "CN", "XD", "Dubbed" are archive-specific suffixes — strip them so archives merge correctly
  const showName = rawTitle
    .replace(/\s*\(season\s+\d+\)\s*/gi, " ")
    .replace(/\s*season\s+\d+\s*/gi, " ")
    .replace(/\s*all\s*seasons?\s*/gi, " ")
    .replace(/\s*all\s*episodes?\s*/gi, " ")
    .replace(/\s*(?:hindi|dubbed|subbed|english|multiquality|quickcloud|quickdrive|quickmulti|quickmega|quicktv)\s*/gi, " ")
    .replace(/\s*\bCN\b\s*/g, " ")   // source/encoding suffix e.g. "MultiQuality CN"
    .replace(/\s*\bXD\b\s*/g, " ")   // source suffix e.g. "MultiQuality XD"
    .replace(/\s*episodes?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!showName || showName.length < 2) return null;

  const rawSlug = showName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Apply franchise grouping alias (e.g. "beyblade-metal-fusion" → "beyblade")
  const showSlug = ATOON_SHOW_SLUG_ALIASES[rawSlug] ?? rawSlug;
  // If aliased, derive canonical display name from the target slug
  const canonicalName =
    showSlug !== rawSlug
      ? showSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : showName;

  return { showName: canonicalName, showSlug, season, isMovie };
}

/** Parse raw archive listing HTML, return raw archive records */
function parseAtoonArchivesFromHtml(html: string): Array<{
  archiveId: number;
  archiveTitle: string;
  archiveUrl: string;
  poster?: string;
}> {
  const results: Array<{ archiveId: number; archiveTitle: string; archiveUrl: string; poster?: string }> = [];
  const seenIds = new Set<number>();

  const re =
    /href="(https:\/\/store\.animetoonhindi\.com\/archives\/(\d+))"[^>]*>\s*([^<]{3,200})\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const archiveId = parseInt(m[2], 10);
    if (seenIds.has(archiveId)) continue;
    const rawTitle = m[3].trim();
    if (rawTitle.length < 4) continue;
    seenIds.add(archiveId);
    results.push({ archiveId, archiveTitle: rawTitle, archiveUrl: m[1] });
  }
  return results;
}

let atoonCatalogCache: AtoonCatalogItem[] | null = null;
let atoonCatalogCacheTime = 0;
let atoonBuildInFlight: Promise<AtoonCatalogItem[]> | null = null;

export async function buildAtoonCatalog(): Promise<AtoonCatalogItem[]> {
  const now = Date.now();
  if (atoonCatalogCache && now - atoonCatalogCacheTime < CATALOG_TTL) {
    return atoonCatalogCache;
  }

  if (atoonBuildInFlight) {
    if (atoonCatalogCache) return atoonCatalogCache;
    return atoonBuildInFlight;
  }

  atoonBuildInFlight = _buildAtoonCatalog().finally(() => { atoonBuildInFlight = null; });
  if (atoonCatalogCache) return atoonCatalogCache;
  return atoonBuildInFlight;
}

async function _buildAtoonCatalog(): Promise<AtoonCatalogItem[]> {
  const now = Date.now();

  logger.info("[Scraper] Building animetoonhindi.com catalog (MultiQuality grouped)");

  // ── Collect all MultiQuality archives via search pagination ─────────────
  // The animetoonhindi.com homepage is JS-rendered (no scrapable listing),
  // but the search endpoint `?s=multiquality&paged=N` returns 10 results per page.
  const rawArchives: Array<{ archiveId: number; archiveTitle: string; archiveUrl: string }> = [];
  const seenArchiveIds = new Set<number>();

  const addArchives = (items: ReturnType<typeof parseAtoonArchivesFromHtml>) => {
    for (const item of items) {
      if (!seenArchiveIds.has(item.archiveId)) {
        seenArchiveIds.add(item.archiveId);
        rawArchives.push(item);
      }
    }
  };

  // Primary: paginate through all "multiquality" search results
  for (let page = 1; page <= 400; page++) {
    const url = page === 1
      ? `${ATOON_BASE}/?s=multiquality`
      : `${ATOON_BASE}/?s=multiquality&paged=${page}`;
    try {
      const html = await fetchAtoon(url);
      const items = parseAtoonArchivesFromHtml(html);
      if (items.length === 0) break;
      addArchives(items);
      logger.info({ page, pageItems: items.length, total: rawArchives.length }, "[Scraper] Atoon MQ search page");
    } catch { break; }
  }

  // Supplement: targeted searches using EXACT title tokens as they appear on the site.
  // Each query is paginated (up to 10 pages × 10 results = 100 archives per query).
  // NOTE: queries must NOT re-append " multiquality" — include it here.
  const SUPPLEMENT_QUERIES = [
    // Series — use the EXACT show name token the site uses (not slugified versions)
    "shin chan multiquality",          // "Shin Chan (Season X) Episodes Hindi MultiQuality"
    "doraemon multiquality",           // "Doraemon Season X Episodes Hindi MultiQuality"
    "naruto multiquality",             // "Naruto Season X Hindi Episodes MultiQuality"
    "naruto shippuden multiquality",
    "dragon ball multiquality",        // covers DBZ + DBS + DBGT
    "pokemon multiquality",
    "one piece multiquality",
    "bleach multiquality",
    "boruto multiquality",
    "beyblade multiquality",
    "ben 10 multiquality",
    "digimon multiquality",
    "attack on titan multiquality",
    "demon slayer multiquality",
    "my hero academia multiquality",
    "jujutsu kaisen multiquality",
    "death note multiquality",
    "fairy tail multiquality",
    "hunter x hunter multiquality",
    "sword art online multiquality",
    "fullmetal alchemist multiquality",
    "seven deadly sins multiquality",
    "black clover multiquality",
    "spy x family multiquality",
    "one punch man multiquality",
    "code geass multiquality",
    // Movies — atoon titles often say "Movie" without "season"
    "movie multiquality hindi",
    "shin chan movie multiquality",
    "doraemon movie multiquality",
    "dragon ball movie multiquality",
    "pokemon movie multiquality",
    "naruto movie multiquality",
    // Additional shows not covered by primary search
    "johnny test multiquality",
    "tom and jerry multiquality",
    "scooby doo multiquality",
    "looney tunes multiquality",
    "ducktales multiquality",
    "teen titans multiquality",
    "powerpuff girls multiquality",
    "gravity falls multiquality",
    "phineas and ferb multiquality",
    "batman multiquality hindi",
    "superman multiquality hindi",
    "avengers multiquality hindi",
    "spider man multiquality hindi",
    "x men multiquality hindi",
    "transformers multiquality hindi",
    "thundercats multiquality hindi",
    "he man multiquality",
    "voltron multiquality hindi",
    "godzilla multiquality hindi",
    "yu gi oh multiquality",
    "inuyasha multiquality hindi",
    "sword art online multiquality",
    "dragon ball super multiquality",
    "initial d multiquality hindi",
    "slam dunk multiquality hindi",
    "captain tsubasa multiquality hindi",
  ];

  await Promise.allSettled(
    SUPPLEMENT_QUERIES.map(async (q) => {
      for (let p = 1; p <= 10; p++) {
        const url = p === 1
          ? `${ATOON_BASE}/?s=${encodeURIComponent(q)}`
          : `${ATOON_BASE}/?s=${encodeURIComponent(q)}&paged=${p}`;
        try {
          const html = await fetchAtoon(url);
          const items = parseAtoonArchivesFromHtml(html);
          if (items.length === 0) break;
          addArchives(items);
        } catch { break; }
      }
    })
  );

  logger.info({ rawCount: rawArchives.length }, "[Scraper] Atoon raw archives collected");

  // ── Group archives by show (MultiQuality filter applied in parseAtoonShowInfo) ──
  atoonShowMap.clear();
  const showNameMap = new Map<string, string>(); // showSlug → showName
  const showTypeMap = new Map<string, "series" | "movie">(); // showSlug → type

  for (const archive of rawArchives) {
    const info = parseAtoonShowInfo(archive.archiveTitle);
    if (!info) continue; // filtered out (not MultiQuality, wrong language, etc.)

    const { showSlug, showName, season, isMovie } = info;
    if (!atoonShowMap.has(showSlug)) {
      atoonShowMap.set(showSlug, []);
      showNameMap.set(showSlug, showName);
      showTypeMap.set(showSlug, isMovie ? "movie" : "series");
    }
    const seasons = atoonShowMap.get(showSlug)!;
    if (!seasons.some((s) => s.season === season)) {
      seasons.push({ season, archiveId: archive.archiveId, archiveTitle: archive.archiveTitle });
    }
  }

  // Sort seasons within each show
  for (const seasons of atoonShowMap.values()) {
    seasons.sort((a, b) => a.season - b.season);
  }

  // ── One catalog entry per unique show slug ────────────────────────────────
  const items: AtoonCatalogItem[] = [];
  for (const [showSlug, seasons] of atoonShowMap.entries()) {
    const firstSeason = seasons[0];
    const showName = showNameMap.get(showSlug) || showSlug;
    const type = showTypeMap.get(showSlug) || "series";
    items.push({
      id: `atoon:${showSlug}`,
      type,
      name: showName,
      archiveId: firstSeason.archiveId,
      archiveUrl: `${ATOON_BASE}/archives/${firstSeason.archiveId}`,
      archiveTitle: firstSeason.archiveTitle,
    });
  }

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "series" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  logger.info({ total: items.length, shows: atoonShowMap.size }, "[Scraper] Atoon catalog built");
  atoonCatalogCache = items;
  atoonCatalogCacheTime = now;
  // Allow cross-source merge to re-run after this rebuild
  crossSourceMergeBuilt = false;
  // Build cross-source merge (runs only when both catalogs are populated)
  buildCrossSourceMerge();

  // Note: posters for atoon items that match rareanimes.buzz are injected by
  // buildCrossSourceMerge() after both catalogs are built. The store.animetoonhindi.com
  // archive pages use a default placeholder image so per-page poster fetching is skipped.
  return items;
}

/** Return all season archive entries for an atoon show */
export function getAtoonShowSeasons(showSlug: string): AtoonSeasonEntry[] {
  return atoonShowMap.get(showSlug) ?? [];
}

/**
 * Direct archive episode lookup using a rareanimes base slug + season number.
 * Used as a secondary fallback when slug-based atoon search fails
 * (e.g. for aggregate "all-seasons" page slugs like doraemon-all-seasons-...).
 * Requires buildCrossSourceMerge() to have run first.
 */
export async function getAtoonEpsForBaseSlug(
  rareBaseSlug: string,
  seasonNum: number,
): Promise<EpisodeLink[]> {
  const atoonSlug = rareBaseToAtoonSlug.get(rareBaseSlug);
  if (!atoonSlug) return [];

  const seasons = atoonShowMap.get(atoonSlug);
  if (!seasons || seasons.length === 0) return [];

  // Exact season match first, then nearest, then first
  const entry =
    seasons.find((s) => s.season === seasonNum) ??
    seasons.reduce((best, s) =>
      Math.abs(s.season - seasonNum) < Math.abs(best.season - seasonNum) ? s : best,
    );

  logger.info(
    { rareBaseSlug, atoonSlug, requestedSeason: seasonNum, archiveSeason: entry.season, archiveId: entry.archiveId },
    "[Scraper] Direct atoon archive lookup",
  );
  return getAtoonEpisodeLinks(entry.archiveId);
}

export async function getAtoonArchiveMeta(archiveId: number): Promise<{
  title: string;
  description: string;
  poster?: string;
  episodes: EpisodeLink[];
}> {
  const archiveUrl = `${ATOON_BASE}/archives/${archiveId}`;
  let html: string;
  try {
    html = await fetchAtoon(archiveUrl);
  } catch (err) {
    logger.warn({ archiveId, err }, "[Scraper] Failed to fetch atoon archive");
    return { title: "Hindi Episodes", description: "", episodes: [] };
  }

  const $ = cheerio.load(html);
  let title =
    $("meta[property='og:title']").attr("content") ||
    $("h1.entry-title, h1").first().text().trim() ||
    $("title").text().trim() ||
    "Hindi Episodes";
  title = cleanTitle(title);

  const poster =
    $("meta[property='og:image']").attr("content") ||
    $(".wp-post-image").attr("src") ||
    $("img[class*='post-image'], img[class*='thumbnail']").first().attr("src") ||
    $(".entry-content img[src*='wp-content']").first().attr("src") ||
    $(".entry-content img").first().attr("src") ||
    undefined;

  const episodes = scrapeCodedewLinksFromHtml(html);
  const cleanedPoster = poster && poster.startsWith("http") ? poster : undefined;

  logger.info({ archiveId, title, count: episodes.length }, "[Scraper] Atoon archive meta");
  return {
    title,
    description: `${episodes.length} episodes available in Hindi dubbed.`,
    poster: cleanedPoster,
    episodes,
  };
}

// Cache: archiveId → episode links (TTL: 6 hours)
const atoonEpisodeLinkCache = new Map<number, { links: EpisodeLink[]; at: number }>();
const ATOON_EP_CACHE_TTL = 6 * 60 * 60 * 1000;

export async function getAtoonEpisodeLinks(archiveId: number): Promise<EpisodeLink[]> {
  const cached = atoonEpisodeLinkCache.get(archiveId);
  if (cached && Date.now() - cached.at < ATOON_EP_CACHE_TTL) return cached.links;
  try {
    const html = await fetchAtoon(`${ATOON_BASE}/archives/${archiveId}`);
    const links = scrapeCodedewLinksFromHtml(html);
    atoonEpisodeLinkCache.set(archiveId, { links, at: Date.now() });
    return links;
  } catch (err) {
    logger.error({ err, archiveId }, "[Scraper] Failed to fetch atoon episodes");
    return [];
  }
}

function scrapeCodedewLinksFromHtml(html: string): EpisodeLink[] {
  const links: EpisodeLink[] = [];
  let fallbackIndex = 0;

  // Accept both /multiquality/ and /zipper/ codedew links.
  // /zipper/ URLs HTTP-302 redirect to /multiquality/?url=... (individual episode streams).
  // Skip batch-download labels ("ZIP – PIXEL", "ZIP – NF", etc.) and non-streaming types
  // (quickcloud, doodstream, doquality, mega, gdrive).
  const re = /href="(https?:\/\/codedew\.com\/(?:multiquality|zipper)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const codedewUrl = m[1];
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // Skip batch ZIP download links
    if (isBatchDownloadLabel(label)) continue;

    const epLabelMatch =
      label.match(/S\d+E(\d+)/i) ||
      label.match(/\bEpisode\s+(\d+)\b/i) ||
      label.match(/\bEp\.?\s*(\d+)\b/i) ||
      label.match(/\b(\d{1,4})\s*$/);
    const epNum = epLabelMatch ? parseInt(epLabelMatch[1], 10) : ++fallbackIndex;
    if (isNaN(epNum) || epNum <= 0) continue;
    if (!links.some((l) => l.episodeNumber === epNum)) {
      links.push({ episodeNumber: epNum, title: label || `Episode ${epNum}`, codedewUrl });
    }
  }

  links.sort((a, b) => a.episodeNumber - b.episodeNumber);
  return links;
}

// ─── animetoonhindi.com — Slug lookup (rareanimes fallback) ──────────────────

const atoonPageCache = new Map<string, string | null>();

export async function findAndScrapeAtoonEpisodes(slug: string): Promise<EpisodeLink[]> {
  if (atoonPageCache.has(slug)) {
    const cached = atoonPageCache.get(slug)!;
    if (!cached) return [];
    const archiveId = parseInt(cached.split("/archives/")[1] ?? "", 10);
    if (!isNaN(archiveId)) return getAtoonEpisodeLinks(archiveId);
    return [];
  }

  let query = slug
    .replace(/[-–](?:hindi|tamil|telugu)(?:[-–].+)?$/i, "")
    .replace(/[-–](?:episodes?|download|watch|in-hd|hd)(?:[-–].+)?$/i, "")
    .replace(/-/g, " ")
    .trim();

  const seasonMatch = slug.match(/season[-–]0*(\d+)/i);
  const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;

  let html = "";
  try {
    html = await fetchAtoon(
      `${ATOON_BASE}/?s=${encodeURIComponent(query + " hindi multiquality")}`
    );
  } catch {
    atoonPageCache.set(slug, null);
    return [];
  }

  const results: Array<{ url: string; archiveId: number; title: string }> = [];
  const re =
    /href="(https:\/\/store\.animetoonhindi\.com\/archives\/(\d+))"[^>]*>\s*([^<]{3,120})\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push({ url: m[1], archiveId: parseInt(m[2], 10), title: m[3].trim() });
  }

  let filtered = results.filter((r) => !/telugu|tamil|malayalam|bengali/i.test(r.title));
  if (season !== null) {
    const exact = new RegExp(`\\bseason\\s+0*${season}\\b`, "i");
    const sf = filtered.filter((r) => exact.test(r.title));
    if (sf.length > 0) filtered = sf;
  }

  const best =
    filtered.find((r) => /MultiQuality/i.test(r.title)) ||
    filtered.find((r) => /QuickMulti/i.test(r.title)) ||
    filtered[0];

  if (!best) { atoonPageCache.set(slug, null); return []; }
  atoonPageCache.set(slug, best.url);
  return getAtoonEpisodeLinks(best.archiveId);
}
