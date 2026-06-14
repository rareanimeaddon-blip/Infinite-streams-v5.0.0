import axios from "axios";
import * as cheerio from "cheerio";
import {
  fetchHtml,
  fetchText,
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

const HDHUB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

const HDHUB_HEADERS: Record<string, string> = {
  "User-Agent": HDHUB_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Cookie: "xla=s4t",
};

const DOMAINS_URL =
  "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
const FALLBACK_DOMAIN = "https://hdhub4u.glass";

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= "Z" ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

async function fetchActiveDomain(): Promise<string> {
  const cacheKey = "hdhub4u:domain:v2";
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get<{ HDHUB4u?: string }>(DOMAINS_URL, {
      timeout: 8000,
      headers: { "User-Agent": HDHUB_UA },
    });
    const domain = res.data?.HDHUB4u?.trim();
    if (domain && domain.startsWith("http")) {
      cache.set(cacheKey, domain, 60 * 60 * 1000);
      logger.info({ domain }, "HDHub4U domain from GitHub");
      return domain;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch HDHub4U domain from GitHub");
  }

  cache.set(cacheKey, FALLBACK_DOMAIN, 15 * 60 * 1000);
  return FALLBACK_DOMAIN;
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

function detectTypeFromCategories(categories: string[]): "movie" | "series" {
  const joined = categories.join(" ").toLowerCase();
  // Require a STRONG series signal — a standalone "series" or "web series" category.
  // Avoid matching "series" embedded in phrases like "South Indian Movies - Hindi Dubbed Series"
  // where "series" is a loose tag and the content is actually a movie.
  if (/\bweb.?series\b|\bwebseries\b|\bseries\b.*\bepisode\b|\bseason\s*\d+/i.test(joined)) return "series";
  return "movie";
}

function detectTypeFromPostType(postType: string, categories: string[]): "movie" | "series" {
  const pt = (postType ?? "").toLowerCase().replace(/[-_\s]+/g, "");
  // Explicit post_type signals override category guessing
  if (pt === "webseries" || pt === "tvseries" || pt === "tvshow") return "series";
  if (pt === "movie" || pt === "film") return "movie";
  // For generic WordPress post type ("post") fall back to category-based detection
  return detectTypeFromCategories(categories);
}

function detectTypeFromSlug(slug: string, title: string): "movie" | "series" {
  return /season|web.?series|webseries|s\d{2}e\d{2}/i.test(slug + " " + title)
    ? "series"
    : "movie";
}

interface TypesenseHit {
  document: {
    post_title: string;
    permalink: string;
    post_thumbnail: string;
    post_type: string;
    category: string[];
  };
}

interface TypesenseResponse {
  hits: TypesenseHit[];
}

export async function searchSite(query: string): Promise<ScrapeItem[]> {
  const cacheKey = `hdhub4u:search:${query.toLowerCase()}`;
  const cached = cache.get<ScrapeItem[]>(cacheKey);
  if (cached) return cached;

  const items: ScrapeItem[] = [];

  try {
    const apiUrl =
      `https://search.pingora.fyi/collections/post/documents/search` +
      `?q=${encodeURIComponent(query)}` +
      `&query_by=post_title,category` +
      `&query_by_weights=4,2` +
      `&sort_by=sort_by_date:desc` +
      `&limit=20` +
      `&highlight_fields=none` +
      `&use_cache=true` +
      `&page=1`;

    const res = await axios.get<TypesenseResponse>(apiUrl, {
      timeout: 10000,
      headers: { "User-Agent": HDHUB_UA, Referer: FALLBACK_DOMAIN },
    });

    const activeDomain = await fetchActiveDomain();

    for (const hit of res.data?.hits ?? []) {
      const doc = hit.document;
      if (!doc.permalink || !doc.post_title) continue;

      const fullUrl = doc.permalink.startsWith("http")
        ? doc.permalink
        : `${activeDomain}${doc.permalink.startsWith("/") ? "" : "/"}${doc.permalink}`;

      const slug = fullUrl.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      items.push({
        slug,
        title: cleanTitle(doc.post_title),
        year: extractYear(doc.post_title),
        poster: doc.post_thumbnail || undefined,
        url: fullUrl,
        type: detectTypeFromPostType(doc.post_type ?? "", doc.category ?? []),
      });
    }
  } catch (err) {
    logger.warn({ query, err }, "HDHub4U Typesense search failed");
  }

  if (items.length === 0) {
    const base = await fetchActiveDomain();
    const $page = await fetchHtml(`${base}/?s=${encodeURIComponent(query)}`, HDHUB_HEADERS);
    if ($page) {
      $page(".recent-movies > li.thumb, article, .post").each((_i, el) => {
        const linkEl = $page(el).find("a[href]").first();
        const href = linkEl.attr("href") ?? "";
        if (!href.startsWith("http")) return;
        const rawTitle =
          $page(el).find("figcaption p, h2, h3, .entry-title, .post-title").first().text().trim() ||
          linkEl.attr("title") ||
          linkEl.text().trim();
        if (!rawTitle || rawTitle.length < 2) return;
        const slug = href.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
        if (!slug || slug.startsWith("category/") || slug.startsWith("page/")) return;
        const imgEl = $page(el).find("img").first();
        const poster = imgEl.attr("data-src") || imgEl.attr("src") || undefined;
        items.push({
          slug,
          title: cleanTitle(rawTitle),
          year: extractYear(rawTitle + " " + slug),
          poster: poster?.startsWith("http") ? poster : undefined,
          url: href,
          type: detectTypeFromSlug(slug, rawTitle),
        });
      });
    }
  }

  const unique = items.filter(
    (item, idx, arr) => item.slug && arr.findIndex((x) => x.slug === item.slug) === idx,
  );
  cache.set(cacheKey, unique.slice(0, 20), TTL.SEARCH);
  return unique.slice(0, 20);
}

export async function fetchListing(
  type: "movie" | "series",
  page = 1,
): Promise<ScrapeItem[]> {
  const cacheKey = `hdhub4u:listing:${type}:${page}`;
  const cached = cache.get<ScrapeItem[]>(cacheKey);
  if (cached) return cached;

  const base = await fetchActiveDomain();

  const paths =
    type === "movie"
      ? [
          `${base}/page/${page}/`,
          `${base}/category/bollywood-movies/page/${page}/`,
          `${base}/category/hollywood-movies/page/${page}/`,
        ]
      : [
          `${base}/category/category/web-series/page/${page}/`,
          `${base}/category/web-series/page/${page}/`,
        ];

  const items: ScrapeItem[] = [];

  for (const url of paths) {
    const $ = await fetchHtml(url, HDHUB_HEADERS);
    if (!$) continue;

    $(".recent-movies > li.thumb").each((_i, el) => {
      const titleText = $(el)
        .find("figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)")
        .text()
        .trim();
      const href = $(el).find("figure:nth-child(1) > a:nth-child(2)").attr("href") ?? "";
      const poster = $(el).find("figure:nth-child(1) > img:nth-child(1)").attr("src");

      if (!titleText || !href.startsWith("http")) return;

      const slug = href.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      items.push({
        slug,
        title: cleanTitle(titleText),
        year: extractYear(titleText + " " + slug),
        poster: poster?.startsWith("http") ? poster : undefined,
        url: href,
        type: detectTypeFromSlug(slug, titleText),
      });
    });

    if (items.length > 0) break;
  }

  const filtered = items.filter((i) => i.type === type);
  const unique = (filtered.length > 0 ? filtered : items).filter(
    (item, idx, arr) => item.slug && arr.findIndex((x) => x.slug === item.slug) === idx,
  );

  cache.set(cacheKey, unique, TTL.CATALOG);
  return unique;
}

async function getRedirectLinks(url: string): Promise<string | null> {
  try {
    const text = await fetchText(url, HDHUB_HEADERS);
    if (!text) return null;

    const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = "";
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const val = m[1] ?? m[2];
      if (val) combined += val;
    }

    if (!combined) return null;

    const step1 = Buffer.from(combined, "base64").toString("utf8");
    const step2 = Buffer.from(step1, "base64").toString("utf8");
    const step3 = rot13(step2);
    const jsonStr = Buffer.from(step3, "base64").toString("utf8");

    const json = JSON.parse(jsonStr) as {
      o?: string;
      data?: string;
      blog_url?: string;
    };

    const encodedUrl = json.o
      ? Buffer.from(json.o, "base64").toString("utf8").trim()
      : "";
    if (encodedUrl.startsWith("http")) return encodedUrl;

    const data = json.data
      ? Buffer.from(json.data, "base64").toString("utf8").trim()
      : "";
    const blogUrl = (json.blog_url ?? "").trim();

    if (blogUrl && data) {
      const directText = await fetchText(`${blogUrl}?re=${data}`, HDHUB_HEADERS);
      if (directText) {
        const $ = cheerio.load(directText);
        const directLink = $("body").text().trim();
        if (directLink.startsWith("http")) return directLink;
      }
    }

    return encodedUrl || null;
  } catch (err) {
    logger.warn({ url, err }, "getRedirectLinks failed");
    return null;
  }
}

const ALLOWED_STREAM_DOMAINS =
  /https?:\/\/(?:.*\.)?(hubcloud|hubdrive|hubstream|hdstream4u|hblinks|pixeldrain|pixeldrain\.dev|streamtape|filemoon|streamwish|wishfast|doodstream|dood\.|upstream|mixdrop|1fichier|mp4upload|gofile)\./i;

export async function extractStreams(
  pageUrl: string,
  season?: number,
  episode?: number,
  expectedImdbId?: string,
): Promise<StreamEntry[]> {
  const cacheKey = `hdhub4u:streams:${pageUrl}:${season ?? ""}:${episode ?? ""}`;
  const cached = cache.get<StreamEntry[]>(cacheKey);
  if (cached) return cached;

  const $ = await fetchHtml(pageUrl, HDHUB_HEADERS);
  if (!$) return [];

  // IMDB ID verification: if the page embeds a different IMDB ID than the one
  // requested, this is the wrong content (remake, regional variant, sequel, etc.).
  // Only reject when a mismatch is confirmed — pages without any IMDB link pass through.
  if (expectedImdbId) {
    const pageImdbId = extractImdbIdFromHtml($.html());
    if (pageImdbId && pageImdbId !== expectedImdbId) {
      logger.info({ pageUrl, pageImdbId, expectedImdbId }, "HDHub4U: IMDB ID mismatch — skipping page");
      return [];
    }
  }

  const isSeries = season !== undefined && episode !== undefined;
  const rawLinks: { url: string; context: string }[] = [];

  // Extract page-level language once from body text (most reliable source)
  const pageBodyText = $("main, .entry-content, .post-content, .page-body, article").first().text();
  const pageLanguage = extractLanguage(pageBodyText + " " + pageUrl);

  if (!isSeries) {
    $("h3 a, h4 a").each((_i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href") ?? "";
      if (/480|720|1080|2160|4K/i.test(text) && href.startsWith("http")) {
        rawLinks.push({ url: href, context: text });
      }
    });

    $(".page-body > div a, .entry-content > div a, .post-content > div a").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (
        href.startsWith("http") &&
        /https?:\/\/(?:.*\.)?(hdstream4u|hubstream)\./i.test(href)
      ) {
        if (!rawLinks.some((r) => r.url === href)) {
          rawLinks.push({ url: href, context: $(el).text().trim() });
        }
      }
    });

    if (rawLinks.length === 0) {
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href") ?? "";
        if (href.startsWith("http") && ALLOWED_STREAM_DOMAINS.test(href)) {
          if (!rawLinks.some((r) => r.url === href)) {
            rawLinks.push({ url: href, context: $(el).text().trim() });
          }
        }
      });
    }
  } else {
    const epLinksMap = new Map<number, string[]>();
    const episodeRegex = /EPiSODE\s*(\d+)/i;

    const headings = $("h3, h4").toArray();

    for (const headerEl of headings) {
      const headerText = $(headerEl).text();
      const epMatch = episodeRegex.exec(headerText);
      const episodeNumberFromTitle = epMatch ? parseInt(epMatch[1]!, 10) : null;

      const headingLinks = $(headerEl)
        .find("a[href]")
        .toArray()
        .map((a) => $(a).attr("href") ?? "")
        .filter((h) => h.startsWith("http"));

      const isDirectLinkBlock = $(headerEl)
        .find("a")
        .toArray()
        .some((a) => /1080|720|4K|2160/i.test($(a).text()));

      if (isDirectLinkBlock) {
        for (const linkUrl of headingLinks) {
          try {
            const resolvedUrl = (await getRedirectLinks(linkUrl.trim())) ?? linkUrl;
            const $ep = await fetchHtml(resolvedUrl, HDHUB_HEADERS);
            if (!$ep) continue;

            $ep("h5 a").each((_j, aEl) => {
              const text = $ep(aEl).text();
              const link = $ep(aEl).attr("href") ?? "";
              if (!link.startsWith("http")) return;
              const epNumMatch = /Episode\s*(\d+)/i.exec(text);
              const epNum = epNumMatch ? parseInt(epNumMatch[1]!, 10) : null;
              if (epNum !== null) {
                const existing = epLinksMap.get(epNum) ?? [];
                existing.push(link);
                epLinksMap.set(epNum, existing);
              }
            });
          } catch (err) {
            logger.warn({ linkUrl, err }, "HDHub4U: error resolving direct link block");
          }
        }
      } else if (episodeNumberFromTitle !== null) {
        const allEpisodeLinks = new Set<string>(headingLinks);

        if ($(headerEl).prop("tagName")?.toLowerCase() === "h4") {
          let next = $(headerEl).next();
          while (next.length && next.prop("tagName")?.toLowerCase() !== "hr") {
            next.find("a[href]").each((_j, aEl) => {
              const h = $(aEl).attr("href") ?? "";
              if (h.startsWith("http")) allEpisodeLinks.add(h);
            });
            next = next.next();
          }
        }

        if (allEpisodeLinks.size > 0) {
          const existing = epLinksMap.get(episodeNumberFromTitle) ?? [];
          for (const l of allEpisodeLinks) existing.push(l);
          epLinksMap.set(episodeNumberFromTitle, existing);
        }
      }
    }

    const episodeLinks = epLinksMap.get(episode!) ?? [];

    if (episodeLinks.length === 0) {
      logger.warn({ pageUrl, season, episode }, "HDHub4U: no episode-specific links found, falling back to all links");
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href") ?? "";
        if (href.startsWith("http") && ALLOWED_STREAM_DOMAINS.test(href)) {
          rawLinks.push({ url: href, context: "" });
        }
      });
    } else {
      for (const l of episodeLinks) rawLinks.push({ url: l, context: "" });
    }
  }

  if (rawLinks.length === 0) {
    logger.warn({ pageUrl, season, episode }, "HDHub4U: no stream links found");
    return [];
  }

  const seen = new Set<string>();
  const uniqueRaw = rawLinks.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  const streams: StreamEntry[] = [];

  const resolvePromises = uniqueRaw.slice(0, 12).map(async (link) => {
    try {
      let finalLink = link.url;
      if (link.url.includes("?id=")) {
        finalLink = (await getRedirectLinks(link.url)) ?? link.url;
      }

      // Context = anchor text (e.g. "1080p 10Bit HEVC [1.6GB]") + pageUrl slug
      const ctx = link.context + " " + pageUrl;
      const qualityHint = extractQuality(ctx);

      // Size: extract from anchor text like "[370MB]", "[1.6GB]", "11.8GB"
      const sizeMatch = /[\[(]?(\d+\.?\d*\s*(?:GB|MB))[\])]?/i.exec(link.context);
      const size = sizeMatch ? sizeMatch[1]!.replace(/\s+/, " ") : undefined;

      const resolved = await resolveLink(finalLink, qualityHint);
      if (!resolved) return null;

      return {
        url: resolved.url,
        quality: resolved.quality,
        language: pageLanguage,
        label: `${resolved.quality} [${resolved.host}]`,
        server: resolved.host,
        size,
        season,
        episode,
      } as StreamEntry;
    } catch (err) {
      logger.warn({ link: link.url, err }, "HDHub4U stream resolve failed");
      return null;
    }
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
