/**
 * piratexplay.cc scraper
 *
 * Site structure (post-2026 migration to TMDB-based slugs):
 *   Category: /category/{cat}  → article.post links with new-format slugs
 *   Series:   /series/{show}-season-{N}-{tmdbId}/  → episode list + season swiper
 *   Episode:  /episode/{show}-season-{N}-{tmdbId}-{S}x{E}/
 *             *** REQUIRES Referer: /series/{slug}/ or returns "Invalid API response" ***
 *   Search:   /api/search-ajax.php?keyword={q}  → JSON {status, data[].tmdb}
 *   Seasons:  a.season-btn[href]  → /series/{show}-season-{N}-{tmdbId}/
 */

import * as cheerio from "cheerio";
import * as nodeCrypto from "crypto";

const BASE_URL = "https://piratexplay.cc";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContentType = "series" | "movies";

export interface AnimeCard {
  id: string;
  type: ContentType;
  slug: string;
  title: string;
  poster: string;
  rating?: string;
  detailUrl: string;
}

export interface EpisodeInfo {
  id: string;
  title: string;
  season: number;
  episode: number;
  episodeUrl: string;
}

export interface AnimeMeta {
  id: string;
  type: ContentType;
  slug: string;
  title: string;
  poster: string;
  description?: string;
  genres?: string[];
  year?: string;
  rating?: string;
  detailUrl: string;
  episodes: EpisodeInfo[];
  tmdbId?: string;
}

export interface StreamResult {
  name: string;
  title: string;
  url?: string;
  externalUrl?: string;
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
    [key: string]: unknown;
  };
}

/**
 * Returns the HTTP Referer header that the CDN serving this video URL requires.
 * Without it Stremio's VLC-based player gets 403 on segment fetches.
 */
function getStreamReferer(videoUrl: string): string | undefined {
  try {
    const host = new URL(videoUrl).hostname;
    // Emturbovid CDNs (teifanc, muletten, foudsea, emturbo)
    if (
      host.includes("teifanc") ||
      host.includes("muletten") ||
      host.includes("foudsea") ||
      host.includes("emturbo")
    ) {
      return "https://emturbovid.com/";
    }
    // AWSStream / as-cdn21
    if (host.includes("as-cdn21") || host.includes("awstream")) {
      return "https://as-cdn21.top/";
    }
    // Vidmoly CDNs (vmeas, box-*.vmeas)
    if (host.includes("vmeas") || host.includes("vidmoly")) {
      return "https://vidmoly.to/";
    }
    // Filemoon / Byse Frontend CDNs (includes bysetayico = gdmirr mirror)
    if (
      host.includes("bysezejataos") ||
      host.includes("bysetayico") ||
      host.includes("moonembd") ||
      host.includes("moonfeel") ||
      host.includes("moonfast") ||
      host.includes("filemoon") ||
      host.includes("moona")
    ) {
      return "https://filemoon.sx/";
    }
    // SprintCDN (used by bysetayico/gdmirr Byse Frontend streams)
    if (host.includes("sprintcdn") || host.includes("sprint-cdn")) {
      return "https://bysetayico.com/";
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      ...(referer ? { Referer: referer } : { Referer: BASE_URL + "/" }),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

function getBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

function absoluteUrl(href: string, base = BASE_URL): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  return base + (href.startsWith("/") ? href : "/" + href);
}

// ─── Path / ID helpers ────────────────────────────────────────────────────────

function parsePathParts(href: string): { type: ContentType; slug: string } | null {
  const m = href.match(/^\/?((series|movies)\/([^/?#]+))/);
  if (!m) return null;
  return { type: m[2] as ContentType, slug: m[3] };
}

function makeId(type: ContentType, slug: string): string {
  return `pxp:${type}:${slug}`;
}

// ─── Card parsing (shared for category + search pages) ───────────────────────

function parseCards($: cheerio.CheerioAPI): AnimeCard[] {
  const cards: AnimeCard[] = [];
  $("article.post").each((_, el) => {
    const element = $(el);
    if (element.hasClass("episodes")) return;

    const href = element.find("a.lnk-blk").attr("href") ?? "";
    const parts = parsePathParts(href);
    if (!parts) return;

    const title =
      element.find("h2.entry-title").text().trim() ||
      element.find("h3.entry-title").text().trim();
    if (!title) return;

    const poster =
      element.find("div.post-thumbnail img").attr("src") ||
      element.find("img").first().attr("src") ||
      "";

    const rating = element.find("span.vote").text().replace(/TMDB/g, "").trim();

    cards.push({
      id: makeId(parts.type, parts.slug),
      type: parts.type,
      slug: parts.slug,
      title,
      poster,
      rating: rating || undefined,
      detailUrl: `${BASE_URL}/${parts.type}/${parts.slug}`,
    });
  });
  return cards;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type CategoryKey =
  | "anime"
  | "cartoon"
  | "movie"
  | "popular"
  | "latest"
  | "complete"
  | "ongoing"
  | "top-airing";

export async function fetchCategory(category: CategoryKey, page = 1): Promise<AnimeCard[]> {
  const url = `${BASE_URL}/category/${category}?page=${page}`;
  const html = await fetchHtml(url);
  return parseCards(cheerio.load(html));
}

export async function searchAnime(query: string): Promise<AnimeCard[]> {
  try {
    const url = `${BASE_URL}/api/search-ajax.php?keyword=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      status: string;
      data: Array<{
        tmdb: {
          type: string;
          url: string;
          title: string;
          poster: string;
          rating?: number;
        };
      }>;
    };
    if (data.status !== "success" || !Array.isArray(data.data)) return [];
    return data.data.map(({ tmdb }) => {
      const type: ContentType = tmdb.type === "movies" ? "movies" : "series";
      const slug = tmdb.url;
      return {
        id: makeId(type, slug),
        type,
        slug,
        title: tmdb.title,
        poster: tmdb.poster?.startsWith("/")
          ? `https://image.tmdb.org/t/p/w300${tmdb.poster}`
          : tmdb.poster ?? "",
        rating: tmdb.rating !== undefined ? String(tmdb.rating) : undefined,
        detailUrl: `${BASE_URL}/${type}/${slug}`,
      };
    });
  } catch {
    return [];
  }
}

// ─── Meta (all seasons + episodes) ───────────────────────────────────────────

/**
 * Parse episodes from a season page.
 * Season pages have episodes in #episode_by_temp li or article.post.episodes.
 * Each episode header span contains "SxE" e.g. "4x1".
 */
function parseEpisodesFromPage(
  $: cheerio.CheerioAPI,
  type: ContentType,
  slug: string
): EpisodeInfo[] {
  const episodes: EpisodeInfo[] = [];

  // Primary selector: #episode_by_temp li
  const items = $("#episode_by_temp li");
  const selector = items.length > 0 ? items : $("article.post.episodes");

  selector.each((_, ep) => {
    const epEl = $(ep);

    // Get episode link
    const epLink =
      epEl.find("a[href*='/episode/']").first().attr("href") ||
      epEl.find("a").first().attr("href") ||
      "";
    if (!epLink) return;

    let season: number | undefined;
    let episode: number | undefined;

    // Try "SxE" from header span first
    const headerSpan = epEl.find("header.entry-header span").first().text().trim();
    if (headerSpan && headerSpan.includes("x")) {
      const [s, e] = headerSpan.split("x");
      season = parseInt(s, 10) || undefined;
      episode = parseInt(e, 10) || undefined;
    }

    // Fallback: parse from URL /episode/slug-SxE/
    if (!season || !episode) {
      const m = epLink.match(/\/episode\/.*?-(\d+)x(\d+)\/?$/);
      if (m) {
        season = parseInt(m[1], 10);
        episode = parseInt(m[2], 10);
      }
    }
    if (!season || !episode) return;

    const epTitle =
      epEl.find(".ep-name, .ep-title, .num-epi").text().trim() ||
      `Episode ${episode}`;

    // Use the slug embedded in the episode URL (may differ from parent series slug
    // when episodes come from a different season page, e.g. shin-chan-season-1-30623
    // vs the parent shin-chan-season-4-30623).
    const slugFromUrl =
      epLink.match(/\/episode\/(.+)-\d+x\d+\/?$/)?.[1] ?? slug;

    episodes.push({
      id: `pxp:${type}:${slugFromUrl}:${season}:${episode}`,
      title: epTitle,
      season,
      episode,
      episodeUrl: absoluteUrl(epLink),
    });
  });

  return episodes;
}

export async function fetchAnimeMeta(
  type: ContentType,
  slug: string
): Promise<AnimeMeta | null> {
  const detailUrl = `${BASE_URL}/${type}/${slug}`;
  let html: string;
  try {
    html = await fetchHtml(detailUrl);
  } catch {
    return null;
  }

  const $ = cheerio.load(html);

  const title =
    $("h1.entry-title").first().text().trim() ||
    $("h2.entry-title").first().text().trim();
  if (!title) return null;

  const poster =
    $("div.post-thumbnail img").first().attr("src") ||
    $("img.poster").attr("src") ||
    "";

  const description = $("div.description p").first().text().trim() || undefined;

  const genres: string[] = [];
  $("p.genres a, header ul li:contains(Genres) p a").each((_, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  const rating =
    $("span.vote").first().text().replace(/TMDB/g, "").trim() || undefined;
  const year =
    $("span.year").first().text().replace(/[^0-9–\-]/g, "").trim() || undefined;

  // Extract TMDB ID from any themoviedb.org link on the page
  let tmdbId: string | undefined;
  $("a[href*='themoviedb.org']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
    if (m && !tmdbId) tmdbId = m[2];
  });

  // ── Episode fetching ──────────────────────────────────────────────────────
  const allEpisodes: EpisodeInfo[] = [];

  if (type === "series") {
    // Collect season page links from season-swiper nav
    const seasonHrefs: string[] = [];
    $("div.season-swiper a.season-btn, .seasons a.season-btn, a.season-btn").each(
      (_, el) => {
        const href = $(el).attr("href") ?? "";
        if (href && !seasonHrefs.includes(href)) seasonHrefs.push(href);
      }
    );

    if (seasonHrefs.length > 0) {
      // Multi-season: fetch each season page in parallel.
      const seasonResults = await Promise.allSettled(
        seasonHrefs.map(async (seasonHref) => {
          const seasonUrl = absoluteUrl(seasonHref);
          const seasonSlug = parsePathParts(seasonHref)?.slug ?? slug;
          const seasonHtml = await fetchHtml(seasonUrl, detailUrl);
          return parseEpisodesFromPage(cheerio.load(seasonHtml), type, seasonSlug);
        })
      );

      for (const result of seasonResults) {
        if (result.status === "fulfilled") {
          allEpisodes.push(...result.value);
        }
      }
    }

    // If no season nav found (or it yielded nothing), parse from main page
    if (allEpisodes.length === 0) {
      allEpisodes.push(...parseEpisodesFromPage($, type, slug));
    }

    // Legacy fallback: article.post.episodes a[href] (old format)
    if (allEpisodes.length === 0) {
      $("article.post.episodes a[href]").each((_, el) => {
        const epHref = $(el).attr("href") ?? "";
        const m = epHref.match(/\/episode\/(.+)-(\d+)x(\d+)\/?$/);
        if (!m) return;
        const season = parseInt(m[2], 10);
        const episode = parseInt(m[3], 10);
        allEpisodes.push({
          id: `pxp:${type}:${slug}:${season}:${episode}`,
          title: `Episode ${episode}`,
          season,
          episode,
          episodeUrl: absoluteUrl(epHref),
        });
      });
    }
  }

  // Deduplicate and sort
  const seen = new Set<string>();
  const uniqueEpisodes = allEpisodes
    .filter((ep) => {
      const key = `${ep.season}:${ep.episode}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);

  return {
    id: makeId(type, slug),
    type,
    slug,
    title,
    poster,
    description,
    genres: genres.length > 0 ? genres : undefined,
    year,
    rating,
    tmdbId,
    detailUrl,
    episodes: uniqueEpisodes,
  };
}

// ─── Stream extractors ────────────────────────────────────────────────────────

/**
 * AWSStream / ascdn21 extractor.
 * POST to {host}/player/index.php?data={hash}&do=getVideo
 * Returns JSON { videoSource: "m3u8_url" }
 */
async function extractAWSStream(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const baseUrl = getBaseUrl(url);
    const urlObj = new URL(url);
    const hash =
      urlObj.searchParams.get("data") ||
      url.split("/").filter(Boolean).pop() ||
      "";
    if (!hash) return null;

    const apiUrl = `${baseUrl}/player/index.php?data=${hash}&do=getVideo`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": HEADERS["User-Agent"],
        Referer: referer,
        Origin: baseUrl,
      },
      body: `hash=${encodeURIComponent(hash)}&r=${encodeURIComponent(referer)}`,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { videoSource?: string };
    return data.videoSource || null;
  } catch {
    return null;
  }
}

/**
 * Generic extractor for Streamwish / Filesim / VidStack / Emturbovid style players.
 * Looks for m3u8 or mp4 sources in page JS/HTML using a broad set of patterns.
 */
async function extractGenericPlayer(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const html = await fetchHtml(url, referer);
    const patterns = [
      // Named-key patterns (JS object / JWPlayer setup)
      /file\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/,
      /source\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/,
      /"file"\s*:\s*"([^"]+\.m3u8[^"]*?)"/,
      /src\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/,
      // data-hash attribute (Emturbovid)
      /data-hash=["']([^"']+\.m3u8[^"']*?)["']/,
      // var urlPlay = '...' (Emturbovid)
      /var\s+urlPlay\s*=\s*["']([^"']+\.m3u8[^"']*?)["']/,
      // hlsUrl / videoUrl / streamUrl assignments
      /(?:hlsUrl|videoUrl|streamUrl|hls_url|video_url|stream_url)\s*[=:]\s*["']([^"']+\.m3u8[^"']*?)["']/,
      // <source src="...m3u8...">
      /<source[^>]+src=["']([^"']+\.m3u8[^"']*?)["']/,
      // Bare m3u8 URL in quoted string (broadest fallback)
      /"(https?:\/\/[^"]+\.m3u8(?:[?#][^"]*)?)"/.source,
      /'(https?:\/\/[^']+\.m3u8(?:[?#][^']*)?)'/.source,
      // MP4 fallbacks
      /file\s*:\s*["']([^"']+\.mp4[^"']*?)["']/,
      /"file"\s*:\s*"([^"]+\.mp4[^"]*?)"/,
      /<source[^>]+src=["']([^"']+\.mp4[^"']*?)["']/,
      /"(https?:\/\/[^"]+\.mp4(?:[?#][^"]*)?)"/.source,
    ].map((p) => (typeof p === "string" ? new RegExp(p) : p));

    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (m?.[1] && !m[1].includes("undefined")) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode Animesalt's base64 data URL param into per-language link pairs.
 * The URL looks like: animesalt.ac/multi-lang-plyr/player.php?data=BASE64JSON
 * where BASE64JSON decodes to [{language: "Hindi", link: "https://..."}]
 */
function decodeAnimesalt(url: string): Array<{ language: string; link: string }> {
  try {
    const u = new URL(url);
    const data = u.searchParams.get("data");
    if (!data) return [];
    const parsed = JSON.parse(
      Buffer.from(data, "base64").toString("utf8")
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, string>>)
      .filter((p) => p.language && p.link)
      .map((p) => ({ language: p.language as string, link: p.link as string }));
  } catch {
    return [];
  }
}

/**
 * MyAnimeworld: fetches its page, finds an inner iframe, resolves that.
 */
async function extractMyAnimeworld(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const html = await fetchHtml(url, referer);
    const $ = cheerio.load(html);
    const inner =
      $("iframe").first().attr("src") ||
      $("iframe").first().attr("data-src") ||
      "";
    if (!inner) return null;
    const innerUrl = absoluteUrl(inner, getBaseUrl(url));
    return await extractGenericPlayer(innerUrl, url);
  } catch {
    return null;
  }
}

/**
 * PiratexplayExtractor: piratexplay episode page or own player.
 * Handles /public/player/index11.php?id=... pages too.
 */
async function extractPiratexplayPage(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const html = await fetchHtml(url, referer);
    const $ = cheerio.load(html);

    // Check for #playerFrame iframe
    const inner =
      $("#playerFrame").attr("src") ||
      $("iframe[src]").first().attr("src") ||
      $("iframe[data-src]").first().attr("data-src") ||
      "";
    if (inner) {
      const innerUrl = absoluteUrl(inner, BASE_URL);
      const resolved = await resolveEmbedUrl(innerUrl, url);
      if (resolved) return resolved;
    }

    // Try to extract video URL directly from the page (own player)
    return extractGenericPlayer(url, referer);
  } catch {
    return null;
  }
}

/**
 * Mirror sources we are willing to surface to Stremio when they come from
 * piratexplay's own multi-mirror player page (index11.php). That page's
 * "Select Streaming Server" modal offers several mirrors (FM, Strm, Hyd,
 * Gdmirr).  FM (Filemoon) and Gdmirr (pro.iqsmartgames.com) both reliably
 * resolve to directly-playable streams.
 * Labels are stored lowercase for case-insensitive matching.
 */
const ALLOWED_MIRROR_LANGUAGES = new Set(["fm", "gdmirr"]);

/**
 * Parses piratexplay's own player page (/public/player/index11.php?id=...)
 * and resolves every mirror in its "Select Streaming Server" modal whose
 * label is in ALLOWED_MIRROR_LANGUAGES (currently FM only).
 * Returns one entry per resolved mirror, including the resolved embed URL so
 * callers can derive the correct CDN Referer (e.g. filemoon.sx for FM).
 */
async function extractPiratexplayModalSources(
  url: string,
  referer: string
): Promise<Array<{ label: string; videoUrl: string; embedUrl: string }>> {
  try {
    const html = await fetchHtml(url, referer);
    const $ = cheerio.load(html);

    // ── DEBUG: log ALL server-option elements so we can see labels/links ──────
    const allOptions: Array<{ label: string; link: string }> = [];
    $(".server-option[data-link]").each((_, el) => {
      const el$ = $(el);
      allOptions.push({
        label: (el$.attr("data-language") ?? el$.attr("data-label") ?? el$.text().trim()).trim(),
        link: el$.attr("data-link") ?? "",
      });
    });
    console.log("[PXP modal] all server-options found:", JSON.stringify(allOptions));

    const candidates: Array<{ label: string; link: string }> = [];
    $(".server-option[data-link]").each((_, el) => {
      const el$ = $(el);
      const link = el$.attr("data-link") ?? "";
      // Try data-language first, fall back to element text (some modal buttons
      // store the label as inner text rather than a data attribute).
      const rawLabel =
        (el$.attr("data-language") ?? el$.attr("data-label") ?? el$.text()).trim();
      const label = rawLabel;
      if (!link || !label) return;
      if (!ALLOWED_MIRROR_LANGUAGES.has(label.toLowerCase())) return;
      candidates.push({ label, link });
    });

    console.log("[PXP modal] candidates after filter:", JSON.stringify(candidates));

    if (candidates.length === 0) return [];

    const resolved = await Promise.allSettled(
      candidates.map(async ({ label, link }) => {
        const embedUrl = absoluteUrl(link, BASE_URL);
        console.log(`[PXP modal] resolving label=${label} embedUrl=${embedUrl}`);
        const videoUrl = await resolveEmbedUrl(embedUrl, url);
        console.log(`[PXP modal] resolved label=${label} videoUrl=${videoUrl}`);
        return videoUrl ? { label, videoUrl, embedUrl } : null;
      })
    );

    return resolved
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<{ label: string; videoUrl: string; embedUrl: string } | null>).value)
      .filter((v): v is { label: string; videoUrl: string; embedUrl: string } => v !== null);
  } catch (err) {
    console.log("[PXP modal] error:", err);
    return [];
  }
}

/**
 * GDMirrorbot extractor.
 * POSTs to /embedhelper.php with sid, gets back siteUrls + mresult,
 * resolves each mirror URL.
 */
async function extractGDMirrorbot(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const baseUrl = getBaseUrl(url);
    const sid = url.split("/").filter(Boolean).pop()?.split("?")[0] ?? "";
    if (!sid) return null;

    const res = await fetch(`${baseUrl}/embedhelper.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": HEADERS["User-Agent"],
        Referer: url,
        Origin: baseUrl,
      },
      body: `sid=${encodeURIComponent(sid)}`,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      siteUrls?: Record<string, string>;
      mresult?: string | Record<string, string>;
      siteFriendlyNames?: Record<string, string>;
    };

    const siteUrls = data.siteUrls ?? {};
    let mresult: Record<string, string> = {};
    if (typeof data.mresult === "string") {
      try {
        mresult = JSON.parse(
          Buffer.from(data.mresult, "base64").toString("utf8")
        ) as Record<string, string>;
      } catch { /* ignore */ }
    } else if (data.mresult && typeof data.mresult === "object") {
      mresult = data.mresult as Record<string, string>;
    }

    console.log(`[GDMirrorbot sid=${sid}] siteUrls keys:`, Object.keys(siteUrls));
    console.log(`[GDMirrorbot sid=${sid}] mresult keys:`, Object.keys(mresult));
    console.log(`[GDMirrorbot sid=${sid}] flmn in mresult:`, "flmn" in mresult, "flmn mresult val:", mresult["flmn"]);

    // Try each mirror
    const keys = Object.keys(siteUrls).filter((k) => mresult[k]);
    console.log(`[GDMirrorbot sid=${sid}] intersection keys to try:`, keys);
    for (const key of keys) {
      const base = (siteUrls[key] ?? "").replace(/\/$/, "");
      const path = (mresult[key] ?? "").replace(/^\//, "");
      if (!base || !path) continue;
      // Handle hash-fragment URL bases (e.g. "https://host/#") — no slash between base and path
      const mirrorUrl = base.endsWith("#") ? `${base}${path}` : `${base}/${path}`;
      console.log(`[GDMirrorbot sid=${sid}] trying key=${key} mirrorUrl=${mirrorUrl}`);
      const videoUrl = await resolveEmbedUrl(mirrorUrl, url).catch(() => null);
      console.log(`[GDMirrorbot sid=${sid}] key=${key} resolved to:`, videoUrl);
      if (videoUrl) return videoUrl;
    }
    return null;
  } catch (err) {
    console.log(`[GDMirrorbot] error for url=${url}:`, err);
    return null;
  }
}

// ─── Byse Frontend / Filemoon extractor ──────────────────────────────────────

interface BysePlayback {
  algorithm: string;
  iv: string;
  payload: string;
  key_parts: string[];
  version: string;
  expires_at?: string;
}

interface ByseSource {
  quality: string;
  label: string;
  mime_type: string;
  url: string;
  bitrate_kbps?: number;
  height?: number;
}

interface ByseVideoResponse {
  code?: string;
  playback?: BysePlayback;
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

/**
 * Decrypt the AES-256-GCM encrypted playback payload from the Byse Frontend API.
 *
 * Key assembly (from videoPagesBundle source):
 *   vi()[version] returns [n, 31-n] for version = n (where 1 ≤ n ≤ 20)
 *   yo(e) picks key_parts at those 1-based indices and concatenates their
 *   base64url-decoded bytes to form the AES-256 key.
 */
function decryptBysePlayback(playback: BysePlayback): string | null {
  try {
    const parts = playback.key_parts;
    if (!Array.isArray(parts) || parts.length === 0) return null;

    const n = parseInt(playback.version, 10);
    let selectedParts: string[];
    if (n >= 1 && n <= 20) {
      const indices = [n, 31 - n]; // 1-based
      selectedParts = indices
        .filter((i) => i >= 1 && i <= parts.length)
        .map((i) => parts[i - 1]!)
        .filter((p) => typeof p === "string" && p.length > 0);
    } else {
      selectedParts = parts.filter((p) => typeof p === "string" && p.length > 0);
    }
    if (selectedParts.length === 0) return null;

    const key = Buffer.concat(selectedParts.map(base64urlDecode));
    const iv = base64urlDecode(playback.iv);
    const cipherWithTag = base64urlDecode(playback.payload);

    const TAG_LEN = 16;
    const ciphertext = cipherWithTag.subarray(0, -TAG_LEN);
    const authTag = cipherWithTag.subarray(-TAG_LEN);

    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const result = JSON.parse(decrypted.toString("utf8")) as {
      sources?: ByseSource[];
    };
    return result.sources?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Byse Frontend / Filemoon extractor.
 * Works for bysezejataos.com, filemoon.sx, filemoon.to and any other
 * Byse Frontend instance — all use the same /api/videos/{hash}/ API.
 *
 * Embed URL pattern: https://{host}/e/{hash}/
 */
async function extractBysePlayer(
  url: string,
  referer: string
): Promise<string | null> {
  try {
    const hashMatch = url.match(/\/e\/([a-zA-Z0-9]+)\/?/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1];

    const baseUrl = getBaseUrl(url);
    const apiUrl = `${baseUrl}/api/videos/${encodeURIComponent(hash)}/`;

    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        Referer: referer,
        Origin: baseUrl,
      },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as ByseVideoResponse;
    if (!data.playback) return null;

    return decryptBysePlayback(data.playback);
  } catch {
    return null;
  }
}

/**
 * Resolve a single embed iframe URL to a direct video URL.
 * Returns the resolved video URL or null.
 */
async function resolveEmbedUrl(
  embedUrl: string,
  referer: string
): Promise<string | null> {
  // ── piratexplay.cc proxy / own player ──────────────────────────────────────
  // Pattern: /proxy/play.php?url=<actual_embed_url>
  // Unwrap the actual embed URL and resolve that instead.
  if (embedUrl.includes("piratexplay.cc")) {
    try {
      const u = new URL(embedUrl);
      const inner = u.searchParams.get("url");
      if (inner) {
        const innerUrl = inner.startsWith("//") ? "https:" + inner : inner;
        return resolveEmbedUrl(innerUrl, embedUrl);
      }
    } catch { /* fall through */ }
    // Own player pages (e.g. /public/player/index11.php)
    return extractPiratexplayPage(embedUrl, referer);
  }

  // ── Byse Frontend / Filemoon ───────────────────────────────────────────────
  // bysezejataos.com is piratexplay's HQ/HD player (via index11.php).
  // filemoon.sx / filemoon.to / filemoon.in are public Filemoon instances.
  // bysetayico.com is the Filemoon mirror surfaced by the Gdmirr (iqsmartgames)
  // server — same Byse Frontend API, different hostname.
  // moonembd.online / moonfeel.online / moonfast.online are additional Byse
  // Frontend mirrors used by the Gdmirr server.
  if (
    embedUrl.includes("bysezejataos.com") ||
    embedUrl.includes("bysetayico.com") ||
    embedUrl.includes("moonembd.online") ||
    embedUrl.includes("moonfeel.online") ||
    embedUrl.includes("moonfast.online") ||
    embedUrl.includes("filemoon.sx") ||
    embedUrl.includes("filemoon.to") ||
    embedUrl.includes("filemoon.in")
  ) {
    return extractBysePlayer(embedUrl, referer);
  }

  // ── AWSStream / ascdn21 ────────────────────────────────────────────────────
  if (
    embedUrl.includes("awstream.net") ||
    embedUrl.includes("as-cdn21.top") ||
    embedUrl.includes("awstream")
  ) {
    return extractAWSStream(embedUrl, referer);
  }

  // ── GDMirrorbot / techinmind / iqsmartgames ───────────────────────────────
  if (
    embedUrl.includes("gdmirrorbot") ||
    embedUrl.includes("techinmind") ||
    embedUrl.includes("dlx.techinmind") ||
    embedUrl.includes("iqsmartgames.com")
  ) {
    return extractGDMirrorbot(embedUrl, referer);
  }

  // ── Generic player hosts (page contains video URL in JS/HTML) ──────────────
  // This covers: Streamwish, Filesim, VidStack, Vidmoly, Rubystm, Vidstreaming,
  // Abyssplayer, Emturbovid, Strmup, Blakiteapi, Cloudy, etc.
  const genericHosts = [
    "ghbrisk.com", "pixdrive.cfd", "streamwish",
    "cloudy.upns.one", "vidstack",
    "vidmoly.to", "vidmoly.net",
    "rubystm.com", "vidstreaming.xyz", "abyssplayer.com",
    "emturbovid.com", "strmup.to", "blakiteapi.xyz",
    "animesalt.ac", "short.icu",
  ];
  if (genericHosts.some((h) => embedUrl.includes(h))) {
    return await extractGenericPlayer(embedUrl, referer);
  }

  // ── MyAnimeworld ───────────────────────────────────────────────────────────
  if (embedUrl.includes("myanimeworld.in")) {
    return extractMyAnimeworld(embedUrl, referer);
  }

  // ── Generic fallback for any unknown host ──────────────────────────────────
  return extractGenericPlayer(embedUrl, referer);
}

// ─── Stream fetching ──────────────────────────────────────────────────────────

export async function fetchStreams(
  type: ContentType,
  slug: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  let episodeUrl: string;
  if (type === "movies" || (season === undefined && episode === undefined)) {
    episodeUrl = `${BASE_URL}/${type}/${slug}`;
  } else {
    episodeUrl = `${BASE_URL}/episode/${slug}-${season}x${episode}/`;
  }

  // Episode pages require Referer pointing to the series page;
  // without it the server returns "Invalid API response" (20 bytes).
  const seriesPageUrl = `${BASE_URL}/series/${slug}/`;

  let html: string;
  try {
    html = await fetchHtml(episodeUrl, seriesPageUrl);
  } catch {
    return [
      {
        name: "PirateXPlay",
        title: "Watch Online",
        externalUrl: episodeUrl,
        behaviorHints: { notWebReady: true },
      },
    ];
  }

  const $ = cheerio.load(html);

  // Collect server names from the tab buttons.
  // Current site layout (redesign): <button class="server-btn" data-server="N">Name</button>
  // Older layout (kept for resilience): ul.aa-tbs-video / ul.server-video tabs.
  const serverNames: string[] = [];
  const serverBtns = $("button.server-btn[data-server]");
  if (serverBtns.length > 0) {
    serverBtns.each((_, el) => {
      const el$ = $(el);
      const idx = parseInt(el$.attr("data-server") ?? "", 10);
      const label = el$.text().trim();
      serverNames[Number.isNaN(idx) ? serverNames.length : idx] =
        label || `Server ${idx + 1}`;
    });
  } else {
    $("ul.aa-tbs-video li a.btn, ul.server-video li a").each((_, el) => {
      const serverSpan = $(el).find("span.server").text().trim();
      const num = $(el).find("span").not(".server").first().text().trim();
      serverNames.push(serverSpan || `Server ${num || serverNames.length + 1}`);
    });
  }

  // Collect all iframe embed URLs.
  // Current site layout: <div id="options-N"><iframe src|data-src=...></div>
  // Older layout (kept for resilience): div.video.aa-tb / div.tab-content / #player-container.
  const iframeUrls: string[] = [];
  const optionDivs = $('div[id^="options-"]');
  if (optionDivs.length > 0) {
    optionDivs.each((_, el) => {
      const el$ = $(el);
      const idx = parseInt((el$.attr("id") ?? "").replace("options-", ""), 10);
      const iframe = el$.find("iframe").first();
      const src = iframe.attr("src") || iframe.attr("data-src") || "";
      if (!src || src === "about:blank") return;
      iframeUrls[Number.isNaN(idx) ? iframeUrls.length : idx] = absoluteUrl(src);
    });
  } else {
    $("div.video.aa-tb iframe, div.tab-content iframe, #player-container iframe").each(
      (_, el) => {
        const src =
          $(el).attr("src") ||
          $(el).attr("data-src") ||
          "";
        if (!src || src === "about:blank") return;
        iframeUrls.push(absoluteUrl(src));
      }
    );
  }

  if (iframeUrls.length === 0) {
    return [
      {
        name: "PirateXPlay",
        title: "Watch Page",
        externalUrl: episodeUrl,
        behaviorHints: { notWebReady: true },
      },
    ];
  }

  // Expand each iframe URL into one or more {serverName, embedUrl} pairs.
  // Animesalt encodes per-language links in its URL → expand to one entry per language.
  const embeds: Array<{ serverName: string; embedUrl: string }> = [];
  for (let i = 0; i < iframeUrls.length; i++) {
    const embedUrl = iframeUrls[i];
    if (!embedUrl) continue;
    const serverName = serverNames[i] ?? `Server ${i + 1}`;
    if (embedUrl.includes("animesalt.ac")) {
      const pairs = decodeAnimesalt(embedUrl);
      if (pairs.length > 0) {
        for (const pair of pairs) {
          embeds.push({
            serverName: `${serverName} [${pair.language}]`,
            embedUrl: pair.link,
          });
        }
        continue;
      }
    }
    embeds.push({ serverName, embedUrl });
  }

  // Resolve each embed in parallel (10 s timeout per embed)
  const RESOLVE_TIMEOUT = 10000;

  /**
   * Build a StreamResult for a resolved video URL.
   * @param embedRefererHint - Origin of the embed page that produced this URL
   *   (e.g. "https://filemoon.sx/").  Used as the CDN Referer when the video
   *   URL itself doesn't match any known CDN pattern in getStreamReferer.
   */
  function buildStream(
    serverName: string,
    videoUrl: string,
    embedRefererHint?: string
  ): StreamResult {
    const referer = getStreamReferer(videoUrl) ?? embedRefererHint;
    return {
      name: `PirateXPlay | ${serverName}`,
      title: serverName,
      url: videoUrl,
      behaviorHints: {
        notWebReady: false,
        ...(referer
          ? {
              proxyHeaders: {
                request: {
                  Referer: referer,
                  Origin: referer.replace(/\/$/, ""),
                  "User-Agent": HEADERS["User-Agent"],
                },
              },
            }
          : {}),
      },
    };
  }

  // Only these providers are known to reliably produce a directly-playable
  // stream. Everything else (Rubystm, Short, Vidstreaming, Cloudy, Strm,
  // Hyd/Abyssplayer, Gdmirr, etc.) is unreliable or outright broken — we drop
  // those entirely rather than show a stream in Stremio that errors on playback.
  const isDirectlyPlayableHost = (embedUrl: string): boolean =>
    embedUrl.includes("awstream.net") ||
    embedUrl.includes("as-cdn21.top") ||
    embedUrl.includes("awstream") ||
    embedUrl.includes("emturbovid.com") ||
    embedUrl.includes("bysezejataos.com") ||
    embedUrl.includes("bysetayico.com") ||
    embedUrl.includes("moonembd.online") ||
    embedUrl.includes("moonfeel.online") ||
    embedUrl.includes("moonfast.online") ||
    embedUrl.includes("iqsmartgames.com") ||
    embedUrl.includes("gdmirrorbot") ||
    embedUrl.includes("techinmind") ||
    embedUrl.includes("filemoon.sx") ||
    embedUrl.includes("filemoon.to") ||
    embedUrl.includes("filemoon.in");

  const isPiratexplayOwnPlayer = (embedUrl: string): boolean =>
    embedUrl.includes("piratexplay.cc") && embedUrl.includes("/player/");

  const resolved = await Promise.allSettled(
    embeds.map(async ({ serverName, embedUrl }) => {
      // piratexplay's own multi-mirror player page: pull only the FM /
      // FM mirrors out of its "Select Streaming Server" modal.
      if (isPiratexplayOwnPlayer(embedUrl)) {
        const sources = await Promise.race<
          Array<{ label: string; videoUrl: string; embedUrl: string }>
        >([
          extractPiratexplayModalSources(embedUrl, episodeUrl),
          new Promise<Array<{ label: string; videoUrl: string; embedUrl: string }>>((r) =>
            setTimeout(() => r([]), RESOLVE_TIMEOUT)
          ),
        ]).catch(() => [] as Array<{ label: string; videoUrl: string; embedUrl: string }>);
        return sources.map(({ label, videoUrl, embedUrl: srcEmbedUrl }) => {
          // Derive the embed origin as a fallback CDN Referer.
          let embedRefererHint: string | undefined;
          try {
            embedRefererHint = new URL(srcEmbedUrl).origin + "/";
          } catch { /* ignore */ }
          return buildStream(`${serverName} · ${label}`, videoUrl, embedRefererHint);
        });
      }

      // Anything not on the known-working provider list is dropped up
      // front — we never even attempt to resolve it.
      if (!isDirectlyPlayableHost(embedUrl)) {
        return [];
      }

      let videoUrl: string | null = null;
      try {
        videoUrl = await Promise.race<string | null>([
          resolveEmbedUrl(embedUrl, episodeUrl),
          new Promise<null>((r) => setTimeout(() => r(null), RESOLVE_TIMEOUT)),
        ]);
      } catch {
        videoUrl = null;
      }

      if (!videoUrl) return [];

      return [buildStream(serverName, videoUrl)];
    })
  );

  const streams: StreamResult[] = resolved
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => (r as PromiseFulfilledResult<StreamResult[]>).value);

  streams.sort((a, b) => {
    const aHasUrl = a.url ? 0 : 1;
    const bHasUrl = b.url ? 0 : 1;
    return aHasUrl - bHasUrl;
  });

  return streams;
}

// ─── IMDB / Cinemeta lookup ───────────────────────────────────────────────────

interface CinemMeta {
  meta?: {
    name?: string;
    type?: string;
  };
}

/**
 * Normalise a title for fuzzy matching:
 * - lowercase
 * - remove punctuation, "the", "a" articles
 * - collapse whitespace
 */
function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[:\-–—]/g, " ")       // colons/dashes → space (handles "Crayon Shin-Chan")
    .replace(/[^\w\s]/g, "")        // strip remaining punctuation
    .replace(/\b(the|a|an)\b/g, "") // drop common articles
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build candidate search queries from a title, from most specific to least.
 * e.g. "Crayon Shin-Chan" → ["Crayon Shin-Chan", "Shin-Chan", "Crayon Shin Chan", "shin chan", "shinchan"]
 */
function buildSearchQueries(title: string): string[] {
  const queries: string[] = [title];

  // Strip leading article words like "Crayon" to find the core name
  const words = title.split(/\s+/);
  if (words.length > 1) {
    // All words except the first
    queries.push(words.slice(1).join(" "));
    // First two words only (for long titles)
    if (words.length > 2) queries.push(words.slice(0, 2).join(" "));
    // First word only
    queries.push(words[0]!);
  }

  // Subtitle stripped (everything before ":" or " - ")
  const colonIdx = title.indexOf(":");
  if (colonIdx > 2) queries.push(title.slice(0, colonIdx).trim());

  // Hyphen-free variant: "Shin-Chan" → "Shinchan"
  const nohyphen = title.replace(/-/g, "");
  if (nohyphen !== title) queries.push(nohyphen);

  // Deduplicate preserving order
  return [...new Set(queries.filter((q) => q.length > 1))];
}

/**
 * Score a list of cards against a normalised target title.
 * Returns the best card or null if no match found.
 */
function scoreBest(
  candidates: AnimeCard[],
  titleLower: string,
  titleNorm: string,
): AnimeCard | null {
  // Spaceless version handles "Shinchan" (Cinemeta) ↔ "Shin Chan" (PirateXPlay)
  const titleNoSpaces = titleNorm.replace(/\s+/g, "");

  const scored = candidates
    .map((c) => {
      const cl = c.title.toLowerCase();
      const cn = normaliseTitle(c.title);
      const cnNoSpaces = cn.replace(/\s+/g, "");
      const score =
        cl === titleLower || cn === titleNorm || cnNoSpaces === titleNoSpaces ? 4  // exact (including spaceless)
        : cl.includes(titleLower) || cn.includes(titleNorm) ? 3  // contains full
        : titleLower.includes(cl) || titleNorm.includes(cn) ? 2  // title contains card name
        : (titleNorm.split(" ").some((w) => w.length > 3 && cn.includes(w))) ? 1
        : 0;
      return { card: c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.card ?? null;
}

/**
 * Core title-based lookup: search PirateXPlay for a given title and fetch streams.
 * Tries multiple search queries (full title, key words, stripped subtitle, etc.)
 * to maximise hit rate for shows whose PirateXPlay name differs from IMDB/TMDB.
 *
 * stremioType constrains matches to movie or series so cross-type misrouting
 * doesn't happen.
 */
export async function fetchStreamsByTitle(
  title: string,
  stremioType: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  // PirateXPlay ContentType is "movies" for movies, "series" for series/anime
  const pxpType: ContentType = stremioType === "movie" ? "movies" : "series";
  const titleLower = title.toLowerCase();
  const titleNorm = normaliseTitle(title);

  const queries = buildSearchQueries(title);

  let best: AnimeCard | null = null;

  for (const query of queries) {
    let allCards: AnimeCard[];
    try {
      allCards = await searchAnime(query);
    } catch {
      continue;
    }
    if (allCards.length === 0) continue;

    // Prefer type-matching cards; fall back to all if none match type
    const typedCards = allCards.filter((c) => c.type === pxpType);
    const candidates = typedCards.length > 0 ? typedCards : allCards;

    const candidate = scoreBest(candidates, titleLower, titleNorm);
    if (candidate) {
      best = candidate;
      break; // found a confident match — stop trying more queries
    }
  }

  if (!best) return [];

  // The search result slug encodes a specific TMDB season, e.g.
  // "shin-chan-season-4-30623".  If the caller requested a different season
  // we must replace the season number in the slug so the episode URL resolves
  // correctly, e.g. "shin-chan-season-1-30623" for season=1.
  let targetSlug = best.slug;
  if (season !== undefined) {
    const adjusted = best.slug.replace(/(-season-)\d+(-\d+)$/, `$1${season}$2`);
    if (adjusted !== best.slug) targetSlug = adjusted;
  }

  return fetchStreams(best.type, targetSlug, season, episode);
}

/**
 * Given an IMDB id (tt...), look up the title via Cinemeta,
 * search piratexplay, and return streams for the best match.
 */
export async function fetchStreamsByImdbId(
  stremioType: string,
  imdbId: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  try {
    const cineType = stremioType === "movie" ? "movie" : "series";
    const cineRes = await fetch(
      `https://v3-cinemeta.strem.io/meta/${cineType}/${imdbId}.json`,
      { headers: { "User-Agent": HEADERS["User-Agent"] } }
    );
    if (!cineRes.ok) return [];
    const data = (await cineRes.json()) as CinemMeta;
    const title = data.meta?.name;
    if (!title) return [];

    return fetchStreamsByTitle(title, stremioType, season, episode);
  } catch {
    return [];
  }
}

/**
 * Given a TMDB numeric id, look up the title via Cinemeta (which supports
 * tmdb: prefixed IDs), search piratexplay, and return streams for the best match.
 *
 * Cinemeta supports TMDB IDs via: /meta/{type}/tmdb:{id}.json
 */
export async function fetchStreamsByTmdbId(
  stremioType: string,
  tmdbId: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  try {
    const cineType = stremioType === "movie" ? "movie" : "series";
    // Cinemeta accepts tmdb: prefixed IDs directly
    const cineRes = await fetch(
      `https://v3-cinemeta.strem.io/meta/${cineType}/tmdb:${tmdbId}.json`,
      { headers: { "User-Agent": HEADERS["User-Agent"] } }
    );
    if (!cineRes.ok) return [];
    const data = (await cineRes.json()) as CinemMeta;
    const title = data.meta?.name;
    if (!title) return [];

    return fetchStreamsByTitle(title, stremioType, season, episode);
  } catch {
    return [];
  }
}
