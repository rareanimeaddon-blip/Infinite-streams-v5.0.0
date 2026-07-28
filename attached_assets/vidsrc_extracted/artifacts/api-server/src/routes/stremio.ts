import { Router } from "express";
import type { Request, Response } from "express";
import { resolveMovie, resolveSeries, b64url } from "../lib/resolver";

const router = Router();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-expose-headers":
    "content-length, content-range, accept-ranges, content-type",
};

function setCors(res: Response) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

// ── Manifest ─────────────────────────────────────────────────────────────────

const manifest = {
  id: "sbs.vidsrc.stremio",
  version: "1.0.0",
  name: "VidSrc",
  description:
    "HLS streams for movies and TV shows sourced from vidsrc.sbs' embed network (VidAPI, VidRift, MeowTV). Plays natively inside Stremio.",
  logo: "https://vidsrc.sbs/wp-content/uploads/2026/04/cropped-vidsrc-icon-512-192x192.png",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: { adult: false, p2p: false, configurable: false },
};

router.options("/public/manifest.json", (_req, res) => {
  setCors(res);
  res.status(204).end();
});

router.get("/public/manifest.json", (_req, res) => {
  setCors(res);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=3600");
  res.json(manifest);
});

// ── Streams ───────────────────────────────────────────────────────────────────

router.options("/public/stream/:type/*splat", (_req, res) => {
  setCors(res);
  res.status(204).end();
});

router.get("/public/stream/:type/*splat", async (req: Request, res: Response) => {
  setCors(res);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=300");

  const type = req.params.type;
  // In Express 5, wildcard params may be arrays — extract from path instead
  const afterType = req.path.replace(/^\/public\/stream\/[^/]+\//, "");
  const id = afterType.replace(/\.json$/i, "");

  // Build absolute base URL so proxy links work in Stremio's built-in player
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  try {
    let streams: Awaited<ReturnType<typeof resolveMovie>> = [];
    if (type === "movie" && /^tt\d+$/.test(id)) {
      streams = await resolveMovie(id, baseUrl);
    } else if (type === "series") {
      const m = id.match(/^(tt\d+):(\d+):(\d+)$/);
      if (m) streams = await resolveSeries(m[1], Number(m[2]), Number(m[3]), baseUrl);
    }
    res.json({ streams });
  } catch (err) {
    req.log.error(err, "stream resolve failed");
    res.json({ streams: [], err: (err as Error).message });
  }
});

// ── HLS Proxy ─────────────────────────────────────────────────────────────────
// Routes all sources through this proxy so Stremio's built-in browser player
// gets clean CORS headers and upstream Referer requirements are satisfied
// server-side. Rewritten HLS playlists use absolute URLs so Stremio can
// fetch nested segments/playlists without knowing the origin.

function decode(segment: string): string | null {
  try {
    const clean = segment.replace(/\.(mp4|m3u8|ts|vtt|srt|key)$/i, "");
    const b64 = clean.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    return Buffer.from(pad, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function refererFor(url: string): { referer: string; origin: string } {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith("kucwn.com") || h.endsWith("bxncw.com"))
      return { referer: "https://meowtv.xyz/", origin: "https://meowtv.xyz" };
    if (h.endsWith("vidrift.in"))
      return { referer: "https://embed.vidrift.in/", origin: "https://embed.vidrift.in" };
  } catch { /* ignore */ }
  return { referer: "https://player.cinezo.live/", origin: "https://player.cinezo.live" };
}

async function handleProxy(req: Request, res: Response) {
  setCors(res);
  // In Express 5, wildcard params may be arrays — extract from path instead
  const raw = req.path.replace(/^\/public\/proxy\//, "");
  const target = decode(raw);

  // Only proxy HTTPS URLs — block non-https or malformed targets
  if (!target || !isHttps(target)) {
    res.status(400).send("Bad target");
    return;
  }

  const proxyBase = `${req.protocol}://${req.get("host")}`;
  const { referer, origin } = refererFor(target);
  const headers: Record<string, string> = {
    referer,
    origin,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    accept: "*/*",
  };
  const range = req.headers["range"];
  if (range) headers["range"] = range;

  let upstream: globalThis.Response;
  try {
    // follow redirects (flikhub.net often 302s to the real CDN URL)
    upstream = await fetch(target, { method: req.method, headers, redirect: "follow" });
  } catch (err) {
    res.status(502).send(`Upstream fetch failed: ${(err as Error).message}`);
    return;
  }

  const ct = upstream.headers.get("content-type") || "";
  const finalUrl = upstream.url || target;

  if (/mpegurl|m3u8/i.test(ct) || /\.m3u8($|\?)/i.test(finalUrl)) {
    const text = await upstream.text();
    const base = new URL(finalUrl);
    const rewritten = text
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) {
          // Rewrite URI="..." inside HLS tags (EXT-X-KEY, EXT-X-MAP, etc.)
          return line.replace(/URI="([^"]+)"/g, (_m, u) => {
            const abs = new URL(u, base).toString();
            return `URI="${proxyBase}/api/public/proxy/${b64url(abs)}"`;
          });
        }
        const abs = new URL(t, base).toString();
        return `${proxyBase}/api/public/proxy/${b64url(abs)}`;
      })
      .join("\n");
    res.setHeader("content-type", "application/vnd.apple.mpegurl");
    res.setHeader("cache-control", "no-store");
    res.status(upstream.status).send(rewritten);
    return;
  }

  // Binary passthrough (TS segments, MP4, keys, etc.)
  for (const k of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
    "cache-control",
  ]) {
    const v = upstream.headers.get(k);
    if (v) res.setHeader(k, v);
  }
  if (!res.getHeader("content-type")) res.setHeader("content-type", "video/mp4");
  res.status(upstream.status);
  if (upstream.body) {
    const { Readable } = await import("stream");
    Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
  } else {
    res.end();
  }
}

router.options("/public/proxy/*splat", (_req, res) => {
  setCors(res);
  res.status(204).end();
});
router.head("/public/proxy/*splat", handleProxy);
router.get("/public/proxy/*splat", handleProxy);

export default router;
