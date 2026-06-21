import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { titleSimilarityScore } from "../utils/title-score.js";

// ─── HTTP client ──────────────────────────────────────────────────────────────

const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  },
  maxRedirects: 8,
});

// ─── Signer ───────────────────────────────────────────────────────────────────

const SECRET = Buffer.from(
  "NWU5NjA4NWM1NmUwZjU0ZWRhNjU3NzkwYWM1OGQxOWIyNzE0NzljNTA0MzY3ZmM5ZTZhNmMzM2YxZjgyNGU2Yg==",
  "base64",
).toString("utf8");

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function hmacSha256(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex").substring(0, 16);
}

function signHShare(rawId: string, domain: string): string {
  const t = Math.floor(Date.now() / 1000);
  const encoded = base64Url(rawId);
  const s = hmacSha256(SECRET, `${encoded}|${t}`);
  return `${domain}/r.php?d=${encodeURIComponent(encoded)}&t=${t}&s=${s}`;
}

// ─── Cinemeta ─────────────────────────────────────────────────────────────────

async function getMovieMeta(imdbId: string): Promise<{ title: string; year: string } | null> {
  try {
    const char = imdbId.replace(/^tt0*/, "").charAt(0);
    const url = `https://v3.sg.media-imdb.com/suggestion/titles/${encodeURIComponent(char)}/${encodeURIComponent(imdbId)}.json`;
    const res = await http.get<{ d?: Array<{ l?: string; y?: number; id?: string }> }>(url, { timeout: 8000 });
    const item = res.data?.d?.find((x) => x.id === imdbId);
    if (item?.l) return { title: item.l, year: String(item.y ?? "") };
  } catch {
    // ignore
  }

  try {
    const res = await http.get<{ Title?: string; Year?: string; Response?: string }>(
      `https://www.omdbapi.com/?i=${imdbId}&apikey=trilogy`,
      { timeout: 8000 },
    );
    if (res.data?.Response === "True" && res.data.Title) {
      return { title: res.data.Title, year: res.data.Year ?? "" };
    }
  } catch {
    // ignore
  }

  return null;
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://hindmovie.icu";

export interface SiteMovie {
  title: string;
  url: string;
  poster: string | null;
  year: string | null;
  imdbId: string | null;
  genre: string | null;
}

export interface SignedLink {
  signedUrl: string;
  qualityLabel: string;
}

function parseYear(text: string): string | null {
  const m = text.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*(480p|720p|1080p|2160p|4K|UHD)\s*/gi, " ")
    .replace(/\s*Dual\s*Audio\s*/gi, " ")
    .replace(/\s*Hindi[-–]English\s*/gi, " ")
    .replace(/\s*Hindi\s*/gi, " ")
    .replace(/\s*English\s*/gi, " ")
    .replace(/\s*Dubbed\s*/gi, " ")
    .replace(/\s*Subtitle\s*/gi, " ")
    .replace(/\s*BluRay\s*/gi, " ")
    .replace(/\s*WEB-?DL\s*/gi, " ")
    .replace(/\s*\d{4}\s*/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+season\s+\d+/i, "")
    .replace(/\s+s\d{2}e\d{2}.*/i, "")
    .replace(/-/g, "")              // merge hyphenated compounds: "Shin-chan" → "shinchan"
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Require at least one shared word (≥3 chars) between two titles.
// More reliable than a character prefix for avoiding false positives like
// "Friends" → "Friendship" or "Friends" → "Never Kiss Your Best Friend".
function wordOverlap(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(normaliseTitle(s).split(" ").filter((w) => w.length >= 3));
  const wa = words(a);
  if (!wa.size) return false;
  const wb = words(b);
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

function extractImdbId(html: string): string | null {
  const m = html.match(/imdb\.com\/title\/(tt\d{7,8})/i);
  return m ? m[1] : null;
}

function parseMovieList(html: string): SiteMovie[] {
  const $ = cheerio.load(html);
  const movies: SiteMovie[] = [];

  $("article").each((_, el) => {
    const $el = $(el);
    const linkEl = $el.find("h2.entry-title a").first();
    const rawUrl = linkEl.attr("href") ?? "";
    const rawTitle = linkEl.text().trim();
    if (!rawUrl || !rawTitle) return;

    const poster =
      $el.find("img").first().attr("data-src") ||
      $el.find("img").first().attr("src") ||
      null;
    const year = parseYear(rawTitle);
    const imdbId = extractImdbId($.html($el) ?? "");
    const genres = $el
      .find(".cat-links a")
      .map((_, a) => $(a).text().trim())
      .get();

    movies.push({
      title: cleanTitle(rawTitle),
      url: rawUrl.replace(/#.*$/, ""),
      poster: poster ?? null,
      year,
      imdbId,
      genre: genres.length ? genres.join(", ") : null,
    });
  });

  return movies;
}

export async function searchMovies(query: string, page = 1): Promise<SiteMovie[]> {
  const url = `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`;
  const html = (await http.get<string>(url)).data;
  return parseMovieList(html);
}

export async function getMoviesByPage(page = 1): Promise<SiteMovie[]> {
  const url = page === 1 ? `${BASE_URL}/movies/` : `${BASE_URL}/movies/page/${page}/`;
  const html = (await http.get<string>(url)).data;
  return parseMovieList(html);
}

export async function getSeriesByPage(page = 1): Promise<SiteMovie[]> {
  const url = page === 1 ? `${BASE_URL}/web-series/` : `${BASE_URL}/web-series/page/${page}/`;
  const html = (await http.get<string>(url)).data;
  return parseMovieList(html);
}

async function findMovieByTitle(title: string, year?: string, imdbId?: string): Promise<SiteMovie | null> {
  const normTarget = normaliseTitle(title);

  function tryMatch(results: SiteMovie[]): SiteMovie | null {
    if (!results.length) return null;
    // Tier 0: exact IMDB ID match — unambiguous, no false positives possible
    if (imdbId) {
      const idMatch = results.find((m) => m.imdbId && m.imdbId === imdbId);
      if (idMatch) return idMatch;
    }
    // Year-coherent pool: when the requested year is known, exclude any site result
    // that carries a year MORE than 2 years away. Results with no year on the site
    // are always kept (can't verify). This prevents "Friends" (1994) from matching
    // a Hindi show of the same name from a different era.
    const yearCoherent = year
      ? results.filter((m) => !m.year || Math.abs(parseInt(m.year, 10) - parseInt(year, 10)) <= 2)
      : results;

    if (year) {
      // Tier 1: exact normalised title + year
      const hit = yearCoherent.find(
        (m) => normaliseTitle(m.title) === normTarget && m.year === year,
      );
      if (hit) return hit;
      // Tier 2: best-scored word-overlap candidate + year match.
      // Using find() would return the FIRST overlap result (search rank order),
      // which can be wrong when the site returns loosely-related titles first.
      // Instead, score all candidates and pick the highest-scoring one.
      const tier2 = yearCoherent
        .filter((m) => wordOverlap(title, m.title) && m.year === year)
        .map((m) => ({ m, score: titleSimilarityScore(title, m.title) }))
        .sort((a, b) => b.score - a.score);
      if (tier2.length && tier2[0]!.score >= 0.4) return tier2[0]!.m;
    }
    // Tier 3: exact normalised title — use year-coherent pool so a same-name
    // Hindi/regional show from a different year doesn't shadow the real result.
    const exact = yearCoherent.find((m) => normaliseTitle(m.title) === normTarget);
    if (exact) return exact;
    // Tier 4: best-scored word-overlap candidate — weakest fallback.
    // Must score at least 0.5 to prevent mismatches like "Office" → "Office India".
    const tier4 = yearCoherent
      .filter((m) => wordOverlap(title, m.title))
      .map((m) => ({ m, score: titleSimilarityScore(title, m.title) }))
      .sort((a, b) => b.score - a.score);
    if (tier4.length && tier4[0]!.score >= 0.5) return tier4[0]!.m;
    return null;
  }

  try {
    const page1 = await searchMovies(title, 1);
    const hit1 = tryMatch(page1);
    if (hit1) return hit1;

    // Page 1 had results but no good title match — try page 2
    if (page1.length > 0) {
      try {
        const page2 = await searchMovies(title, 2);
        const hit2 = tryMatch(page2);
        if (hit2) return hit2;
      } catch {
        // ignore page 2 failure
      }
    }

    // No match found — return null rather than serving wrong content
    return null;
  } catch {
    return null;
  }
}

async function getMovieSignedLinks(movieUrl: string): Promise<SignedLink[]> {
  const html = (await http.get<string>(movieUrl)).data;
  const $ = cheerio.load(html);

  const tasks: Array<{ mvlinkUrl: string; qualityLabel: string }> = [];

  $("a.maxbutton").each((_, el) => {
    const $btn = $(el);
    const btnHref = $btn.attr("href") ?? "";
    if (!btnHref) return;

    let qualityLabel = "";
    const $parent = $btn.parent();
    const $prevH3 = $parent.prev("h3");
    if ($prevH3.length) {
      qualityLabel = $prevH3.text().trim();
    }

    tasks.push({ mvlinkUrl: btnHref, qualityLabel });
  });

  const resolved: SignedLink[] = [];

  await Promise.allSettled(
    tasks.map(async ({ mvlinkUrl, qualityLabel }) => {
      try {
        const mvHtml = (await http.get<string>(mvlinkUrl)).data;
        const $mv = cheerio.load(mvHtml);

        const anchor = $mv(
          'a.get-link-btn, a:contains("Get Links"), div.entry-content a[href*="/?id="]',
        ).first();
        const rawHref = anchor.attr("href") ?? "";
        if (!rawHref || !rawHref.includes("id=")) return;

        const idIdx = rawHref.indexOf("/?id=");
        if (idIdx === -1) return;
        const domain = rawHref.substring(0, idIdx);
        const rawId = rawHref.substring(idIdx + 5);
        if (!domain || !rawId) return;

        const signed = signHShare(rawId, domain);
        resolved.push({ signedUrl: signed, qualityLabel });
      } catch {
        // ignore individual failures
      }
    }),
  );

  return resolved;
}

async function getSeriesEpisodeSignedLink(
  seriesUrl: string,
  season: number,
  episode: number,
): Promise<string | null> {
  try {
    const html = (await http.get<string>(seriesUrl)).data;
    const $ = cheerio.load(html);

    let episodeListUrl: string | null = null;

    $("h3").each((_, el): false | undefined => {
      const $h3 = $(el);
      const text = $h3.text();
      const match = text.match(/Season\s*(\d+)/i);
      if (!match || parseInt(match[1]!, 10) !== season) return undefined;

      const $sib = $h3.next();
      const href = $sib.find("a[href]").first().attr("href") ?? "";
      if (href) {
        episodeListUrl = href;
        return false;
      }
      return undefined;
    });

    if (!episodeListUrl) {
      episodeListUrl =
        $("a.maxbutton-episode-list, a.maxbutton").first().attr("href") ?? null;
    }

    if (!episodeListUrl) return null;

    const epHtml = (await http.get<string>(episodeListUrl)).data;
    const $ep = cheerio.load(epHtml);

    let epHref: string | null = null;

    $ep('h3 > a, a:contains("Episode")').each((_, el) => {
      const $a = $ep(el);
      const match = $a.text().match(/Episode\s*(\d+)/i);
      if (!match || parseInt(match[1]!, 10) !== episode) return;
      epHref = $a.attr("href") ?? null;
      return false;
    });

    if (!epHref) return null;

    const idIdx = (epHref as string).indexOf("/?id=");
    if (idIdx === -1) return null;
    const domain = (epHref as string).substring(0, idIdx);
    const rawId = (epHref as string).substring(idIdx + 5);
    if (!domain || !rawId) return null;

    return signHShare(rawId, domain);
  } catch {
    return null;
  }
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

interface ResolvedStream {
  name: string;
  title: string;
  url: string;
  notWebReady: boolean;
}

function qualityFromText(text: string): string {
  if (/2160|4[kK]|uhd/i.test(text)) return "4K";
  if (/1080/i.test(text)) return "1080p";
  if (/720/i.test(text)) return "720p";
  if (/480/i.test(text)) return "480p";
  return "HD";
}

function extractSpecs(name: string): string {
  const parts: string[] = [];
  const q = qualityFromText(name);
  if (q !== "HD") parts.push(q);
  if (/bluray|bdrip/i.test(name)) parts.push("BluRay");
  else if (/web[- ]?dl/i.test(name)) parts.push("WEB-DL");
  else if (/webrip/i.test(name)) parts.push("WEBRip");
  else if (/hdrip/i.test(name)) parts.push("HDRip");
  if (/x265|hevc/i.test(name)) parts.push("x265");
  else if (/x264/i.test(name)) parts.push("x264");
  if (/10[- ]?bit/i.test(name)) parts.push("10bit");
  if (/dual/i.test(name)) parts.push("Dual");
  else if (/hindi/i.test(name)) parts.push("HIN");
  return parts.join(" ") || q;
}

async function resolveGdshine(url: string): Promise<string | null> {
  try {
    const id = url.split("/").pop() ?? "";
    if (!id) return null;

    const fileRes = await http.get<{ data: { id: string; name: string } }>(
      `https://gdshine.org/api/files/s/${id}`,
      { timeout: 10000 },
    );
    const fileData = fileRes.data?.data;
    if (!fileData?.id) return null;

    const workerRes = await http.post<{ data: { copyUrl: string } }>(
      `https://gdshine.org/api/downloads/${fileData.id}/via-worker`,
      {},
      { timeout: 10000 },
    );
    return workerRes.data?.data?.copyUrl ?? null;
  } catch {
    return null;
  }
}

async function resolveSignedUrl(
  signedUrl: string,
  qualityLabel: string,
): Promise<ResolvedStream[]> {
  const streams: ResolvedStream[] = [];

  let html: string;
  try {
    html = (await http.get<string>(signedUrl)).data;
  } catch {
    return streams;
  }

  const $ = cheerio.load(html);

  const rawName =
    $("p:contains('Name:')")
      .first()
      .text()
      .replace(/.*Name:\s*/i, "")
      .split("\n")[0]
      ?.trim() ?? "";
  const fileSize =
    $("p:contains('Size:')")
      .first()
      .text()
      .replace(/.*Size:\s*/i, "")
      .split("\n")[0]
      ?.trim() ?? "";

  const specs = extractSpecs(rawName || qualityLabel);
  const sizeTag = fileSize ? ` [${fileSize}]` : "";

  const btnUrls: string[] = [];
  $("a.btn").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href && !href.startsWith("javascript")) btnUrls.push(href);
  });

  await Promise.allSettled(
    btnUrls.map(async (btnUrl) => {
      if (btnUrl.toLowerCase().includes("gdshine")) {
        const directUrl = await resolveGdshine(btnUrl);
        if (directUrl) {
          streams.push({
            name: `HindMoviez\n${specs}`,
            title: `GDShine${sizeTag}`,
            url: directUrl,
            notWebReady: false,
          });
        }
        return;
      }

      try {
        const btnHtml = (await http.get<string>(btnUrl, { timeout: 12000 })).data;
        const $btn = cheerio.load(btnHtml);

        $btn("a.button[href], a[data-video][href], a:has(button.button)[href]").each(
          (_, el) => {
            const href = $btn(el).attr("href") ?? "";
            if (!href || href === "#" || href.startsWith("javascript")) return;

            let label = $btn(el).text().trim();
            if (!label) label = $btn(el).find("button").text().trim();
            if (!label) label = "Stream";

            const notWebReady =
              !href.includes("googleusercontent.com") &&
              !href.includes(".workers.dev") &&
              !href.includes(".m3u8") &&
              !href.startsWith("https://");

            streams.push({
              name: `HindMoviez\n${specs}`,
              title: `${label}${sizeTag}`,
              url: href,
              notWebReady,
            });
          },
        );
      } catch {
        // ignore failures per-btn
      }
    }),
  );

  return streams;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export interface MetaPreview {
  id: string;
  type: "movie" | "series";
  name: string;
  poster: string | null;
  releaseInfo?: string;
  genres?: string[];
}

function toMeta(movie: SiteMovie, type: "movie" | "series"): MetaPreview {
  const id =
    movie.imdbId ?? `hindmoviez:${Buffer.from(movie.url).toString("base64url")}`;
  return {
    id,
    type,
    name: movie.title,
    poster: movie.poster,
    releaseInfo: movie.year ?? undefined,
    genres: movie.genre ? movie.genre.split(",").map((g) => g.trim()) : undefined,
  };
}

export async function getCatalog(
  type: "movie" | "series",
  _id: string,
  extra: Record<string, string>,
): Promise<MetaPreview[]> {
  const skip = parseInt(extra["skip"] ?? "0", 10);
  const page = Math.floor(skip / 20) + 1;
  const search = (extra["search"] ?? "").trim();

  let movies: SiteMovie[] = [];
  if (search) {
    movies = await searchMovies(search, page);
  } else if (type === "series") {
    movies = await getSeriesByPage(page);
  } else {
    movies = await getMoviesByPage(page);
  }

  return movies.map((m) => toMeta(m, type));
}

// ─── Main streams export ──────────────────────────────────────────────────────

export interface StremioStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: Record<string, unknown>;
}

export async function getStreams(
  type: "movie" | "series",
  imdbId: string,
  season?: number,
  episode?: number,
): Promise<StremioStream[]> {
  if (!imdbId.startsWith("tt")) return [];

  try {
    const meta = await getMovieMeta(imdbId);
    if (!meta) {
      logger.warn({ imdbId }, "HindMoviez: could not resolve meta");
      return [];
    }

    const siteEntry = await findMovieByTitle(meta.title, meta.year || undefined, imdbId);
    if (!siteEntry) {
      logger.warn({ imdbId, title: meta.title }, "HindMoviez: no matching page");
      return [];
    }

    // Post-match IMDB cross-check: if the list page embedded an IMDB ID and it
    // differs from the requested one, we have definitively matched the wrong show
    // (e.g. a Hindi "Friends" whose list page links to a different tt ID).
    // When the site has no IMDB ID on the list page we fall back to year-coherent
    // title matching done in findMovieByTitle.
    if (siteEntry.imdbId && siteEntry.imdbId !== imdbId) {
      logger.warn(
        { imdbId, siteImdbId: siteEntry.imdbId, requestedTitle: meta.title, matchedTitle: siteEntry.title },
        "HindMoviez: list-page IMDB ID mismatch — rejecting match",
      );
      return [];
    }

    logger.info({ imdbId, title: meta.title, matched: siteEntry.title, siteImdbId: siteEntry.imdbId ?? "none" }, "HindMoviez: matched");

    const streams: StremioStream[] = [];

    if (type === "movie") {
      const signedLinks = await getMovieSignedLinks(siteEntry.url);

      const results = await Promise.allSettled(
        signedLinks.map(({ signedUrl, qualityLabel }) =>
          resolveSignedUrl(signedUrl, qualityLabel),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          for (const s of result.value) {
            streams.push({
              name: s.name,
              title: s.title,
              url: s.url,
              behaviorHints: { notWebReady: s.notWebReady },
            });
          }
        }
      }
    } else if (type === "series" && season !== undefined && episode !== undefined) {
      const signedUrl = await getSeriesEpisodeSignedLink(siteEntry.url, season, episode);

      if (signedUrl) {
        const resolved = await resolveSignedUrl(signedUrl, `S${season}E${episode}`);
        for (const s of resolved) {
          streams.push({
            name: s.name,
            title: s.title,
            url: s.url,
            behaviorHints: {
              notWebReady: s.notWebReady,
              bingeGroup: `hindmoviez-${imdbId}-s${season}`,
            },
          });
        }
      }
    }

    logger.info({ imdbId, count: streams.length }, "HindMoviez: done");
    return streams;
  } catch (err) {
    logger.error({ err, imdbId }, "HindMoviez: provider error");
    return [];
  }
}
