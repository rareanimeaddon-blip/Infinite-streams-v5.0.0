import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { getPlayerApiResult } from "../lib/animesalt-player-cache.js";
import { logDebug } from "../lib/debug-log.js";
import { BASE_PATH } from "../lib/base-path.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import { extractSrtFromZip } from "../lib/opensubtitles.js";
import { probeAudioTracks, filterAudioPid, filterVideoAndAudio, filterVideoOnly } from "../lib/ts-audio.js";

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

// ─── MPD → HLS (CMAF) helpers ─────────────────────────────────────────────────
// LG WebOS browsers support HEVC in their *native* HLS player but often reject
// HEVC in MSE/DASH.  Converting the MovieBox MPD to an HLS master + media
// playlists (referencing the same fMP4 segments via our /seg proxy) lets LG TV
// play the stream through the native <video> element instead of dash.js + MSE.

function parseMpdDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseFloat(m[1] ?? "0") * 3600 +
          parseFloat(m[2] ?? "0") * 60 +
          parseFloat(m[3] ?? "0"));
}

function applyMpdTemplate(template: string, reprId: string, number?: number): string {
  let s = template.replace(/\$RepresentationID\$/g, reprId);
  s = s.replace(/\$Number(?:%0(\d+)d)?\$/g, (_full, width: string | undefined) => {
    const n = number ?? 0;
    return width ? String(n).padStart(parseInt(width, 10), "0") : String(n);
  });
  return s;
}

/** Extract a single named attribute value from a tag's attribute string (order-independent). */
function attrVal(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  return m?.[1];
}

/**
 * Normalise HEVC codec strings for LG WebOS compatibility.
 * LG WebOS Chromium's isTypeSupported() rejects bare "hev1" or "hvc1" without
 * a profile/level suffix. Convert to the canonical hvc1.1.6.LNN.90 form.
 *
 * HEVC level map (ITU-T H.265 Annex A):
 *   L60=2.0(240p)  L90=3.0(480p)  L93=3.1(720p)  L120=4.0(1080p)  L150=5.0(4K)
 */
const HEVC_LEVELS: Array<[number, string]> = [
  [240, "L60"], [480, "L90"], [720, "L93"], [1080, "L120"], [2160, "L150"],
];
function hevcLevelForHeight(h: number): string {
  for (const [maxH, lvl] of HEVC_LEVELS) if (h <= maxH) return lvl;
  return "L180";
}
function normalizeHevcCodec(codec: string, height: number): string {
  // hev1.X.Y.LZ.W → hvc1.X.Y.LZ.W  (swap type, keep profile info)
  if (/^hev1\.\S/.test(codec)) return codec.replace(/^hev1/, "hvc1");
  // bare hev1 or bare hvc1 → hvc1.1.6.LNN.90
  if (codec === "hev1" || codec === "hvc1") {
    return `hvc1.1.6.${hevcLevelForHeight(height)}.90`;
  }
  return codec;
}

// ─── MPD AdaptationSet parser ─────────────────────────────────────────────────

interface MpdSegment {
  num: number;
  durSec: number;
}

interface MpdTemplate {
  timescale: number;
  initTpl: string;
  mediaTpl: string;
  startNum: number;
  segments: MpdSegment[];
  maxSegDurSec: number;
}

interface MpdAdaptationSet {
  contentType: "video" | "audio";
  lang: string | undefined;
  template: MpdTemplate | null;
  reprs: Array<{
    id: string;
    codecs: string;
    bandwidth: number;
    width: number;
    height: number;
  }>;
}

/**
 * Expand a SegmentTimeline block into a flat list of segments.
 * Handles <S t="..." d="..." r="..." /> (r = repeat count; absent = 0).
 */
function expandSegmentTimeline(
  timelineBlock: string,
  startNum: number,
  timescale: number,
): { segments: MpdSegment[]; maxSegDurSec: number } {
  const segments: MpdSegment[] = [];
  let num = startNum;
  let maxDurSec = 0;
  for (const m of timelineBlock.matchAll(/<S\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? "";
    const d = parseInt(attrVal(attrs, "d") ?? "0", 10);
    const r = parseInt(attrVal(attrs, "r") ?? "0", 10);
    if (d <= 0) continue;
    const durSec = d / timescale;
    if (durSec > maxDurSec) maxDurSec = durSec;
    for (let i = 0; i <= r; i++) {          // r=0 → 1 segment; r=1 → 2 segments
      segments.push({ num, durSec });
      num++;
    }
  }
  return { segments, maxSegDurSec: maxDurSec };
}

/**
 * Parse a single <AdaptationSet …>…</AdaptationSet> block.
 * Returns null if the block lacks a usable SegmentTemplate.
 */
function parseAdaptationBlock(block: string, mpdTotalSecs: number): MpdAdaptationSet | null {
  const setTagM = block.match(/^<AdaptationSet([^>]*)>/);
  const setAttrs = setTagM?.[1] ?? "";

  // Determine content type
  const ctM = setAttrs.match(/contentType="([^"]+)"/);
  const rawCt = ctM?.[1]
    ?? (block.includes('mimeType="video') ? "video"
       : block.includes('mimeType="audio') ? "audio"
       : undefined);
  if (!rawCt) return null;
  const contentType = rawCt === "video" ? "video" : "audio";
  const lang = attrVal(setAttrs, "lang");

  // Collect Representation tags
  const reprs = [...block.matchAll(/<Representation\b([^>]*)>/g)].map(rm => {
    const a = rm[1] ?? "";
    const height = parseInt(attrVal(a, "height") ?? "0", 10);
    const rawCodec = attrVal(a, "codecs") ?? (contentType === "video" ? "hvc1.1.6.L120.90" : "mp4a.40.2");
    return {
      id:        attrVal(a, "id") ?? "0",
      codecs:    contentType === "video" ? normalizeHevcCodec(rawCodec, height) : rawCodec,
      bandwidth: parseInt(attrVal(a, "bandwidth") ?? "0", 10),
      width:     parseInt(attrVal(a, "width")     ?? "0", 10),
      height,
    };
  }).filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i);

  // Find SegmentTemplate (may be inside a Representation or at AdaptationSet level)
  const stTagM = block.match(/<SegmentTemplate\b([^>]*)>/);
  if (!stTagM) return { contentType, lang, template: null, reprs };

  const stAttrs = stTagM[1] ?? "";
  const timescale = parseInt(attrVal(stAttrs, "timescale") ?? "0", 10);
  const initTpl   = attrVal(stAttrs, "initialization");
  const mediaTpl  = attrVal(stAttrs, "media");
  const startNum  = parseInt(attrVal(stAttrs, "startNumber") ?? "1", 10);

  if (!timescale || !initTpl || !mediaTpl) return { contentType, lang, template: null, reprs };

  // Fixed-duration SegmentTemplate (duration attr present)
  const fixedDurTicks = parseInt(attrVal(stAttrs, "duration") ?? "0", 10);
  if (fixedDurTicks > 0) {
    const segDurSec  = fixedDurTicks / timescale;
    const totalSegs  = Math.ceil(mpdTotalSecs / segDurSec);
    const segments: MpdSegment[] = [];
    for (let i = 0; i < totalSegs; i++) {
      const isLast = i === totalSegs - 1;
      const durSec = isLast && mpdTotalSecs > 0 ? mpdTotalSecs - i * segDurSec : segDurSec;
      segments.push({ num: startNum + i, durSec });
    }
    return {
      contentType, lang, reprs,
      template: { timescale, initTpl, mediaTpl, startNum, segments, maxSegDurSec: segDurSec },
    };
  }

  // SegmentTimeline (variable-duration segments)
  const tlM = block.match(/<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
  if (!tlM) return { contentType, lang, template: null, reprs };

  const { segments, maxSegDurSec } = expandSegmentTimeline(tlM[1] ?? "", startNum, timescale);
  return {
    contentType, lang, reprs,
    template: { timescale, initTpl, mediaTpl, startNum, segments, maxSegDurSec },
  };
}

/**
 * Split an MPD into its AdaptationSet blocks and parse each one.
 */
function parseMpdAdaptationSets(mpdText: string, mpdTotalSecs: number): MpdAdaptationSet[] {
  const results: MpdAdaptationSet[] = [];
  for (const m of mpdText.matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g)) {
    const parsed = parseAdaptationBlock(m[0], mpdTotalSecs);
    if (parsed) results.push(parsed);
  }
  return results;
}

// ─── HLS playlist builder ─────────────────────────────────────────────────────

function buildHlsFromMpd(
  mpdText: string,
  cdnBase: string,
  cookie: string | undefined,
  segProxyBase: string,
  reprParam: string | undefined,
  m3u8BaseUrl: string,
): { content: string; contentType: string } {
  const b = encodeParam(cdnBase);
  const c = cookie ? encodeParam(cookie) : "_";
  const segBase = `${segProxyBase}/${b}/${c}/`;

  const durM = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
  const mpdTotalSecs = durM ? parseMpdDuration(durM[1]) : 0;

  const adaptationSets = parseMpdAdaptationSets(mpdText, mpdTotalSecs);
  const videoSets = adaptationSets.filter(s => s.contentType === "video");
  const audioSets = adaptationSets.filter(s => s.contentType === "audio");

  if (adaptationSets.length === 0) {
    logger.warn({ cdnBase }, "buildHlsFromMpd: no AdaptationSets found in MPD");
    return { content: "#EXTM3U\n#EXT-X-ENDLIST\n", contentType: "application/vnd.apple.mpegurl" };
  }

  // Pick the best video set (has template + reprs with resolution)
  const videoSet = videoSets.find(s => s.template && s.reprs.length > 0) ?? videoSets[0];
  // Pick the first audio set that has a usable template
  const audioSet = audioSets.find(s => s.template && s.reprs.length > 0) ?? audioSets[0];

  const contentType = "application/vnd.apple.mpegurl";

  // ── Master playlist ──────────────────────────────────────────────────────────
  if (!reprParam) {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];

    if (audioSet?.reprs.length) {
      const audioReprId = audioSet.reprs[0]!.id;
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,` +
        `URI="${m3u8BaseUrl}&repr=audio:${audioReprId}"`,
      );
    }

    const audioGroup = audioSet?.reprs.length ? `,AUDIO="audio"` : "";
    const videoReprs = (videoSet?.reprs ?? []).sort((a, bv) => bv.bandwidth - a.bandwidth);
    for (const vr of videoReprs) {
      const ac = audioSet?.reprs.length ? ",mp4a.40.2" : "";
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${vr.bandwidth},RESOLUTION=${vr.width}x${vr.height},` +
        `CODECS="${vr.codecs}${ac}"${audioGroup}`,
      );
      lines.push(`${m3u8BaseUrl}&repr=video:${vr.id}`);
    }
    return { content: lines.join("\n") + "\n", contentType };
  }

  // ── Media playlist (video or audio) ──────────────────────────────────────────
  // repr param format: "audio:<reprId>" | "video:<reprId>"
  // Legacy format (no colon): "audio" | "video<id>"
  let isAudio: boolean;
  let reprId: string;
  if (reprParam.startsWith("audio:")) {
    isAudio = true;
    reprId = reprParam.slice("audio:".length);
  } else if (reprParam.startsWith("video:")) {
    isAudio = false;
    reprId = reprParam.slice("video:".length);
  } else if (reprParam === "audio") {
    // legacy
    isAudio = true;
    reprId = audioSet?.reprs[0]?.id ?? "3";
  } else {
    // legacy "video0" style
    isAudio = false;
    reprId = reprParam.replace(/^video/, "");
  }

  const targetSet = isAudio ? audioSet : videoSet;
  if (!targetSet?.template) {
    logger.warn({ cdnBase, reprParam }, "buildHlsFromMpd: no usable template for repr");
    return { content: "#EXTM3U\n#EXT-X-ENDLIST\n", contentType };
  }

  const { initTpl, mediaTpl, segments, maxSegDurSec } = targetSet.template;
  const initUri = segBase + applyMpdTemplate(initTpl, reprId);

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${Math.ceil(maxSegDurSec)}`,
    "#EXT-X-MEDIA-SEQUENCE:1",
    `#EXT-X-MAP:URI="${initUri}"`,
  ];

  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.durSec.toFixed(6)},`);
    lines.push(segBase + applyMpdTemplate(mediaTpl, reprId, seg.num));
  }
  lines.push("#EXT-X-ENDLIST");
  return { content: lines.join("\n") + "\n", contentType };
}

// ─── END MPD → HLS helpers ────────────────────────────────────────────────────

function rewriteMpd(
  mpdText: string,
  cdnBase: string,
  cookie: string | undefined,
  segProxyBase: string,
): string {
  const b = encodeParam(cdnBase);
  const c = cookie ? encodeParam(cookie) : "_";
  const baseUrl = `${segProxyBase}/${b}/${c}/`;

  const cleaned = mpdText.replace(/<BaseURL[^>]*>.*?<\/BaseURL>/gs, "");
  const withBase = cleaned.replace(/(<MPD[^>]*>)/, `$1\n<BaseURL>${baseUrl}</BaseURL>`);

  // LG WebOS Chromium supports H.265 in MSE only via `hvc1` (hvcC box in init segment).
  // MovieBox CDN declares bare `hev1` (no profile/level suffix).
  //
  // Two rewrites needed:
  // 1. hev1.X.Y.LZ.W  → hvc1.X.Y.LZ.W  (codec type swap, profile info already present)
  // 2. bare hev1       → hvc1.1.6.LNN.90 (Main Profile; level inferred from height)
  //    LG WebOS Chromium rejects bare `hvc1` without profile/level via isTypeSupported.
  //    Android ExoPlayer accepts all forms.  Other clients are unaffected.
  //
  // HEVC level map (ITU-T H.265 Annex A):
  //   L60=2.0(240p) L90=3.0(480p) L93=3.1(720p) L120=4.0(1080p) L150=5.0(4K)
  const HEVC_LEVEL: Array<[number, string]> = [
    [240, "L60"], [480, "L90"], [720, "L93"], [1080, "L120"], [2160, "L150"],
  ];
  function hevcLevelForHeight(h: number): string {
    for (const [maxH, lvl] of HEVC_LEVEL) if (h <= maxH) return lvl;
    return "L180";
  }

  // Pass 1: hev1 WITH profile suffix → hvc1 (keep profile as-is)
  let result = withBase.replace(/\bhev1(\.[^\s"<]+)/g, "hvc1$1");

  // Pass 2: bare hev1 inside a <Representation> tag → hvc1.1.6.LNN.90
  result = result.replace(/<Representation([^>]*)>/g, (match, attrs: string) => {
    if (!attrs.includes('codecs="hev1"') && !attrs.includes('codecs="hvc1"')) return match;
    const hm = attrs.match(/height="(\d+)"/);
    const level = hevcLevelForHeight(hm ? parseInt(hm[1], 10) : 1080);
    return match
      .replace('codecs="hev1"', `codecs="hvc1.1.6.${level}.90"`)
      .replace('codecs="hvc1"', `codecs="hvc1.1.6.${level}.90"`);
  });

  return result;
}

async function handleMpd(
  req: Request,
  res: Response,
  targetUrl: string,
  cookie: string | undefined,
): Promise<void> {
  try {
    const upstreamHeaders: Record<string, string> = {
      "user-agent": UPSTREAM_UA,
      referer: "https://api3.aoneroom.com",
    };
    if (cookie) upstreamHeaders["cookie"] = cookie;

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const mpdText = await upstream.text();
    const cdnBase = targetUrl.replace(/\/[^/]*$/, "/");

    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const segProxyBase = `${proto}://${host}${BASE_PATH}/seg`;

    const rewritten = rewriteMpd(mpdText, cdnBase, cookie, segProxyBase);

    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, targetUrl }, "MPD proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/stream.mpd", async (req, res) => {
  const { u, c } = req.query as Record<string, string | undefined>;
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
  await handleMpd(req, res, targetUrl, cookie);
});

router.options("/stream.mpd", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── MPD → HLS route ──────────────────────────────────────────────────────────
// Converts a MovieBox DASH manifest into HLS CMAF playlists on the fly.
// Three sub-paths served from one route, distinguished by ?repr=:
//   (none)        → HLS master playlist (EXT-X-STREAM-INF + EXT-X-MEDIA)
//   repr=videoN   → video media playlist for representation N
//   repr=audio    → audio media playlist
// All segment URLs point to our existing /seg proxy so CloudFront cookies
// are forwarded transparently.
router.get("/stream.m3u8", async (req, res) => {
  const { u, c, repr } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c && c !== "_" ? decodeParam(c) : undefined;

  try {
    const upstreamHeaders: Record<string, string> = {
      "user-agent": UPSTREAM_UA,
      "referer":    "https://api3.aoneroom.com",
      "origin":     "https://api3.aoneroom.com",
    };
    if (cookie) upstreamHeaders["cookie"] = cookie;

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const mpdText    = await upstream.text();
    const cdnBase    = targetUrl.replace(/\/[^/]*$/, "/");
    const proto      = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host       = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const segBase    = `${proto}://${host}${BASE_PATH}/seg`;
    // Absolute base URL for variant references in master playlist
    const m3u8Base   = `${proto}://${host}${BASE_PATH}/stream.m3u8` +
                       `?u=${encodeURIComponent(u)}&c=${encodeURIComponent(c ?? "_")}`;

    const { content, contentType } = buildHlsFromMpd(
      mpdText, cdnBase, cookie, segBase, repr, m3u8Base,
    );

    res.setHeader("Content-Type",                contentType);
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control",               "no-store");
    res.send(content);
  } catch (err) {
    logger.error({ err, targetUrl }, "MPD-to-HLS error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/stream.m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HindMoviez / GDShine range-request proxy ────────────────────────────────
// Unlike /proxy (which injects CDN-specific Referer/Origin headers for
// aoneroom.com), this endpoint uses neutral headers so GDShine and other
// HindMoviez CDNs don't reject the request.  It properly forwards the
// Range header so Stremio can stream large files (>1 GB) in chunks.
router.all("/hmproxy", async (req: Request, res: Response) => {
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

  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const t0 = Date.now();
  const range = req.headers["range"];

  const upstreamHeaders: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept": "*/*",
    // Force identity encoding so Content-Length matches the piped byte count.
    "accept-encoding": "identity",
  };
  if (range) upstreamHeaders["range"] = range;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    logger.error({ err, targetUrl }, "HMProxy: upstream fetch failed");
    if (!res.headersSent) res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    logger.warn({ targetUrl, status: upstream.status }, "HMProxy: upstream error");
    res.status(upstream.status).end();
    return;
  }

  // HEAD: return headers only — no body peek needed.
  if (req.method === "HEAD") {
    const rawCtHead = upstream.headers.get("content-type") ?? "";
    res.setHeader("Content-Type", resolveContentType(rawCtHead));
    res.setHeader("Accept-Ranges", "bytes");
    const clHead = upstream.headers.get("content-length");
    if (clHead) res.setHeader("Content-Length", clHead);
    const crHead = upstream.headers.get("content-range");
    if (crHead) res.setHeader("Content-Range", crHead);
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Disposition");
    res.status(upstream.status);
    upstream.body?.cancel().catch(() => {});
    res.end();
    return;
  }

  if (!upstream.body) {
    res.setHeader("Content-Type", resolveContentType(upstream.headers.get("content-type") ?? ""));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Disposition");
    res.status(upstream.status);
    res.end();
    return;
  }

  // Peek first chunk for magic-byte content-type detection before setting headers.
  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let firstChunk: Uint8Array | undefined;
  try {
    const { done, value } = await reader.read();
    if (!done && value?.length) firstChunk = value;
  } catch { /* stream ended early */ }

  const rawHmCt = upstream.headers.get("content-type") ?? "";
  const contentType = resolveContentType(rawHmCt, firstChunk);

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("Content-Disposition");

  // For HLS master playlists missing CODECS= attributes, buffer and rewrite them
  // before forwarding. LG TV (webOS) and other strict HLS players require explicit
  // codec declarations on #EXT-X-STREAM-INF lines to initialise the video decoder;
  // without them the player picks audio fine (AAC is implicit) but leaves video black.
  const isHls = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");
  if (isHls) {
    const hlsChunks: Uint8Array[] = [];
    if (firstChunk?.length) hlsChunks.push(firstChunk);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hlsChunks.push(value);
      }
    } catch { /* ignore early close */ }

    let playlist = Buffer.concat(hlsChunks).toString("utf8");

    // Only rewrite master playlists that declare stream variants but omit CODECS=.
    // Kartoons streams are confirmed H.264 High Profile Level 4.0 + AAC.
    if (playlist.includes("#EXT-X-STREAM-INF") && !playlist.includes("CODECS=")) {
      playlist = playlist.replace(
        /#EXT-X-STREAM-INF:([^\n\r]*)/g,
        (_match, attrs: string) => `#EXT-X-STREAM-INF:${attrs},CODECS="avc1.640028,mp4a.40.2"`,
      );
    }

    const hlsBody = Buffer.from(playlist, "utf8");
    res.setHeader("Content-Length", hlsBody.length);
    res.status(upstream.status);
    logger.info(
      { targetUrl, status: upstream.status, bytesSent: hlsBody.length, durationMs: Date.now() - t0 },
      "HMProxy: done (m3u8 rewrite)",
    );
    res.end(hlsBody);
    return;
  }

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  res.status(upstream.status);

  let bytesSent = 0;
  try {
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
    logger.warn({ err, targetUrl }, "HMProxy: pipe interrupted");
  }

  logger.info({ targetUrl, status: upstream.status, bytesSent, durationMs: Date.now() - t0 }, "HMProxy: done");
  res.end();
});

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

router.use("/seg/:b/:c", async (req: Request, res: Response) => {
  const { b, c } = req.params as Record<string, string>;
  const filename = req.path.replace(/^\//, "");

  if (!filename) { res.status(400).end(); return; }

  let cdnBase: string;
  let cookie: string | undefined;
  try {
    cdnBase = decodeParam(b);
    new URL(cdnBase);
    cookie = c !== "_" ? decodeParam(c) : undefined;
  } catch {
    res.status(400).end();
    return;
  }

  const targetUrl = cdnBase + filename;

  try {
    await pipeUpstream(targetUrl, cookie, req, res);
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});


// ─── Subtitle proxy — fetches yifysubtitles.ch ZIP files, extracts SRT ────────
// Stremio fetches subtitle URLs directly; this proxy handles ZIP decompression
// (using built-in DataView + DecompressionStream) and adds CORS headers.
router.get("/subtitle-proxy", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) return void res.status(400).send("Missing url param");

  let targetUrl: string;
  try {
    targetUrl = Buffer.from(rawUrl, "base64url").toString("utf8");
  } catch {
    return void res.status(400).send("Invalid url encoding");
  }

  // Safety: only allow known subtitle provider domains
  const allowed = /^https?:\/\/([a-z0-9-]+\.)*yifysubtitles\.(ch|com|org)\//i;
  if (!allowed.test(targetUrl)) {
    return void res.status(403).send("Disallowed host");
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://yifysubtitles.ch/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      return void res.status(502).send(`Upstream error: ${upstream.status}`);
    }
    if (!upstream.body) return void res.status(502).send("Empty upstream body");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const ct = upstream.headers.get("content-type") ?? "";
    const isZip = ct.includes("zip") || targetUrl.endsWith(".zip");

    if (isZip) {
      const buf = await upstream.arrayBuffer();
      const srt = await extractSrtFromZip(new Uint8Array(buf));
      res.send(srt);
    } else {
      // Plain SRT / VTT served directly
      const text = await upstream.text();
      res.send(text);
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "subtitle-proxy: fetch error");
    if (!res.headersSent) res.status(502).send("Subtitle fetch failed");
  }
});

router.options("/subtitle-proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

router.options("/seg/:b/:c", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HLS proxy (generalized — supports AnimeSalt, AnimeDekho, and any CDN) ────
// Fetches the HLS playlist with caller-supplied headers, then rewrites all
// segment / sub-playlist lines to route through this server so that the player
// never needs to know the CDN's Referer/Origin requirements.

const AS_CDN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36";
const AS_CDN_REFERER = "https://animesalt.ac/";

// Extra browser-like headers that some CDNs (Cloudflare bot-mgmt) require
// to distinguish real browsers from bots/datacenter IPs.
const AS_BROWSER_EXTRA: Record<string, string> = {
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Connection": "keep-alive",
};

/**
 * Reduce a proxied HLS master playlist to its single highest-bandwidth variant,
 * preserving all #EXT-X-MEDIA (audio/subtitle) renditions.
 *
 * LG TV WebOS performs ABR quality-switching between variants; each switch
 * triggers a video-decoder re-init that the WebOS player cannot recover from,
 * causing "video freeze, audio continues".  By keeping only one variant we
 * eliminate quality switching entirely.  Android ExoPlayer handles ABR fine
 * so it is unaffected (it also only gets a single variant from this function).
 */
function filterToSingleVariantProxy(m3u8: string): string {
  const lines = m3u8.split("\n");

  // Collect all #EXT-X-MEDIA lines (audio renditions, subtitles, etc.)
  const mediaLines: string[] = [];
  // Collect #EXT-X-STREAM-INF + following variant URL pairs
  interface VariantEntry { inf: string; url: string; bandwidth: number }
  const variants: VariantEntry[] = [];

  let pendingInf: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#EXT-X-MEDIA")) {
      mediaLines.push(line);
    } else if (t.startsWith("#EXT-X-STREAM-INF")) {
      pendingInf = line;
    } else if (pendingInf !== null) {
      if (t && !t.startsWith("#")) {
        const bwMatch = /BANDWIDTH=(\d+)/i.exec(pendingInf);
        variants.push({ inf: pendingInf, url: line, bandwidth: bwMatch ? parseInt(bwMatch[1]!, 10) : 0 });
      }
      pendingInf = null;
    }
  }

  if (variants.length === 0) return m3u8; // nothing to filter

  // Pick highest-bandwidth variant
  const best = variants.reduce((a, b) => b.bandwidth > a.bandwidth ? b : a);

  const header = lines.filter(l => {
    const t = l.trim();
    return t.startsWith("#EXTM3U") || t.startsWith("#EXT-X-VERSION") || t.startsWith("#EXT-X-INDEPENDENT");
  });

  return [
    ...header,
    "",
    ...mediaLines,
    "",
    best.inf,
    best.url,
  ].join("\n");
}

// /api/m3u8?url=<enc>&referer=<enc>&origin=<enc>
// referer and origin are optional — defaults keep AnimeSalt backward-compat.
router.get("/m3u8", async (req: Request, res: Response) => {
  const { url, referer: refParam, origin: originParam, audiopid: audiopidParam, pmtpid: pmtpidParam,
          noAudioProbe: noAudioProbeParam } =
    req.query as Record<string, string | undefined>;
  if (!url) { res.status(400).json({ error: "Missing url" }); return; }

  // When audiopid is set, the caller wants every TS segment filtered to keep
  // only that audio PID (+ video/PAT/PMT).  Segments go through /as-va instead
  // of /seg, and the inner synthetic-master logic is skipped.
  const filterAudioPidNum = audiopidParam ? parseInt(audiopidParam, 10) : undefined;
  const filterPmtPidNum   = pmtpidParam   ? parseInt(pmtpidParam, 10)   : undefined;
  const doAudioFilter = filterAudioPidNum !== undefined && isFinite(filterAudioPidNum) &&
                        filterPmtPidNum   !== undefined && isFinite(filterPmtPidNum);

  // noAudioProbe=1 is set by computeRelayM3u8 on every playlist URL it generates
  // so that the TS audio-probe inside this handler does NOT fire when the player
  // fetches a variant/rendition that is already part of a properly-structured
  // outer master.  Without this guard the probe can return a synthetic inner
  // master in place of the expected segment playlist, which causes LG TV's player
  // to receive a master where it expects a variant → video freeze.
  const noAudioProbe = noAudioProbeParam === "1";

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid url" }); return;
  }

  const effectiveReferer = refParam ? decodeURIComponent(refParam) : AS_CDN_REFERER;
  let effectiveOrigin: string;
  if (originParam) {
    effectiveOrigin = decodeURIComponent(originParam);
  } else {
    try { effectiveOrigin = new URL(effectiveReferer).origin; } catch { effectiveOrigin = effectiveReferer; }
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        "Referer": effectiveReferer,
        "Origin": effectiveOrigin,
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text = await upstream.text();

    const parsed = new URL(targetUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const publicUrl = process.env["PUBLIC_URL"];
    const replitDomains = process.env["REPLIT_DOMAINS"];
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
    const proxyBase = publicUrl
      ? publicUrl.replace(/\/$/, "") + BASE_PATH
      : replitDomains
        ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
        : `${proto}://${host}${BASE_PATH}`;

    const toAbsUrl = (rel: string): string => {
      if (rel.startsWith("http")) return rel;
      if (rel.startsWith("/")) return parsed.origin + rel;
      return segBase + rel;
    };

    // Encode referer/origin so sub-playlists and segments carry the same headers
    const refEnc = encodeURIComponent(effectiveReferer);
    const orgEnc = encodeURIComponent(effectiveOrigin);

    // AnimeSalt CDN (as-cdn*.top) serves TS segments under fake extensions (.js,
    // .css, .woff) with Content-Type: application/javascript.  Routing them
    // through /seg.ts gives the proxy URL a literal .ts suffix so that both
    // the player's URL-extension parser and segmentContentType() independently
    // resolve to video/MP2T — isolating the fake-extension/MIME hypothesis.
    const isAnimeSaltCdn = /^as-cdn\d*\.top$/i.test(parsed.hostname);
    const segRoute = isAnimeSaltCdn ? "seg.ts" : "seg";

    const proxyUrl = (absUrl: string, isPlaylist: boolean): string => {
      if (isPlaylist) {
        return `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`;
      }
      // When audio-filtering is requested, route every TS segment through /as-va
      // so it strips all audio PIDs except the chosen one before delivery.
      if (doAudioFilter) {
        return (
          `${proxyBase}/as-va?url=${encodeURIComponent(absUrl)}` +
          `&audiopid=${filterAudioPidNum}&pmtpid=${filterPmtPidNum}` +
          `&ref=${refEnc}&org=${orgEnc}`
        );
      }
      return `${proxyBase}/${segRoute}?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;
    };

    // Detect whether the CDN returned a variant or master playlist.
    // A variant has #EXTINF segment entries directly; a master has #EXT-X-STREAM-INF.
    const isVariantPlaylist = /^#EXTINF:/m.test(text) && !/^#EXT-X-STREAM-INF/m.test(text);

    // AnimeSalt CDN variant playlists don't include #EXT-X-PLAYLIST-TYPE:VOD or
    // #EXT-X-ENDLIST even though the full episode's segments are present.  Inject
    // both tags directly into `text` before the rewriting loop — plain "#" tag
    // lines pass through the rewriter unchanged, so they survive into the output.
    // We do this early (before the audio-probe block) so they are also present in
    // any synthetic master that is assembled from this text.
    // The CDN already appends #EXT-X-ENDLIST, but never adds
    // #EXT-X-PLAYLIST-TYPE:VOD.  Inject it here, right after the first line
    // (#EXTM3U), so the tag survives the rewriting loop intact (# lines are
    // returned unchanged by the rewriter).
    let playlistText = text;
    if (isAnimeSaltCdn && isVariantPlaylist && !playlistText.includes("#EXT-X-PLAYLIST-TYPE")) {
      playlistText = playlistText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const nl = playlistText.indexOf("\n");
      if (nl !== -1) {
        playlistText = playlistText.slice(0, nl + 1) + "#EXT-X-PLAYLIST-TYPE:VOD\n" + playlistText.slice(nl + 1);
      }
    }

    // For AnimeSalt CDN variant playlists, probe the first TS segment for muxed
    // audio PIDs and synthesise a proper HLS master with #EXT-X-MEDIA:TYPE=AUDIO
    // so LG TV's native player shows a language selector.
    // Only runs for AnimeSalt CDN hostnames AND when the caller did not already
    // request audio filtering (doAudioFilter means we're already serving filtered
    // segments — no need for another synthetic master layer).
    if (isVariantPlaylist && /as-cdn\d*\.top/i.test(parsed.hostname) && !doAudioFilter && !noAudioProbe) {
      const firstSegRel = playlistText.split("\n").find(l => { const t = l.trim(); return t && !t.startsWith("#"); });
      if (firstSegRel) {
        const firstSegUrl = firstSegRel.trim().startsWith("http") ? firstSegRel.trim()
          : firstSegRel.trim().startsWith("/") ? parsed.origin + firstSegRel.trim()
          : segBase + firstSegRel.trim();
        try {
          const segResp = await fetch(firstSegUrl, {
            headers: {
              "User-Agent": AS_CDN_UA,
              "Referer": effectiveReferer,
              "Origin": effectiveOrigin,
              "Range": "bytes=0-7519", // 40 TS packets — enough for PAT+PMT
              ...AS_BROWSER_EXTRA,
            },
            signal: AbortSignal.timeout(8_000),
            redirect: "follow",
          });
          if (segResp.ok || segResp.status === 206) {
            const segBuf = Buffer.from(await segResp.arrayBuffer());
            const { tracks, pmtPid } = probeAudioTracks(segBuf);
            logger.info(
              { targetUrl: targetUrl.slice(0, 80), tracks: tracks.map(t => `${t.name}(${t.pid})`), pmtPid },
              "M3U8 proxy: TS audio probe result"
            );
            if (tracks.length > 1) {
              const encVariant = encodeURIComponent(targetUrl);
              const pmtStr = String(pmtPid);
              const variantProxied = `${proxyBase}/m3u8?url=${encVariant}&referer=${refEnc}&origin=${orgEnc}`;

              const hindiIdxM3u8 = tracks.findIndex(
                t => /hindi/i.test(t.name) || t.language === "hin" || t.language === "hi"
              );
              const orderedM3u8 = hindiIdxM3u8 > 0
                ? [tracks[hindiIdxM3u8]!, ...tracks.filter((_, i) => i !== hindiIdxM3u8)]
                : tracks;

              const mediaLines = orderedM3u8.map((t, i) => {
                const audioPlUrl =
                  `${proxyBase}/as-audio-pl?variantUrl=${encVariant}` +
                  `&pid=${t.pid}&pmtpid=${pmtStr}&ref=${refEnc}&org=${orgEnc}`;
                return (
                  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",` +
                  `LANGUAGE="${t.language || `und${i}`}",NAME="${t.name}",` +
                  `DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,` +
                  `URI="${audioPlUrl}"`
                );
              });

              const syntheticMaster = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                "",
                ...mediaLines,
                "",
                `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"`,
                variantProxied,
              ].join("\n");

              res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "no-store");
              res.send(syntheticMaster);
              return;
            }
          }
        } catch (err) {
          logger.warn({ err, targetUrl: targetUrl.slice(0, 80) }, "M3U8 proxy: TS audio probe failed (non-fatal)");
        }
      }
    }

    let nextLineIsVariant = false;
    const rewritten = playlistText.split("\n").map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, true)}"`;
        });
      }

      // Proxy AES-128 encryption key URIs so the player fetches keys through our
      // server (same IP as the CDN token was issued to) rather than directly from
      // the CDN. Without this, FileMoon and similar CDNs return 403 for key requests
      // made from the player's IP which differs from the server's IP.
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, false)}"`;
        });
      }

      // Proxy fMP4/CMAF init segment URIs (#EXT-X-MAP:URI="...") through the
      // segment proxy so that the CDN's Referer/Origin token check is satisfied.
      // Without this, LG TV and other players fetch the init segment directly
      // from the CDN, get a 403, and audio renditions silently fail — meaning
      // the player never shows the audio track selector.
      if (trimmed.startsWith("#EXT-X-MAP") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, false)}"`;
        });
      }

      if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
        nextLineIsVariant = true;
        return line;
      }

      if (!trimmed || trimmed.startsWith("#")) return line;

      const absUrl = toAbsUrl(trimmed);
      const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
      nextLineIsVariant = false;
      return proxyUrl(absUrl, isPlaylist);
    }).join("\n");

    // If the CDN returned a master playlist (multiple quality variants), reduce
    // it to a single highest-bandwidth variant before handing it to the player.
    // LG TV WebOS's native HLS player performs ABR quality switches between
    // variants; each switch triggers a video-decoder re-initialisation that
    // WebOS cannot recover from ("video freeze, audio continues").
    // Android ExoPlayer handles ABR correctly so it is unaffected.
    const finalM3u8 = rewritten.includes("#EXT-X-STREAM-INF")
      ? filterToSingleVariantProxy(rewritten)
      : rewritten;

    const outputM3u8 = finalM3u8;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(outputM3u8);
  } catch (err) {
    logger.error({ err, targetUrl }, "M3U8 proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Generalized segment proxy — serves .ts / .aac / key segments with caller-supplied headers.
// /api/seg?u=<enc>&ref=<enc>&org=<enc>
// Kept at /seg (new); the old /as-seg is aliased below for backward compatibility.
function segmentContentType(targetUrl: string, cdnType: string | null): string {
  const u = targetUrl.split("?")[0].toLowerCase();
  if (u.endsWith(".ts") || u.includes(".ts?")) return "video/MP2T";
  if (u.endsWith(".aac") || u.includes(".aac?")) return "audio/aac";
  if (u.endsWith(".mp4") || u.includes(".mp4?")) return "video/mp4";
  if (u.endsWith(".m4s") || u.includes(".m4s?")) return "video/iso.segment";
  if (u.endsWith(".vtt") || u.includes(".vtt?")) return "text/vtt";
  if (u.endsWith(".key") || u.includes(".key?")) return "application/octet-stream";

  // Some CDNs (TikTok CDN, DooFlix) disguise video segments as image/png or image/jpeg
  // to prevent direct hotlinking. Detect and override these fake content types.
  if (cdnType && cdnType.startsWith("image/")) return "video/MP2T";

  // AnimeSalt CDN (as-cdn*.top) disguises MPEG-TS segments with fake browser-safe
  // MIME types (application/javascript, text/css, font/woff*, etc.) to defeat
  // hotlink-detection. LG WebOS's native HLS player strictly validates Content-Type
  // and refuses to decode segments that are not video/MP2T — returning these fake
  // types verbatim causes immediate playback failure on WebOS.
  // Override any clearly-non-media CDN type to the correct value.
  const FAKE_MEDIA_TYPES = [
    "application/javascript",
    "text/javascript",
    "text/css",
    "font/woff",
    "font/woff2",
    "application/font-woff",
    "application/x-font-woff",
    "text/plain",
    "text/html",
  ];
  if (cdnType && FAKE_MEDIA_TYPES.some((t) => cdnType.startsWith(t))) return "video/MP2T";

  return cdnType ?? "video/MP2T";
}

/**
 * Find the byte offset where real MPEG-TS data starts.
 * MPEG-TS packets are 188 bytes each, always starting with sync byte 0x47.
 * Some CDNs (TikTok/DooFlix) prepend a fake PNG header to obfuscate TS segments.
 * We scan for the first 0x47 that repeats consistently every 188 bytes.
 * Returns 0 if data already starts at a valid TS sync byte.
 */
function findTsStart(buf: Buffer): number {
  const SYNC = 0x47;
  const PKT  = 188;
  // Need at least 4 confirming packets to be sure we found the right offset
  for (let i = 0; i < Math.min(buf.length - PKT * 4, 4096); i++) {
    if (buf[i] === SYNC &&
        buf[i + PKT]     === SYNC &&
        buf[i + PKT * 2] === SYNC &&
        buf[i + PKT * 3] === SYNC) {
      return i;
    }
  }
  return 0; // no fake header found — pass through as-is
}

async function serveSegment(req: Request, res: Response, targetUrl: string, referer?: string, origin?: string) {
  try {
    const headers: Record<string, string> = {
      "User-Agent": AS_CDN_UA,
      ...AS_BROWSER_EXTRA,
    };
    if (referer) headers["Referer"] = referer;
    if (origin) headers["Origin"] = origin;

    const rangeHeader = req.headers["range"];
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok && upstream.status !== 206) { res.status(upstream.status).end(); return; }

    const cdnContentType = upstream.headers.get("content-type");
    const hasFakeImageType = !!(cdnContentType && cdnContentType.startsWith("image/"));
    const contentType = segmentContentType(targetUrl, cdnContentType);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    // When the CDN disguises the segment as an image, buffer the whole response,
    // strip any fake header bytes before the real MPEG-TS sync pattern, then send.
    // This makes HLS.js (Stremio Web / browsers) accept the segment — it requires
    // TS data to start exactly with 0x47, unlike ExoPlayer which scans past garbage.
    if (hasFakeImageType && upstream.body) {
      const raw   = Buffer.from(await upstream.arrayBuffer());
      const start = findTsStart(raw);
      const body  = start > 0 ? raw.subarray(start) : raw;
      res.setHeader("Content-Length", body.length);
      res.status(upstream.status);
      res.end(body);
      return;
    }

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/seg", async (req: Request, res: Response) => {
  const { u, ref, org } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl, ref ? decodeURIComponent(ref) : undefined, org ? decodeURIComponent(org) : undefined);
});

router.options("/seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Backward-compat alias for AnimeSalt segments (old /as-seg path)
router.get("/as-seg", async (req: Request, res: Response) => {
  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl);
});

router.options("/as-seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Segment proxy whose route path ends in ".ts" so that LG WebOS's native HLS
// player sees a proper .ts URL extension in the playlist.  Some WebOS builds
// check the URL path extension as a fallback when deciding whether to hand a
// segment to the MPEG-TS demuxer; a .js / .css path can cause silent rejection
// even if Content-Type is correct.  This route is identical to /seg in every
// respect — segmentContentType() returns video/MP2T for both ".ts"-suffixed
// URLs and fake non-media CDN types — but having both mechanisms removes any
// ambiguity for strict players.
router.get("/seg.ts", async (req: Request, res: Response) => {
  const { u, ref, org } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl, ref ? decodeURIComponent(ref) : undefined, org ? decodeURIComponent(org) : undefined);
});

router.options("/seg.ts", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── AnimeSalt fresh-relay ────────────────────────────────────────────────────
// Instead of embedding a pre-signed CDN URL in the stream response (which gets
// IP-checked against the server IP at FETCH time but then may be blocked by
// Cloudflare bot-mgmt on the next segment request), this endpoint:
//   1. Re-calls AnimeSalt's player API fresh on every playback start → gets a
//      brand-new signed m3u8 URL bound to OUR server IP right now.
//   2. Immediately fetches and proxies that m3u8 with full browser headers,
//      rewriting all sub-playlist / segment lines through /api/m3u8 and /api/seg.
// This makes every single CDN request originate from our server IP with the
// token that was literally just issued for that same IP seconds ago.
//
// The result is cached for 90 seconds and pre-warmed from the stream handler so
// Stremio gets an instant response instead of waiting 10-15 s for two sequential
// upstream fetches.
//
// GET /api/as-relay?hash=<videoHash>&player=<base64url-playerCdn>

interface RelayCache { m3u8: string; expiresAt: number }
const relayResultCache = new Map<string, RelayCache>();
const relayInFlight = new Map<string, Promise<string>>();
const RELAY_TTL_MS = 90_000;

/**
 * Post-processes a proxied HLS master playlist so that the Hindi audio
 * rendition is listed FIRST and has DEFAULT=YES, while all other audio
 * renditions have DEFAULT=NO.
 *
 * Why: AnimeSalt's CDN emits all three renditions (tel/tam/hin) with
 * DEFAULT=NO.  LG TV selects the first-listed rendition regardless of
 * DEFAULT= flags, so without this fix Telugu always plays on LG TV.
 * This is a no-op if the playlist has no Hindi #EXT-X-MEDIA:TYPE=AUDIO line.
 */
function putHindiFirstInMaster(m3u8: string): string {
  const isHindiLine = (line: string): boolean => {
    const lang = (line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? "").toLowerCase();
    const name = (line.match(/NAME="([^"]+)"/)?.[1] ?? "").toLowerCase();
    return lang === "hin" || lang === "hi" || /hindi/.test(name);
  };

  const isAudioMedia = (line: string): boolean =>
    line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/i.test(line);

  const lines = m3u8.split("\n");

  let hindiLine: string | null = null;
  const otherAudioLines: string[] = [];
  const rest: string[] = [];
  let firstAudioInsertIdx = -1;

  for (const line of lines) {
    if (isAudioMedia(line)) {
      if (firstAudioInsertIdx === -1) firstAudioInsertIdx = rest.length;
      const updated = line.replace(/DEFAULT=(YES|NO)/i, `DEFAULT=${isHindiLine(line) ? "YES" : "NO"}`);
      if (isHindiLine(line)) {
        hindiLine = updated;
      } else {
        otherAudioLines.push(updated);
      }
    } else {
      rest.push(line);
    }
  }

  if (hindiLine === null || firstAudioInsertIdx === -1) return m3u8;

  const ordered = [hindiLine, ...otherAudioLines];
  return [
    ...rest.slice(0, firstAudioInsertIdx),
    ...ordered,
    ...rest.slice(firstAudioInsertIdx),
  ].join("\n");
}

async function computeRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const playerUrl = `${playerCdn}/video/${hash}`;
  const animesaltBase = "https://animesalt.ac";

  // Step 1: Get the signed m3u8 URL.
  // Check the scraper's cache first — animesalt.ts already called the player API
  // during scraping and stored the result.  If it's there we skip a full round-trip.
  let m3u8Url: string | undefined = getPlayerApiResult(hash)?.m3u8Url;

  if (m3u8Url) {
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: m3u8 from scraper cache (skip player API call)");
  } else {
    // Cache miss — call the player API fresh.
    logger.info({ hash }, "AnimeSalt relay: cache miss, calling player API");
    const apiResp = await fetch(
      `${playerCdn}/player/index.php?data=${hash}&do=getVideo`,
      {
        method: "POST",
        headers: {
          "User-Agent": AS_CDN_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${animesaltBase}/`,
          "Origin": playerCdn,
          "X-Requested-With": "XMLHttpRequest",
          ...AS_BROWSER_EXTRA,
        },
        body: `hash=${hash}&r=${encodeURIComponent(`${animesaltBase}/`)}`,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!apiResp.ok) {
      throw Object.assign(new Error("player API error"), { status: apiResp.status });
    }

    const json = (await apiResp.json()) as Record<string, unknown>;
    m3u8Url = (
      json["videoSource"] ?? json["securedLink"] ?? json["file"] ??
      json["url"] ?? json["hls"] ?? json["src"]
    ) as string | undefined;

    if (!m3u8Url) throw new Error("no m3u8 in player API response");
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: fresh m3u8 obtained via player API");
  }

  // Step 2: Fetch the master m3u8 immediately from our server (same IP, fresh token)
  const upstream = await fetch(m3u8Url, {
    headers: {
      "User-Agent": AS_CDN_UA,
      "Referer": playerUrl,
      "Origin": playerCdn,
      ...AS_BROWSER_EXTRA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });

  if (!upstream.ok) {
    throw Object.assign(new Error("CDN m3u8 fetch failed"), { status: upstream.status });
  }

  const text = await upstream.text();
  const parsed = new URL(m3u8Url);
  const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

  const refEnc = encodeURIComponent(playerUrl);
  const orgEnc = encodeURIComponent(playerCdn);

  // Detect whether the CDN returned a variant playlist (direct TS segments)
  // vs a master playlist (quality renditions with #EXT-X-STREAM-INF).
  // AnimeSalt's CDN returns a variant URL directly from the player API.
  const isVariant = /^#EXTINF:/m.test(text) && !/^#EXT-X-STREAM-INF/m.test(text);

  // If it's a variant, probe the first TS segment to find muxed audio PIDs.
  // This lets us synthesise a proper HLS master with #EXT-X-MEDIA:TYPE=AUDIO
  // entries so LG TV's native player shows a language selector.
  let detectedTracks: import("../lib/ts-audio.js").AudioTrack[] = [];
  let detectedPmtPid = -1;

  if (isVariant) {
    const firstSegRel = text.split("\n").find(l => { const t = l.trim(); return t && !t.startsWith("#"); });
    if (firstSegRel) {
      const firstSegUrl = firstSegRel.trim().startsWith("http")
        ? firstSegRel.trim()
        : firstSegRel.trim().startsWith("/")
          ? parsed.origin + firstSegRel.trim()
          : segBase + firstSegRel.trim();
      try {
        const segResp = await fetch(firstSegUrl, {
          headers: {
            "User-Agent": AS_CDN_UA,
            "Referer": playerUrl,
            "Origin": playerCdn,
            "Range": "bytes=0-7519", // 40 × 188 B TS packets is enough for PAT+PMT
            ...AS_BROWSER_EXTRA,
          },
          signal: AbortSignal.timeout(8_000),
          redirect: "follow",
        });
        if (segResp.ok || segResp.status === 206) {
          const buf = Buffer.from(await segResp.arrayBuffer());
          const probe = probeAudioTracks(buf);
          detectedTracks = probe.tracks;
          detectedPmtPid = probe.pmtPid;
          logger.info(
            { hash, tracks: detectedTracks.map(t => `${t.name}(pid=${t.pid})`), pmtPid: detectedPmtPid },
            "AnimeSalt relay: TS audio probe"
          );
        }
      } catch (err) {
        logger.warn({ hash, err }, "AnimeSalt relay: TS probe failed (non-fatal, falling back to plain variant)");
      }
    }
  }

  // For CDN multi-quality masters (isVariant=false): probe the first segment of
  // the first video variant to get the PMT PID.  We need it to route every
  // video-variant segment through /as-va, which patches the PMT to remove the
  // audio PID declaration and drops any audio TS packets.
  //
  // Why this matters for LG TV WebOS:
  //   The CDN video variants have PMT entries that declare audio PID 256 (Hindi)
  //   even though the TS packets for that PID are absent.  When the HLS master
  //   also declares an external AUDIO= group, LG TV's GStreamer pipeline finds
  //   both the PMT-promised audio AND the external rendition audio and tries to
  //   sync them.  The resulting double-audio condition stalls the video decoder
  //   (classic "video frozen, audio plays" symptom).  Stripping the PMT audio
  //   entry makes the video TS truly video-only; LG TV then cleanly uses the
  //   external CDN audio renditions with no conflict.
  let cdnPmtPid = -1;
  if (!isVariant) {
    const masterLines = text.split("\n");
    let firstVariantAbsUrl: string | undefined;
    for (let i = 0; i < masterLines.length - 1; i++) {
      const t = masterLines[i].trim();
      if (t.startsWith("#EXT-X-STREAM-INF")) {
        const nextUrl = masterLines[i + 1]?.trim();
        if (nextUrl && !nextUrl.startsWith("#")) {
          firstVariantAbsUrl = nextUrl.startsWith("http") ? nextUrl
            : nextUrl.startsWith("/") ? parsed.origin + nextUrl
            : segBase + nextUrl;
          break;
        }
      }
    }
    if (firstVariantAbsUrl) {
      try {
        const varResp = await fetch(firstVariantAbsUrl, {
          headers: { "User-Agent": AS_CDN_UA, "Referer": playerUrl, "Origin": playerCdn, ...AS_BROWSER_EXTRA },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (varResp.ok) {
          const varText = await varResp.text();
          const varParsed = new URL(firstVariantAbsUrl);
          const varSegBase = varParsed.origin + varParsed.pathname.replace(/[^/]+$/, "");
          const firstSegRel = varText.split("\n").find(l => { const t = l.trim(); return t && !t.startsWith("#"); });
          if (firstSegRel) {
            const firstSegUrl = firstSegRel.trim().startsWith("http") ? firstSegRel.trim()
              : firstSegRel.trim().startsWith("/") ? varParsed.origin + firstSegRel.trim()
              : varSegBase + firstSegRel.trim();
            const segResp = await fetch(firstSegUrl, {
              headers: {
                "User-Agent": AS_CDN_UA, "Referer": playerUrl, "Origin": playerCdn,
                "Range": "bytes=0-7519",
                ...AS_BROWSER_EXTRA,
              },
              signal: AbortSignal.timeout(8_000),
              redirect: "follow",
            });
            if (segResp.ok || segResp.status === 206) {
              const buf = Buffer.from(await segResp.arrayBuffer());
              const probe = probeAudioTracks(buf);
              cdnPmtPid = probe.pmtPid;
              logger.info(
                { hash, pmtPid: cdnPmtPid, tracks: probe.tracks.map(t => `${t.name}(${t.pid})`) },
                "AnimeSalt relay: CDN master segment probe"
              );
            }
          }
        }
      } catch (err) {
        logger.warn({ hash, err }, "AnimeSalt relay: CDN master probe failed (non-fatal)");
      }
    }
  }

  const toAbsUrl = (rel: string): string => {
    if (rel.startsWith("http")) return rel;
    if (rel.startsWith("/")) return parsed.origin + rel;
    return segBase + rel;
  };

  // proxyUrl builds the appropriate proxy URL for a CDN URL.
  //
  // For video quality variant playlist URLs (isVideoVariant=true) when we have
  // a valid PMT PID from the probe above, we add audiopid+pmtpid so the /m3u8
  // handler sets doAudioFilter=true and routes every segment through /as-va.
  // /as-va patches the PMT to remove the audio PID entry and drops audio TS
  // packets, giving LG TV a truly video-only TS with no PMT audio promise.
  // audiopid=1 is a dummy value (>0 satisfies doAudioFilter; /as-va ignores it).
  //
  // noAudioProbe=1 on every playlist URL prevents the /m3u8 handler from
  // running its own TS audio probe (which could replace a variant playlist
  // with an inner synthetic master, nesting HLS levels unexpectedly).
  const proxyUrl = (absUrl: string, isPlaylist: boolean, isVideoVariant = false): string => {
    if (!isPlaylist) {
      return `${proxyBase}/seg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;
    }
    const base = `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}&noAudioProbe=1`;
    if (isVideoVariant && !isVariant && cdnPmtPid > 0) {
      return `${base}&audiopid=1&pmtpid=${cdnPmtPid}`;
    }
    return base;
  };

  let nextLineIsVariant = false;
  const rewritten = text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), true, false)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), false)}"`
      );
    }
    // Proxy fMP4/CMAF init segment URIs so the CDN's Referer/Origin token check
    // is satisfied for audio rendition init segments.  Without this the player
    // fetches init-audio.mp4 directly from the CDN (wrong IP/headers) → 403 →
    // the audio rendition silently fails and LG TV never shows the track selector.
    if (trimmed.startsWith("#EXT-X-MAP") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), false)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) { nextLineIsVariant = true; return line; }
    if (!trimmed || trimmed.startsWith("#")) return line;
    const absUrl = toAbsUrl(trimmed);
    const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
    const isVideoVar = nextLineIsVariant;
    nextLineIsVariant = false;
    return proxyUrl(absUrl, isPlaylist, isVideoVar);
  }).join("\n");

  // For master playlists that have real #EXT-X-MEDIA:TYPE=AUDIO renditions,
  // ensure Hindi is listed FIRST and has DEFAULT=YES.
  //
  // If the CDN master probe failed (cdnPmtPid <= 0) we cannot route video
  // segments through /as-va, so the PMT still declares audio.  In that case
  // fall back to stripping the external audio group entirely — LG TV then plays
  // the PMT-promised (but empty) audio from the video TS silently, which is
  // better than the double-audio freeze.
  let withHindiFirst: string;
  if (!isVariant && cdnPmtPid <= 0) {
    withHindiFirst = rewritten
      .split("\n")
      .filter(l => !(l.trim().startsWith("#EXT-X-MEDIA") && l.includes("TYPE=AUDIO")))
      .map(l => l.trim().startsWith("#EXT-X-STREAM-INF") ? l.replace(/,?\s*AUDIO="[^"]*"/, "") : l)
      .join("\n");
    logger.warn({ hash }, "AnimeSalt relay: CDN master probe failed — stripped audio renditions as fallback");
  } else {
    withHindiFirst = putHindiFirstInMaster(rewritten);
    if (withHindiFirst !== rewritten) {
      logger.info({ hash }, "AnimeSalt relay: reordered audio renditions — Hindi first, DEFAULT=YES");
    }
  }

  // For CDN multi-quality masters (isVariant=false), collapse to the single
  // highest-bandwidth variant before serving to LG TV WebOS.
  //
  // Why: LG TV attempts ABR quality-switching at ~5 s intervals; each switch
  // is a codec re-init that WebOS cannot recover from, producing a video
  // freeze 2–5 s after playback starts (identical to the old RareAnime bug,
  // fixed there via filterToSingleVariant).
  //
  // filterToSingleVariantProxy preserves all #EXT-X-MEDIA audio renditions
  // (the audio group system is orthogonal to quality variant selection) so
  // language switching and the Hindi-first ordering set above are unaffected.
  //
  // For plain variant playlists (isVariant=true, single-track fallback path
  // below) the function is a no-op: no #EXT-X-STREAM-INF line is present.
  const withSingleVariant = filterToSingleVariantProxy(withHindiFirst);
  if (withSingleVariant !== withHindiFirst) {
    logger.info(
      { hash },
      "AnimeSalt relay: collapsed multi-variant CDN master to single variant for LG WebOS ABR compatibility"
    );
  }

  // If we're wrapping a CDN variant and detected multiple audio tracks,
  // synthesise a proper HLS master playlist with #EXT-X-MEDIA:TYPE=AUDIO
  // entries pointing to our per-PID audio rendition proxy endpoints.
  // Video playback is fully unchanged — the variant URL is unmodified.
  if (isVariant && detectedTracks.length > 1) {
    const variantProxied = `${proxyBase}/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${refEnc}&origin=${orgEnc}`;
    const encVariant = encodeURIComponent(m3u8Url);
    const pmtStr = String(detectedPmtPid);

    // Move Hindi track to front. Also mark it DEFAULT=YES per the HLS spec.
    const hindiIdx = detectedTracks.findIndex(
      t => /hindi/i.test(t.name) || t.language === "hin" || t.language === "hi"
    );
    const orderedTracks = hindiIdx > 0
      ? [detectedTracks[hindiIdx]!, ...detectedTracks.filter((_, i) => i !== hindiIdx)]
      : detectedTracks;

    const hindiTrack = orderedTracks[0]!;

    // Route the main variant through /m3u8 with audiopid=<hindiPid> so that
    // the /m3u8 route rewrites every TS segment URL to /as-va, which strips
    // all audio PIDs except Hindi from each segment.  LG TV (which ignores
    // HLS DEFAULT= flags and just plays the first audio PID found in the TS)
    // therefore has no choice but to play Hindi.  Android users can still
    // switch via the #EXT-X-MEDIA renditions below.
    const variantWithHindi =
      `${proxyBase}/m3u8?url=${encVariant}&referer=${refEnc}&origin=${orgEnc}` +
      `&audiopid=${hindiTrack.pid}&pmtpid=${pmtStr}&noAudioProbe=1`;

    const mediaLines = orderedTracks.map((t, i) => {
      const audioPlUrl =
        `${proxyBase}/as-audio-pl?variantUrl=${encVariant}` +
        `&pid=${t.pid}&pmtpid=${pmtStr}&ref=${refEnc}&org=${orgEnc}`;
      return (
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",` +
        `LANGUAGE="${t.language || `und${i}`}",NAME="${t.name}",` +
        `DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,` +
        `URI="${audioPlUrl}"`
      );
    });

    logger.info({ hash, tracks: detectedTracks.length, defaultTrack: hindiTrack.name, hindiPid: hindiTrack.pid }, "AnimeSalt relay: serving synthetic HLS master with Hindi-filtered main variant");

    return [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "",
      ...mediaLines,
      "",
      `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"`,
      variantWithHindi,
    ].join("\n");
  }

  return withSingleVariant;
}

// Returns a promise that resolves to the rewritten m3u8, using the cache and
// in-flight dedup map to avoid redundant upstream calls.
async function getRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const key = `${hash}::${playerCdn}::${proxyBase}`;

  const cached = relayResultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.m3u8;

  const inflight = relayInFlight.get(key);
  if (inflight) return inflight;

  const promise = computeRelayM3u8(hash, playerCdn, proxyBase).then((m3u8) => {
    relayResultCache.set(key, { m3u8, expiresAt: Date.now() + RELAY_TTL_MS });
    relayInFlight.delete(key);
    return m3u8;
  }).catch((err) => {
    relayInFlight.delete(key);
    throw err;
  });

  relayInFlight.set(key, promise);
  return promise;
}

/**
 * Pre-warm the relay cache in the background so that the first playback
 * request gets a cache-hit instead of waiting 10-15 s.  Call this from the
 * stream handler right after building the relay URL.
 */
export function prewarmAsRelay(hash: string, playerCdn: string, proxyBase: string): void {
  getRelayM3u8(hash, playerCdn, proxyBase).catch(() => {});
}

router.get("/as-relay", async (req: Request, res: Response) => {
  const { hash, player } = req.query as Record<string, string | undefined>;
  if (!hash || !player) {
    res.status(400).json({ error: "Missing hash or player" });
    return;
  }

  let playerCdn: string;
  try {
    playerCdn = decodeParam(player);
    new URL(playerCdn);
  } catch {
    res.status(400).json({ error: "Invalid player param" });
    return;
  }

  const publicUrl = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const proxyBase = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const m3u8 = await getRelayM3u8(hash, playerCdn, proxyBase);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(m3u8);
  } catch (err: unknown) {
    logger.error({ err, hash, playerCdn }, "AnimeSalt relay error");
    if (!res.headersSent) {
      const status = (err as { status?: number }).status;
      res.status(typeof status === "number" ? status : 502).end();
    }
  }
});

router.options("/as-relay", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-audio-pl — audio rendition playlist proxy
//
// Fetches the original CDN variant playlist and rewrites every segment line
// to route through /as-audio, which strips all but the selected audio PID
// from the MPEG-TS packets.
//
// Query params:
//   variantUrl  — URL-encoded raw CDN variant m3u8 URL
//   pid         — the MPEG-TS audio elementary PID to keep
//   pmtpid      — the MPEG-TS PMT PID (needed so we keep PMT packets too)
//   ref         — URL-encoded Referer header to forward to CDN
//   org         — URL-encoded Origin header to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-audio-pl", async (req: Request, res: Response) => {
  const { variantUrl: variantUrlEnc, pid: pidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!variantUrlEnc || !pidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(pidStr, 10);
  const pmtPid = parseInt(pmtpidStr, 10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let variantUrl: string;
  try { variantUrl = decodeURIComponent(variantUrlEnc); new URL(variantUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc)  : undefined;

  const publicUrl     = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto  = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host   = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const base   = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const upstream = await fetch(variantUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text   = await upstream.text();
    const parsed = new URL(variantUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const rewritten = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = trimmed.startsWith("http") ? trimmed
        : trimmed.startsWith("/") ? parsed.origin + trimmed
        : segBase + trimmed;
      return (
        `${base}/as-audio?url=${encodeURIComponent(absUrl)}&pid=${audioPid}&pmtpid=${pmtPid}` +
        (referer ? `&ref=${encodeURIComponent(referer)}` : "") +
        (origin  ? `&org=${encodeURIComponent(origin)}`  : "")
      );
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, variantUrl }, "as-audio-pl error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-audio-pl", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-audio — filtered MPEG-TS segment endpoint
//
// Fetches a TS segment from the CDN and strips all packets except PAT, PMT,
// and the selected audio PID, producing an audio-only TS stream that LG TV's
// HLS player uses for the chosen language rendition.
//
// Query params:
//   url     — URL-encoded raw CDN segment URL
//   pid     — MPEG-TS audio elementary PID to keep
//   pmtpid  — MPEG-TS PMT PID to keep
//   ref     — URL-encoded Referer to forward to CDN
//   org     — URL-encoded Origin to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-audio", async (req: Request, res: Response) => {
  const { url: urlEnc, pid: pidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!urlEnc || !pidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(pidStr, 10);
  const pmtPid   = parseInt(pmtpidStr, 10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let segUrl: string;
  try { segUrl = decodeURIComponent(urlEnc); new URL(segUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc)  : undefined;

  try {
    const upstream = await fetch(segUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const raw     = Buffer.from(await upstream.arrayBuffer());
    const filtered = filterAudioPid(raw, audioPid, pmtPid);

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(filtered);
  } catch (err) {
    logger.error({ err, segUrl }, "as-audio error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-audio", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-va-pl — video + single-audio playlist proxy
//
// Fetches the original CDN variant playlist and rewrites every segment URL
// to route through /as-va, which strips all audio PIDs except the chosen one.
// This is used as the main #EXT-X-STREAM-INF URL in the AnimeSalt synthetic
// HLS master so that LG TV (which ignores DEFAULT= flags and plays the first
// audio PID in the TS) always plays Hindi.
//
// Query params:
//   variantUrl  — URL-encoded raw CDN variant m3u8 URL
//   audiopid    — the MPEG-TS audio PID to KEEP (all others are dropped)
//   pmtpid      — the MPEG-TS PMT PID
//   ref         — URL-encoded Referer header to forward to CDN
//   org         — URL-encoded Origin header to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-va-pl", async (req: Request, res: Response) => {
  const { variantUrl: variantUrlEnc, audiopid: audiopidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!variantUrlEnc || !audiopidStr || !pmtpidStr) { res.status(400).end(); return; }

  const audioPid = parseInt(audiopidStr, 10);
  const pmtPid   = parseInt(pmtpidStr,   10);
  if (!isFinite(audioPid) || !isFinite(pmtPid)) { res.status(400).end(); return; }

  let variantUrl: string;
  try { variantUrl = decodeURIComponent(variantUrlEnc); new URL(variantUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc) : undefined;

  const publicUrl     = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto  = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host   = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const base   = publicUrl
    ? publicUrl.replace(/\/$/, "") + BASE_PATH
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}${BASE_PATH}`
      : `${proto}://${host}${BASE_PATH}`;

  try {
    const upstream = await fetch(variantUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text   = await upstream.text();
    const parsed = new URL(variantUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const rewritten = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = trimmed.startsWith("http") ? trimmed
        : trimmed.startsWith("/") ? parsed.origin + trimmed
        : segBase + trimmed;
      return (
        `${base}/as-va?url=${encodeURIComponent(absUrl)}&audiopid=${audioPid}&pmtpid=${pmtPid}` +
        (referer ? `&ref=${encodeURIComponent(referer)}` : "") +
        (origin  ? `&org=${encodeURIComponent(origin)}`  : "")
      );
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, variantUrl }, "as-va-pl error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-va-pl", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// /as-va — video + single-audio TS segment filter
//
// Fetches a TS segment and strips ALL audio PIDs, returning a video-only TS.
//
// Why video-only instead of keeping one audio track:
//   The HLS master we generate includes AUDIO="audio" in #EXT-X-STREAM-INF,
//   which tells every conformant HLS player to use a separate #EXT-X-MEDIA
//   rendition for audio rather than the muxed audio in the variant TS.
//   Android ExoPlayer (and most software players) honour this correctly and
//   ignore any muxed audio.  LG TV WebOS however fetches BOTH the muxed audio
//   AND the rendition audio and tries to keep them in sync.  The two audio
//   streams arrive over different HTTP connections with different buffering
//   latencies; as they drift apart LG TV's GStreamer player stalls the video
//   decoder while the audio buffer plays out — the classic "video freeze, audio
//   continues" bug that does not reproduce on Android.
//
//   Making the variant TS video-only eliminates the double-audio condition: LG
//   TV (and Android) both use the Hindi #EXT-X-MEDIA rendition (DEFAULT=YES,
//   listed first) for audio.  Language switching via other renditions continues
//   to work on all platforms.
//
// Query params:
//   url       — URL-encoded raw CDN segment URL
//   audiopid  — MPEG-TS audio PID (kept in URL for cache-busting / debugging;
//               no longer used for filtering — all audio is stripped)
//   pmtpid    — MPEG-TS PMT PID (used to patch the PMT table)
//   ref       — URL-encoded Referer to forward to CDN
//   org       — URL-encoded Origin to forward to CDN
// ---------------------------------------------------------------------------
router.get("/as-va", async (req: Request, res: Response) => {
  const { url: urlEnc, audiopid: audiopidStr, pmtpid: pmtpidStr, ref: refEnc, org: orgEnc } =
    req.query as Record<string, string | undefined>;

  if (!urlEnc || !pmtpidStr) { res.status(400).end(); return; }

  const pmtPid = parseInt(pmtpidStr, 10);
  if (!isFinite(pmtPid)) { res.status(400).end(); return; }

  // audiopid is accepted for backward-compat / cache-differentiation but is
  // not used: filterVideoOnly strips all audio regardless.
  void audiopidStr;

  let segUrl: string;
  try { segUrl = decodeURIComponent(urlEnc); new URL(segUrl); }
  catch { res.status(400).end(); return; }

  const referer = refEnc ? decodeURIComponent(refEnc) : undefined;
  const origin  = orgEnc ? decodeURIComponent(orgEnc) : undefined;

  try {
    const upstream = await fetch(segUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        ...(referer ? { "Referer": referer } : {}),
        ...(origin  ? { "Origin":  origin  } : {}),
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const raw      = Buffer.from(await upstream.arrayBuffer());
    const filtered = filterVideoOnly(raw, pmtPid);

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(filtered);
  } catch (err) {
    logger.error({ err, segUrl }, "as-va error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/as-va", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── VidLink CDN streaming proxy ───────────────────────────────────────────────
// VidLink's mp4 CDN (vodvidl.site) runs a Cloudflare-style WAF that intermittently
// blocks requests from certain client IPs/networks (seen: Indian mobile carrier
// IPs blocked on 480p/360p while 1080p and other titles worked) with a "Sorry, you
// have been blocked" page. That block is keyed on the *client's* IP reputation, not
// on headers — so handing the client the raw CDN URL (even with correct
// proxyHeaders) still lets a flaky/flagged client IP get blocked directly by the
// CDN, causing endless loading in the player.
//
// Fix: proxy the actual video bytes through our own server (this route) instead of
// letting the client hit vodvidl.site directly. The CDN then only ever sees our
// server's IP, which is not subject to that per-client WAF block, and we still
// forward the required Referer/Origin headers ourselves so it never depends on the
// client/player attaching them correctly. Range requests are forwarded so seeking
// still works. See buildVidLinkStreams in routes/stremio.ts for the caller.
//
// This route fetches an arbitrary attacker-decodable URL, which would be an open
// proxy / SSRF vector on its own. It's locked down two ways:
//   1. The encoded URL must carry an HMAC signature (keyed on SESSION_SECRET) that
//      we generate ourselves in buildVidLinkStreamProxyUrl — a third party can't
//      forge a signature for a URL of their choosing.
//   2. Even with a valid signature, the target must be a public https:// host —
//      no localhost/private/link-local targets, so a leaked/replayed signed URL
//      still can't be used to reach internal services.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

// No fallback secret: if SESSION_SECRET is missing, signatures must not be
// forgeable-by-default, so the route refuses to sign/verify at all (see below)
// rather than silently using a guessable well-known key.
const VIDLINK_SIGN_SECRET = process.env["SESSION_SECRET"];
if (!VIDLINK_SIGN_SECRET) {
  logger.error("VidLink stream proxy: SESSION_SECRET is not set — /vidlink-stream will refuse all requests");
}

// Signed URLs expire well after the aggregation window (~20s) plus generous
// player buffering/seek time, but are not valid forever — this bounds how long
// a leaked/logged/shared link (e.g. from a browser history or proxy log) stays
// usable as an open-fetch primitive against the upstream CDN.
const VIDLINK_SIGN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function signVidLinkUrl(encoded: string, expires: number): string {
  if (!VIDLINK_SIGN_SECRET) throw new Error("SESSION_SECRET not configured");
  return createHmac("sha256", VIDLINK_SIGN_SECRET).update(`${encoded}.${expires}`).digest("base64url").slice(0, 22);
}

function verifyVidLinkSignature(encoded: string, expires: number, sig: string): boolean {
  if (!VIDLINK_SIGN_SECRET) return false;
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expected = signVidLinkUrl(encoded, expires);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True for a literal IPv4 address in a private/loopback/link-local/reserved range. */
function isDisallowedIpv4(h: string): boolean {
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> deny
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expands a valid IPv6 literal (any legal textual form, including `::`
 * compression and a trailing dotted-quad) into its canonical 16-byte form.
 * Returns null if the string isn't parseable — callers must treat that as deny.
 */
function parseIpv6ToBytes(hRaw: string): number[] | null {
  let h = hRaw.toLowerCase();
  const zoneIdx = h.indexOf("%");
  if (zoneIdx !== -1) h = h.slice(0, zoneIdx); // strip zone id, e.g. fe80::1%eth0

  // Trailing embedded IPv4 dotted-quad (e.g. ::ffff:192.0.2.1) -> convert to two hextets.
  const dottedMatch = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch) {
    const octets = dottedMatch[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex1 = ((octets[0]! << 8) | octets[1]!).toString(16);
    const hex2 = ((octets[2]! << 8) | octets[3]!).toString(16);
    h = `${dottedMatch[1]}${hex1}:${hex2}`;
  }

  const halves = h.split("::");
  if (halves.length > 2) return null; // more than one "::" is invalid

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (!left || !right || left.length + right.length > 7) return null;
    const missing = 8 - left.length - right.length;
    hextets = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const full = parseGroups(halves[0]!);
    if (!full || full.length !== 8) return null;
    hextets = full;
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of hextets) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * True for a literal IPv6 address in a special-use range that must never be
 * proxy-fetched: unspecified, loopback, link-local, unique-local (ULA),
 * multicast, the discard-only prefix, documentation space, 6to4/Teredo
 * transition ranges (both can tunnel to arbitrary/internal IPv4), and any
 * IPv4-mapped/-compatible form (recurses into the embedded IPv4 check).
 * Unparseable input is treated as disallowed (fail closed).
 */
function isDisallowedIpv6(hRaw: string): boolean {
  const b = parseIpv6ToBytes(hRaw);
  if (!b) return true;

  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);

  if (allZero(0, 16)) return true; // :: (unspecified)
  if (allZero(0, 15) && b[15] === 1) return true; // ::1 (loopback)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (ULA)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (allZero(0, 7) && b[7] === 1) return true; // 100::/64 discard-only
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && allZero(2, 4)) return true; // 2001::/32 Teredo — can tunnel anywhere, deny
  if (b[0] === 0x20 && b[1] === 0x02) return isDisallowedIpv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`); // 2002::/16 6to4
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isDisallowedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // ::ffff:a.b.c.d mapped
  if (allZero(0, 12) && !allZero(12, 16)) return isDisallowedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // deprecated ::a.b.c.d compatible
  return false;
}

/** True if the literal IP string (v4 or v6) falls in a disallowed range. */
function isDisallowedIpLiteral(h: string): boolean {
  const kind = isIP(h);
  if (kind === 4) return isDisallowedIpv4(h);
  if (kind === 6) return isDisallowedIpv6(h);
  return true; // not a valid IP literal at all -> treat conservatively as disallowed if used where an IP is expected
}

/**
 * Rejects localhost / private / link-local / multicast / reserved targets to
 * prevent SSRF via a replayed signed URL. Resolves the hostname via DNS (rather
 * than only checking the literal string) so a public-looking hostname that
 * actually resolves to an internal IP (DNS rebinding / attacker-controlled DNS)
 * is still caught. Returns true (disallowed) on any lookup failure — fail closed.
 */
async function isPrivateOrDisallowedHost(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;

  if (isIP(h)) return isDisallowedIpLiteral(h);

  try {
    const results = await dnsLookup(h, { all: true, verbatim: true });
    if (results.length === 0) return true;
    return results.some((r) => isDisallowedIpLiteral(r.address));
  } catch {
    return true; // DNS failure -> fail closed
  }
}

export function encodeProxyUrl(cdnUrl: string): string {
  return Buffer.from(cdnUrl, "utf8").toString("base64url");
}

/** Returns null (rather than throwing) when SESSION_SECRET isn't configured, so
 * callers can simply omit VidLink streams instead of crashing aggregation. */
export function buildVidLinkStreamProxyUrl(serverBase: string, cdnUrl: string, filename: string): string | null {
  if (!VIDLINK_SIGN_SECRET) return null;
  const encoded = encodeProxyUrl(cdnUrl);
  const expires = Date.now() + VIDLINK_SIGN_TTL_MS;
  const sig = signVidLinkUrl(encoded, expires);
  return `${serverBase}/vidlink-stream/${encoded}/${encodeURIComponent(filename)}?sig=${sig}&exp=${expires}`;
}

const VIDLINK_HEADERS = { Referer: "https://vidlink.pro/", Origin: "https://vidlink.pro" };

router.get("/vidlink-stream/:encodedUrl/:filename", async (req: Request, res: Response): Promise<void> => {
  const { encodedUrl } = req.params as { encodedUrl: string; filename: string };
  const sig = req.query["sig"] as string | undefined;
  const expires = Number(req.query["exp"]);

  if (!sig || !verifyVidLinkSignature(encodedUrl, expires, sig)) {
    res.status(403).json({ error: "Invalid, missing, or expired signature" });
    return;
  }

  let targetUrl: string;
  let parsed: URL;
  try {
    targetUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
    parsed = new URL(targetUrl); // throws on malformed input
  } catch {
    res.status(400).json({ error: "Invalid proxy URL" });
    return;
  }
  if (parsed.protocol !== "https:" || (await isPrivateOrDisallowedHost(parsed.hostname))) {
    logger.warn({ host: parsed.hostname }, "VidLink stream proxy: disallowed target");
    res.status(403).json({ error: "Target not allowed" });
    return;
  }

  const fetchHeaders: Record<string, string> = { ...VIDLINK_HEADERS };
  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader as string;

  // Full VidLink mp4s can be multiple GB — a fixed whole-request timeout would
  // abort long-running playback well before it finishes. Instead we use an
  // *idle* timeout: only abort if no bytes arrive for 20s (dead connection),
  // never based on total elapsed time. connectTimeout guards a hung initial
  // connect/headers phase separately.
  const controller = new AbortController();
  const connectTimeout = setTimeout(() => controller.abort(), 20_000);
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 20_000);
  };

  try {
    // redirect: "manual" — the host check above only validated targetUrl itself;
    // silently following a redirect would let a validated public host hand us
    // off to an internal target without re-validation (classic SSRF-via-redirect).
    // VidLink's mp4 CDN never redirects for a direct file fetch, so treat any
    // redirect response as untrusted and reject it outright rather than chase it.
    const upstream = await fetch(targetUrl, { headers: fetchHeaders, signal: controller.signal, redirect: "manual" });
    clearTimeout(connectTimeout);

    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      logger.warn({ status: upstream.status, host: parsed.hostname }, "VidLink stream proxy: refusing to follow redirect");
      res.status(502).json({ error: "Upstream redirect not allowed" });
      return;
    }

    if (!upstream.ok && upstream.status !== 206) {
      logger.warn({ status: upstream.status, host: parsed.hostname }, "VidLink stream proxy: upstream error");
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.statusText}` });
      return;
    }
    if (!upstream.body) {
      res.status(502).json({ error: "No response body" });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
    const ac = upstream.headers.get("accept-ranges");
    if (ac) res.setHeader("Accept-Ranges", ac);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);

    const reader = upstream.body.getReader();
    req.on("close", () => { if (idleTimer) clearTimeout(idleTimer); reader.cancel().catch(() => {}); });
    for (;;) {
      resetIdleTimer();
      const { done, value } = await reader.read();
      if (done) break;
      const flushed = res.write(Buffer.from(value));
      if (!flushed) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    if (idleTimer) clearTimeout(idleTimer);
    res.end();
  } catch (err) {
    clearTimeout(connectTimeout);
    if (idleTimer) clearTimeout(idleTimer);
    logger.error({ err, host: parsed.hostname }, "VidLink stream proxy error");
    if (!res.headersSent) res.status(502).json({ error: "Proxy error" });
    else res.destroy();
  }
});

router.options("/vidlink-stream/:encodedUrl/:filename", (_req, res) => {
  res
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "*")
    .status(204)
    .end();
});

export default router;
