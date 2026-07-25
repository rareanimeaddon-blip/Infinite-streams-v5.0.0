import { createRequire } from "module";
import { chromium } from "playwright";
import { logger } from "./lib/logger.js";

const require = createRequire(import.meta.url);
const { addonBuilder } = require("stremio-addon-sdk");

export const TMDB_API_KEY = process.env["TMDB_API_KEY"] || "5f39fd16e987a9e3fce30d55cf09b438";
const VIDLINK_BASE = "https://vidlink.pro";
export const EXTRACTION_TIMEOUT_MS = Number(process.env["EXTRACTION_TIMEOUT_MS"] || 35000);

const CHROMIUM_EXECUTABLE_PATH =
  process.env["CHROMIUM_EXECUTABLE_PATH"] ||
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ||
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

export const USER_AGENT =
  process.env["USER_AGENT"] ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ADDON_BASE_URL = (() => {
  if (process.env["ADDON_BASE_URL"]) return process.env["ADDON_BASE_URL"].replace(/\/$/, "");
  if (process.env["REPLIT_DEV_DOMAIN"]) return `https://${process.env["REPLIT_DEV_DOMAIN"]}`;
  return "http://127.0.0.1:8080";
})();

// ---------- manifest ----------
const manifest = {
  id: "community.vidlink.direct.fresh",
  version: "3.2.0",
  name: "VidLink Direct Fresh",
  description:
    "Vidlink.pro streams proxied through the addon server — all quality variants extracted on every play, with automatic retry on rate limit.",
  logo: "https://vidlink.pro/favicon.ico",
  resources: [
    "stream",
    "meta",
    { name: "catalog", types: ["movie", "series"], idPrefixes: ["tmdb", "tt"] },
  ],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb"],
  catalogs: [
    { type: "movie", id: "vidlink_trending_movies", name: "VidLink Trending Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "movie", id: "vidlink_popular_movies", name: "VidLink Popular Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "vidlink_trending_series", name: "VidLink Trending Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "vidlink_popular_series", name: "VidLink Popular Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ---------- TMDB cache ----------
const tmdbCache = new Map<string, { value: unknown; expires: number }>();
function cacheGet(key: string): unknown {
  const hit = tmdbCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { tmdbCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key: string, value: unknown, ttlMs = 6 * 60 * 60 * 1000): unknown {
  tmdbCache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function tmdb(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const key = `tmdb:${url.href}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return cacheSet(key, await res.json());
}

export async function resolveTmdbId(type: string, rawId: string): Promise<string | null> {
  const parts = rawId.split(":");
  if (parts[0] === "tmdb") return parts[1] || null;
  if (/^\d+$/.test(parts[0])) return parts[0];
  if (!/^tt\d+/.test(parts[0])) return null;
  const mediaType = type === "series" ? "tv" : "movie";
  const key = `resolve:${mediaType}:${parts[0]}`;
  const cached = cacheGet(key);
  if (cached) return cached as string;
  const data = await tmdb(`/find/${parts[0]}`, { external_source: "imdb_id" });
  const item = mediaType === "tv" ? data.tv_results?.[0] : data.movie_results?.[0];
  return cacheSet(key, item?.id ? String(item.id) : null) as string | null;
}

export function parseStremioId(id: string): { baseId: string; season?: string; episode?: string } {
  const parts = id.split(":");
  if (parts[0] === "tmdb") return { baseId: `tmdb:${parts[1]}`, season: parts[2], episode: parts[3] };
  return { baseId: parts[0], season: parts[1], episode: parts[2] };
}

// ---------- browser (singleton) ----------
let browserPromise: ReturnType<typeof chromium.launch> | null = null;
async function getBrowser() {
  if (!browserPromise) {
    const inheritedLibraryPath = process.env["LD_LIBRARY_PATH"] || process.env["NIX_LD_LIBRARY_PATH"] || "";
    browserPromise = chromium.launch({
      headless: true,
      executablePath: CHROMIUM_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
      ],
      env: { ...(process.env as Record<string, string>), LD_LIBRARY_PATH: inheritedLibraryPath },
    });
  }
  return browserPromise;
}

// ---------- URL normalisation ----------
export function normalizeRequestHeaders(headers: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (lower === "referer" || lower === "referrer") out["referer"] = String(value);
    if (lower === "origin") out["origin"] = String(value).replace(/\/$/, "");
  }
  if (!out["referer"]) out["referer"] = "https://filmboom.top/";
  if (!out["origin"]) out["origin"] = "https://filmboom.top";
  return out;
}

function parseHeadersParam(value: string | null): Record<string, string> {
  if (!value) return {};
  try { return normalizeRequestHeaders(JSON.parse(value)); } catch (_) { return {}; }
}

export interface Candidate {
  url: string;
  headers: Record<string, string>;
  sourceUrl: string;
  quality?: string;
}

export function normalizeVidlinkMediaUrl(rawUrl: string): Candidate | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch (_) { return null; }
  const headers = parseHeadersParam(url.searchParams.get("headers"));
  const host = url.searchParams.get("host");
  const looksLikeVideo = /\.(mp4|m3u8)(?:$|[?#])/i.test(rawUrl) || /\/mp\/resource\//i.test(url.pathname);
  if (!looksLikeVideo) return null;
  if (host) {
    try {
      const cleanedPath = url.pathname.replace(/^\/mp\//, "/");
      const direct = new URL(cleanedPath, host);
      for (const key of ["sign", "t", "Policy", "Signature", "Key-Pair-Id", "Expires"]) {
        const value = url.searchParams.get(key);
        if (value) direct.searchParams.set(key, value);
      }
      return { url: direct.href, headers, sourceUrl: rawUrl };
    } catch (_) { /* fall through */ }
  }
  const direct = new URL(url.href);
  direct.searchParams.delete("headers");
  direct.searchParams.delete("host");
  return { url: direct.href, headers, sourceUrl: rawUrl };
}

// ---------- quality helpers ----------
function detectQualityFromUrl(url: string): string | undefined {
  if (/2160|4k|uhd/i.test(url)) return "4K";
  if (/1080/i.test(url)) return "1080p";
  if (/720/i.test(url)) return "720p";
  if (/480/i.test(url)) return "480p";
  if (/360/i.test(url)) return "360p";
  return undefined;
}

function qualityRank(q: string | undefined): number {
  switch (q) {
    case "4K":    return 5;
    case "1080p": return 4;
    case "720p":  return 3;
    case "480p":  return 2;
    case "360p":  return 1;
    default:      return 0;
  }
}

/**
 * If a captured URL is an HLS master playlist, fetch it and expand each
 * quality variant into its own Candidate.  Non-master playlists and MP4s
 * pass through unchanged (quality label filled from URL if detectable).
 */
export async function expandM3u8Masters(candidates: Candidate[]): Promise<Candidate[]> {
  const expanded: Candidate[] = [];

  for (const c of candidates) {
    // MP4 — just tag quality from URL
    if (!/\.m3u8/i.test(c.url)) {
      expanded.push({ ...c, quality: detectQualityFromUrl(c.url) });
      continue;
    }

    let text: string;
    try {
      const resp = await fetch(c.url, {
        headers: {
          referer: c.headers["referer"] || "https://filmboom.top/",
          origin:  c.headers["origin"]  || "https://filmboom.top",
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
    } catch (err: any) {
      logger.warn({ err: err.message, url: c.url }, "Could not fetch m3u8 for quality expansion");
      expanded.push({ ...c, quality: detectQualityFromUrl(c.url) });
      continue;
    }

    // Not a master playlist — single-quality media segment list
    if (!text.includes("#EXT-X-STREAM-INF")) {
      expanded.push({ ...c, quality: detectQualityFromUrl(c.url) });
      continue;
    }

    // Parse master playlist variants
    const lines = text.split("\n");
    let addedVariants = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const resMatch  = line.match(/RESOLUTION=\d+x(\d+)/i);
      const height    = resMatch ? parseInt(resMatch[1]) : 0;
      const nextLine  = lines[i + 1]?.trim();
      if (!nextLine || nextLine.startsWith("#")) continue;
      const variantUrl = nextLine.startsWith("http")
        ? nextLine
        : new URL(nextLine, c.url).href;
      const quality =
        height >= 2160 ? "4K"   :
        height >= 1080 ? "1080p":
        height >= 720  ? "720p" :
        height >= 480  ? "480p" :
        height >  0    ? "360p" :
        detectQualityFromUrl(variantUrl);
      expanded.push({ ...c, url: variantUrl, quality });
      addedVariants++;
    }

    // Master parsed but no variants found — keep original
    if (addedVariants === 0) {
      expanded.push({ ...c, quality: detectQualityFromUrl(c.url) });
    }
  }

  // Deduplicate by URL, then sort best quality first
  const seen = new Set<string>();
  return expanded
    .filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; })
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

// ---------- short-TTL candidate cache (CDN URLs expire ~5-10 min) ----------
const candidateCache = new Map<string, { list: Candidate[]; exp: number }>();
const CAND_TTL_MS = 4 * 60 * 1000; // 4 minutes

export function candidateCacheKey(
  type: string, tmdbId: string, season?: string, episode?: string,
): string {
  return `cands:${type}:${tmdbId}:${season || ""}:${episode || ""}`;
}

export function cacheCandidates(key: string, list: Candidate[]): void {
  candidateCache.set(key, { list, exp: Date.now() + CAND_TTL_MS });
}

export function getCachedCandidates(key: string): Candidate[] | null {
  const hit = candidateCache.get(key);
  if (!hit || hit.exp < Date.now()) { candidateCache.delete(key); return null; }
  return hit.list;
}

// ---------- in-flight dedup ----------
const inflight = new Map<string, Promise<Candidate[]>>();

export async function extractVidlinkStreams(args: {
  type: string;
  tmdbId: string;
  season?: string;
  episode?: string;
}): Promise<Candidate[]> {
  const key = `${args.type}:${args.tmdbId}:${args.season || ""}:${args.episode || ""}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await extractOnce(args);
    } finally {
      setTimeout(() => inflight.delete(key), 500);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

async function extractOnce(args: {
  type: string;
  tmdbId: string;
  season?: string;
  episode?: string;
}): Promise<Candidate[]> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    userAgent: USER_AGENT,
    locale: "en-US",
    javaScriptEnabled: true,
    bypassCSP: true,
    extraHTTPHeaders: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const candidates = new Map<string, Candidate>();
  const addCandidate = (raw: string) => {
    const n = normalizeVidlinkMediaUrl(raw);
    if (n) candidates.set(n.url, n);
  };
  page.on("request",  (req) => addCandidate(req.url()));
  page.on("response", (res) => addCandidate(res.url()));
  try {
    const target =
      args.type === "series"
        ? `${VIDLINK_BASE}/tv/${args.tmdbId}/${args.season || 1}/${args.episode || 1}`
        : `${VIDLINK_BASE}/movie/${args.tmdbId}`;
    logger.info({ target }, "Extracting Vidlink stream");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: EXTRACTION_TIMEOUT_MS });
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("video")).some(
          (v) => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src,
        ),
        null,
        { timeout: EXTRACTION_TIMEOUT_MS },
      );
    } catch (_) {
      await page.waitForTimeout(4000);
    }

    // Grab initial video src tags
    const videoSources: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video"))
        .flatMap((v) => [(v as HTMLVideoElement).currentSrc, (v as HTMLVideoElement).src])
        .filter(Boolean),
    );
    for (const src of videoSources) addCandidate(src);

    // --- Pull quality URLs from known player APIs before touching the UI ---
    const jsUrls: string[] = await page.evaluate(() => {
      const urls: string[] = [];
      try {
        // ArtPlayer (common on vidlink)
        for (const key of Object.keys(window as any)) {
          const obj = (window as any)[key];
          if (!obj || typeof obj !== "object") continue;
          // ArtPlayer exposes option.quality[]
          const quality = obj.option?.quality ?? obj.quality;
          if (Array.isArray(quality)) {
            for (const q of quality) {
              if (typeof q?.url === "string") urls.push(q.url);
              if (typeof q?.html === "string" && q.html.startsWith("http")) urls.push(q.html);
            }
          }
          // DPlayer exposes options.video.quality[]
          const dq = obj.options?.video?.quality ?? obj.video?.quality;
          if (Array.isArray(dq)) {
            for (const q of dq) {
              if (typeof q?.url === "string") urls.push(q.url);
            }
          }
        }
        // JW Player
        if (typeof (window as any).jwplayer === "function") {
          const pl = (window as any).jwplayer().getPlaylist?.();
          for (const item of pl ?? []) {
            for (const s of item?.sources ?? []) {
              if (typeof s?.file === "string") urls.push(s.file);
            }
          }
        }
      } catch (_) {}
      return urls;
    }).catch(() => [] as string[]);

    for (const u of jsUrls) addCandidate(u);
    logger.info({ jsUrlCount: jsUrls.length, jsUrls }, "Player JS quality URLs");

    // --- Click through the quality selector to trigger additional network requests ---
    try {
      // Extra wait for player controls to fully initialise
      await page.waitForTimeout(2000);

      // Selectors that cover ArtPlayer, DPlayer, Plyr, JW Player, and similar
      const settingsBtnSelectors = [
        ".art-icon-setting",
        ".art-setting",
        "[class*='art-icon-setting']",
        ".dplayer-setting",
        "[class*='setting']",
        "[class*='quality']",
        "[aria-label*='quality' i]",
        "[aria-label*='setting' i]",
        ".plyr__controls [data-plyr='settings']",
      ];

      let opened = false;
      for (const sel of settingsBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          await btn.click({ timeout: 1000 });
          await page.waitForTimeout(600);
          opened = true;
          logger.info({ selector: sel }, "Clicked player settings button");
          break;
        }
      }

      if (opened) {
        // Look for individual quality menu items and click each
        const qualityItemSelectors = [
          ".art-selector-item",
          ".art-setting-item",
          "[class*='quality-item']",
          "[class*='qualityItem']",
          "[data-value]",
          ".dplayer-quality-item",
        ];
        for (const qSel of qualityItemSelectors) {
          const items = await page.locator(qSel).all();
          if (!items.length) continue;
          logger.info({ selector: qSel, count: items.length }, "Found quality items");
          for (const item of items) {
            try {
              await item.click({ timeout: 1000 });
              // Wait for the player to switch source and fire a new network request
              await page.waitForTimeout(2000);
            } catch (_) {}
          }
          break;
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Quality selector interaction failed (non-fatal)");
    }

    // Final sweep: grab any new video src values after interactions
    const finalSources: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video"))
        .flatMap((v) => [(v as HTMLVideoElement).currentSrc, (v as HTMLVideoElement).src])
        .filter(Boolean),
    );
    for (const src of finalSources) addCandidate(src);

    // m3u8 first — signed HLS playlists survive longer than one-shot mp4 links
    const ordered = Array.from(candidates.values())
      .filter((c) => /\.(mp4|m3u8)(?:$|[?#])/i.test(c.url))
      .sort((a, b) => {
        const am = /\.m3u8/.test(a.url) ? 0 : 1;
        const bm = /\.m3u8/.test(b.url) ? 0 : 1;
        return am - bm;
      });
    logger.info(
      { count: ordered.length, urls: ordered.map(c => c.url) },
      "Extraction complete — raw candidates",
    );
    if (!ordered.length) {
      const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      throw new Error(`No media URL found. Page: ${bodyText.slice(0, 180)}`);
    }
    return ordered;
  } finally {
    await context.close().catch(() => {});
  }
}

// Back-compat single-candidate export
export async function extractVidlinkStream(args: {
  type: string;
  tmdbId: string;
  season?: string;
  episode?: string;
}): Promise<Candidate> {
  const list = await extractVidlinkStreams(args);
  return list[0];
}

// ---------- TMDB meta helpers ----------
function posterUrl(path: string | undefined, size = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

async function imdbIdForTmdb(type: string, tmdbId: string): Promise<string> {
  const mediaType = type === "series" ? "tv" : "movie";
  const key = `imdb:${mediaType}:${tmdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached as string;
  const ids = await tmdb(`/${mediaType}/${tmdbId}/external_ids`);
  return cacheSet(key, ids.imdb_id || `tmdb:${tmdbId}`) as string;
}

async function tmdbToMeta(type: string, item: any) {
  const id = await imdbIdForTmdb(type, item.id).catch(() => `tmdb:${item.id}`);
  return {
    id,
    type,
    name: item.title || item.name || item.original_title || item.original_name || "Untitled",
    poster: posterUrl(item.poster_path),
    background: posterUrl(item.backdrop_path, "w1280"),
    description: item.overview || undefined,
    releaseInfo: (item.release_date || item.first_air_date || "").slice(0, 4) || undefined,
    imdbRating: item.vote_average ? String(Math.round(item.vote_average * 10) / 10) : undefined,
  };
}

// ---------- build addon ----------
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }: { type: string; id: string }) => {
  try {
    if (type !== "movie" && type !== "series") return { streams: [] };

    const { baseId, season, episode } = parseStremioId(id);
    const tmdbId = await resolveTmdbId(type, baseId);
    if (!tmdbId) return { streams: [] };

    const key = candidateCacheKey(type, tmdbId, season, episode);

    // Use cached candidates if still fresh; otherwise extract + expand
    let candidates = getCachedCandidates(key);
    if (!candidates) {
      const raw = await extractVidlinkStreams({ type, tmdbId, season, episode });
      candidates = await expandM3u8Masters(raw);
      if (candidates.length) cacheCandidates(key, candidates);
    }

    if (!candidates || !candidates.length) return { streams: [] };

    const isMovie = type === "movie";
    return {
      streams: candidates.map((c, i) => ({
        name: "VidLink",
        title: `VidLink${isMovie ? " Movie" : " Series"} · ${c.quality ?? "HD"}\nFresh CDN stream`,
        url: `${ADDON_BASE_URL}/stream-proxy/${encodeURIComponent(type)}/${encodeURIComponent(id)}?qi=${i}`,
        behaviorHints: { bingeGroup: `vidlink-q${i}` },
      })),
      cacheMaxAge: 0,
      staleRevalidate: 0,
      staleError: 0,
    };
  } catch (err: any) {
    logger.error({ err: err.stack || err.message }, "Stream handler error");
    return { streams: [] };
  }
});

builder.defineCatalogHandler(
  async ({ type, id, extra = {} }: { type: string; id: string; extra: Record<string, string> }) => {
    try {
      const page = Math.floor(Number(extra["skip"] || 0) / 20) + 1;
      let data: any;
      if (extra["search"]) {
        data = await tmdb(`/search/${type === "series" ? "tv" : "movie"}`, { query: extra["search"], page: String(page) });
      } else if (id.includes("popular")) {
        data = await tmdb(`/${type === "series" ? "tv" : "movie"}/popular`, { page: String(page) });
      } else {
        data = await tmdb(`/trending/${type === "series" ? "tv" : "movie"}/week`, { page: String(page) });
      }
      const metas = await Promise.all((data.results || []).slice(0, 20).map((item: any) => tmdbToMeta(type, item)));
      return { metas };
    } catch (err: any) {
      logger.error({ err: err.message }, "Catalog error");
      return { metas: [] };
    }
  },
);

builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
  try {
    const parsed = parseStremioId(id);
    const tmdbId = await resolveTmdbId(type, parsed.baseId);
    if (!tmdbId) return { meta: null };
    const mediaType = type === "series" ? "tv" : "movie";
    const data = await tmdb(`/${mediaType}/${tmdbId}`, { append_to_response: "external_ids" });
    const meta: any = await tmdbToMeta(type, data);
    meta.id = data.external_ids?.imdb_id || meta.id || `tmdb:${tmdbId}`;
    if (type === "series" && data.seasons) {
      meta.videos = data.seasons.flatMap((season: any) => {
        const count = season.episode_count || 0;
        return Array.from({ length: count }, (_, index) => ({
          id: `${meta.id}:${season.season_number}:${index + 1}`,
          title: `S${season.season_number} E${index + 1}`,
          season: season.season_number,
          episode: index + 1,
          released: data.first_air_date,
        }));
      });
    }
    return { meta };
  } catch (err: any) {
    logger.error({ err: err.message }, "Meta error");
    return { meta: null };
  }
});

export const addonInterface = builder.getInterface();

export async function closeBrowser() {
  if (browserPromise) {
    try { (await browserPromise).close(); } catch (_) {}
  }
}
