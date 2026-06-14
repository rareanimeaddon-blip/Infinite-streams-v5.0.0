import axios from "axios";
import {
  fetchHtml,
  cleanTitle,
  extractYear,
  extractQuality,
  extractLanguage,
  resolveLink,
  extractImdbIdFromHtml,
  cache,
  TTL,
} from "./hdhub4u-base.js";
import { logger } from "../lib/logger.js";

const FALLBACK_DOMAINS = [
  "https://4khdhub.one",
  "https://4khdhub.com",
  "https://4khdhub.net",
  "https://4khdhub.org",
];

async function getActiveDomain(): Promise<string> {
  const cacheKey = "4khdhub:domain";
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const checks = FALLBACK_DOMAINS.map(async (domain) => {
    try {
      const res = await axios.get(`${domain}/`, {
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        maxRedirects: 5,
        validateStatus: (s) => s < 500,
      });
      if (res.status < 400) return domain;
    } catch {
      return null;
    }
    return null;
  });

  const results = await Promise.allSettled(checks);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      cache.set(cacheKey, r.value, 30 * 60 * 1000);
      logger.info({ domain: r.value }, "4KHDHub active domain found");
      return r.value;
    }
  }

  const fallback = FALLBACK_DOMAINS[0]!;
  cache.set(cacheKey, fallback, 5 * 60 * 1000);
  return fallback;
}

export interface ScrapeItem {
  slug: string;
  title: string;
  year?: string;
  poster?: string;
  url: string;
  type: "movie" | "series";
}

export interface StreamEntry {
  url: string;
  quality: string;
  language: string;
  label: string;
  size?: string;
  server?: string;
  season?: number;
  episode?: number;
}

function itemTypeFromHref(href: string): "movie" | "series" {
  return /-series-\d+/.test(href) || /\bseries\b|\bseason\b/i.test(href) ? "series" : "movie";
}

const STREAM_HOST_PATTERN = /hubcloud|hubdrive|pixeldrain|streamtape|gofile|gdrive|filepress|filemoon|streamwish|wishfast|doodstream|dood\.|upstream|mixdrop|1fichier|terabox|mp4upload/i;

export async function fetchListing(
  type: "movie" | "series",
  page = 1,
): Promise<ScrapeItem[]> {
  const catPath = type === "movie" ? "movies" : "series";
  const cacheKey = `4khdhub:listing:${type}:${page}`;
  const cached = cache.get<ScrapeItem[]>(cacheKey);
  if (cached) return cached;

  const BASE_URL = await getActiveDomain();
  const url =
    page === 1
      ? `${BASE_URL}/category/${catPath}/?catx=${catPath}`
      : `${BASE_URL}/category/${catPath}/?catx=${catPath}&pagex=${page}`;

  const $ = await fetchHtml(url);
  if (!$) return [];

  const items: ScrapeItem[] = [];

  const cardSelectors = ["a.movie-card[href]", "a.post-card[href]", ".movies-list a[href]", "article a[href]", ".item a[href]"];

  for (const sel of cardSelectors) {
    if (items.length > 0) break;
    $(sel).each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const slug = href.replace(/^\//, "").replace(/\/$/, "");
      if (!slug || slug.includes("category") || slug.includes("page")) return;

      const rawTitle =
        $(el).find(".movie-card-title, .post-title, .title, h2, h3").text().trim() ||
        $(el).attr("aria-label") ||
        $(el).attr("title") ||
        "";
      if (!rawTitle || rawTitle.length < 2) return;

      const yearText = $(el).find(".movie-card-meta, .meta, .year").text().trim();
      const year = extractYear(yearText + " " + slug);

      const imgEl = $(el).find("img").first();
      const poster = imgEl.attr("data-src") || imgEl.attr("src") || undefined;

      items.push({
        slug,
        title: cleanTitle(rawTitle),
        year,
        poster: poster?.startsWith("http") ? poster : undefined,
        url: fullUrl,
        type: itemTypeFromHref(href),
      });
    });
  }

  const unique = items.filter(
    (item, idx, arr) => item.slug && arr.findIndex((x) => x.slug === item.slug) === idx,
  );

  cache.set(cacheKey, unique, TTL.CATALOG);
  return unique;
}

export async function searchSite(query: string): Promise<ScrapeItem[]> {
  const cacheKey = `4khdhub:search:${query.toLowerCase()}`;
  const cached = cache.get<ScrapeItem[]>(cacheKey);
  if (cached) return cached;

  const BASE_URL = await getActiveDomain();
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const $ = await fetchHtml(url);
  if (!$) return [];

  const items: ScrapeItem[] = [];

  const cardSelectors = ["a.movie-card[href]", "a.post-card[href]", ".movies-list a[href]", "article a[href]"];
  for (const sel of cardSelectors) {
    if (items.length > 0) break;
    $(sel).each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const slug = href.replace(/^\//, "").replace(/\/$/, "");
      if (!slug || slug.includes("category") || slug.includes("page")) return;

      const rawTitle =
        $(el).find(".movie-card-title, .post-title, .title, h2, h3").text().trim() ||
        $(el).attr("aria-label") ||
        $(el).attr("title") ||
        "";
      if (!rawTitle || rawTitle.length < 2) return;

      const yearText = $(el).find(".movie-card-meta, .meta, .year").text().trim();
      const year = extractYear(yearText + " " + slug);

      const imgEl = $(el).find("img").first();
      const poster = imgEl.attr("data-src") || imgEl.attr("src") || undefined;

      items.push({
        slug,
        title: cleanTitle(rawTitle),
        year,
        poster: poster?.startsWith("http") ? poster : undefined,
        url: fullUrl,
        type: itemTypeFromHref(href),
      });
    });
  }

  if (items.length === 0) {
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (!/-(?:movie|series)-\d+\/?$/.test(href) && !/\/(movie|series)\//.test(href)) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const slug = href.replace(/^\//, "").replace(/\/$/, "");
      const text = ($(el).text().trim() || $(el).attr("aria-label") || $(el).attr("title") || "").trim();
      if (!text || text.length < 2) return;
      items.push({
        slug,
        title: cleanTitle(text),
        year: extractYear(text + " " + slug),
        url: fullUrl,
        type: itemTypeFromHref(href),
      });
    });
  }

  const unique = items.filter(
    (item, idx, arr) => item.slug && arr.findIndex((x) => x.slug === item.slug) === idx,
  );

  cache.set(cacheKey, unique.slice(0, 20), TTL.SEARCH);
  return unique.slice(0, 20);
}

export async function extractStreams(
  pageUrl: string,
  season?: number,
  episode?: number,
  expectedImdbId?: string,
): Promise<StreamEntry[]> {
  const cacheKey = `4khdhub:streams:${pageUrl}:${season ?? ""}:${episode ?? ""}`;
  const cached = cache.get<StreamEntry[]>(cacheKey);
  if (cached) return cached;

  const $ = await fetchHtml(pageUrl, { Referer: pageUrl });
  if (!$) return [];

  // IMDB ID verification: if the page embeds a different IMDB ID than the one
  // requested, this is the wrong content (remake, regional variant, sequel, etc.).
  // Only reject when a mismatch is confirmed — pages without any IMDB link pass through.
  if (expectedImdbId) {
    const pageImdbId = extractImdbIdFromHtml($.html());
    if (pageImdbId && pageImdbId !== expectedImdbId) {
      logger.info({ pageUrl, pageImdbId, expectedImdbId }, "4KHDHub: IMDB ID mismatch — skipping page");
      return [];
    }
  }

  const rawLinks: { url: string; label: string; quality: string; language: string; size?: string }[] = [];
  const isSeries = season !== undefined;
  const seasonStr = isSeries ? `S${String(season).padStart(2, "0")}` : null;

  $(".download-item, [class*=download-item], [class*=dl-item]").each((_i, dlItem) => {
    const header = $(dlItem).find(".download-header, [class*=download-header], [class*=dl-header]").first();
    const episodeNum = header.find(".episode-number, [class*=episode]").text().trim().toUpperCase();
    const headerTitle = header.find(".flex-1, [class*=title], h3, h4").first().text().trim() || header.text().trim();

    if (seasonStr) {
      const matchesSeason =
        episodeNum.includes(seasonStr) ||
        headerTitle.toUpperCase().includes(seasonStr) ||
        episodeNum.includes(`S${season}`) ||
        headerTitle.toUpperCase().includes(`SEASON ${season}`);
      if (!matchesSeason) return;
    }

    const badgeText = header.find(".badge, [class*=badge], [class*=tag]").map((_j, b) => $(b).text()).get().join(" ");
    const quality = extractQuality(headerTitle + " " + badgeText);

    // Size: orange badge (#ea580c) e.g. "54.72 GB"
    let size: string | undefined;
    header.find(".badge").each((_j, b) => {
      const style = $(b).attr("style") ?? "";
      if (/ea580c/i.test(style)) {
        const t = $(b).text().trim();
        if (/\d+\.?\d*\s*(?:GB|MB|TB)/i.test(t)) size = t;
      }
    });

    // Language: teal badge (#0d9488) e.g. "Hindi,English" — most accurate source
    let language: string | undefined;
    header.find(".badge").each((_j, b) => {
      const style = $(b).attr("style") ?? "";
      if (/0d9488/i.test(style)) {
        const t = $(b).text().trim();
        if (t) language = t.replace(/,\s*/g, " + ");
      }
    });
    if (!language) {
      const langs: string[] = [];
      header.find(".badge, [class*=badge], [class*=tag]").each((_j, b) => {
        const t = $(b).text().trim();
        if (/hindi|english|tamil|telugu|multi|dual|korean|japanese|french/i.test(t)) langs.push(t);
      });
      language = langs.length > 0 ? langs.join(" + ") : extractLanguage(headerTitle + " " + pageUrl);
    }

    $(dlItem).find("a[href]").each((_j, aEl) => {
      const href = $(aEl).attr("href") ?? "";
      const spanText = $(aEl).find("span").first().text().trim() || $(aEl).text().trim();
      if (!href.startsWith("http")) return;
      if (STREAM_HOST_PATTERN.test(href + " " + spanText)) {
        rawLinks.push({ url: href, label: spanText || href, quality, language, size });
      }
    });
  });

  if (rawLinks.length === 0) {
    $("a.btn[href], a[href]").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).find("span").first().text().trim() || $(el).text().trim();
      if (!href.startsWith("http")) return;
      if (STREAM_HOST_PATTERN.test(href + " " + text)) {
        const context = $(el).parents("p, div, li, section").slice(0, 2).text();
        rawLinks.push({
          url: href,
          label: text || href,
          quality: extractQuality(text + " " + context + " " + href + " " + pageUrl),
          language: extractLanguage(text + " " + context + " " + pageUrl),
        });
      }
    });
  }

  if (rawLinks.length === 0) {
    logger.warn({ pageUrl, season, episode }, "4KHDHub: no raw stream links found on page");
  }

  const seen = new Set<string>();
  const uniqueRaw = rawLinks.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  const streams: StreamEntry[] = [];
  const resolvePromises = uniqueRaw.slice(0, 10).map(async (link) => {
    try {
      const resolved = await resolveLink(link.url, link.quality);
      if (resolved) {
        return {
          url: resolved.url,
          quality: resolved.quality,
          language: link.language,
          label: `${resolved.host} | ${link.label}`.slice(0, 80),
          size: link.size,
          server: resolved.host,
          season,
          episode,
        };
      }
    } catch (err) {
      logger.warn({ url: link.url, err }, "4KHDHub stream resolve failed");
    }
    return null;
  });

  const results = await Promise.allSettled(resolvePromises);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) streams.push(r.value);
  }

  if (streams.length > 0) {
    cache.set(cacheKey, streams, TTL.STREAM);
  }
  return streams;
}
