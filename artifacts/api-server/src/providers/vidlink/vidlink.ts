/**
 * VidLink provider — Playwright-based stream extraction.
 *
 * Navigates vidlink.pro in a headless Chromium browser, intercepts all
 * network requests/responses to find signed HLS/MP4 CDN URLs, then
 * expands HLS master playlists into per-quality variants.
 *
 * Requires a TMDB numeric ID. Pass null to skip (returns []).
 */

import { chromium, type Browser } from "playwright";
import { logger } from "../../lib/logger.js";

const VIDLINK_BASE = "https://vidlink.pro";
const EXTRACTION_TIMEOUT_MS = 35_000;

const CHROMIUM_EXECUTABLE_PATH =
  process.env["CHROMIUM_EXECUTABLE_PATH"] ||
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ||
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── Browser singleton ────────────────────────────────────────────────────────

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const inheritedLibraryPath =
      process.env["LD_LIBRARY_PATH"] || process.env["NIX_LD_LIBRARY_PATH"] || "";
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

// ── URL / header normalisation ────────────────────────────────────────────────

interface Candidate {
  url: string;
  headers: Record<string, string>;
}

function parseHeadersParam(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const raw: Record<string, string> = JSON.parse(value);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v) continue;
      const lower = k.toLowerCase();
      if (lower === "referer" || lower === "referrer") out["referer"] = String(v);
      if (lower === "origin") out["origin"] = String(v).replace(/\/$/, "");
    }
    if (!out["referer"]) out["referer"] = "https://filmboom.top/";
    if (!out["origin"]) out["origin"] = "https://filmboom.top";
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * Turn a raw intercepted URL into a Candidate, extracting embedded
 * `headers` and `host` query params that vidlink.pro encodes into its CDN URLs.
 * Returns null if the URL doesn't look like a video file.
 */
function normalizeVidlinkMediaUrl(rawUrl: string): Candidate | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch (_) { return null; }

  const looksLikeVideo =
    /\.(mp4|m3u8)(?:$|[?#])/i.test(rawUrl) || /\/mp\/resource\//i.test(url.pathname);
  if (!looksLikeVideo) return null;

  const headers = parseHeadersParam(url.searchParams.get("headers"));
  const host = url.searchParams.get("host");

  if (host) {
    try {
      const cleanedPath = url.pathname.replace(/^\/mp\//, "/");
      const direct = new URL(cleanedPath, host);
      for (const key of ["sign", "t", "Policy", "Signature", "Key-Pair-Id", "Expires"]) {
        const value = url.searchParams.get(key);
        if (value) direct.searchParams.set(key, value);
      }
      return { url: direct.href, headers };
    } catch (_) { /* fall through */ }
  }

  const direct = new URL(url.href);
  direct.searchParams.delete("headers");
  direct.searchParams.delete("host");
  return { url: direct.href, headers };
}

// ── Quality helpers ───────────────────────────────────────────────────────────

function detectQualityFromUrl(url: string): string {
  if (/2160|4k|uhd/i.test(url)) return "4K";
  if (/1080/i.test(url)) return "1080p";
  if (/720/i.test(url)) return "720p";
  if (/480/i.test(url)) return "480p";
  if (/360/i.test(url)) return "360p";
  return "HD";
}

function qualityRank(q: string): number {
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
 * Fetch an HLS master playlist and expand each variant into its own entry.
 * Non-master playlists and MP4s pass through unchanged.
 */
async function expandM3u8Masters(
  candidates: Array<Candidate & { quality: string }>,
): Promise<Array<Candidate & { quality: string }>> {
  const expanded: Array<Candidate & { quality: string }> = [];

  for (const c of candidates) {
    if (!/\.m3u8/i.test(c.url)) {
      expanded.push(c);
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
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
    } catch (err: any) {
      logger.warn({ err: err.message, url: c.url }, "VidLink: could not fetch m3u8 for quality expansion");
      expanded.push(c);
      continue;
    }

    if (!text.includes("#EXT-X-STREAM-INF")) {
      expanded.push(c);
      continue;
    }

    const lines = text.split("\n");
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
      const height   = resMatch ? parseInt(resMatch[1]) : 0;
      const nextLine = lines[i + 1]?.trim();
      if (!nextLine || nextLine.startsWith("#")) continue;
      const variantUrl = nextLine.startsWith("http") ? nextLine : new URL(nextLine, c.url).href;
      const quality =
        height >= 2160 ? "4K"    :
        height >= 1080 ? "1080p" :
        height >= 720  ? "720p"  :
        height >= 480  ? "480p"  :
        height > 0     ? "360p"  :
        detectQualityFromUrl(variantUrl);
      expanded.push({ ...c, url: variantUrl, quality });
      added++;
    }

    if (added === 0) expanded.push(c);
  }

  // Deduplicate by URL, sort best quality first
  const seen = new Set<string>();
  return expanded
    .filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; })
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

// ── In-flight dedup ───────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<Record<string, unknown>[]>>();

export async function getVidlinkStreams(
  tmdbId: string | null,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  if (!tmdbId) return [];

  const key = `${type}:${tmdbId}:${season}:${episode}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await extractOnce(tmdbId, type, season, episode);
    } finally {
      setTimeout(() => inflight.delete(key), 500);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

// ── Core Playwright extraction ────────────────────────────────────────────────

async function extractOnce(
  tmdbId: string,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  const target =
    type === "series"
      ? `${VIDLINK_BASE}/tv/${tmdbId}/${season}/${episode}`
      : `${VIDLINK_BASE}/movie/${tmdbId}`;

  logger.info({ target }, "VidLink: launching browser extraction");

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

  // Block images/fonts/media to speed up load
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  const candidatesMap = new Map<string, Candidate>();
  const addCandidate = (raw: string) => {
    const n = normalizeVidlinkMediaUrl(raw);
    if (n) candidatesMap.set(n.url, n);
  };

  page.on("request",  (req) => addCandidate(req.url()));
  page.on("response", (res) => addCandidate(res.url()));

  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: EXTRACTION_TIMEOUT_MS });

    // Wait for a video element with a source
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("video")).some(
          (v) => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src,
        ),
        null,
        { timeout: EXTRACTION_TIMEOUT_MS },
      );
    } catch (_) {
      await page.waitForTimeout(4_000);
    }

    // Grab video src attributes
    const videoSources: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video"))
        .flatMap((v) => [(v as HTMLVideoElement).currentSrc, (v as HTMLVideoElement).src])
        .filter(Boolean),
    );
    for (const src of videoSources) addCandidate(src);

    // Pull quality URLs from known player APIs (ArtPlayer, DPlayer, JW Player)
    const jsUrls: string[] = await page.evaluate(() => {
      const urls: string[] = [];
      try {
        for (const key of Object.keys(window as any)) {
          const obj = (window as any)[key];
          if (!obj || typeof obj !== "object") continue;
          const quality = obj.option?.quality ?? obj.quality;
          if (Array.isArray(quality)) {
            for (const q of quality) {
              if (typeof q?.url === "string") urls.push(q.url);
              if (typeof q?.html === "string" && q.html.startsWith("http")) urls.push(q.html);
            }
          }
          const dq = obj.options?.video?.quality ?? obj.video?.quality;
          if (Array.isArray(dq)) {
            for (const q of dq) {
              if (typeof q?.url === "string") urls.push(q.url);
            }
          }
        }
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

    // Click through the quality selector to trigger extra network requests
    try {
      await page.waitForTimeout(2_000);
      const settingsBtnSelectors = [
        ".art-icon-setting", ".art-setting", "[class*='art-icon-setting']",
        ".dplayer-setting", "[class*='setting']", "[class*='quality']",
        "[aria-label*='quality' i]", "[aria-label*='setting' i]",
        ".plyr__controls [data-plyr='settings']",
      ];
      let opened = false;
      for (const sel of settingsBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          await btn.click({ timeout: 1_000 });
          await page.waitForTimeout(600);
          opened = true;
          break;
        }
      }
      if (opened) {
        const qualityItemSelectors = [
          ".art-selector-item", ".art-setting-item", "[class*='quality-item']",
          "[class*='qualityItem']", "[data-value]", ".dplayer-quality-item",
        ];
        for (const qSel of qualityItemSelectors) {
          const items = await page.locator(qSel).all();
          if (!items.length) continue;
          for (const item of items) {
            try {
              await item.click({ timeout: 1_000 });
              await page.waitForTimeout(2_000);
            } catch (_) {}
          }
          break;
        }
      }
    } catch (_) { /* non-fatal */ }

    // Final sweep
    const finalSources: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video"))
        .flatMap((v) => [(v as HTMLVideoElement).currentSrc, (v as HTMLVideoElement).src])
        .filter(Boolean),
    );
    for (const src of finalSources) addCandidate(src);

  } finally {
    await context.close().catch(() => {});
  }

  // Filter to only video files, prefer m3u8 first
  const rawCandidates = Array.from(candidatesMap.values())
    .filter(c => /\.(mp4|m3u8)(?:$|[?#])/i.test(c.url))
    .sort((a, b) => {
      const am = /\.m3u8/.test(a.url) ? 0 : 1;
      const bm = /\.m3u8/.test(b.url) ? 0 : 1;
      return am - bm;
    });

  logger.info({ tmdbId, type, count: rawCandidates.length }, "VidLink: raw candidates found");

  if (!rawCandidates.length) return [];

  // Tag with quality, then expand HLS master playlists
  const tagged = rawCandidates.map(c => ({ ...c, quality: detectQualityFromUrl(c.url) }));
  const candidates = await expandM3u8Masters(tagged);

  logger.info({ tmdbId, type, count: candidates.length }, "VidLink: streams after expansion");

  return candidates.map((c, i) => ({
    name: "🔗 VidLink",
    title: `VidLink · ${c.quality}${i > 0 ? ` (${i + 1})` : ""}\nvidlink.pro`,
    url: c.url,
    ...(Object.keys(c.headers).length
      ? { behaviorHints: { proxyHeaders: { request: c.headers }, notWebReady: false } }
      : { behaviorHints: { notWebReady: false } }),
    _idVerified: true,
  }));
}
