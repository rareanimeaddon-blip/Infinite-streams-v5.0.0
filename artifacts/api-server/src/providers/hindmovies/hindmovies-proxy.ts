import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";

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

export default router;
