import { Router, type Request, type Response } from "express";
import { Readable } from "stream";
import { logger } from "../../lib/logger.js";
import { resolveVidsrcLink } from "../../lib/vidsrc-link-store.js";
import { createVidsrcLink } from "../../lib/vidsrc-link-store.js";
import { BASE_PATH } from "../../lib/base-path.js";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function setCors(res: Response): void {
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

// ─── M3U8 playlist proxy (rewrites all child URLs through this proxy) ─────────

router.get("/vidsrc-proxy/m3u8/:id.m3u8", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const link = resolveVidsrcLink(req.params.id!);
  if (!link) {
    res.status(410).send("Link expired");
    return;
  }
  const { url: targetUrl, referer } = link;

  try {
    const upstream = await fetch(targetUrl, {
      headers: { "User-Agent": UA, Referer: referer },
    });

    if (!upstream.ok) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    const body = await upstream.text();
    const effectiveUrl = upstream.url || targetUrl;
    const lastSlash = effectiveUrl.lastIndexOf("/");
    const base = effectiveUrl.slice(0, lastSlash + 1);
    const origin = new URL(effectiveUrl).origin;
    const proxyBase = getProxyBase(req);

    function resolveAbsolute(href: string): string {
      const t = href.trim();
      if (t.startsWith("http://") || t.startsWith("https://")) return t;
      if (t.startsWith("//")) return "https:" + t;
      if (t.startsWith("/")) return origin + t;
      return base + t;
    }

    function makeProxyUrl(absUrl: string): string {
      const id = createVidsrcLink(absUrl, referer);
      const isPlaylist = absUrl.split("?")[0]?.toLowerCase().endsWith(".m3u8");
      return isPlaylist
        ? `${proxyBase}/vidsrc-proxy/m3u8/${id}.m3u8`
        : `${proxyBase}/vidsrc-proxy/seg/${id}.ts`;
    }

    const rawLines = body.split(/\r?\n/);
    const rewritten: string[] = [];
    let lastTag = "";

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) { rewritten.push(rawLine); continue; }

      if (trimmed.startsWith("#")) {
        lastTag = trimmed;
        const rewrittenTag = rawLine.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          return `URI="${makeProxyUrl(resolveAbsolute(uri))}"`;
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

        rewritten.push(makeProxyUrl(absUrl));
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

// ─── Binary segment proxy ─────────────────────────────────────────────────────

router.get("/vidsrc-proxy/seg/:id.ts", async (req: Request, res: Response): Promise<void> => {
  setCors(res);

  const link = resolveVidsrcLink(req.params.id!);
  if (!link) {
    res.status(410).send("Link expired");
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
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    setCors(res);
    const ct = upstream.headers.get("content-type") ?? "";
    const isMisleading =
      !ct || ct.includes("text/html") || ct.includes("text/plain");
    res.setHeader("Content-Type", isMisleading ? "video/mp2t" : ct);

    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");

    if (!upstream.body) { res.end(); return; }
    res.status(upstream.status);
    const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
    nodeStream.pipe(res);
  } catch (err) {
    logger.error({ err, targetUrl }, "VidSrc proxy: segment error");
    if (!res.headersSent) res.status(502).send("Proxy error");
    else res.end();
  }
});

export default router;
