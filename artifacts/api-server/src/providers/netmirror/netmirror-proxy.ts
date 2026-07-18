// NetMirror proxy routes + stream-fetch helper for the main Stremio aggregator.
// Proxy paths are isolated to /nmproxy and /nmsubproxy so they don't collide
// with any other provider route. Admin cache-clear lives at /nmadmin/reload.

import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  getStreams,
  imdbToTmdb,
  fetchSubtitles,
  clearAllCaches,
  type StremioStream,
} from "./netmirror.js";

// ─── SSRF guard for subtitle proxy ──────────────────────────────────────────
// Only HTTPS URLs on these known subtitle/caption hosts are allowed through
// nmsubproxy. Anything else (private IPs, internal hostnames, unknown domains)
// is rejected with 403.
const ALLOWED_SUBTITLE_HOSTS = new Set([
  "dl.opensubtitles.org",
  "www.opensubtitles.org",
  "opensubtitles.org",
  "rest.opensubtitles.org",
  "net27.cc",
  "www.net27.cc",
  // env-configured base may use a different hostname — added dynamically below
]);

const PRIVATE_IP_RE = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1$|fc00:|fe80:)/;

function isAllowedSubtitleUrl(rawUrl: string): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }

  if (parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_IP_RE.test(host)) return false;

  const configuredBase = process.env["NETMIRROR_API_BASE"];
  if (configuredBase) {
    try { ALLOWED_SUBTITLE_HOSTS.add(new URL(configuredBase).hostname.toLowerCase()); }
    catch { /* ignore bad env */ }
  }

  return ALLOWED_SUBTITLE_HOSTS.has(host);
}

const gunzipAsync = promisify(gunzip);
const router: IRouter = Router();

// ─── Proxy URL builders ──────────────────────────────────────────────────────

/**
 * Wraps a stream URL + headers through the /nmproxy endpoint so Stremio
 * receives an unblocked URL regardless of CDN geo-restrictions.
 */
export function toProxyUrl(
  targetUrl: string,
  streamHeaders: Record<string, string>,
  apiBase: string,
): string {
  const u = Buffer.from(targetUrl).toString("base64url");
  const params = new URLSearchParams({ u });
  const ref = streamHeaders["Referer"] ?? streamHeaders["referer"];
  const ua = streamHeaders["User-Agent"] ?? streamHeaders["user-agent"];
  if (ref) params.set("r", Buffer.from(ref).toString("base64url"));
  if (ua) params.set("a", Buffer.from(ua).toString("base64url"));
  return `${apiBase}/nmproxy?${params.toString()}`;
}

function toSubProxyUrl(originalUrl: string, apiBase: string): string {
  const u = Buffer.from(originalUrl).toString("base64url");
  return `${apiBase}/nmsubproxy?u=${u}`;
}

function resolveSegmentUrl(raw: string, base: URL): string {
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("//")) return base.protocol + raw;
  if (raw.startsWith("/")) return base.origin + raw;
  return new URL(raw, base.href).href;
}

function rewriteM3u8(
  content: string,
  m3u8Url: string,
  apiBase: string,
  referer?: string,
  userAgent?: string,
): string {
  const base = new URL(m3u8Url);
  const hdrs: Record<string, string> = {};
  if (referer) hdrs["Referer"] = referer;
  if (userAgent) hdrs["User-Agent"] = userAgent;

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_, uri: string) =>
          `URI="${toProxyUrl(resolveSegmentUrl(uri, base), hdrs, apiBase)}"`,
        );
      }
      if (trimmed === "" || trimmed.startsWith("#")) return line;
      return toProxyUrl(resolveSegmentUrl(trimmed, base), hdrs, apiBase);
    })
    .join("\n");
}

function getRequestBase(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.get("host");
  // Strip /api suffix if present so we can add it back consistently
  const base = `${proto}://${host}`;
  // Import BASE_PATH at call-time to respect env overrides
  const basePath = process.env["BASE_PATH"] ?? "/api";
  return `${base}${basePath}`;
}

// ─── Stream proxy (/nmproxy) ─────────────────────────────────────────────────

router.get("/nmproxy", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  if (!query.u) { res.status(400).json({ error: "Missing url param" }); return; }

  let targetUrl: string, referer: string | undefined, userAgent: string;
  try {
    targetUrl = Buffer.from(query.u, "base64url").toString("utf-8");
    referer = query.r ? Buffer.from(query.r, "base64url").toString("utf-8") : undefined;
    userAgent = query.a
      ? Buffer.from(query.a, "base64url").toString("utf-8")
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  } catch {
    res.status(400).json({ error: "Invalid param encoding" }); return;
  }

  const fetchHeaders: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
  if (referer) fetchHeaders["Referer"] = referer;
  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

  try {
    const upstream = await fetch(targetUrl, { headers: fetchHeaders, redirect: "follow" });
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const finalUrl = upstream.url ?? targetUrl;
    const isM3u8 =
      contentType.toLowerCase().includes("mpegurl") ||
      finalUrl.split("?")[0].endsWith(".m3u8") ||
      finalUrl.split("?")[0].endsWith(".m3u");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    if (isM3u8 && upstream.ok) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8(text, finalUrl, getRequestBase(req), referer, userAgent);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
      return;
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    for (const h of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) { res.end(); return; }

    const readable = Readable.fromWeb(
      upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    res.on("close", () => { if (!readable.destroyed) readable.destroy(); });
    readable.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "Upstream fetch failed" });
  }
});

// ─── Subtitle proxy (/nmsubproxy) ───────────────────────────────────────────
// OpenSubtitles serves .srt.gz files. This endpoint decompresses them so
// Stremio's player gets a plain UTF-8 SRT it can render directly.

router.get("/nmsubproxy", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  if (!query.u) { res.status(400).json({ error: "Missing url param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = Buffer.from(query.u, "base64url").toString("utf-8");
  } catch {
    res.status(400).json({ error: "Invalid param encoding" }); return;
  }

  if (!isAllowedSubtitleUrl(targetUrl)) {
    res.status(403).json({ error: "Host not allowed" });
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NetMirror/1.0)",
        Accept: "*/*",
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "Upstream subtitle fetch failed" });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const contentEncoding = upstream.headers.get("content-encoding") ?? "";
    const finalUrl = upstream.url ?? targetUrl;
    const isGzip =
      contentType.includes("gzip") ||
      contentType.includes("x-gzip") ||
      contentEncoding === "gzip" ||
      contentEncoding === "x-gzip" ||
      finalUrl.split("?")[0].endsWith(".gz");

    const rawBuffer = Buffer.from(await upstream.arrayBuffer());
    const text = isGzip
      ? (await gunzipAsync(rawBuffer)).toString("utf-8")
      : rawBuffer.toString("utf-8");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (text.trimStart().startsWith("WEBVTT")) {
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    } else {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.send(text);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "Subtitle proxy error" });
  }
});

// ─── Admin: cache reload (/nmadmin/reload) ───────────────────────────────────
// Update NETMIRROR_API_BASE / NETMIRROR_STREAM_REFERER / NEWTV_DOMAINS secrets
// then hit this endpoint — no redeploy needed.
// Auth: ?key=<SESSION_SECRET value>

router.get("/nmadmin/reload", (req: Request, res: Response) => {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || req.query["key"] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  clearAllCaches();
  res.json({
    ok: true,
    message: "All caches cleared. Next request will re-resolve source URLs from current env vars.",
    env: {
      NETMIRROR_API_BASE: process.env["NETMIRROR_API_BASE"] ?? "(default: https://net27.cc)",
      NETMIRROR_STREAM_REFERER: process.env["NETMIRROR_STREAM_REFERER"] ?? "(default: https://videodownloader.site/)",
      NEWTV_DOMAINS: process.env["NEWTV_DOMAINS"] ? "(set)" : "(using built-in list)",
    },
  });
});

// ─── Stream fetcher for the main Stremio aggregator ─────────────────────────

/**
 * Fetches NetMirror streams by IMDB ID (used in the IMDB aggregation block).
 * Internally resolves IMDB → TMDB, then queries all platforms.
 * Returns streams with URLs already proxied through /nmproxy.
 */
export async function fetchNetmirrorStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined | null,
  episode: number | undefined | null,
  req: Request,
): Promise<StremioStream[]> {
  const tmdbInfo = await imdbToTmdb(imdbId, type);
  if (!tmdbInfo) return [];
  return fetchNetmirrorTmdbStreams(
    tmdbInfo.tmdbId,
    type,
    tmdbInfo.title,
    season,
    episode,
    req,
  );
}

/**
 * Fetches NetMirror streams by TMDB ID (used in the TMDB aggregation block).
 * Returns streams with URLs already proxied through /nmproxy.
 */
export async function fetchNetmirrorTmdbStreams(
  tmdbId: number,
  type: "movie" | "series",
  title: string,
  season: number | undefined | null,
  episode: number | undefined | null,
  req: Request,
): Promise<StremioStream[]> {
  const apiBase = getRequestBase(req);
  const rawStreams = await getStreams(
    tmdbId,
    type,
    title,
    season ?? null,
    episode ?? null,
  );

  return rawStreams.map((s: StremioStream) => ({
    name: s.name,
    title: s.title,
    url: toProxyUrl(s.url, s.behaviorHints?.headers ?? {}, apiBase),
    behaviorHints: { notWebReady: false },
    ...(s.subtitles && s.subtitles.length > 0
      ? {
          subtitles: s.subtitles.map((sub) => ({
            id: sub.lang,
            url: isAllowedSubtitleUrl(sub.url)
              ? toSubProxyUrl(sub.url, apiBase)
              : sub.url,
            lang: sub.lang,
          })),
        }
      : {}),
  }));
}

export default router;
