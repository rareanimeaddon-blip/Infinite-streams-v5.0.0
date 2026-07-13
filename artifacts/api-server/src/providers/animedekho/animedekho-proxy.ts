import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";
import { BASE_PATH } from "../../lib/base-path.js";

const router = Router();

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

// ─── CDN headers ──────────────────────────────────────────────────────────────
// AnimeDekho CDNs (StreamRuby, StreamWish, FileMoon, etc.) require browser-like
// headers to bypass hotlink detection.

const AD_PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36";

const AD_PROXY_EXTRA: Record<string, string> = {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reduce a proxied HLS master playlist to its single highest-bandwidth variant,
 * preserving all #EXT-X-MEDIA (audio/subtitle) renditions.
 * Prevents LG TV WebOS ABR quality-switching which causes video freeze.
 */
function filterToSingleVariantProxy(m3u8: string): string {
  const lines = m3u8.split("\n");
  const mediaLines: string[] = [];
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

  if (variants.length === 0) return m3u8;

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

function segmentContentType(targetUrl: string, cdnType: string | null): string {
  const u = targetUrl.split("?")[0].toLowerCase();
  if (u.endsWith(".ts") || u.includes(".ts?")) return "video/MP2T";
  if (u.endsWith(".aac") || u.includes(".aac?")) return "audio/aac";
  if (u.endsWith(".mp4") || u.includes(".mp4?")) return "video/mp4";
  if (u.endsWith(".m4s") || u.includes(".m4s?")) return "video/iso.segment";
  if (u.endsWith(".vtt") || u.includes(".vtt?")) return "text/vtt";
  if (u.endsWith(".key") || u.includes(".key?")) return "application/octet-stream";

  if (cdnType && cdnType.startsWith("image/")) return "video/MP2T";

  const FAKE_MEDIA_TYPES = [
    "application/javascript", "text/javascript", "text/css",
    "font/woff", "font/woff2", "application/font-woff",
    "application/x-font-woff", "text/plain", "text/html",
  ];
  if (cdnType && FAKE_MEDIA_TYPES.some((t) => cdnType.startsWith(t))) return "video/MP2T";

  return cdnType ?? "video/MP2T";
}

function findTsStart(buf: Buffer): number {
  const SYNC = 0x47;
  const PKT  = 188;
  for (let i = 0; i < Math.min(buf.length - PKT * 4, 4096); i++) {
    if (buf[i] === SYNC && buf[i + PKT] === SYNC &&
        buf[i + PKT * 2] === SYNC && buf[i + PKT * 3] === SYNC) {
      return i;
    }
  }
  return 0;
}

async function serveAdSegment(req: Request, res: Response, targetUrl: string, referer?: string, origin?: string) {
  try {
    const headers: Record<string, string> = {
      "User-Agent": AD_PROXY_UA,
      ...AD_PROXY_EXTRA,
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
    logger.error({ err, targetUrl }, "AD segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

// ─── /adm3u8 — AnimeDekho HLS playlist proxy ─────────────────────────────────
// Fetches the HLS playlist with caller-supplied Referer/Origin headers and
// rewrites all segment/sub-playlist URLs to route through this server's own
// /adseg and /adm3u8 routes — no dependency on AnimeSalt's routes.
router.get("/adm3u8", async (req: Request, res: Response) => {
  const { url, referer: refParam, origin: originParam } =
    req.query as Record<string, string | undefined>;
  if (!url) { res.status(400).json({ error: "Missing url" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid url" }); return;
  }

  const effectiveReferer = refParam ? decodeURIComponent(refParam) : "https://animedekho.app/";
  let effectiveOrigin: string;
  if (originParam) {
    effectiveOrigin = decodeURIComponent(originParam);
  } else {
    try { effectiveOrigin = new URL(effectiveReferer).origin; } catch { effectiveOrigin = effectiveReferer; }
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": AD_PROXY_UA,
        "Referer": effectiveReferer,
        "Origin": effectiveOrigin,
        ...AD_PROXY_EXTRA,
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

    const refEnc = encodeURIComponent(effectiveReferer);
    const orgEnc = encodeURIComponent(effectiveOrigin);

    const proxyUrl = (absUrl: string, isPlaylist: boolean): string => {
      if (isPlaylist) {
        return `${proxyBase}/adm3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`;
      }
      return `${proxyBase}/adseg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;
    };

    let nextLineIsVariant = false;
    const rewritten = text.split("\n").map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
          `URI="${proxyUrl(toAbsUrl(uri), true)}"`);
      }

      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
          `URI="${proxyUrl(toAbsUrl(uri), false)}"`);
      }

      if (trimmed.startsWith("#EXT-X-MAP") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
          `URI="${proxyUrl(toAbsUrl(uri), false)}"`);
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

    const finalM3u8 = rewritten.includes("#EXT-X-STREAM-INF")
      ? filterToSingleVariantProxy(rewritten)
      : rewritten;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(finalM3u8);
  } catch (err) {
    logger.error({ err, targetUrl }, "AnimeDekho M3U8 proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/adm3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── /adseg — AnimeDekho segment proxy ────────────────────────────────────────
router.get("/adseg", async (req: Request, res: Response) => {
  const { u, ref, org } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveAdSegment(req, res, targetUrl, ref ? decodeURIComponent(ref) : undefined, org ? decodeURIComponent(org) : undefined);
});

router.options("/adseg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── /adneoproxy — NeoCDN stable MP4 proxy ────────────────────────────────────
// AnimeDekho's NeoCDN streams are served via a Cloudflare Worker that rotates
// every few minutes. Instead of baking the current worker URL into a cached
// stream object (which quickly goes stale), we store only the myth player URL.
// On every play/seek request we re-fetch the myth page to get the CURRENT live
// worker URL, then proxy the MP4 through it — immune to rotation.
//
// Query params:
//   ?m  = base64url-encoded myth player URL
//   ?t  = URL-encoded quality type (e.g. "480p") — picks best available if omitted

interface NeoProxyCacheEntry {
  workerUrl: string;
  fetchId: string;
  expires: number;
}
const neoProxyCache = new Map<string, NeoProxyCacheEntry>();
const NEO_PROXY_CACHE_TTL = 3 * 60 * 1000; // 3 min — conservative vs observed rotation speed
const NEO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

async function resolveNeoWorkerAndFetchId(
  mythUrl: string,
  force = false,
): Promise<{ workerUrl: string; fetchId: string } | null> {
  const now = Date.now();
  const cached = neoProxyCache.get(mythUrl);
  if (!force && cached && cached.expires > now) {
    return { workerUrl: cached.workerUrl, fetchId: cached.fetchId };
  }
  try {
    const resp = await fetch(mythUrl, {
      headers: {
        Cookie: "toronites_server=vidstream",
        "User-Agent": NEO_UA,
        Referer: "https://animedekho.app/",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    const fetchId = html.match(/myth\/fetch\.php\?id=([^"'\s\\]+)/)?.[1];
    if (!fetchId) return null;

    const rawWorker = html.match(/const\s+worker\s*=\s*["']([^"']+)["']/)?.[1]?.trim() ?? "";
    const workerBase = rawWorker.startsWith("https://") ? rawWorker : "";
    // Fallback: last known-good worker (used only if myth page provides none)
    const workerUrl = workerBase
      ? (workerBase.includes("?") ? workerBase : workerBase + "?url=")
      : "https://jolly-salad-69ad.zenhashi.workers.dev/?url=";

    neoProxyCache.set(mythUrl, { workerUrl, fetchId, expires: now + NEO_PROXY_CACHE_TTL });
    logger.info(
      { workerUrl, fetchId: fetchId.slice(0, 24) + "…", cached: false },
      "adneoproxy: resolved live worker",
    );
    return { workerUrl, fetchId };
  } catch (err) {
    logger.warn({ mythUrl, err }, "adneoproxy: myth page fetch failed");
    return null;
  }
}

router.get("/adneoproxy", async (req: Request, res: Response) => {
  const { m, t } = req.query as Record<string, string | undefined>;
  if (!m) { res.status(400).end(); return; }

  let mythUrl: string;
  try {
    mythUrl = Buffer.from(m, "base64url").toString("utf8");
    new URL(mythUrl); // validate
  } catch {
    res.status(400).end(); return;
  }

  const requestedType = t ? decodeURIComponent(t) : "";

  // Fetch current sources from fetch.php (always fresh — trycloudflare URLs are ephemeral)
  const fetchSources = async (fetchId: string) => {
    const r = await fetch(`https://animedekho.app/aaa/myth/fetch.php?id=${fetchId}`, {
      headers: { Referer: mythUrl, "User-Agent": NEO_UA },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { sources?: Array<{ url: string; size: string; type: string }> };
    return data.sources?.length ? data.sources : null;
  };

  // Proxy a single source URL through the given worker, forwarding range headers.
  // Returns true if the response was 2xx/206 and has been piped; false on error.
  const proxyThrough = async (workerUrl: string, sourceUrl: string): Promise<boolean> => {
    const headers: Record<string, string> = { "User-Agent": NEO_UA };
    const range = req.headers["range"] as string | undefined;
    if (range) headers["Range"] = range;

    const upstream = await fetch(workerUrl + encodeURIComponent(sourceUrl), {
      headers,
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      logger.warn(
        { worker: workerUrl.split("?")[0], status: upstream.status },
        "adneoproxy: worker returned error",
      );
      return false;
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.status(upstream.status);

    if (!upstream.body) { res.end(); return true; }
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
    }
    res.end();
    return true;
  };

  try {
    // Step 1 — resolve current worker + fetchId (cached, 3-min TTL)
    let resolved = await resolveNeoWorkerAndFetchId(mythUrl);
    if (!resolved) { res.status(502).json({ error: "myth page unavailable" }); return; }

    // Step 2 — fetch current source URLs (always live, not cached)
    let sources = await fetchSources(resolved.fetchId);
    if (!sources) { res.status(404).end(); return; }

    const pickSrc = (srcs: typeof sources) =>
      (requestedType && srcs!.find(s => s.type === requestedType)) ?? srcs![srcs!.length - 1]!;

    // Step 3 — proxy through current worker
    let ok = await proxyThrough(resolved.workerUrl, pickSrc(sources).url);

    if (!ok) {
      // Worker failed — bust cache and retry with a freshly-resolved worker
      neoProxyCache.delete(mythUrl);
      logger.info({ mythUrl }, "adneoproxy: worker failed — retrying with fresh worker");
      resolved = await resolveNeoWorkerAndFetchId(mythUrl, true);
      if (!resolved) { if (!res.headersSent) res.status(502).end(); return; }
      sources = await fetchSources(resolved.fetchId);
      if (!sources) { if (!res.headersSent) res.status(404).end(); return; }
      ok = await proxyThrough(resolved.workerUrl, pickSrc(sources).url);
      if (!ok && !res.headersSent) res.status(502).end();
    }
  } catch (err) {
    logger.error({ err, mythUrl }, "adneoproxy: unexpected error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/adneoproxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

export default router;
