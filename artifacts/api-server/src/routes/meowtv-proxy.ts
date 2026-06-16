import { Router, type Request, type Response } from "express";
import { Readable } from "stream";
import { logger } from "../lib/logger.js";
import {
  fetchMeowServerStream,
  imdbToTmdbNumeric,
  makeMeowM3u8ProxyUrl,
  makeMeowBinaryProxyUrl,
} from "../providers/meowtv.js";
import { BASE_PATH } from "../lib/base-path.js";

// ─── PNG-wrapper stripping ────────────────────────────────────────────────────
// 1shows.app (TikTok CDN) hides MPEG-TS segments inside a fake PNG envelope:
//   Bytes 0–119  : minimal 1×1 PNG (IHDR + sRGB + gAMA + pHYs + IDAT + IEND)
//   Bytes 120–end: raw 188-byte MPEG-TS packets
//
// The IEND chunk always ends with the fixed 8-byte sequence
//   49 45 4E 44  AE 42 60 82   ("IEND" + its invariant CRC)
// We locate that marker, skip past it, verify the 0x47 TS sync byte, and
// serve the real payload as video/mp2t so that LG TV (and any standards-
// compliant HLS player) can decode it.

const IEND_MAGIC = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function stripPngTsWrapper(body: Buffer): { buf: Buffer; stripped: boolean } {
  if (
    body.length < 128 ||
    body[0] !== 0x89 ||
    body[1] !== 0x50 ||
    body[2] !== 0x4e ||
    body[3] !== 0x47
  ) {
    return { buf: body, stripped: false };
  }
  const iendIdx = body.indexOf(IEND_MAGIC);
  if (iendIdx === -1) return { buf: body, stripped: false };
  const tsStart = iendIdx + IEND_MAGIC.length;
  if (tsStart >= body.length) return { buf: body, stripped: false };
  const tsData = body.subarray(tsStart);
  if (tsData[0] !== 0x47) return { buf: body, stripped: false };
  return { buf: tsData, stripped: true };
}

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function setCors(res: Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
}

function getProxyBase(req: Request): string {
  const publicUrl = process.env["PUBLIC_URL"];
  if (publicUrl) return publicUrl.replace(/\/$/, "") + (BASE_PATH ?? "");
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}${BASE_PATH ?? ""}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers["host"] as string | undefined) ??
    "localhost";
  return `${proto}://${host}${BASE_PATH ?? ""}`;
}

function buildUpstreamHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": UA,
    Referer: "https://meowtv.ru/",
    Origin: "https://meowtv.ru",
    ...extra,
  };
}

// ─── Binary proxy ─────────────────────────────────────────────────────────────

router.get("/meow-proxy", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const encUrl = req.query["u"] as string | undefined;
  const encHeaders = req.query["h"] as string | undefined;

  if (!encUrl) { res.status(400).send("Missing u parameter"); return; }

  let targetUrl: string;
  let extraHeaders: Record<string, string> = {};

  try {
    targetUrl = Buffer.from(encUrl, "base64url").toString("utf-8");
  } catch {
    res.status(400).send("Invalid u parameter");
    return;
  }

  if (encHeaders) {
    try {
      extraHeaders = JSON.parse(Buffer.from(encHeaders, "base64url").toString("utf-8")) as Record<string, string>;
    } catch { /* ignore */ }
  }

  try {
    const upstream = await fetch(targetUrl, { headers: buildUpstreamHeaders(extraHeaders) });
    if (!upstream.ok) { res.status(502).send(`Upstream ${upstream.status}`); return; }

    const ct = upstream.headers.get("content-type") ?? "";
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    // If the CDN mislabels the segment as an image (1shows.app/TikTok CDN
    // hides MPEG-TS inside a fake PNG envelope), buffer and strip the wrapper.
    if (ct.startsWith("image/")) {
      const bodyBuf = Buffer.from(await upstream.arrayBuffer());
      const { buf, stripped } = stripPngTsWrapper(bodyBuf);
      if (stripped) {
        logger.debug({ targetUrl: targetUrl.slice(0, 80) }, "MeowTV proxy: stripped PNG wrapper → video/mp2t");
        res.setHeader("Content-Type", "video/mp2t");
      } else {
        if (ct) res.setHeader("Content-Type", ct);
      }
      res.end(buf);
      return;
    }

    if (ct) res.setHeader("Content-Type", ct);
    if (!upstream.body) { res.end(); return; }

    const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
    nodeStream.pipe(res);
  } catch (e) {
    logger.warn({ err: e, targetUrl }, "MeowTV binary proxy error");
    if (!res.headersSent) res.status(500).send("Proxy error");
  }
});

// ─── HLS M3U8 proxy (with CDN token refresh on 404) ─────────────────────────

router.get("/meow-proxy.m3u8", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const encUrl = req.query["u"] as string | undefined;
  const encHeaders = req.query["h"] as string | undefined;

  if (!encUrl) { res.status(400).send("Missing u parameter"); return; }

  let targetUrl: string;
  let extraHeaders: Record<string, string> = {};

  try {
    targetUrl = Buffer.from(encUrl, "base64url").toString("utf-8");
  } catch {
    res.status(400).send("Invalid u parameter");
    return;
  }

  if (encHeaders) {
    try {
      extraHeaders = JSON.parse(Buffer.from(encHeaders, "base64url").toString("utf-8")) as Record<string, string>;
    } catch { /* ignore */ }
  }

  const refetchType = req.query["t"] as string | undefined;
  const refetchImdb = req.query["i"] as string | undefined;
  const refetchServer = req.query["s"] as string | undefined;
  const refetchSeason = req.query["sn"] ? parseInt(req.query["sn"] as string) : undefined;
  const refetchEpisode = req.query["ep"] ? parseInt(req.query["ep"] as string) : undefined;
  const hasRefetchParams = !!(refetchType && refetchImdb && refetchServer);

  const proxyBase = getProxyBase(req);

  let currentUrl = targetUrl;
  let currentHeaders = extraHeaders;
  let attempt = 0;

  while (attempt < 2) {
    attempt++;

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(currentUrl, { headers: buildUpstreamHeaders(currentHeaders) });
    } catch (e) {
      logger.warn({ err: e, targetUrl: currentUrl }, "MeowTV HLS proxy fetch error");
      if (!res.headersSent) res.status(500).send("Proxy error");
      return;
    }

    if (!upstream.ok) {
      if (upstream.status === 404 && attempt === 1 && hasRefetchParams) {
        try {
          const freshTmdbId = await imdbToTmdbNumeric(
            refetchImdb!,
            refetchType! as "movie" | "series",
          );
          if (freshTmdbId) {
            const freshData = await fetchMeowServerStream(
              refetchType! as "movie" | "series",
              freshTmdbId,
              refetchServer!,
              refetchSeason,
              refetchEpisode,
            );
            if (freshData?.url && !freshData.url.match(/\.(mp4|mkv|webm|avi|mov)(\?|$)/i)) {
              logger.info(
                { server: refetchServer, imdb: refetchImdb },
                "MeowTV M3U8 proxy: CDN token expired — refreshed stream URL",
              );
              currentUrl = freshData.url;
              currentHeaders = freshData.headers ?? {};
              continue;
            }
          }
        } catch (e) {
          logger.warn({ err: e, server: refetchServer }, "MeowTV M3U8 proxy: stream refresh failed");
        }
      }
      res.status(502).send(`Upstream ${upstream.status}`);
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "";
    const ctLower = ct.toLowerCase();
    const looksLikeText =
      ctLower.includes("mpegurl") ||
      ctLower.includes("text/") ||
      ctLower.includes("application/x-mpegurl") ||
      ct === "";

    if (!looksLikeText) {
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      if (upstream.body) {
        const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
      return;
    }

    const body = await upstream.text();
    const effectiveUrl = upstream.url || currentUrl;
    const lastSlash = effectiveUrl.lastIndexOf("/");
    const base = effectiveUrl.slice(0, lastSlash + 1);
    const origin = new URL(effectiveUrl).origin;

    function resolveAbsolute(href: string): string {
      const t = href.trim();
      if (t.startsWith("http://") || t.startsWith("https://")) return t;
      if (t.startsWith("//")) return "https:" + t;
      if (t.startsWith("/")) return origin + t;
      return base + t;
    }

    const rawLines = body.split(/\r?\n/);
    const rewrittenLines: string[] = [];
    let lastTag = "";

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();

      if (!trimmed) { rewrittenLines.push(rawLine); continue; }

      if (trimmed.startsWith("#")) {
        lastTag = trimmed;
        const rewrittenTag = rawLine.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          return `URI="${makeMeowBinaryProxyUrl(proxyBase, resolveAbsolute(uri), currentHeaders)}"`;
        });
        rewrittenLines.push(rewrittenTag);
      } else {
        const absUrl = resolveAbsolute(trimmed);
        const lowerPath = (absUrl.split("?")[0] ?? "").toLowerCase();

        const isPlaylist =
          lastTag.startsWith("#EXT-X-STREAM-INF") ||
          lastTag.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
          lowerPath.endsWith(".m3u8") ||
          lowerPath.endsWith(".txt");

        if (isPlaylist) {
          rewrittenLines.push(makeMeowM3u8ProxyUrl(proxyBase, absUrl, currentHeaders));
        } else {
          rewrittenLines.push(makeMeowBinaryProxyUrl(proxyBase, absUrl, currentHeaders));
        }

        lastTag = "";
      }
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(rewrittenLines.join("\n"));
    return;
  }

  if (!res.headersSent) res.status(502).send("Upstream 404");
});

export default router;
