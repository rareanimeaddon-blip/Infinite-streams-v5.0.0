import { Router } from "express";
import type { Request, Response } from "express";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { BASE_PATH } from "../lib/base-path.js";

const raProxyRouter = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const GROOVY_REFERER = "https://groovy.monster/";
const GROOVY_ORIGIN = "https://groovy.monster";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(url: string, base: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

function urlDir(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    parts.pop();
    return `${u.protocol}//${u.host}${parts.join("/")}`;
  } catch { return url; }
}

/** base64url-encode an arbitrary string for safe use as a query param */
function encodeCookie(cookie: string): string {
  return Buffer.from(cookie, "utf8").toString("base64url");
}

/** Decode a base64url cookie string */
function decodeCookie(encoded: string): string {
  try { return Buffer.from(encoded, "base64url").toString("utf8"); } catch { return ""; }
}

/**
 * Build a proxy URL for a segment/sub-playlist, threading the cookie and
 * referer through so every upstream request carries authentication.
 */
function proxySegUrl(rawUrl: string, addonBase: string, referer: string, ck: string): string {
  let url = `${addonBase}${BASE_PATH}/hls/seg?url=${encodeURIComponent(rawUrl)}&ref=${encodeURIComponent(referer)}`;
  if (ck) url += `&ck=${encodeURIComponent(ck)}`;
  return url;
}

function proxyM3u8Url(rawUrl: string, addonBase: string, referer: string, ck: string): string {
  let url = `${addonBase}${BASE_PATH}/hls/master.m3u8?url=${encodeURIComponent(rawUrl)}&ref=${encodeURIComponent(referer)}`;
  if (ck) url += `&ck=${encodeURIComponent(ck)}`;
  return url;
}

/**
 * Rewrite every URL inside an m3u8 playlist to go through our proxy,
 * threading the cookie (ck) and referer parameters through every link so
 * that Stremio's player never has to talk to the CDN directly.
 */
function rewriteM3u8(
  content: string,
  originalUrl: string,
  addonBase: string,
  referer: string,
  ck: string
): string {
  const baseDir = urlDir(originalUrl);
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Tag lines — rewrite URI="..." attributes (keys, subtitles, etc.)
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/gi, (_match, uri: string) => {
        const abs = resolveUrl(uri, baseDir);
        const proxied = abs.includes(".m3u8")
          ? proxyM3u8Url(abs, addonBase, referer, ck)
          : proxySegUrl(abs, addonBase, referer, ck);
        return `URI="${proxied}"`;
      });
    }

    // Segment / sub-playlist lines
    const abs = resolveUrl(trimmed, baseDir);
    return abs.includes(".m3u8")
      ? proxyM3u8Url(abs, addonBase, referer, ck)
      : proxySegUrl(abs, addonBase, referer, ck);
  }).join("\n");
}

/**
 * If `content` is a master HLS playlist (contains #EXT-X-STREAM-INF),
 * rewrite it to expose ONLY the single highest-bandwidth variant.
 *
 * LG WebOS's native HLS player buffers ~5–6 s of MPEG-TS and then attempts
 * its first ABR quality switch.  That switch causes a PID/codec discontinuity
 * in the MPEG-TS stream that WebOS cannot recover from → "Error while
 * decoding".  Android ExoPlayer re-initialises the codec on every switch and
 * is unaffected.
 *
 * By exposing a single variant the player never attempts a switch, and
 * playback continues indefinitely on both platforms.
 *
 * This function is called on the already-rewritten playlist (all URLs are
 * already proxied absolute URLs), so no URL resolution is needed here.
 *
 * MPEG-TS muxes audio into the video stream — EXT-X-MEDIA audio groups are
 * therefore not needed and are stripped to keep the playlist clean.
 */
function filterToSingleVariant(content: string): string {
  if (!content.includes("#EXT-X-STREAM-INF")) {
    // Not a master playlist — media playlist, pass through unchanged.
    return content;
  }

  const lines = content.split("\n");

  // ── Pass 1: collect all variant entries (STREAM-INF line + URL line) ────────
  interface Variant {
    infIdx: number;   // index of the #EXT-X-STREAM-INF line
    urlIdx: number;   // index of the following URL line
    bandwidth: number;
  }
  const variants: Variant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? "";
    if (!t.startsWith("#EXT-X-STREAM-INF")) continue;

    const bwM = t.match(/BANDWIDTH=(\d+)/i);
    const bandwidth = bwM ? parseInt(bwM[1]!, 10) : 0;

    // The URL is the next non-empty, non-comment line
    let j = i + 1;
    while (j < lines.length && (lines[j]?.trim() === "" || lines[j]?.trim().startsWith("#"))) {
      j++;
    }

    if (j < lines.length && lines[j]?.trim() !== "") {
      variants.push({ infIdx: i, urlIdx: j, bandwidth });
      i = j; // skip past the URL line so we don't double-count
    }
  }

  if (variants.length <= 1) {
    // Already single-variant or empty — nothing to filter.
    return content;
  }

  // ── Pick the single highest-bandwidth variant ────────────────────────────────
  const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));

  logger.info(
    {
      totalVariants: variants.length,
      selectedBandwidth: best.bandwidth,
      droppedVariants: variants.length - 1,
    },
    "[RareAnimeProxy] filterToSingleVariant: reduced ABR master to single variant for LG WebOS compatibility"
  );

  // ── Build the set of line indices that belong to non-best variants ───────────
  const dropIndices = new Set<number>();
  for (const v of variants) {
    if (v === best) continue;
    dropIndices.add(v.infIdx);
    dropIndices.add(v.urlIdx);
  }

  // ── Determine which AUDIO group the best variant references (if any) ─────────
  const bestInfLine = lines[best.infIdx]?.trim() ?? "";
  const audioGroupM = bestInfLine.match(/AUDIO="([^"]+)"/i);
  const keepAudioGroup = audioGroupM?.[1] ?? null;

  // ── Pass 2: build output ─────────────────────────────────────────────────────
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (dropIndices.has(i)) continue;

    const t = lines[i]?.trim() ?? "";

    // Drop EXT-X-MEDIA audio/subtitle groups that are NOT referenced by the
    // best variant (MPEG-TS embeds audio in-stream; separate groups unneeded).
    if (t.startsWith("#EXT-X-MEDIA:")) {
      const groupM = t.match(/GROUP-ID="([^"]+)"/i);
      const group = groupM?.[1] ?? null;
      if (group && group !== keepAudioGroup) continue;
    }

    // Drop EXT-X-I-FRAME-STREAM-INF trick-play variants — WebOS ignores them
    // and they can confuse stricter parsers.
    if (t.startsWith("#EXT-X-I-FRAME-STREAM-INF")) continue;

    // On the best variant's STREAM-INF line, strip the AUDIO group reference
    // if the group itself was also stripped (no separate audio track in TS).
    if (i === best.infIdx && !keepAudioGroup) {
      output.push((lines[i] ?? "").replace(/,?\s*AUDIO="[^"]*"/gi, ""));
      continue;
    }

    output.push(lines[i] ?? "");
  }

  return output.join("\n");
}

/** Derive the addon's externally-accessible base URL from the request */
function addonBaseUrl(req: Request): string {
  const publicUrl = process.env["PUBLIC_URL"];
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || (req.headers["host"] as string | undefined) || "localhost";
  return `${proto}://${host}`;
}

/** Build upstream headers, optionally including session cookies and a Range header */
function buildUpstreamHeaders(referer: string, cookie?: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Referer: referer,
    Origin: GROOVY_ORIGIN,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  if (cookie) headers["Cookie"] = cookie;
  // Forward Range header when present so the CDN returns the correct byte window.
  // All groovy.monster segment URLs are signed tokens for the same full video file
  // (~33 MB); #EXT-X-BYTERANGE maps each 10-second segment to a byte range within
  // that file.  Without forwarding Range the CDN returns the whole file from byte 0
  // (= the intro) regardless of which segment is being requested.
  if (range) headers["Range"] = range;
  return headers;
}

// ─── CORS pre-flight ──────────────────────────────────────────────────────────

raProxyRouter.options("/hls/{*splat}", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.sendStatus(200);
});

// ─── Master / media playlist proxy ───────────────────────────────────────────

/**
 * GET /api/hls/master.m3u8?url=...&ref=...&ck=...
 *
 * Fetches a master or media m3u8 from the upstream CDN with full auth
 * headers (Referer, Origin, Cookie), rewrites every URL to go through our
 * proxy, then reduces any multi-variant ABR master to a single variant so
 * that LG WebOS does not attempt quality switches (which cause MPEG-TS
 * PID discontinuities and "Error while decoding" after ~5 s).
 */
raProxyRouter.get("/hls/master.m3u8", async (req: Request, res: Response) => {
  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const targetUrl = decodeURIComponent(rawUrl);
  const referer = req.query["ref"]
    ? decodeURIComponent(req.query["ref"] as string)
    : GROOVY_REFERER;
  const ckEncoded = req.query["ck"] as string | undefined ?? "";
  const cookie = ckEncoded ? decodeCookie(decodeURIComponent(ckEncoded)) : undefined;

  logger.info(
    { url: targetUrl.slice(0, 100), hasCookie: !!cookie },
    "[RareAnimeProxy] Fetching m3u8"
  );

  try {
    const upstream = await axios.get<string>(targetUrl, {
      headers: buildUpstreamHeaders(referer, cookie),
      timeout: 20000,
      responseType: "text",
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      logger.warn(
        { status: upstream.status, url: targetUrl.slice(0, 100), body: String(upstream.data).slice(0, 200) },
        "[RareAnimeProxy] m3u8 upstream returned error"
      );
      res.status(upstream.status).end();
      return;
    }

    const addonBase = addonBaseUrl(req);

    // Step 1: rewrite all CDN URLs to go through our proxy
    const rewritten = rewriteM3u8(upstream.data, targetUrl, addonBase, referer, ckEncoded);

    // Step 2: if this is a multi-variant ABR master, reduce to a single
    // highest-bandwidth variant.  This prevents LG WebOS from attempting
    // quality switches that cause MPEG-TS decoder errors.
    const filtered = filterToSingleVariant(rewritten);

    logger.info(
      { url: targetUrl.slice(0, 80), lines: filtered.split("\n").length },
      "[RareAnimeProxy] m3u8 rewritten OK"
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.send(filtered);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, url: targetUrl.slice(0, 100) },
      "[RareAnimeProxy] m3u8 fetch error"
    );
    res.status(502).end();
  }
});

// ─── Segment / sub-playlist proxy ────────────────────────────────────────────

/**
 * GET /api/hls/seg?url=...&ref=...&ck=...
 *
 * Proxies a single HLS resource (TS segment, AES-128 key, or sub-playlist)
 * from the upstream CDN with full auth headers.  If the response is itself
 * an m3u8 it is rewritten recursively and single-variant filtered.
 */
raProxyRouter.get("/hls/seg", async (req: Request, res: Response) => {
  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const targetUrl = decodeURIComponent(rawUrl);
  const referer = req.query["ref"]
    ? decodeURIComponent(req.query["ref"] as string)
    : GROOVY_REFERER;
  const ckEncoded = req.query["ck"] as string | undefined ?? "";
  const cookie = ckEncoded ? decodeCookie(decodeURIComponent(ckEncoded)) : undefined;

  // Forward the client's Range header to the CDN.
  // groovy.monster URLs are all tokens for the same ~33 MB full video file;
  // only Range-forwarding lets the CDN return the correct byte window for each
  // segment, enabling accurate playback and seeking on all platforms.
  const clientRange = req.headers["range"] as string | undefined;

  // Detect whether this is a playlist or binary segment
  const lc = targetUrl.toLowerCase();
  const isPlaylist =
    lc.includes(".m3u8") ||
    lc.includes("/hls/") ||
    lc.includes("playlist") ||
    lc.includes("index.m3u");

  try {
    const upstream = await axios.get(targetUrl, {
      headers: buildUpstreamHeaders(referer, cookie, clientRange),
      timeout: 30000,
      responseType: isPlaylist ? "text" : "stream",
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      logger.warn(
        { status: upstream.status, url: targetUrl.slice(0, 100) },
        "[RareAnimeProxy] Segment upstream returned error"
      );
      res.status(upstream.status).end();
      return;
    }

    const contentType = (upstream.headers["content-type"] as string | undefined) || "";
    res.setHeader("Access-Control-Allow-Origin", "*");

    const isM3u8Response =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      isPlaylist;

    if (isM3u8Response) {
      // Sub-playlist — rewrite URLs recursively and apply single-variant filter
      const text = typeof upstream.data === "string"
        ? upstream.data
        : String(upstream.data);
      const addonBase = addonBaseUrl(req);
      const rewritten = rewriteM3u8(text, targetUrl, addonBase, referer, ckEncoded);
      const filtered = filterToSingleVariant(rewritten);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.send(filtered);
    } else {
      // Binary segment — relay CDN response directly, including 206 Partial Content.
      //
      // All groovy.monster segment URLs are signed tokens for the *same* ~33 MB full
      // video file.  #EXT-X-BYTERANGE maps each 10-second window to a byte range
      // within that file.  We forward the client's Range header to the CDN (done above
      // via buildUpstreamHeaders), so the CDN returns exactly the right bytes for each
      // segment/seek position and responds with its own 206 + Content-Range.
      // We relay those headers verbatim — no faking needed.
      const contentLen = upstream.headers["content-length"] as string | undefined;
      const cdnContentRange = upstream.headers["content-range"] as string | undefined;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType || "video/mp2t");
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (contentLen) res.setHeader("Content-Length", contentLen);
      if (cdnContentRange) res.setHeader("Content-Range", cdnContentRange);

      // Relay the CDN status (200 or 206) so strict players (LG TV, HLS.js) see
      // the correct partial-content response for Range requests.
      res.status(upstream.status);
      (upstream.data as NodeJS.ReadableStream).pipe(res);
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, url: targetUrl.slice(0, 100) },
      "[RareAnimeProxy] Segment fetch error"
    );
    res.status(502).end();
  }
});

export { encodeCookie };
export default raProxyRouter;
