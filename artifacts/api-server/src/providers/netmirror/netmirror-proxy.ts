import { spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
import {
  FFMPEG_PATH,
  nmBuildFetchHeaders,
  nmBuildProxyUrl,
  nmFetchWithRetry,
  nmIsHlsPlaylist,
  nmRewriteM3u8,
} from "./netmirror.js";
import { logger } from "../../lib/logger.js";

const router = Router();

const NETMIRROR_REFERER = "https://net22.cc/";

// ─── Rate-limit circuit breaker ───────────────────────────────────────────────
// When the NetMirror CDN returns an HTML abuse / rate-limit page we stop hitting
// that CDN host for a cooldown period rather than hammering it further.

const RATELIMIT_COOLDOWN = 3 * 60 * 1000; // 3 minutes
const rateLimitedHosts = new Map<string, number>(); // host → expiry timestamp

function isHostRateLimited(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const expiry = rateLimitedHosts.get(host);
    if (!expiry) return false;
    if (Date.now() < expiry) return true;
    rateLimitedHosts.delete(host);
    return false;
  } catch {
    return false;
  }
}

function markHostRateLimited(url: string): void {
  try {
    const host = new URL(url).hostname;
    rateLimitedHosts.set(host, Date.now() + RATELIMIT_COOLDOWN);
    logger.warn({ host }, "NetMirror CDN: rate-limited — pausing requests for 3 min");
  } catch { /* ignore */ }
}

/** Returns true (and sends a 429) if the upstream response body is an HTML abuse page. */
async function rejectIfAbusePage(upstream: Response, targetUrl: string, res: Response): Promise<boolean> {
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return false;
  // Read a small prefix to detect the abuse page without buffering everything
  const reader = upstream.body?.getReader();
  if (!reader) return false;
  let snippet = "";
  try {
    const { value } = await reader.read();
    if (value) snippet = new TextDecoder().decode(value.slice(0, 2048));
  } finally {
    reader.cancel().catch(() => {});
  }
  const isAbuse =
    snippet.includes("Too Many Requests") ||
    snippet.includes("STOP Abuse") ||
    snippet.includes("Stop Abuse") ||
    snippet.includes("Rate Limit") ||
    snippet.includes("rate limit") ||
    snippet.includes("Cloudflare") && upstream.status === 429;
  if (isAbuse) {
    markHostRateLimited(targetUrl);
    if (!res.headersSent) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(429).send("NetMirror CDN rate-limited — try again in a few minutes");
    }
    return true;
  }
  return false;
}

// ─── Variant playlist cache ───────────────────────────────────────────────────
// Shared across concurrent nm-seg requests so seeks don't hammer the CDN with
// duplicate variant fetches.

const VARIANT_CACHE_TTL = 90_000; // 90 seconds — reduces CDN variant re-fetches by ~4x vs 20 s
const variantCache = new Map<string, { text: string; fetchedAt: number }>();

async function fetchVariantCached(variantUrl: string, referer: string): Promise<string> {
  const cached = variantCache.get(variantUrl);
  if (cached && Date.now() - cached.fetchedAt < VARIANT_CACHE_TTL) {
    return cached.text;
  }
  const headers = nmBuildFetchHeaders(variantUrl, referer);
  const resp = await nmFetchWithRetry(
    variantUrl,
    { headers, signal: AbortSignal.timeout(10000) },
    2
  );
  if (!resp.ok) throw new Error(`Variant fetch failed: ${resp.status}`);
  const text = await resp.text();
  variantCache.set(variantUrl, { text, fetchedAt: Date.now() });
  // Evict stale entries to avoid unbounded growth
  if (variantCache.size > 100) {
    const cutoff = Date.now() - VARIANT_CACHE_TTL * 3;
    for (const [k, v] of variantCache) {
      if (v.fetchedAt < cutoff) variantCache.delete(k);
    }
  }
  return text;
}

// ─── Shared proxy handler ─────────────────────────────────────────────────────

async function handleNmProxy(req: Request, res: Response): Promise<void> {
  const targetUrl = req.query["url"] as string;
  const referer = (req.query["referer"] as string) || NETMIRROR_REFERER;

  if (!targetUrl) {
    res.status(400).send("Missing url");
    return;
  }

  const urlForTypeDetect = targetUrl.toLowerCase().split("?")[0] ?? "";

  // NOTE: do NOT rewrite the referer's domain here — NetMirror's CDN issues a
  // dynamic mirror domain (e.g. net52.cc) per player.php call and validates
  // Referer/Origin against that exact domain. Forcing it back to net22.cc
  // causes the CDN to 404.
  const safeReferer = referer || NETMIRROR_REFERER;

  const fetchHeaders = nmBuildFetchHeaders(targetUrl, safeReferer);

  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

  try {
    const upstream = await nmFetchWithRetry(
      targetUrl,
      { headers: fetchHeaders, signal: AbortSignal.timeout(30000) },
      3
    );

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
      return;
    }

    const upstreamContentType = upstream.headers.get("content-type") || "";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    // ── HLS playlist ──────────────────────────────────────────────────────────
    if (nmIsHlsPlaylist(targetUrl, upstreamContentType)) {
      const text = await upstream.text();
      const rewritten = nmRewriteM3u8(text, targetUrl, safeReferer, req);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.send(rewritten);
      return;
    }

    // ── Binary segment ────────────────────────────────────────────────────────
    const isVideoSegment =
      urlForTypeDetect.endsWith(".jpg") ||
      urlForTypeDetect.endsWith(".jpeg") ||
      (urlForTypeDetect.endsWith(".ts") && !nmIsHlsPlaylist(targetUrl, upstreamContentType)) ||
      upstreamContentType.includes("image/jpeg") ||
      upstreamContentType.includes("image/jpg");

    const isAudioSegment =
      urlForTypeDetect.endsWith(".js") ||
      upstreamContentType.includes("text/javascript") ||
      upstreamContentType.includes("application/javascript");

    const isBinarySegment = isVideoSegment || isAudioSegment;

    const outContentType = isBinarySegment
      ? "video/mp2t"
      : upstreamContentType || "application/octet-stream";

    if (!upstream.body) {
      res.status(502).send("No response body");
      return;
    }

    res.setHeader("Cache-Control", isBinarySegment
      ? "public, max-age=3600, immutable"
      : "no-cache, no-store");

    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);

    // ── ffmpeg SPS/PPS fix for video segments ─────────────────────────────────
    if (isVideoSegment && !rangeHeader && FFMPEG_PATH) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Accept-Ranges", "none");

      const chunks: Uint8Array[] = [];
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } catch {
        const raw = Buffer.concat(chunks);
        if (!res.headersSent) res.setHeader("Content-Type", "video/mp2t");
        res.setHeader("Content-Length", raw.length.toString());
        res.end(raw);
        return;
      }

      const rawBuffer = Buffer.concat(chunks);

      await new Promise<void>((resolve) => {
        const ff = spawn(FFMPEG_PATH!, [
          "-loglevel", "error",
          "-fflags", "+genpts+discardcorrupt",
          "-analyzeduration", "0",
          "-probesize", "32",
          "-i", "pipe:0",
          "-c", "copy",
          "-bsf:v", "dump_extra",
          "-f", "mpegts",
          "pipe:1",
        ]);

        let outputStarted = false;
        const outputChunks: Buffer[] = [];

        ff.stdout.on("data", (chunk: Buffer) => {
          outputStarted = true;
          outputChunks.push(chunk);
        });

        ff.on("error", () => {
          if (!res.writableEnded) {
            res.setHeader("Content-Length", rawBuffer.length.toString());
            res.end(rawBuffer);
          }
          resolve();
        });

        ff.on("close", (_code: number | null) => {
          if (outputStarted && outputChunks.length > 0) {
            const outBuf = Buffer.concat(outputChunks);
            res.setHeader("Content-Length", outBuf.length.toString());
            res.end(outBuf);
          } else {
            if (!res.writableEnded) {
              res.setHeader("Content-Length", rawBuffer.length.toString());
              res.end(rawBuffer);
            }
          }
          resolve();
        });

        req.on("close", () => {
          ff.kill("SIGTERM");
          resolve();
        });

        ff.stdin.write(rawBuffer, () => ff.stdin.end());
      });

      return;
    }

    // ── Direct pipe ───────────────────────────────────────────────────────────
    res.setHeader("Content-Type", outContentType);
    const ac = upstream.headers.get("accept-ranges");
    if (ac) res.setHeader("Accept-Ranges", ac);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const flushed = res.write(Buffer.from(value));
      if (!flushed) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "NetMirror proxy error");
    if (!res.headersSent) res.status(502).send("Proxy error");
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/nm-proxy", handleNmProxy);

router.options("/nm-proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// /hls/stream.m3u8 — served with .m3u8 extension so Stremio treats it as HLS
router.get("/hls/stream.m3u8", async (req: Request, res: Response): Promise<void> => {
  const targetUrl = req.query["url"] as string;
  const referer = (req.query["referer"] as string) || NETMIRROR_REFERER;

  if (!targetUrl) {
    res.status(400).send("Missing url");
    return;
  }

  // NOTE: do NOT rewrite the referer's domain here — see comment in
  // handleNmProxy above for why the dynamic mirror domain must be preserved.
  const safeReferer = referer || NETMIRROR_REFERER;
  const fetchHeaders = nmBuildFetchHeaders(targetUrl, safeReferer);
  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

  try {
    const upstream = await nmFetchWithRetry(
      targetUrl,
      { headers: fetchHeaders, signal: AbortSignal.timeout(30000) },
      3
    );

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
      return;
    }

    const upstreamContentType = upstream.headers.get("content-type") || "";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (nmIsHlsPlaylist(targetUrl, upstreamContentType)) {
      const text = await upstream.text();
      const rewritten = nmRewriteM3u8(text, targetUrl, safeReferer, req);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.end(rewritten);
      return;
    }

    if (!upstream.body) {
      res.status(502).send("No response body");
      return;
    }

    const upContentType = upstreamContentType || "application/octet-stream";
    res.setHeader("Content-Type", upContentType);
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const ac = upstream.headers.get("accept-ranges");
    if (ac) res.setHeader("Accept-Ranges", ac);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const flushed = res.write(Buffer.from(value));
      if (!flushed) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "NetMirror HLS stream error");
    if (!res.headersSent) res.status(502).send("Proxy error");
  }
});

router.options("/hls/stream.m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// /nm-seg — re-fetches the variant playlist fresh on every request so tokens
// never expire mid-stream, then proxies the Nth segment from that fresh playlist.
router.get("/nm-seg", async (req: Request, res: Response): Promise<void> => {
  const variantUrl = req.query["v"] as string;
  const referer = (req.query["r"] as string) || NETMIRROR_REFERER;
  const seq = parseInt(req.query["s"] as string ?? "", 10);

  if (!variantUrl || isNaN(seq)) {
    res.status(400).send("Missing parameters");
    return;
  }

  // NOTE: do NOT rewrite the referer's domain here — see comment in
  // handleNmProxy above for why the dynamic mirror domain must be preserved.
  const safeReferer = referer || NETMIRROR_REFERER;

  // Use cached variant playlist — shared across concurrent seeks so the CDN
  // isn't hammered with duplicate fetches. Cache refreshes every 20 s to keep
  // tokens valid without re-fetching on every single segment request.
  let segmentUrl: string;
  try {
    const variantText = await fetchVariantCached(variantUrl, safeReferer);
    // Collect only non-comment, non-empty lines — these are segment URIs
    const segLines = variantText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (seq >= segLines.length || !segLines[seq]) {
      // Cache may be stale — bust it and retry once with a fresh fetch
      variantCache.delete(variantUrl);
      const freshText = await fetchVariantCached(variantUrl, safeReferer);
      const freshLines = freshText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      if (seq >= freshLines.length || !freshLines[seq]) {
        res.status(404).send("Segment index out of range");
        return;
      }
      segmentUrl = new URL(freshLines[seq]!, variantUrl).toString();
    } else {
      // Resolve relative segment URL against the variant playlist base
      segmentUrl = new URL(segLines[seq]!, variantUrl).toString();
    }
  } catch (err) {
    logger.error({ err }, "nm-seg: variant fetch error");
    if (!res.headersSent) res.status(502).send("Variant fetch error");
    return;
  }

  // Proxy the segment with the correct CDN headers
  const segHeaders = nmBuildFetchHeaders(segmentUrl, safeReferer);
  const rangeHeader = req.headers["range"];
  if (rangeHeader) segHeaders["Range"] = rangeHeader;

  try {
    const upstream = await nmFetchWithRetry(
      segmentUrl,
      { headers: segHeaders, signal: AbortSignal.timeout(30000) },
      2
    );

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);

    if (!upstream.body) {
      res.status(502).send("No response body");
      return;
    }

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const flushed = res.write(Buffer.from(value));
      if (!flushed) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } catch (err) {
    logger.error({ err }, "nm-seg: segment fetch error");
    if (!res.headersSent) res.status(502).send("Segment fetch error");
  }
});

router.options("/nm-seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

export default router;
