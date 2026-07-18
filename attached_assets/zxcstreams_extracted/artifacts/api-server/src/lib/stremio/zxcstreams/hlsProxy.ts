/**
 * ZXCStream HLS reverse-proxy.
 *
 * Fetches HLS playlists and segments with the correct Referer/Origin headers
 * for ZXCStream CDNs and rewrites every URI inside playlists to route back
 * through this endpoint so all downstream requests also carry the headers.
 *
 * Route:  GET /api/zxc/hls/proxy?url=<encoded>&ref=<encoded-referer>
 */

import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

const PUBLIC_HOST = process.env["REPLIT_DEV_DOMAIN"]
  ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
  : null;

function buildProxyUrl(req: Request, targetUrl: string, referer: string): string {
  const base = `${PUBLIC_HOST ?? `${req.protocol}://${req.hostname}`}/api/zxc/hls/proxy`;
  return `${base}?${new URLSearchParams({ url: targetUrl, ref: referer }).toString()}`;
}

function sniffContentType(buf: Buffer, upstreamType: string): string {
  if (buf.length > 0 && buf[0] === 0x47) return "video/mp2t";
  if (buf.length > 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (upstreamType && !upstreamType.startsWith("image/") && upstreamType !== "text/html") {
    return upstreamType;
  }
  return "application/octet-stream";
}

function rewritePlaylist(text: string, target: string, referer: string, req: Request): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        const m = line.match(/URI="([^"]+)"/);
        if (!m) return line;
        const absolute = new URL(m[1], target).toString();
        return line.replace(m[1], buildProxyUrl(req, absolute, referer));
      }

      const absolute = new URL(trimmed, target).toString();
      return buildProxyUrl(req, absolute, referer);
    })
    .join("\n");
}

router.all("/zxc/hls/proxy", async (req: Request, res: Response) => {
  const { url: target, ref: referer } = req.query as Record<string, string | undefined>;

  if (typeof target !== "string" || typeof referer !== "string") {
    res.status(400).json({ error: "missing url or ref query param" });
    return;
  }

  try { new URL(target); } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }

  const method = req.method === "HEAD" ? "HEAD" : "GET";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        Origin: new URL(referer).origin,
        Referer: referer,
        ...(typeof req.headers.range === "string" ? { Range: req.headers.range } : {}),
      },
    });
  } catch (err) {
    res.status(502).json({ error: `upstream fetch failed: ${String(err)}` });
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    res.status(upstream.status).end();
    return;
  }

  const ct = upstream.headers.get("content-type") ?? "";
  const isPlaylist = ct.includes("mpegurl") || target.toLowerCase().includes(".m3u8");

  res.set("Access-Control-Allow-Origin", "*");
  res.set("Accept-Ranges", "bytes");

  if (isPlaylist) {
    const text = await upstream.text();
    if (text.trimStart().startsWith("#EXTM3U")) {
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      res.send(rewritePlaylist(text, target, referer, req));
      return;
    }
    res.set("Content-Type", ct || "application/octet-stream");
    res.send(text);
    return;
  }

  if (method === "HEAD") {
    res.status(upstream.status);
    res.set("Content-Type", ct || "application/octet-stream");
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    res.end();
    return;
  }

  const suspiciousCT = ct.startsWith("image/") || ct === "text/html" || ct === "";
  res.status(upstream.status);
  res.set("Cache-Control", "public, max-age=300");
  const cl2 = upstream.headers.get("content-length");
  const cr2 = upstream.headers.get("content-range");
  if (cl2) res.set("Content-Length", cl2);
  if (cr2) res.set("Content-Range", cr2);

  if (suspiciousCT && upstream.body) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", sniffContentType(buf, ct));
    res.set("Content-Length", String(buf.length));
    res.end(buf);
    return;
  }

  res.set("Content-Type", ct || "application/octet-stream");
  if (upstream.body) {
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
  } else {
    res.end();
  }
});

export default router;
