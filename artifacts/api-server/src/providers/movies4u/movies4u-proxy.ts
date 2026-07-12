import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";
import { logDebug } from "../../lib/debug-log.js";

const router = Router();

const UPSTREAM_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeParam(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** True for plain pub-*.r2.dev URLs that have no presigning params. */
function isPlainR2(url: string): boolean {
  return /pub-[0-9a-f]{10,}\.r2\.dev\//i.test(url) &&
         !/[?&](X-Amz-Signature|token|Expires)=/i.test(url);
}

/**
 * Follow HTTP redirects manually so we can preserve custom headers (especially
 * Referer) across hops.  The native `redirect: "follow"` strips Referer on
 * cross-origin redirects per the browser spec, which breaks FSL/S3 CDN links
 * that validate the Referer header at every step of their redirect chain.
 */
async function fetchWithRedirects(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 8,
): Promise<globalThis.Response> {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    const status = res.status;
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      currentUrl = loc.startsWith("http") ? loc : new URL(loc, currentUrl).href;
      continue;
    }
    return res;
  }
  throw new Error("fetchWithRedirects: too many redirects");
}

/**
 * Re-fetch the HubCloud download page and extract a fresh signed CDN URL.
 * Used as a reactive fallback when the CDN returns 403/404 for the stored URL.
 * Matches both FSL/R2-style (?token=<epoch>) and S3/B2-style (?Expires=<epoch>).
 */
/**
 * Re-extracts a fresh signed CDN URL starting from the stable HubCloud
 * *landing* page (e.g. gamerxyt.com/drive/<id>).  Landing pages carry no
 * expiry token, so this succeeds even when both the cached R2 token and the
 * cached download-page session token have expired.
 *
 * Steps:
 *   1. Fetch landing page → find "#download" href → fresh download-page URL
 *      (contains a brand-new server-side session token).
 *   2. Fetch download page → find first signed CDN URL (FSL / R2 / S3 / B2).
 *
 * If `landingPageUrl` is itself a hubcloud.php URL (i.e. already a download
 * page), step 1 is skipped and we go directly to step 2.
 */
async function reExtractFromHubCloud(landingPageUrl: string): Promise<string | null> {
  try {
    let downloadPageUrl: string;

    if (landingPageUrl.includes("hubcloud.php")) {
      downloadPageUrl = landingPageUrl;
    } else {
      // Step 1 — get a fresh download-page URL from the stable landing page
      const landingRes = await fetch(landingPageUrl, {
        headers: { "User-Agent": UPSTREAM_UA },
        signal: AbortSignal.timeout(12_000),
        redirect: "follow",
      });
      if (!landingRes.ok) {
        logger.warn({ status: landingRes.status, url: landingPageUrl.slice(0, 80) }, "Proxy: landing page fetch failed");
        return null;
      }
      const landingHtml = await landingRes.text();
      // id="download" href="..." or href="..." id="download"
      const m =
        /id="download"[^>]*\shref="([^"]+)"/i.exec(landingHtml) ||
        /href="([^"]+)"[^>]*\sid="download"/i.exec(landingHtml);
      if (!m?.[1]) {
        logger.warn({ url: landingPageUrl.slice(0, 80) }, "Proxy: #download link not found on HubCloud landing page");
        return null;
      }
      const rawHref = m[1].replace(/&amp;/gi, "&");
      if (rawHref.startsWith("http")) {
        downloadPageUrl = rawHref;
      } else {
        const base = new URL(landingPageUrl);
        downloadPageUrl = `${base.origin}/${rawHref.replace(/^\//, "")}`;
      }
    }

    // Step 2 — fetch the download page and extract a CDN URL.
    // Priority order (to avoid Cloudflare R2 private-bucket 403s):
    //   1. BuzzServer button → call /download → buzz CDN URL (never R2, long-lived)
    //   2. hub.*.buzz signed URLs in the page (long token grace period)
    //   3. Non-R2 signed URLs (FSL / S3 / B2)
    //   4. R2 signed URLs last resort (pub-*.r2.dev — some buckets are private)
    const dlRes = await fetch(downloadPageUrl, {
      headers: { "User-Agent": UPSTREAM_UA, "Referer": landingPageUrl },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!dlRes.ok) {
      logger.warn({ status: dlRes.status, url: downloadPageUrl.slice(0, 80) }, "Proxy: HubCloud download page fetch failed");
      return null;
    }
    const dlHtml = await dlRes.text();

    // Priority 1 — BuzzServer: find any <a> whose visible text contains "buzz"
    // and call its /download endpoint.
    // Old behaviour: BuzzServer responds with hx-redirect / location → CDN URL.
    // New behaviour (2025-06+): BuzzServer returns 200 HTML "Link Generated!"
    //   page — the CDN URL is in id="download" href inside that HTML body.
    const allAnchors = [...dlHtml.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const [, rawHref, innerHtml] of allAnchors) {
      if (!rawHref) continue;
      const visibleText = innerHtml.replace(/<[^>]+>/g, "").toLowerCase().trim();
      if (!visibleText.includes("buzz")) continue;
      const buzzLink = rawHref.replace(/&amp;/gi, "&").replace(/\/$/, "");
      if (!buzzLink.startsWith("http")) continue;
      try {
        const buzzRes = await fetch(`${buzzLink}/download`, {
          headers: { "User-Agent": UPSTREAM_UA, "Referer": downloadPageUrl },
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });

        // Old path: redirect header
        const loc = buzzRes.headers.get("hx-redirect") || buzzRes.headers.get("location") || "";
        if (loc && loc.startsWith("http")) {
          logger.info({ loc: loc.slice(0, 100) }, "Proxy: BuzzServer re-extraction → redirect CDN URL");
          return loc;
        }

        // New path: 200 HTML body — extract id="download" href
        if (buzzRes.status === 200) {
          const html = await buzzRes.text();
          const m =
            /id="download"[^>]*\shref="([^"]+)"/i.exec(html) ||
            /href="([^"]+)"[^>]*\sid="download"/i.exec(html);
          if (m?.[1]) {
            const cdnUrl = m[1].replace(/&amp;/gi, "&");
            if (cdnUrl.startsWith("http")) {
              logger.info({ cdnUrl: cdnUrl.slice(0, 100) }, "Proxy: BuzzServer re-extraction → CDN URL from HTML page");
              return cdnUrl;
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e }, "Proxy: BuzzServer re-extraction failed");
      }
    }

    // Priority 2: 10Gbps / hubcloud.cx button → follow redirect to get link= param
    for (const [, rawHref, innerHtml] of allAnchors) {
      if (!rawHref) continue;
      const text = innerHtml.replace(/<[^>]+>/g, "").toLowerCase().trim();
      const link = rawHref.replace(/&amp;/gi, "&").replace(/\/$/, "");
      if (!link.startsWith("http")) continue;
      if (!text.includes("10gbps") && !link.includes("hubcloud.cx")) continue;
      try {
        if (!link.includes("hubcloud.cx")) {
          const r = await fetch(link, {
            headers: { "User-Agent": UPSTREAM_UA },
            redirect: "manual",
            signal: AbortSignal.timeout(8_000),
          });
          const loc = r.headers.get("location") ?? "";
          if (loc.includes("link=")) {
            const extracted = loc.substring(loc.indexOf("link=") + 5);
            logger.info({ extracted: extracted.slice(0, 80) }, "Proxy: 10Gbps re-extraction → CDN URL");
            return extracted;
          }
          if (loc && loc.startsWith("http") && !/pub-[0-9a-f]+\.r2\.dev\//i.test(loc)) {
            logger.info({ loc: loc.slice(0, 80) }, "Proxy: 10Gbps re-extraction → redirect URL");
            return loc;
          }
        } else {
          // gpdl.hubcloud.cx → workers.dev → gamerxyt.com/dl.php?link=VIDEO_URL (200 HTML)
          // Follow ALL redirects; the actual video URL is in the `link=` query param
          // of the final dl.php URL.
          try {
            const cx = await fetch(link, {
              headers: { "User-Agent": UPSTREAM_UA },
              redirect: "follow",
              signal: AbortSignal.timeout(15_000),
            });
            const finalUrl = cx.url;
            try {
              const u = new URL(finalUrl);
              const videoLink = u.searchParams.get("link");
              if (videoLink && videoLink.startsWith("http")) {
                logger.info({ videoLink: videoLink.slice(0, 80) }, "Proxy: hubcloud.cx re-extraction → video URL from dl.php chain");
                return videoLink;
              }
            } catch { /* invalid URL */ }
            if (finalUrl && finalUrl.startsWith("http") && !/\.php(\?|$)/.test(finalUrl)) {
              logger.info({ finalUrl: finalUrl.slice(0, 80) }, "Proxy: hubcloud.cx re-extraction → final redirect URL");
              return finalUrl;
            }
          } catch (cxErr) {
            logger.warn({ err: cxErr }, "Proxy: hubcloud.cx chain follow failed");
          }
          logger.warn({ link: link.slice(0, 80) }, "Proxy: hubcloud.cx chain unresolved — skipping");
        }
      } catch { /* ignore, try next */ }
    }

    // Priority 3: ZipDisk / Cloudflare workers.dev button (non-R2)
    for (const [, rawHref, innerHtml] of allAnchors) {
      if (!rawHref) continue;
      const text = innerHtml.replace(/<[^>]+>/g, "").toLowerCase().trim();
      const link = rawHref.replace(/&amp;/gi, "&");
      if (!link.startsWith("http")) continue;
      if ((text.includes("zipdisk") || link.includes("workers.dev")) && !/pub-[0-9a-f]+\.r2\.dev\//i.test(link)) {
        logger.info({ link: link.slice(0, 80) }, "Proxy: ZipDisk/worker re-extraction");
        return link;
      }
    }

    // Priority 4: signed URLs in page HTML — prefer buzz > non-R2 > R2
    const signedUrls = [...dlHtml.matchAll(/href="(https?:\/\/[^"]{10,}[?&](?:amp;)?(?:token|Expires)=\d{9,12}[^"]*)"/gi)]
      .map(m => m[1]!.replace(/&amp;/gi, "&"));
    if (signedUrls.length > 0) {
      const buzzUrl  = signedUrls.find(u => /hub\.[^.]+\.buzz\//i.test(u));
      const nonR2Url = signedUrls.find(u => !/pub-[0-9a-f]+\.r2\.dev\//i.test(u));
      const chosen = buzzUrl ?? nonR2Url ?? signedUrls[0]!;
      logger.info(
        { chosen: chosen.slice(0, 80), total: signedUrls.length, isR2: /pub-[0-9a-f]+\.r2\.dev\//i.test(chosen) },
        "Proxy: picked CDN URL from signed URLs",
      );
      return chosen;
    }

    // Priority 5: any non-R2 direct video link (.mp4 / large file hint)
    const anyLinks = [...dlHtml.matchAll(/href="(https?:\/\/[^"]+\.(?:mp4|mkv|avi|mov)[^"]*)"/gi)]
      .map(m => m[1]!.replace(/&amp;/gi, "&"))
      .filter(u => !/pub-[0-9a-f]+\.r2\.dev\//i.test(u));
    if (anyLinks.length > 0) {
      logger.info({ link: anyLinks[0]!.slice(0, 80) }, "Proxy: direct video link fallback");
      return anyLinks[0]!;
    }

    logger.warn({ url: downloadPageUrl.slice(0, 80) }, "Proxy: no CDN URL found on HubCloud download page");
    return null;
  } catch (err) {
    logger.warn({ err }, "Proxy: reExtractFromHubCloud error");
    return null;
  }
}

async function refreshFromDownloadPage(downloadPageUrl: string): Promise<string | null> {
  try {
    const pageRes = await fetch(downloadPageUrl, {
      headers: { "User-Agent": UPSTREAM_UA },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];

    // Priority 1: BuzzServer button → /download → CDN URL
    // Old BuzzServer: hx-redirect / location header.
    // New BuzzServer (2025-06+): 200 HTML body with id="download" href.
    for (const [, rawHref, inner] of anchors) {
      if (!rawHref) continue;
      const text = inner.replace(/<[^>]+>/g, "").toLowerCase().trim();
      if (!text.includes("buzz")) continue;
      const link = rawHref.replace(/&amp;/gi, "&").replace(/\/$/, "");
      if (!link.startsWith("http")) continue;
      try {
        const bRes = await fetch(`${link}/download`, {
          headers: { "User-Agent": UPSTREAM_UA, "Referer": downloadPageUrl },
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
        const loc = bRes.headers.get("hx-redirect") || bRes.headers.get("location") || "";
        if (loc && loc.startsWith("http")) return loc;
        if (bRes.status === 200) {
          const bHtml = await bRes.text();
          const m = /id="download"[^>]*\shref="([^"]+)"/i.exec(bHtml) ||
                    /href="([^"]+)"[^>]*\sid="download"/i.exec(bHtml);
          if (m?.[1]) {
            const cdnUrl = m[1].replace(/&amp;/gi, "&");
            if (cdnUrl.startsWith("http")) return cdnUrl;
          }
        }
      } catch { /* ignore, fall through */ }
    }

    // Priority 2: 10Gbps / hubcloud.cx button — follow chain to video URL
    for (const [, rawHref, inner] of anchors) {
      if (!rawHref) continue;
      const text = inner.replace(/<[^>]+>/g, "").toLowerCase().trim();
      const link = rawHref.replace(/&amp;/gi, "&");
      if (!link.startsWith("http")) continue;
      if (!text.includes("10gbps") && !link.includes("hubcloud.cx")) continue;
      try {
        if (link.includes("hubcloud.cx")) {
          const cx = await fetch(link, {
            headers: { "User-Agent": UPSTREAM_UA },
            redirect: "follow",
            signal: AbortSignal.timeout(15_000),
          });
          const finalUrl = cx.url;
          try {
            const u = new URL(finalUrl);
            const videoLink = u.searchParams.get("link");
            if (videoLink && videoLink.startsWith("http")) return videoLink;
          } catch { /* invalid URL */ }
          if (finalUrl && finalUrl.startsWith("http") && !/\.php(\?|$)/.test(finalUrl)) return finalUrl;
        } else {
          const r = await fetch(link, {
            headers: { "User-Agent": UPSTREAM_UA },
            redirect: "manual",
            signal: AbortSignal.timeout(8_000),
          });
          const loc = r.headers.get("location") ?? "";
          if (loc.includes("link=")) return loc.substring(loc.indexOf("link=") + 5);
          if (loc && loc.startsWith("http")) return loc;
        }
      } catch { /* ignore, try next */ }
    }

    // Priority 3-5: signed URLs — prefer buzz > non-R2 > R2
    const signedUrls = [...html.matchAll(/href="(https?:\/\/[^"]{10,}[?&](?:amp;)?(?:token|Expires)=\d{9,12}[^"]*)"/gi)]
      .map(m => m[1]!.replace(/&amp;/gi, "&"));
    if (signedUrls.length > 0) {
      const buzzUrl  = signedUrls.find(u => /hub\.[^.]+\.buzz\//i.test(u));
      const nonR2Url = signedUrls.find(u => !/pub-[0-9a-f]+\.r2\.dev\//i.test(u));
      return buzzUrl ?? nonR2Url ?? signedUrls[0]!;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalise a CDN-supplied Content-Type to a value ExoPlayer accepts.
 *
 * CDNs are inconsistent:
 *   - HubCloud FSL/buzz: "video/mkv" for Matroska, "application/octet-stream" for MP4
 *   - Some CDNs: no Content-Type at all
 *
 * ExoPlayer only recognises IANA-registered types and will silently fail
 * (Position 0ms, Codec N/A) if it receives an unknown type like "video/mkv".
 *
 * When the type is ambiguous we sniff the first bytes of the response body.
 */
// ─── GDFlix / GDLink / BusyCDN chain resolver ────────────────────────────────
//
// GDFlix pages (gdflix.dev/file/..., gdlink.dev/...) are intermediate HTML
// pages that embed a link to instant.busycdn.xyz, which 302s to a
// fastcdn-dl.pages.dev interstitial whose `?url=` query param is the actual
// video file.
//
// The movies4u provider pre-resolves this chain at scrape time. When that
// fails (Cloudflare challenge, different CDN backend, timeout) the raw
// gdflix.dev URL lands in our proxy — we do the full resolution here instead
// of serving HTML to the player.

const GDFLIX_PROXY_ALLOWED_HOSTS = new Set([
  "gdlink.dev",
  "gdflix.dev",
  "gdflix.lol",
  "new1.gdflix.io",
  "new2.gdflix.app",
]);

function isGdflixFamilyUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && GDFLIX_PROXY_ALLOWED_HOSTS.has(hostname);
  } catch { return false; }
}

function isBusyCdnUrl(url: string): boolean {
  try { return new URL(url).hostname.endsWith("busycdn.xyz"); }
  catch { return false; }
}

/** Follow a busycdn URL → fastcdn-dl.pages.dev?url=FINAL → return FINAL. */
async function followBusyCdnToFinalUrl(busyUrl: string, referer: string): Promise<string | null> {
  try {
    const res = await fetch(busyUrl, {
      headers: { "User-Agent": UPSTREAM_UA, Referer: referer },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    const finalUrl = new URL(res.url);
    res.body?.cancel();
    const target = finalUrl.searchParams.get("url");
    return (target?.startsWith("http")) ? target : null;
  } catch { return null; }
}

/**
 * Follow the cdn.foxcloud.rest two-hop chain to a Google Video URL.
 *
 * Hop 1: cdn.foxcloud.rest/?url=... → 200 HTML with JS redirect to /upload?url=...
 * Hop 2: cdn.foxcloud.rest/upload?url=... → page with Google Video download button
 *
 * The GDFlix page embeds the cdn.foxcloud.rest link as a static href, so no
 * JavaScript execution is needed to start the chain — only to do Hop 1→2 follow.
 */
async function followFoxcloudChain(foxUrl: string, referer: string): Promise<string | null> {
  try {
    // Hop 1: cdn.foxcloud.rest/?url=...
    const res1 = await fetch(foxUrl, {
      headers: { "User-Agent": UPSTREAM_UA, Referer: referer },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res1.ok) return null;
    const html1 = await res1.text();

    // Extract the /upload?url=... path from the JS redirect
    const uploadMatch = html1.match(/window\.location\.href\s*=\s*["']([^"']*\/upload\?url=[^"']*)["']/);
    if (!uploadMatch?.[1]) return null;
    const uploadPath = uploadMatch[1];
    const uploadUrl = uploadPath.startsWith("http")
      ? uploadPath
      : `https://cdn.foxcloud.rest${uploadPath.startsWith("/") ? "" : "/"}${uploadPath}`;

    // Hop 2: cdn.foxcloud.rest/upload?url=...
    const res2 = await fetch(uploadUrl, {
      headers: { "User-Agent": UPSTREAM_UA, Referer: foxUrl },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res2.ok) return null;
    const html2 = await res2.text();

    // Google Video URL in the download button href
    const gvMatch = html2.match(/href="(https?:\/\/video-downloads\.googleusercontent\.com\/[^"]+)"/i);
    if (gvMatch?.[1]) return gvMatch[1];

    // Any direct video URL on the final page
    const directMatch = html2.match(/href="(https?:\/\/[^"]+\.(?:mp4|mkv|avi|mov)[^"]*)"/i);
    if (directMatch?.[1]) return directMatch[1].replace(/&amp;/g, "&");

    return null;
  } catch { return null; }
}

/**
 * Fetch a GDFlix/GDLink intermediate page and resolve it to a playable CDN URL.
 *
 * Priority order (highest → lowest reliability from server-side):
 *   1. pixeldrain.com/u/{ID} or pixeldrain.dev/u/{ID}  → direct API streaming URL
 *      (no extra hops, streams directly, confirmed 200 video/x-matroska)
 *   2. cdn.foxcloud.rest/?url=... chain  → Google Video URL via 2-hop follow
 *   3. instant.busycdn.xyz link (rare as static href, usually needs JS+Turnstile)
 *      → follow to fastcdn-dl.pages.dev?url=FINAL
 *   4. Any direct .mp4/.mkv href on the page
 *   5. Any googlevideo.com href on the page
 */
async function resolveGdflixChain(gdflixUrl: string): Promise<string | null> {
  try {
    const res = await fetch(gdflixUrl, {
      headers: { "User-Agent": UPSTREAM_UA, Referer: "https://m4ulinks.site/" },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url: gdflixUrl.slice(0, 80) }, "GDFlix proxy: page fetch failed");
      return null;
    }
    const html = await res.text();

    // Priority 1: Pixeldrain — direct streaming API, zero extra hops.
    const pdMatch = html.match(/href="https?:\/\/pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)"/);
    if (pdMatch?.[1]) {
      const pdUrl = `https://pixeldrain.com/api/file/${pdMatch[1]}`;
      logger.info({ url: pdUrl }, "GDFlix proxy: resolved via Pixeldrain");
      return pdUrl;
    }

    // Priority 2: foxcloud.rest chain → Google Video URL.
    const foxMatch = html.match(/href="(https?:\/\/cdn\.foxcloud\.rest\/\?url=[^"]*)"/);
    if (foxMatch?.[1]) {
      const foxUrl = foxMatch[1].replace(/&amp;/g, "&");
      const foxFinal = await followFoxcloudChain(foxUrl, gdflixUrl);
      if (foxFinal) {
        logger.info({ url: foxFinal.slice(0, 80) }, "GDFlix proxy: resolved via foxcloud chain");
        return foxFinal;
      }
      logger.warn({ foxUrl: foxUrl.slice(0, 80) }, "GDFlix proxy: foxcloud chain failed");
    }

    // Priority 3: busycdn link (static href — rare, most pages require JS+Turnstile)
    const busyMatch = html.match(/href="(https:\/\/instant\.busycdn\.xyz\/[^"]{10,})"/);
    if (busyMatch?.[1]) {
      const final = await followBusyCdnToFinalUrl(busyMatch[1], gdflixUrl);
      if (final) {
        logger.info({ final: final.slice(0, 80) }, "GDFlix proxy: resolved via busycdn");
        return final;
      }
      // BusyCDN is broken (returns error JSON). Do NOT return the raw busycdn
      // URL — it causes the player to hang indefinitely. Return null so the
      // caller returns a clean 502 instead.
      logger.warn({ busyUrl: busyMatch[1].slice(0, 80) }, "GDFlix proxy: busycdn follow failed — returning null");
    }

    // Priority 4: any direct .mp4/.mkv link on the page
    const directVideo = html.match(/href="(https?:\/\/[^"]+\.(?:mp4|mkv|avi|mov)[^"]*)"/i);
    if (directVideo?.[1]) {
      logger.info({ url: directVideo[1].slice(0, 80) }, "GDFlix proxy: resolved via direct video link");
      return directVideo[1].replace(/&amp;/g, "&");
    }

    // Priority 5: any googlevideo.com href on the page
    const gvMatch = html.match(/href="(https?:\/\/[^"]*googlevideo\.com\/[^"]*)"/i);
    if (gvMatch?.[1]) {
      logger.info({ url: gvMatch[1].slice(0, 80) }, "GDFlix proxy: resolved via googlevideo");
      return gvMatch[1].replace(/&amp;/g, "&");
    }

    logger.warn({ url: gdflixUrl.slice(0, 80) }, "GDFlix proxy: no CDN URL found on page");
    return null;
  } catch (e) {
    logger.warn({ err: e, url: gdflixUrl.slice(0, 80) }, "GDFlix proxy: resolution error");
    return null;
  }
}

function resolveContentType(raw: string, firstBytes?: Uint8Array): string {
  // ── Known wrong labels ────────────────────────────────────────────────────
  // "video/mkv" / "video/x-mkv" are not IANA types; ExoPlayer has no parser
  // registered for them.  The correct type is "video/x-matroska".
  if (raw === "video/mkv" || raw === "video/x-mkv") return "video/x-matroska";

  // ── Unambiguous types — trust the CDN ────────────────────────────────────
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") {
    return raw;
  }

  // ── Ambiguous / missing type — sniff magic bytes ──────────────────────────
  if (firstBytes && firstBytes.length >= 8) {
    // MKV / WebM: EBML magic  1A 45 DF A3
    if (firstBytes[0] === 0x1a && firstBytes[1] === 0x45 &&
        firstBytes[2] === 0xdf && firstBytes[3] === 0xa3) {
      return "video/x-matroska";
    }
    // MP4: 'ftyp' box at offset 4  (66 74 79 70)
    if (firstBytes[4] === 0x66 && firstBytes[5] === 0x74 &&
        firstBytes[6] === 0x79 && firstBytes[7] === 0x70) {
      return "video/mp4";
    }
    // MPEG-TS: sync byte 0x47 at offset 0
    if (firstBytes[0] === 0x47) return "video/mp2t";
  }

  return "video/mp4"; // safe default
}


async function pipeUpstream(
  targetUrl: string,
  cookie: string | undefined,
  req: Request,
  res: Response,
  extraHeaders?: Record<string, string>,
  onError?: (status: number) => Promise<string | null>,
): Promise<void> {
  const t0 = Date.now();

  const upstreamHeaders: Record<string, string> = {
    "user-agent": UPSTREAM_UA,
    referer: "https://api3.aoneroom.com",
    origin: "https://api3.aoneroom.com",
    // Force identity encoding so the upstream Content-Length matches the raw
    // byte count we pipe to the client.  Without this, Node's fetch may
    // auto-decompress gzip/brotli responses but still forward the CDN's
    // compressed Content-Length, causing ExoPlayer seek failures.
    "accept-encoding": "identity",
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      upstreamHeaders[k.toLowerCase()] = v;
    }
  }
  if (cookie) upstreamHeaders["cookie"] = cookie;

  const range = req.headers["range"];
  if (range) upstreamHeaders["range"] = range;

  const ifRange = req.headers["if-range"];
  if (ifRange) upstreamHeaders["if-range"] = String(ifRange);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  // Use manual redirect following when custom headers (Referer) are present so
  // the Referer is preserved across all hops.  Plain requests use native follow.
  const fetchFn = extraHeaders
    ? () => fetchWithRedirects(targetUrl, upstreamHeaders)
    : () => fetch(targetUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });

  let upstream: globalThis.Response;
  try {
    upstream = await fetchFn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, targetUrl }, "Upstream fetch failed");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: 502,
      durationMs: Date.now() - t0,
      error: msg,
    });
    res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    // Give the caller a chance to supply a fresh URL (e.g. re-extracted from
    // the HubCloud download page) before we commit the error to the client.
    if (onError) {
      const freshUrl = await onError(upstream.status).catch(() => null);
      // onError may have already sent a redirect (302) — check before writing
      // anything else to the response.
      if (res.headersSent) return;
      if (freshUrl) {
        logger.info({ freshUrl: freshUrl.slice(0, 100), originalStatus: upstream.status }, "Proxy: retrying with refreshed URL");
        return pipeUpstream(freshUrl, cookie, req, res, extraHeaders);
      }
    }
    if (res.headersSent) return;
    logger.warn({ targetUrl, status: upstream.status }, "Upstream error");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: upstream.status,
      durationMs: Date.now() - t0,
      error: `CDN returned ${upstream.status}`,
    });
    res.status(upstream.status).end();
    return;
  }

  // HEAD: we still need headers but no body — skip the peek.
  if (req.method === "HEAD") {
    const rawCtHead = upstream.headers.get("content-type") ?? "";
    const contentTypeHead = resolveContentType(rawCtHead);
    res.setHeader("Content-Type", contentTypeHead);
    res.setHeader("Accept-Ranges", "bytes");
    const clHead = upstream.headers.get("content-length");
    if (clHead) res.setHeader("Content-Length", clHead);
    const crHead = upstream.headers.get("content-range");
    if (crHead) res.setHeader("Content-Range", crHead);
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Disposition");
    res.status(upstream.status);
    upstream.body?.cancel().catch(() => {});
    logDebug({
      method: "HEAD", path: req.path, rangeHeader: range,
      targetUrl, status: upstream.status, contentType: contentTypeHead,
      bytesSent: 0, durationMs: Date.now() - t0,
    });
    res.end();
    return;
  }

  if (!upstream.body) {
    res.setHeader("Content-Type", resolveContentType(upstream.headers.get("content-type") ?? ""));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Disposition");
    res.status(upstream.status);
    logDebug({
      method: req.method, path: req.path, rangeHeader: range,
      targetUrl, status: upstream.status, contentType: "unknown",
      bytesSent: 0, durationMs: Date.now() - t0,
    });
    res.end();
    return;
  }

  // Peek first chunk so we can sniff magic bytes for content-type detection
  // BEFORE writing any headers (headers must be set before the first write).
  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let firstChunk: Uint8Array | undefined;
  try {
    const { done, value } = await reader.read();
    if (!done && value?.length) firstChunk = value;
  } catch { /* stream ended or errored before first byte */ }

  const rawCt = upstream.headers.get("content-type") ?? "";
  const contentType = resolveContentType(rawCt, firstChunk);

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  // Suppress Content-Disposition: attachment — ExoPlayer won't play download-mode responses.
  res.removeHeader("Content-Disposition");
  res.status(upstream.status);

  let bytesSent = 0;
  try {
    // Write the already-read first chunk, then stream the rest.
    if (firstChunk?.length && !res.destroyed) {
      res.write(Buffer.from(firstChunk));
      bytesSent += firstChunk.byteLength;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
      bytesSent += value.byteLength;
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "Pipe interrupted");
  }

  logDebug({
    method: req.method, path: req.path, rangeHeader: range,
    targetUrl, status: upstream.status, contentType,
    bytesSent, durationMs: Date.now() - t0,
  });

  res.end();
}

router.all("/proxy", async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.status(204).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).end();
    return;
  }

  const { u, c, ref, ori, lp } = req.query as Record<string, string | undefined>;

  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c ? decodeParam(c) : undefined;

  // Optional referer/origin override — used to satisfy hotlink protection on
  // Backblaze B2 / FSL / S3 buckets served via HubCloud.
  const extraHeaders: Record<string, string> | undefined = (ref || ori) ? {} : undefined;
  if (extraHeaders && ref) extraHeaders["referer"] = decodeParam(ref);
  if (extraHeaders && ori) extraHeaders["origin"] = decodeParam(ori);

  // lp = HubCloud landing page URL (stable, no expiry token).  When present,
  // token refresh re-runs the full 2-step extraction instead of re-fetching
  // the short-lived download-page URL stored in ref.
  const landingPage = lp ? decodeParam(lp) : undefined;

  // ── GDFlix / GDLink intermediate page resolution ──────────────────────────
  // The movies4u provider pre-resolves GDFlix chains at scrape time. When that
  // fails (timeout, CF challenge, unexpected CDN backend) the raw gdflix.dev
  // URL arrives here with our proxy wrapping it. Resolve the full chain now
  // so the player gets an actual video file rather than an HTML page.
  if (isGdflixFamilyUrl(targetUrl)) {
    logger.info({ url: targetUrl.slice(0, 80) }, "Proxy: resolving GDFlix intermediate page at play time");
    const resolved = await resolveGdflixChain(targetUrl);
    if (!resolved) {
      logger.warn({ url: targetUrl.slice(0, 80) }, "Proxy: GDFlix resolution failed — returning 502");
      if (!res.headersSent) res.status(502).json({ error: "GDFlix: could not resolve to a video URL" });
      return;
    }
    logger.info({ resolved: resolved.slice(0, 80) }, "Proxy: GDFlix chain resolved — piping through server");
    // Pipe all GDFlix-resolved URLs through our server rather than 302-redirecting.
    //
    // Why not redirect?  The foxcloud → Google Video and busycdn → fastcdn-dl chains
    // produce signed URLs that are effectively IP-bound to the server that generated
    // them (our Replit instance).  Redirecting hands the URL to Stremio's player,
    // which fetches from the user's device IP — a different IP — causing 403 errors
    // or endless-loading in Stremio while the same URL plays fine in VLC/MPV (where
    // users paste and play immediately, before the IP binding can be detected).
    //
    // By piping here, all range requests come from our server IP, which matches the
    // IP used to generate/verify the signed URL. Pixeldrain is also piped for
    // consistency (it's fully public but piping avoids any future IP-policy changes).
    try {
      await pipeUpstream(resolved, undefined, req, res, { Referer: "https://m4ulinks.site/" });
    } catch (err) {
      logger.error({ err, resolved: resolved.slice(0, 80) }, "Proxy: GDFlix pipe error");
      if (!res.headersSent) res.status(502).end();
    }
    return;
  }

  // ── BusyCDN intermediate URL (gdflix second hop) ──────────────────────────
  // Arrives here when the scrape-time busycdn → fastcdn-dl step failed but
  // the busycdn URL itself was found. Follow it now.
  if (isBusyCdnUrl(targetUrl)) {
    logger.info({ url: targetUrl.slice(0, 80) }, "Proxy: following BusyCDN intermediate URL at play time");
    const resolved = await followBusyCdnToFinalUrl(targetUrl, "https://gdflix.dev/");
    if (resolved) {
      logger.info({ resolved: resolved.slice(0, 80) }, "Proxy: BusyCDN resolved — 302 redirect");
      if (!res.headersSent) res.redirect(302, resolved);
      return;
    }
    // BusyCDN is broken (returns error JSON / hangs). Do NOT fall through to
    // pipeUpstream — piping a dead busycdn URL causes the player to hang
    // indefinitely waiting for bytes that never arrive.
    logger.warn({ url: targetUrl.slice(0, 80) }, "Proxy: BusyCDN follow failed — returning 502");
    if (!res.headersSent) res.status(502).json({ error: "BusyCDN: could not resolve to a video URL" });
    return;
  }

  const isMpd = targetUrl.includes(".mpd") || targetUrl.includes("manifest");

  if (!isMpd) {
    // ── Proactive re-extraction for HubCloud CDN URLs ─────────────────────────
    // HubCloud serves content via short-lived tokens (FSL/S3/B2/buzz) or private
    // Cloudflare R2 buckets (pub-*.r2.dev — "bucket cannot be viewed" 403).
    //
    // Two cases require proactive re-extraction before even attempting to pipe:
    //
    //   Case A — Plain R2 private bucket URL (no auth params):
    //     pub-*.r2.dev URLs without X-Amz-Signature / token are inaccessible.
    //     Going straight to re-extraction avoids a guaranteed 403.
    //
    //   Case B — Expired short-lived numeric token (epoch 9-11 digits):
    //     Token has expired or expires within 60 s → re-extract before piping.
    //
    // In both cases, pipe the fresh URL through our proxy (never redirect to R2).

    const targetIsPlainR2 = isPlainR2(targetUrl);

    const numericTokenMatch = /[?&](?:token|Expires)=(\d{9,11})(?:[&#]|$)/.exec(targetUrl);
    const tokenExpired = numericTokenMatch
      ? parseInt(numericTokenMatch[1]!) <= Math.floor(Date.now() / 1000) + 60
      : false;

    if ((targetIsPlainR2 || tokenExpired) && (landingPage || extraHeaders?.referer)) {
      logger.info(
        { isPlainR2: targetIsPlainR2, tokenExpired, url: targetUrl.slice(0, 100) },
        "Proxy: proactive re-extraction triggered",
      );
      try {
        let freshUrl: string | null = null;

        if (landingPage) {
          freshUrl = await reExtractFromHubCloud(landingPage);
          if (freshUrl) {
            logger.info({ newUrl: freshUrl.slice(0, 100) }, "Proxy: proactively re-extracted fresh CDN URL");
          }
        }

        if (!freshUrl && extraHeaders?.referer) {
          freshUrl = await refreshFromDownloadPage(extraHeaders.referer);
          if (freshUrl) {
            logger.info({ newUrl: freshUrl.slice(0, 100) }, "Proxy: proactively refreshed via download page");
          }
        }

        if (freshUrl && !isPlainR2(freshUrl)) {
          // Got a better (non-R2) CDN URL — pipe through proxy
          logger.info({ freshUrl: freshUrl.slice(0, 100) }, "Proxy: using fresh non-R2 CDN URL");
          targetUrl = freshUrl;
        } else {
          // Re-extraction failed or still returned R2 — redirect player directly.
          // The player's mobile/residential IP can access public R2 buckets even
          // when our Cloudflare data-centre IP is blocked.
          const redirectTo = freshUrl ?? targetUrl;
          logger.info({ redirectTo: redirectTo.slice(0, 100) }, "Proxy: R2 fallback — 302 redirect to R2 for direct player fetch");
          if (!res.headersSent) res.redirect(302, redirectTo);
          return;
        }
      } catch (err) {
        // On unexpected error, still redirect rather than returning an error status
        logger.warn({ err }, "Proxy: proactive refresh error — 302 redirect to R2 as fallback");
        if (!res.headersSent) res.redirect(302, targetUrl);
        return;
      }
    }

    // ── Reactive retry on 403/404 ─────────────────────────────────────────────
    // If the CDN still returns 403/404 after proactive refresh (or for streams
    // with no numeric token), attempt re-extraction from the landing page, then
    // fall back to the download-page refresh.
    // Always pipe fresh URLs through our proxy — never redirect to R2 directly,
    // since private R2 buckets return 403 for all pub-*.r2.dev requests.
    const onError = (landingPage || extraHeaders?.referer)
      ? async (status: number): Promise<string | null> => {
          if (status !== 403 && status !== 404) return null;
          if (landingPage) {
            logger.info({ status, lp: landingPage.slice(0, 80) }, "Proxy: reactive re-extract from HubCloud landing page");
            const freshUrl = await reExtractFromHubCloud(landingPage);
            if (freshUrl) return freshUrl;
          }
          if (extraHeaders?.referer) {
            logger.info({ status, referer: extraHeaders.referer.slice(0, 80) }, "Proxy: reactive refresh from download page");
            return refreshFromDownloadPage(extraHeaders.referer);
          }
          return null;
        }
      : undefined;

    try {
      await pipeUpstream(targetUrl, cookie, req, res, extraHeaders, onError);
    } catch (err) {
      logger.error({ err, targetUrl }, "Proxy error");
      if (!res.headersSent) res.status(502).end();
    }
    return;
  }

  await handleMpd(req, res, targetUrl, cookie);
});


export default router;
