/**
 * Movies4u Scraper
 * Flow: movies4u.clinic search → movie page → m4ulinks.site download page
 *       → hubcloud.cx / filebee.xyz / vcloud.zip links → direct download URL
 */

import { load } from "cheerio";
import { logger } from "../lib/logger.js";

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DOMAINS_URL =
  "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
const FALLBACK_BASE = "https://new1.movies4u.clinic";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Cookie: "xla=s4t",
};

interface Movies4uStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: {
    proxyHeaders?: { request?: Record<string, string> };
  };
}

// ─── Domain Cache ─────────────────────────────────────────────────────────────

let cachedBase: string | null = null;
let domainExpiry = 0;

async function getBaseUrl(): Promise<string> {
  if (cachedBase && Date.now() < domainExpiry) return cachedBase;
  try {
    const res = await fetch(DOMAINS_URL, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as Record<string, string>;
    cachedBase = data["movies4u"] ?? data["movies4uhd"] ?? FALLBACK_BASE;
    domainExpiry = Date.now() + 30 * 60 * 1000; // 30 min cache
  } catch {
    cachedBase = FALLBACK_BASE;
    domainExpiry = Date.now() + 5 * 60 * 1000; // shorter TTL on failure
  }
  return cachedBase;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractQuality(text: string): string {
  const t = text.toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return "4K";
  if (/1080p/.test(t)) return "1080p";
  if (/720p/.test(t)) return "720p";
  if (/480p/.test(t)) return "480p";
  return "Unknown";
}

interface QualityEntry {
  quality: string;
  label: string;
  size: string;
}

function parseH4Quality(h4Text: string): QualityEntry {
  const q = extractQuality(h4Text);
  const sizeMatch = h4Text.match(/\[([^\]]+(?:MB|GB))\]/i);
  return {
    quality: q === "Unknown" ? "1080p" : q,
    label: h4Text.trim(),
    size: sizeMatch?.[1] ?? "N/A",
  };
}

// ─── vcloud.zip resolver ──────────────────────────────────────────────────────

/**
 * Extract the actual download URL from a vcloud.zip page.
 *
 * The page has used two different formats in the wild:
 *   1. (older) double-base64-encoded: var url = atob(atob('...'));
 *   2. (current) a plain JS string literal: var url = 'https://...';
 * We try the current plain-string format first, then fall back to the
 * older double-base64 format so both eras of the page keep working.
 */
const isFinalCdnUrl = (candidate: string): boolean => {
  try {
    return new URL(candidate).hostname !== "vcloud.zip";
  } catch {
    return false;
  }
};

/** One fetch+extract pass over a vcloud.zip page. Returns whatever URL the
 * page embeds next (which may itself be another vcloud.zip hop) or null. */
async function fetchVcloudResolution(vcloudUrl: string): Promise<string | null> {
  const res = await fetch(vcloudUrl, {
    headers: { ...BROWSER_HEADERS, Referer: "https://vcloud.zip/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  // Current format: var url = 'https://...';
  const plain = html.match(/var\s+url\s*=\s*['"`](https?:\/\/[^'"`]+)['"`]/);
  if (plain?.[1]) return plain[1];

  // Legacy format: var url = atob(atob('...'));
  const m = html.match(/atob\(atob\(['"`]([^'"`]+)['"`]\)\)/);
  if (m?.[1]) {
    const step1 = Buffer.from(m[1], "base64").toString("utf8");
    const step2 = Buffer.from(step1, "base64").toString("utf8");
    if (step2.startsWith("http")) return step2;
  }

  return null;
}

/**
 * Extract the actual download URL from a vcloud.zip page.
 *
 * vcloud.zip is sometimes a *two-hop* redirect: the link scraped off
 * m4ulinks.site (no `?token=`) decodes to a second vcloud.zip URL (now with
 * a `?token=`), and only that second page's `var url = ...` reveals the
 * final CDN file. So a decoded candidate that is itself still a vcloud.zip
 * URL is not a dead end -- it must be followed one more hop. We cap the
 * chain at a few hops to avoid ever looping indefinitely.
 *
 * The page also occasionally serves an interstitial/"please wait" page
 * whose own `var url = '...'` self-links back to the *same* vcloud.zip URL
 * we just requested (not a new hop, not the final file) while the real
 * link is still being generated -- so we retry once after a short delay
 * before giving up in that specific case.
 */
async function resolveVcloudUrl(startUrl: string): Promise<string | null> {
  try {
    let current = startUrl;
    for (let hop = 0; hop < 4; hop++) {
      let next = await fetchVcloudResolution(current);
      if (!next) return null;
      if (next === current) {
        // Self-referential "please wait" interstitial; retry once.
        await new Promise((r) => setTimeout(r, 1500));
        next = await fetchVcloudResolution(current);
        if (!next || next === current) return null;
      }
      if (isFinalCdnUrl(next)) return next;
      current = next; // another vcloud.zip hop -- follow it
    }
    return null;
  } catch {
    return null;
  }
}

// ─── hubcloud.cx resolver ─────────────────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–");
}

/**
 * Fetch a hubcloud.cx `/video/{id}` or `/drive/{id}` landing page and resolve
 * it all the way down to a final, directly-fetchable CDN URL.
 *
 * This is a TWO-HOP chain, not a single fetch:
 *   1. hubcloud.cx/{video,drive}/{id} → HTML page with a
 *      gamerxyt.com/hubcloud.php?...&token=... button (the token here is
 *      short-lived, so it must be extracted fresh each time — never cached).
 *   2. gamerxyt.com/hubcloud.php?...  → HTML page listing several CDN
 *      backend buttons for the same file. hubcloud.cx has changed which
 *      backend it offers more than once, so we try known button ids/classes
 *      in priority order and verify the winner with a live HEAD request
 *      rather than hardcoding one domain:
 *        - id="fsl"  (btn-success) → currently `hub.whistle.lat/{hash}?token=...`,
 *          a direct-download CDN link (previously this button pointed at
 *          `fsl.gigabytes.icu`; the domain behind "fsl" has changed at least
 *          twice — always resolve by button id, never by hardcoded hostname).
 *        - the "10Gbps" gpdl*.hubcloud.* button (older layout) — follow its
 *          redirect chain (gpdl.hubcloud.* → *.workers.dev →
 *          gamerxyt.com/dl.php?link=...) and read the final Google-hosted
 *          video URL off the `link` query param.
 *        - a signed r2.cloudflarestorage.com URL (has full AWS SigV4 auth,
 *          unlike the *private* pub-*.r2.dev bucket links on the same page,
 *          which return 403 for everyone and must never be picked).
 *        - any other direct video href as a last resort.
 *
 * Previously this provider handed the raw hubcloud.cx landing-page URL
 * straight to Stremio as the "stream" — that's an HTML page, not a video
 * file, so playback exited immediately. Resolving the full chain at scrape
 * time fixes that; the resolved CDN links we've observed carry multi-hour
 * (or longer) validity, so pre-resolving well before play time is safe.
 */
async function resolveHubcloudUrl(hubUrl: string): Promise<string | null> {
  try {
    const page1Res = await fetch(hubUrl, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!page1Res.ok) return null;
    const page1Html = await page1Res.text();

    // Hop 1: find the gamerxyt.com/hubcloud.php intermediate link.
    const phpMatch = page1Html.match(/href="(https?:\/\/gamerxyt\.com\/hubcloud\.php\?[^"]+)"/i);
    if (!phpMatch?.[1]) return null;
    const phpUrl = decodeHtmlEntities(phpMatch[1]);

    const page2Res = await fetch(phpUrl, {
      headers: { ...BROWSER_HEADERS, Referer: hubUrl },
      signal: AbortSignal.timeout(10000),
    });
    if (!page2Res.ok) return null;
    const page2Html = decodeHtmlEntities(await page2Res.text());

    // Hop 2a (current preferred): the button with id="fsl" (btn-success).
    // Its target domain has changed hostnames before (fsl.gigabytes.icu →
    // hub.whistle.lat) — match by the button's id attribute, not by domain,
    // and confirm it's a real file with a HEAD request before trusting it.
    const fslBtnMatch = page2Html.match(/<a\s+href="([^"]+)"\s+id="fsl"/i);
    if (fslBtnMatch?.[1]) {
      const candidate = decodeHtmlEntities(fslBtnMatch[1]);
      try {
        const headRes = await fetch(candidate, {
          method: "HEAD",
          headers: { ...BROWSER_HEADERS, Referer: phpUrl },
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (headRes.ok) return headRes.url || candidate;
      } catch {
        // fall through to the other backends below
      }
    }

    // Hop 2b (older layout): the "10Gbps" gpdl*.hubcloud.* button. Following
    // its redirect chain lands on gamerxyt.com/dl.php?link=<final video URL>
    // — read the `link` param straight off the final redirect target.
    const gpdlMatch = page2Html.match(/href="(https?:\/\/gpdl\d*\.hubcloud\.[a-z]+\/\?id=[^"]+)"/i);
    if (gpdlMatch?.[1]) {
      try {
        const gpdlRes = await fetch(gpdlMatch[1], {
          headers: { ...BROWSER_HEADERS, Referer: hubUrl },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        const finalLink = new URL(gpdlRes.url).searchParams.get("link");
        if (finalLink?.startsWith("http")) return finalLink;
      } catch {
        // fall through to the other backends below
      }
    }

    // Hop 2c fallbacks — never pick a plain pub-*.r2.dev URL (private bucket,
    // 403s for every requester); prefer the signed r2.cloudflarestorage.com
    // URL instead.
    const r2Signed = page2Html.match(/href="(https?:\/\/[a-z0-9.-]*\.r2\.cloudflarestorage\.com\/[^"]+)"/i);
    if (r2Signed?.[1]) return r2Signed[1];

    const fsl = page2Html.match(/href="(https?:\/\/fsl\.gigabytes\.icu[^"]+)"/i);
    if (fsl?.[1]) return fsl[1];

    const direct = page2Html.match(
      /href="(https?:\/\/(?!hubcloud\.cx)[^"]+\.(?:mp4|mkv)[^"]*)"/i,
    );
    if (direct?.[1] && !/pub-[0-9a-f]+\.r2\.dev\//i.test(direct[1])) return direct[1];

    return null;
  } catch {
    return null;
  }
}

// ─── filebee.xyz resolver ─────────────────────────────────────────────────────

/**
 * filebee.xyz is a React SPA — the CDN URL visible in the initial HTML is
 * rendered into a hidden anchor and the real token is injected by JS.
 * The extracted URL consistently returns 404 without JS execution.
 * We skip filebee.xyz entirely for now.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function resolveFilebeeUrl(_fbUrl: string): Promise<string | null> {
  return null;
}

// ─── gdflix-family pre-resolver ───────────────────────────────────────────────
//
// gdlink.dev / gdflix.* are "intermediate" pages: the real video lives one
// more hop away at instant.busycdn.xyz, which then redirects through the
// fastcdn-dl.pages.dev interstitial to Google Video.
//
// The proxy handles this whole chain lazily (at play time), but doing so adds
// ~1.5 s of latency (3 serial HTTP requests + DNS before the first byte).
//
// Fix: at SCRAPE TIME (when Stremio opens the title), pre-resolve the gdflix
// page to the stable busycdn URL in parallel across quality tiers.  The proxy
// then only needs one hop (busycdn → fastcdn-dl unwrap → Google Video → stream),
// cutting play-start latency to under 500 ms.
//
// If pre-resolve fails (timeout, Cloudflare challenge, network error), we fall
// back silently to the raw gdlink/gdflix URL so the proxy does lazy resolution
// as before — no stream is lost.

// Exact hostnames the pre-resolver is allowed to fetch.  Substring matching
// is insufficient — a crafted source page could supply a URL whose substring
// matches but whose actual hostname (e.g. evil.gdlink.dev.attacker.com) does
// not belong to the intended CDN.
const GDFLIX_ALLOWED_HOSTS = new Set([
  "gdlink.dev",
  "gdflix.dev",
  "gdflix.lol",
  "new1.gdflix.io",
  "new2.gdflix.app",
]);

function isGdflixFamily(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && GDFLIX_ALLOWED_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Follow the cdn.foxcloud.rest two-hop chain to a Google Video direct URL.
 * Hop 1: cdn.foxcloud.rest/?url=... → HTML page with JS redirect to /upload?url=...
 * Hop 2: cdn.foxcloud.rest/upload?url=... → HTML page with Google Video download link
 */
async function followFoxcloudChain(foxUrl: string, referer: string): Promise<string | null> {
  try {
    const res1 = await fetch(foxUrl, {
      headers: { ...BROWSER_HEADERS, Referer: referer },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res1.ok) return null;
    const html1 = await res1.text();
    const uploadMatch = html1.match(/window\.location\.href\s*=\s*["']([^"']*\/upload\?url=[^"']*)["']/);
    if (!uploadMatch?.[1]) return null;
    const uploadPath = uploadMatch[1];
    const uploadUrl = uploadPath.startsWith("http")
      ? uploadPath
      : `https://cdn.foxcloud.rest${uploadPath.startsWith("/") ? "" : "/"}${uploadPath}`;
    const res2 = await fetch(uploadUrl, {
      headers: { ...BROWSER_HEADERS, Referer: foxUrl },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res2.ok) return null;
    const html2 = await res2.text();
    const gvMatch = html2.match(/href="(https?:\/\/video-downloads\.googleusercontent\.com\/[^"]+)"/i);
    if (gvMatch?.[1]) return gvMatch[1];
    const directMatch = html2.match(/href="(https?:\/\/[^"]+\.(?:mp4|mkv|avi)[^"]*)"/i);
    return directMatch?.[1]?.replace(/&amp;/g, "&") ?? null;
  } catch { return null; }
}

/**
 * Fetch a gdlink/gdflix intermediate page and pre-resolve it to a directly
 * playable CDN URL at scrape time so Stremio can start playing immediately.
 *
 * Resolution priority (highest → lowest reliability):
 *   1. pixeldrain.com/u/{ID}  — direct streaming API, confirmed range-request support
 *   2. cdn.foxcloud.rest chain — 2-hop follow to Google Video URL
 *   3. instant.busycdn.xyz    — follow redirect chain to fastcdn-dl ?url= param
 *
 * Returns null on any failure so the caller keeps the raw gdflix URL and the
 * proxy resolves it lazily at play time.  Never returns a dead intermediate URL
 * (raw busycdn) — that causes Stremio to hang indefinitely.
 *
 * Only fetches URLs on the GDFLIX_ALLOWED_HOSTS allowlist (SSRF guard).
 */
async function preResolveToBusycdnUrl(url: string): Promise<string | null> {
  // Hard allowlist check before any network activity
  if (!isGdflixFamily(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Referer: "https://m4ulinks.site/" },
      signal: AbortSignal.timeout(8_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Priority 1: Pixeldrain — direct streaming API, no extra hops.
    const pdMatch = html.match(/(?:href|src)="https?:\/\/pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)(?:\?[^"]*)?"/);
    if (pdMatch?.[1]) {
      return `https://pixeldrain.com/api/file/${pdMatch[1]}`;
    }

    // Priority 2: foxcloud.rest → Google Video URL via 2-hop follow.
    const foxMatch = html.match(/href="(https?:\/\/cdn\.foxcloud\.rest\/\?url=[^"]*)"/);
    if (foxMatch?.[1]) {
      const foxFinal = await followFoxcloudChain(foxMatch[1].replace(/&amp;/g, "&"), url);
      if (foxFinal) return foxFinal;
    }

    // Priority 3: busycdn — follow redirect to fastcdn-dl.pages.dev?url=FINAL.
    const busyMatch = html.match(/href="(https:\/\/instant\.busycdn\.xyz\/[^"]{20,})"/);
    const busyUrl = busyMatch?.[1];
    if (!busyUrl) return null;

    const busyRes = await fetch(busyUrl, {
      headers: { ...BROWSER_HEADERS, Referer: url },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    const finalUrl = new URL(busyRes.url);
    busyRes.body?.cancel();
    const target = finalUrl.searchParams.get("url");
    // If follow didn't land on a fastcdn-dl URL with ?url=, busycdn is broken.
    // Return null — do NOT return the raw busycdn URL; it hangs players.
    if (!target) return null;

    // Verify the extracted CDN link is actually alive before trusting it.
    const headRes = await fetch(target, {
      method: "HEAD",
      headers: { ...BROWSER_HEADERS, Referer: busyUrl },
      signal: AbortSignal.timeout(8_000),
      redirect: "follow",
    }).catch(() => null);
    return headRes?.ok ? (headRes.url || target) : null;
  } catch {
    return null; // network error / timeout — caller falls back to lazy proxy
  }
}

// ─── m4ulinks.site resolver ───────────────────────────────────────────────────

interface QualityLink {
  quality: string;
  label: string;
  size: string;
  url: string;
  needsProxy: boolean;   // true for hubcloud/gdflix (lazy proxy); false for pre-resolved CDN
}

async function resolveM4uLinksPage(
  m4uUrl: string,
  referer: string,
): Promise<QualityLink[]> {
  const results: QualityLink[] = [];
  try {
    const res = await fetch(m4uUrl, {
      headers: { ...BROWSER_HEADERS, Referer: referer },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return results;
    const html = await res.text();
    const $ = load(html);

    const seen = new Set<string>();

    /**
     * Structure inside .download-links-div:
     *   h4: "480p [450MB]"
     *   .downloads-btns-div
     *     a.btn[href*=hubcloud.cx]   ← new format
     *     a.btn[href*=filebee.xyz]   ← new format
     *     a.btn[href*=vcloud.zip]    ← old format
     *   h4: "720p [1GB]"
     *   ...
     */
    /** Returns true for CDN intermediate pages the proxy can lazily resolve. */
    const isSupportedCdn = (href: string) =>
      href.includes("vcloud.zip")       ||
      href.includes("hubcloud.cx")      ||
      href.includes("hubcloud.bond")    ||
      href.includes("gdflix.dev")       ||
      href.includes("gdflix.lol")       ||
      href.includes("new1.gdflix.io")   ||
      href.includes("new2.gdflix.app")  ||
      href.includes("gdlink.dev");

    const container = $(".download-links-div");
    if (container.length > 0) {
      let currentEntry: QualityEntry | null = null;

      container.children().each((_i, el) => {
        const tagName = el.type === "tag" ? el.name : "";
        if (tagName === "h4") {
          currentEntry = parseH4Quality($(el).text().trim());
          return;
        }
        if (!currentEntry) return;

        $(el)
          .find("a.btn[href], a[href*='vcloud.zip'], a[href*='hubcloud.cx'], a[href*='hubcloud.bond'], a[href*='gdflix.dev'], a[href*='gdflix.lol'], a[href*='new1.gdflix.io'], a[href*='new2.gdflix.app'], a[href*='gdlink.dev']")
          .each((_j, a) => {
            const href = $(a).attr("href") ?? "";
            if (!href || seen.has(href)) return;
            if (!isSupportedCdn(href)) return;
            seen.add(href);
            // All intermediate URLs are proxied — the proxy resolves them lazily at play time
            results.push({
              ...currentEntry!,
              url: href,
              needsProxy: true,
            });
          });
      });
    }

    // Fallback: walk h4 → next sibling with links
    if (results.length === 0) {
      $("h4").each((_i, h4el) => {
        const h4Text = $(h4el).text().trim();
        if (!h4Text.match(/\d+p|\d+K/i)) return;
        const entry = parseH4Quality(h4Text);
        $(h4el).next().find("a[href]").each((_j, a) => {
          const href = $(a).attr("href") ?? "";
          if (!href || seen.has(href)) return;
          if (!isSupportedCdn(href)) return;
          seen.add(href);
          results.push({ ...entry, url: href, needsProxy: true });
        });
      });
    }

    // Last resort: any supported link anywhere on the page
    if (results.length === 0) {
      $("a[href*='vcloud.zip'], a[href*='hubcloud.cx'], a[href*='hubcloud.bond'], a[href*='gdflix.dev'], a[href*='gdflix.lol'], a[href*='new1.gdflix.io'], a[href*='new2.gdflix.app'], a[href*='gdlink.dev']").each((_i, a) => {
        const href = $(a).attr("href") ?? "";
        if (!href || seen.has(href)) return;
        seen.add(href);
        const nearbyH4 = $(a).closest("div").prevAll("h4").first().text().trim();
        const entry = parseH4Quality(nearbyH4 || "1080p");
        results.push({ ...entry, url: href, needsProxy: true });
      });
    }
  } catch {
    // ignore
  }
  return results;
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

export async function getMovies4uStreams(
  imdbId: string,
  type: "movie" | "series",
  season?: number,
  episode?: number,
): Promise<Movies4uStream[]> {
  try {
    // 1. Resolve TMDB metadata via IMDB /find
    const findRes = await fetch(
      `${TMDB_BASE}/find/${imdbId}?external_source=imdb_id&api_key=${TMDB_API_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    ).catch(() => null);
    if (!findRes?.ok) return [];

    const findData = (await findRes.json()) as {
      movie_results: Array<{
        id: number;
        title?: string;
        name?: string;
        release_date?: string;
        first_air_date?: string;
      }>;
      tv_results: Array<{
        id: number;
        name?: string;
        title?: string;
        first_air_date?: string;
      }>;
    };

    const tmdbResults =
      type === "movie" ? findData.movie_results : findData.tv_results;
    if (!tmdbResults?.length) return [];
    const tmdb = tmdbResults[0];
    if (!tmdb) return [];

    const title = tmdb.title ?? tmdb.name ?? "";
    if (!title) return [];

    const dateStr =
      (tmdb as { release_date?: string }).release_date ??
      (tmdb as { first_air_date?: string }).first_air_date ?? "";
    const year = dateStr.split("-")[0] ?? "";

    // Get runtime (best effort)
    let runtimeMin = 120;
    try {
      const endpoint = type === "series" ? "tv" : "movie";
      const detRes = await fetch(
        `${TMDB_BASE}/${endpoint}/${tmdb.id}?api_key=${TMDB_API_KEY}`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (detRes.ok) {
        const det = (await detRes.json()) as { runtime?: number; episode_run_time?: number[] };
        if (type === "movie" && det.runtime) runtimeMin = det.runtime;
        if (type === "series" && det.episode_run_time?.[0]) runtimeMin = det.episode_run_time[0];
      }
    } catch { /* ignore */ }
    const runtimeStr = `${runtimeMin} min`;

    // 2. Get movies4u domain
    const baseUrl = await getBaseUrl();

    // 3. Search for the title
    const searchRes = await fetch(
      `${baseUrl}/?s=${encodeURIComponent(title)}`,
      {
        headers: { ...BROWSER_HEADERS, Referer: baseUrl },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!searchRes.ok) return [];

    const searchHtml = await searchRes.text();
    const $s = load(searchHtml);

    const articles: Array<{ href: string; name: string }> = [];
    $s("article").each((_i, el) => {
      // Try h2/h3 entry-title link (has rel="bookmark" and full title as text)
      let link = $s(el).find(".entry-title a, h2 a[rel='bookmark'], h3 a[rel='bookmark'], h2 a, h3 a").first();
      let href = link.attr("href") ?? "";
      let name = link.text().trim();

      // Fallback: post-thumbnail anchor (href = movie page, aria-label or img alt = title)
      if (!name) {
        const thumb = $s(el).find("a.post-thumbnail").first();
        href = thumb.attr("href") ?? "";
        name = thumb.attr("aria-label")
          ?? $s(el).find("img").first().attr("alt")
          ?? "";
        // Strip quality/format junk from alt text
        name = name.replace(/\s*(?:WEB-DL|BluRay|HDRip|WEBRip|HDTV|iMAX|Dual Audio|Multi Audio|\d{3,4}p|\d+K|\[.*?\])\s*/gi, " ").trim();
      }

      if (!href || !name) return;
      if (!href.startsWith("http")) href = `${baseUrl}/${href.replace(/^\/+/, "")}`;
      articles.push({ href, name });
    });

    if (!articles.length) return [];

    // Pick best matching article
    const titleLc = title.toLowerCase();
    const best =
      articles.find((a) => {
        const n = a.name.toLowerCase();
        return n.includes(titleLc) && (!year || n.includes(year));
      }) ??
      articles.find((a) => a.name.toLowerCase().includes(titleLc)) ??
      articles[0];

    if (!best) return [];

    // 4. Fetch the movie/show page
    const pageRes = await fetch(best.href, {
      headers: { ...BROWSER_HEADERS, Referer: baseUrl },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageRes.ok) return [];

    const pageHtml = await pageRes.text();
    const $p = load(pageHtml);

    // 5. Find m4ulinks.site download page links
    const m4uLinkUrls: string[] = [];
    const seenM4u = new Set<string>();

    $p("a[href*='m4ulinks.site']").each((_i, el) => {
      const href = $p(el).attr("href") ?? "";
      if (!seenM4u.has(href)) { seenM4u.add(href); m4uLinkUrls.push(href); }
    });

    // TV series: look for season-specific links
    if (type === "series" && m4uLinkUrls.length === 0) {
      const s = season ?? 1;
      $p("h4, h3, h2").each((_i, el) => {
        const text = $p(el).text().toLowerCase();
        if (!text.includes(`season ${s}`)) return;
        $p(el).nextAll().slice(0, 20).each((_j, sibling) => {
          $p(sibling).find("a[href*='m4ulinks.site']").each((_k, a) => {
            const href = $p(a).attr("href") ?? "";
            if (href && !seenM4u.has(href)) { seenM4u.add(href); m4uLinkUrls.push(href); }
          });
        });
      });
    }

    if (!m4uLinkUrls.length) return [];

    // 6. Resolve each m4ulinks.site page to quality links
    const targetM4uUrls = type === "series" ? m4uLinkUrls.slice(0, 1) : m4uLinkUrls;
    const allQualityLinks: QualityLink[] = [];

    await Promise.all(
      targetM4uUrls.map(async (m4uUrl) => {
        let qualityLinks = await resolveM4uLinksPage(m4uUrl, best.href);

        // TV series: the m4ulinks.site page may contain episode sub-pages
        if (type === "series" && qualityLinks.length === 0) {
          const s = season ?? 1;
          const e = episode ?? 1;
          try {
            const pgRes = await fetch(m4uUrl, {
              headers: { ...BROWSER_HEADERS, Referer: best.href },
              signal: AbortSignal.timeout(12000),
            });
            if (pgRes.ok) {
              const pgHtml = await pgRes.text();
              const $ep = load(pgHtml);
              const epLinks: string[] = [];
              const seenEp = new Set<string>();

              $ep("h5, h4, h3, h2").each((_i, el) => {
                const text = $ep(el).text().toLowerCase();
                const matchesEp =
                  text.includes(`episode ${e}`) ||
                  text.includes(`ep ${e}`) ||
                  text.includes(`e${String(e).padStart(2, "0")}`);
                if (!matchesEp) return;
                $ep(el).nextAll().slice(0, 10).each((_j, sib) => {
                  $ep(sib).find("a[href*='m4ulinks.site']").each((_k, a) => {
                    const href = $ep(a).attr("href") ?? "";
                    if (href && !seenEp.has(href)) { seenEp.add(href); epLinks.push(href); }
                  });
                });
              });

              for (const epUrl of epLinks) {
                qualityLinks.push(...(await resolveM4uLinksPage(epUrl, m4uUrl)));
              }
            }
          } catch { /* ignore */ }
        }

        allQualityLinks.push(...qualityLinks);
      }),
    );

    if (!allQualityLinks.length) return [];

    // 7. Group by quality tier; sort highest quality first.
    //    Within a quality, prefer: vcloud > gdlink > hubcloud > gdflix (all work — pick first valid).
    const qualityScore: Record<string, number> = {
      "4K": 100, "1080p": 50, "720p": 25, "480p": 10, Unknown: 0,
    };
    const byQuality = new Map<string, QualityLink[]>();
    for (const ql of allQualityLinks) {
      const bucket = byQuality.get(ql.quality) ?? [];
      bucket.push(ql);
      byQuality.set(ql.quality, bucket);
    }

    const hostPriority = (url: string) =>
      url.includes("vcloud.zip")   ? 0 :
      url.includes("gdlink.dev")   ? 1 :
      url.includes("hubcloud")     ? 2 :
      url.includes("gdflix")       ? 3 : 4;

    const candidates = [...byQuality.entries()]
      .sort(([a], [b]) => (qualityScore[b] ?? 0) - (qualityScore[a] ?? 0))
      .slice(0, 6)
      .map(([, links]) => links.sort((a, b) => hostPriority(a.url) - hostPriority(b.url)));

    // 8. Resolve candidates per quality tier and decide how to serve each.
    //
    //  • vcloud.zip   — pre-resolved to *.workers.dev CDN (currently skipped — CF Error 1101).
    //
    //  • gdlink.dev / gdflix.* — all are gdflix-family intermediate pages.
    //                  Tokens on the final CDN chain expire quickly.
    //                  We return the raw intermediate URL and let the proxy
    //                  lazily resolve it at PLAY TIME so tokens are always fresh.
    //
    //  • hubcloud — fully resolved to the final CDN URL (FSLv2/FSL/R2/GPDL/Workers)
    //               at SCRAPE TIME via resolveHubcloudUrl(). The intermediate
    //               hubcloud.cx page URL is never handed to the player directly —
    //               that's an HTML landing page, not a playable file, which is why
    //               streams used to exit immediately on play. The resolved CDN
    //               link (e.g. signed R2 URL) carries a multi-hour expiry, so
    //               resolving now (rather than lazily at play time) is safe.
    //
    // We keep up to MAX_HOSTS_PER_QUALITY distinct hosts per tier so Stremio
    // shows fallback mirrors as separate stream entries.
    const MAX_HOSTS_PER_QUALITY = 3;

    const hostLabel = (url: string): string =>
      url.includes("vcloud.zip")     ? "VCloud"   :
      url.includes("gdlink.dev")     ? "GDLink"   :
      url.includes("hubcloud")       ? "HubCloud" :
      url.includes("gdflix")         ? "GDFlix"   :
      url.includes("gdflix.io")      ? "GDFlix"   :
      url.includes("gdflix.app")     ? "GDFlix"   :
      url.includes("busycdn")        ? "GDFlix"   : "Mirror";

    interface ResolvedLink {
      quality: string; label: string; size: string; host: string;
      url: string; needsProxy: boolean;
    }

    const preResolved = await Promise.all(
      candidates.map(async (links) => {
        // ── Step A: pick eligible links (de-dup by host, skip broken CDNs) ──
        const eligible: typeof links = [];
        const seenHosts = new Set<string>();
        for (const ql of links) {
          if (eligible.length >= MAX_HOSTS_PER_QUALITY) break;
          // filebee.xyz — React SPA, no SSR, JS-only; skip.
          // vcloud.zip  — resolves to *.workers.dev which throws Cloudflare Error 1101
          //               ("Worker threw exception") on all requests; skip until fixed.
          if (ql.url.includes("filebee.xyz") || ql.url.includes("vcloud.zip")) continue;
          const host = hostLabel(ql.url);
          if (seenHosts.has(host)) continue;
          seenHosts.add(host);
          eligible.push(ql);
        }

        // ── Step B: pre-resolve intermediate-page URLs in parallel ───────
        // For each gdlink/gdflix URL we fire a fetch RIGHT NOW (scrape time)
        // to obtain the stable busycdn CDN URL.  The proxy then only needs one
        // hop at play time instead of the full 3-hop intermediate chain.
        // hubcloud.cx URLs are fully resolved to their final CDN file now —
        // see resolveHubcloudUrl() for why lazy/never-resolved was the bug.
        return Promise.all(
          eligible.map(async (ql) => {
            const host = hostLabel(ql.url);
            let streamUrl = ql.url;
            let needsProxy = true;

            if (isGdflixFamily(ql.url)) {
              const resolved = await preResolveToBusycdnUrl(ql.url);
              if (resolved) {
                streamUrl = resolved;
                // Fully resolved to the final CDN file (not just the busycdn
                // interstitial link) — no proxy hop needed. Only the busycdn
                // link itself (interstitial-layout-changed fallback) still
                // needs the proxy's lazy resolution.
                needsProxy = resolved.includes("instant.busycdn.xyz");
              }
              // On failure streamUrl stays as the raw gdlink/gdflix URL and
              // the proxy falls back to lazy resolution automatically.
            } else if (ql.url.includes("hubcloud.cx") || ql.url.includes("hubcloud.bond")) {
              const resolved = await resolveHubcloudUrl(ql.url);
              if (resolved) {
                // Final CDN file — hand it straight to the player, no proxy needed.
                streamUrl = resolved;
                needsProxy = false;
              }
              // On failure streamUrl stays as the raw hubcloud.cx landing page —
              // Stremio can't play it, but we don't silently drop the entry;
              // it'll surface as a dead stream rather than vanishing entirely.
            }

            return {
              quality: ql.quality, label: ql.label, size: ql.size,
              host,          // display label (GDLink/GDFlix/HubCloud) uses original URL
              url: streamUrl, // streaming URL (resolved CDN file when possible)
              needsProxy,
            } satisfies ResolvedLink;
          }),
        );
      }),
    );

    // 9. Build stream entries
    const epLabel =
      type === "series"
        ? ` - S${String(season ?? 1).padStart(2, "0")}E${String(episode ?? 1).padStart(2, "0")}`
        : "";

    return preResolved
      .flat()
      .map((item): Movies4uStream => {
        const s: Movies4uStream = {
          name:  `⚡ StreamFlow | Movies4u | ${item.host} | ${item.quality}`,
          title: `🎬 ${title}${epLabel}${year ? ` (${year})` : ""}\n⚡ ${item.quality} | 💾 ${item.size} | ⏱️ ${runtimeStr} | 🌐 ${item.host}\n🎞️ ${item.label}`,
          url:   item.url,
        };
        if (item.needsProxy) {
          // proxyHeaders causes applyProxy in addon.ts to wrap this URL through our
          // server so the proxy can do lazy resolution of the intermediate page.
          s.behaviorHints = {
            proxyHeaders: {
              request: {
                Referer: "https://m4ulinks.site/",
                "User-Agent": BROWSER_HEADERS["User-Agent"]!,
              },
            },
          };
        }
        return s;
      });
  } catch (err) {
    logger.error({ err, imdbId }, "Movies4u: provider error");
    return [];
  }
}
