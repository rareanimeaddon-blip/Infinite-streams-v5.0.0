import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";
import { logDebug } from "../../lib/debug-log.js";
import { BASE_PATH } from "../../lib/base-path.js";
import { getPlayerApiResult } from "./animesalt-player-cache.js";
import { probeAudioTracks, filterAudioPid, filterVideoAndAudio, filterVideoOnly } from "../../lib/ts-audio.js";

const router = Router();

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeParam(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}


const AS_CDN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36";
const AS_CDN_REFERER = "https://animesalt.link/";

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

// Pre-generated audio rendition playlists, keyed by `hash::playerCdn::pid`.
// Populated during relay computation so that /as-audio-cached can serve them
// without re-fetching the CDN variant URL (whose signed token may have expired
// by the time the player requests the audio rendition — a common cause of
// "starts loading video, then playback error" on Android ExoPlayer).
interface AudioPlCache { playlist: string; expiresAt: number }
const relayAudioCache = new Map<string, AudioPlCache>();

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
  const animesaltBase = "https://animesalt.link";

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

    // Pre-generate and cache audio rendition playlists NOW, using the CDN
    // variant text we already fetched.  This avoids a second CDN fetch at play
    // time — the CDN's signed URLs typically expire within 30-60 s, so by the
    // time Android ExoPlayer requests the audio rendition playlist (a few
    // seconds after the master, after the video variant loads), the URL may
    // already be invalid → 403 → no audio → hard playback error and app exit.
    // Serving from cache guarantees the playlist is always available within
    // the relay's 90 s window regardless of CDN token lifetime.
    let variantText = text;
    if (!variantText.includes("#EXT-X-PLAYLIST-TYPE")) {
      variantText = variantText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const nl = variantText.indexOf("\n");
      if (nl !== -1) variantText = variantText.slice(0, nl + 1) + "#EXT-X-PLAYLIST-TYPE:VOD\n" + variantText.slice(nl + 1);
    }
    // Cache key mirrors relayResultCache: hash::playerCdn::proxyBase::pid.
    // Including proxyBase ensures that if the same relay is served from two
    // different origin domains (e.g. Pi and Replit), each gets its own cached
    // playlist with correctly-scoped URLs.
    for (const t of orderedTracks) {
      const audioPl = variantText.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const absUrl = trimmed.startsWith("http") ? trimmed
          : trimmed.startsWith("/") ? parsed.origin + trimmed
          : segBase + trimmed;
        return (
          `${proxyBase}/as-audio?url=${encodeURIComponent(absUrl)}` +
          `&pid=${t.pid}&pmtpid=${pmtStr}&ref=${refEnc}&org=${orgEnc}`
        );
      }).join("\n");
      relayAudioCache.set(`${hash}::${playerCdn}::${proxyBase}::${t.pid}`, {
        playlist: audioPl,
        expiresAt: Date.now() + RELAY_TTL_MS,
      });
    }

    const encodedProxyBase = encodeParam(proxyBase);
    const mediaLines = orderedTracks.map((t, i) => {
      // Point to /as-audio-cached so the player fetches the pre-generated
      // playlist from our cache instead of triggering a fresh CDN fetch via
      // /as-audio-pl (which risks hitting an expired CDN token).
      const audioPlUrl =
        `${proxyBase}/as-audio-cached` +
        `?hash=${encodeURIComponent(hash)}&cdn=${encodeParam(playerCdn)}&pid=${t.pid}&base=${encodedProxyBase}`;
      return (
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",` +
        `LANGUAGE="${t.language || `und${i}`}",NAME="${t.name}",` +
        `DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,` +
        `URI="${audioPlUrl}"`
      );
    });

    logger.info({ hash, tracks: detectedTracks.length, defaultTrack: hindiTrack.name, hindiPid: hindiTrack.pid }, "AnimeSalt relay: serving synthetic HLS master with Hindi-filtered main variant");

    // CODECS declares only the video codec — audio comes entirely from the
    // AUDIO= rendition group.  Omitting mp4a.40.2 here is correct because
    // /as-va strips all audio from the variant TS segments; including it would
    // be a false promise that ExoPlayer (Android) enforces strictly by waiting
    // for audio packets that never arrive → stall → playback error.
    // hls.js (web) and GStreamer (LG TV) tolerate the mismatch, but ExoPlayer
    // does not, which is why Android was the only platform that failed.
    return [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "",
      ...mediaLines,
      "",
      `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c01f",AUDIO="audio"`,
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
// /as-audio-cached — serves pre-generated audio rendition playlists
//
// Audio rendition playlists for the AnimeSalt relay are pre-generated during
// relay computation (computeRelayM3u8) and stored in relayAudioCache, keyed
// by hash::playerCdn::pid.  This endpoint serves them so the player never
// needs to re-fetch the CDN variant URL (whose signed token expires in ~30-60 s,
// often before Android ExoPlayer gets around to requesting the audio rendition).
//
// Query params:
//   hash  — AnimeSalt video hash
//   cdn   — base64url-encoded playerCdn (same encoding as /as-relay's `player`)
//   pid   — audio elementary stream PID (integer)
// ---------------------------------------------------------------------------
router.get("/as-audio-cached", (req: Request, res: Response) => {
  const { hash, cdn, pid, base } = req.query as Record<string, string | undefined>;
  if (!hash || !cdn || !pid || !base) { res.status(400).end(); return; }
  let playerCdn: string;
  let proxyBase: string;
  try { playerCdn = decodeParam(cdn); proxyBase = decodeParam(base); } catch { res.status(400).end(); return; }
  const key = `${hash}::${playerCdn}::${proxyBase}::${pid}`;
  const cached = relayAudioCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    logger.warn({ hash, pid }, "as-audio-cached: cache miss — relay may have expired or not been computed yet");
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.send(cached.playlist);
});

router.options("/as-audio-cached", (_req, res) => {
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

export default router;
