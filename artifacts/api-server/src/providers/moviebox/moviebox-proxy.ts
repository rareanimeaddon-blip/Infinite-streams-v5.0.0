import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";
import { logDebug } from "../../lib/debug-log.js";
import { BASE_PATH } from "../../lib/base-path.js";
import { extractSrtFromZip } from "../../lib/opensubtitles.js";

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

export default router;
