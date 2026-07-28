// VidSrc HLS proxy — fully self-contained within the vidsrc provider folder.
//
// Security model: only server-minted tokens (from vidsrc-link-store) can be
// proxied. External callers cannot request arbitrary URLs — they can only use
// tokens created by the resolver or by this proxy while rewriting M3U8 content
// from an already-approved upstream response.
//
// Route prefix: /vidsrc/proxy/*  (unique to this provider — no conflicts)

import { Router, type Request, type Response } from "express";
import { Readable } from "stream";
import { logger } from "../../lib/logger.js";
import { BASE_PATH } from "../../lib/base-path.js";
import { createVidsrcLink, resolveVidsrcLink } from "./vidsrc-link-store.js";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── Helpers ───────────────────────────────────────────────────────────────────

function setCors(res: Response): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  res.setHeader(
    "access-control-expose-headers",
    "content-length, content-range, accept-ranges, content-type",
  );
}

// Returns the public base URL including BASE_PATH (/api) for rewriting child HLS URLs.
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

// Pick the correct Referer for each CDN so the upstream server accepts the request.
function refererFor(url: string): string {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith("kucwn.com") || h.endsWith("bxncw.com"))
      return "https://meowtv.xyz/";
    if (h.endsWith("vidrift.in"))
      return "https://embed.vidrift.in/";
  } catch { /* ignore */ }
  return "https://player.cinezo.live/";
}

// Mint a new server-side token for a child URL discovered while rewriting an M3U8.
// The referer is derived from the child URL's hostname.
function mintChildToken(absUrl: string): string {
  return createVidsrcLink(absUrl, refererFor(absUrl));
}

// ── M3U8 playlist proxy ───────────────────────────────────────────────────────
// Fetches the approved upstream M3U8, then rewrites every child URL (segments,
// sub-playlists, keys) into new server-minted token URLs through this proxy.

router.options("/vidsrc/proxy/m3u8/:id.m3u8", (_req, res) => {
  setCors(res as Response);
  res.status(204).end();
});

router.get("/vidsrc/proxy/m3u8/:id.m3u8", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const link = resolveVidsrcLink(req.params["id"]!);
  if (!link) {
    res.status(410).send("Link expired or not found");
    return;
  }
  const { url: targetUrl, referer } = link;

  try {
    const upstream = await fetch(targetUrl, {
      headers: { "User-Agent": UA, Referer: referer },
      redirect: "follow",
    });

    if (!upstream.ok) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    const body = await upstream.text();
    const effectiveUrl = upstream.url || targetUrl;
    const base = new URL(effectiveUrl);
    const proxyBase = getProxyBase(req);

    function resolveAbsolute(href: string): string {
      const t = href.trim();
      if (t.startsWith("https://") || t.startsWith("http://")) return t;
      if (t.startsWith("//")) return "https:" + t;
      if (t.startsWith("/")) return base.origin + t;
      return base.href.slice(0, base.href.lastIndexOf("/") + 1) + t;
    }

    function proxyUrl(absUrl: string): string {
      const token = mintChildToken(absUrl);
      const lowerPath = (absUrl.split("?")[0] ?? "").toLowerCase();
      const isPlaylist = lowerPath.endsWith(".m3u8") || lowerPath.endsWith(".txt");
      return isPlaylist
        ? `${proxyBase}/vidsrc/proxy/m3u8/${token}.m3u8`
        : `${proxyBase}/vidsrc/proxy/seg/${token}.ts`;
    }

    const rawLines = body.split(/\r?\n/);
    const rewritten: string[] = [];
    let lastTag = "";

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) { rewritten.push(rawLine); continue; }

      if (trimmed.startsWith("#")) {
        lastTag = trimmed;
        // Rewrite URI="..." inside HLS tags (EXT-X-KEY, EXT-X-MAP, etc.)
        const rewrittenTag = rawLine.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          return `URI="${proxyUrl(resolveAbsolute(uri))}"`;
        });
        rewritten.push(rewrittenTag);
      } else {
        const absUrl = resolveAbsolute(trimmed);
        const lowerPath = (absUrl.split("?")[0] ?? "").toLowerCase();
        const isPlaylist =
          lastTag.startsWith("#EXT-X-STREAM-INF") ||
          lastTag.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
          lowerPath.endsWith(".m3u8") ||
          lowerPath.endsWith(".txt");
        rewritten.push(proxyUrl(absUrl));
        if (!isPlaylist) lastTag = "";
      }
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(rewritten.join("\n"));
  } catch (err) {
    logger.error({ err, targetUrl }, "VidSrc proxy: m3u8 error");
    if (!res.headersSent) res.status(502).send("Proxy error");
  }
});

// ── Binary segment proxy ──────────────────────────────────────────────────────

router.options("/vidsrc/proxy/seg/:id.ts", (_req, res) => {
  setCors(res as Response);
  res.status(204).end();
});

router.get("/vidsrc/proxy/seg/:id.ts", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const link = resolveVidsrcLink(req.params["id"]!);
  if (!link) {
    res.status(410).send("Link expired or not found");
    return;
  }
  const { url: targetUrl, referer } = link;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Referer: referer,
        ...(req.headers.range ? { Range: req.headers.range as string } : {}),
      },
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "";
    const isMisleading = !ct || ct.includes("text/html") || ct.includes("text/plain");
    res.setHeader("Content-Type", isMisleading ? "video/mp2t" : ct);

    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");

    if (!upstream.body) { res.end(); return; }
    res.status(upstream.status);
    Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
  } catch (err) {
    logger.error({ err, targetUrl }, "VidSrc proxy: segment error");
    if (!res.headersSent) res.status(502).send("Proxy error");
    else res.end();
  }
});

// ── OPTIONS catch-all ─────────────────────────────────────────────────────────
router.options("/vidsrc/proxy/*splat", (_req, res) => {
  setCors(res as Response);
  res.status(204).end();
});

export default router;
