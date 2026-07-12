import { Router, type Request, type Response } from "express";
import { logger } from "../../lib/logger.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const router = Router();

const VIDLINK_SIGN_SECRET = process.env["SESSION_SECRET"];
if (!VIDLINK_SIGN_SECRET) {
  logger.warn(
    "VidLink: SESSION_SECRET env var is not set. " +
    "Streams will be served by handing CDN URLs directly to the player (pre-proxy fallback) instead of " +
    "routing through the server proxy. This works fine for most deployments. " +
    "Set SESSION_SECRET to a strong random string if you need the server-side proxy (e.g. to shield client IPs from the CDN WAF)."
  );
}

// Signed URLs expire well after the aggregation window (~20s) plus generous
// player buffering/seek time, but are not valid forever — this bounds how long
// a leaked/logged/shared link (e.g. from a browser history or proxy log) stays
// usable as an open-fetch primitive against the upstream CDN.
const VIDLINK_SIGN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function signVidLinkUrl(encoded: string, expires: number): string {
  if (!VIDLINK_SIGN_SECRET) throw new Error("SESSION_SECRET not configured");
  return createHmac("sha256", VIDLINK_SIGN_SECRET).update(`${encoded}.${expires}`).digest("base64url").slice(0, 22);
}

function verifyVidLinkSignature(encoded: string, expires: number, sig: string): boolean {
  if (!VIDLINK_SIGN_SECRET) return false;
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expected = signVidLinkUrl(encoded, expires);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True for a literal IPv4 address in a private/loopback/link-local/reserved range. */
function isDisallowedIpv4(h: string): boolean {
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> deny
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expands a valid IPv6 literal (any legal textual form, including `::`
 * compression and a trailing dotted-quad) into its canonical 16-byte form.
 * Returns null if the string isn't parseable — callers must treat that as deny.
 */
function parseIpv6ToBytes(hRaw: string): number[] | null {
  let h = hRaw.toLowerCase();
  const zoneIdx = h.indexOf("%");
  if (zoneIdx !== -1) h = h.slice(0, zoneIdx); // strip zone id, e.g. fe80::1%eth0

  // Trailing embedded IPv4 dotted-quad (e.g. ::ffff:192.0.2.1) -> convert to two hextets.
  const dottedMatch = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch) {
    const octets = dottedMatch[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex1 = ((octets[0]! << 8) | octets[1]!).toString(16);
    const hex2 = ((octets[2]! << 8) | octets[3]!).toString(16);
    h = `${dottedMatch[1]}${hex1}:${hex2}`;
  }

  const halves = h.split("::");
  if (halves.length > 2) return null; // more than one "::" is invalid

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (!left || !right || left.length + right.length > 7) return null;
    const missing = 8 - left.length - right.length;
    hextets = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const full = parseGroups(halves[0]!);
    if (!full || full.length !== 8) return null;
    hextets = full;
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of hextets) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * True for a literal IPv6 address in a special-use range that must never be
 * proxy-fetched: unspecified, loopback, link-local, unique-local (ULA),
 * multicast, the discard-only prefix, documentation space, 6to4/Teredo
 * transition ranges (both can tunnel to arbitrary/internal IPv4), and any
 * IPv4-mapped/-compatible form (recurses into the embedded IPv4 check).
 * Unparseable input is treated as disallowed (fail closed).
 */
function isDisallowedIpv6(hRaw: string): boolean {
  const b = parseIpv6ToBytes(hRaw);
  if (!b) return true;

  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);

  if (allZero(0, 16)) return true; // :: (unspecified)
  if (allZero(0, 15) && b[15] === 1) return true; // ::1 (loopback)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (ULA)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (allZero(0, 7) && b[7] === 1) return true; // 100::/64 discard-only
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && allZero(2, 4)) return true; // 2001::/32 Teredo — can tunnel anywhere, deny
  if (b[0] === 0x20 && b[1] === 0x02) return isDisallowedIpv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`); // 2002::/16 6to4
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isDisallowedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // ::ffff:a.b.c.d mapped
  if (allZero(0, 12) && !allZero(12, 16)) return isDisallowedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // deprecated ::a.b.c.d compatible
  return false;
}

/** True if the literal IP string (v4 or v6) falls in a disallowed range. */
function isDisallowedIpLiteral(h: string): boolean {
  const kind = isIP(h);
  if (kind === 4) return isDisallowedIpv4(h);
  if (kind === 6) return isDisallowedIpv6(h);
  return true; // not a valid IP literal at all -> treat conservatively as disallowed if used where an IP is expected
}

// ---------------------------------------------------------------------------
// DNS validation result cache
//
// isPrivateOrDisallowedHost is called on every proxy request (HEAD + each GET
// range request the video player issues).  DNS lookups add 100-300 ms per call,
// so caching the result eliminates that overhead on all but the first request
// per hostname.  CDN hostnames are stable — their IPs don't change mid-session.
//
// Allowed results are cached for 10 min (well within any CDN TTL, safe against
// DNS rebinding since we checked at admission time).  Denied results are cached
// for only 1 min so transient failures (DNS blip) recover quickly.
// ---------------------------------------------------------------------------
const DNS_CACHE_ALLOWED_TTL = 10 * 60 * 1000; // 10 minutes
const DNS_CACHE_DENIED_TTL  =      60 * 1000;  //  1 minute

interface DnsCacheEntry { allowed: boolean; expiresAt: number }
const dnsValidationCache = new Map<string, DnsCacheEntry>();

function pruneDnsCache(): void {
  const now = Date.now();
  for (const [key, entry] of dnsValidationCache) {
    if (now > entry.expiresAt) dnsValidationCache.delete(key);
  }
}

/**
 * Rejects localhost / private / link-local / multicast / reserved targets to
 * prevent SSRF via a replayed signed URL. Resolves the hostname via DNS (rather
 * than only checking the literal string) so a public-looking hostname that
 * actually resolves to an internal IP (DNS rebinding / attacker-controlled DNS)
 * is still caught. Returns true (disallowed) on any lookup failure — fail closed.
 *
 * Results are cached per hostname to avoid paying DNS round-trip cost on every
 * range request the video player issues during buffering and seeking.
 */
async function isPrivateOrDisallowedHost(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;

  if (isIP(h)) return isDisallowedIpLiteral(h);

  // Check cache first
  const cached = dnsValidationCache.get(h);
  if (cached && Date.now() < cached.expiresAt) return !cached.allowed;

  let disallowed: boolean;
  try {
    const results = await dnsLookup(h, { all: true, verbatim: true });
    disallowed = results.length === 0 || results.some((r) => isDisallowedIpLiteral(r.address));
  } catch {
    disallowed = true; // DNS failure -> fail closed
  }

  // Opportunistically prune stale entries (map stays tiny for typical use)
  if (dnsValidationCache.size > 500) pruneDnsCache();

  dnsValidationCache.set(h, {
    allowed: !disallowed,
    expiresAt: Date.now() + (disallowed ? DNS_CACHE_DENIED_TTL : DNS_CACHE_ALLOWED_TTL),
  });
  return disallowed;
}

export function encodeProxyUrl(cdnUrl: string): string {
  return Buffer.from(cdnUrl, "utf8").toString("base64url");
}

/** Returns null (rather than throwing) when SESSION_SECRET isn't configured, so
 * callers can simply omit VidLink streams instead of crashing aggregation. */
export function buildVidLinkStreamProxyUrl(serverBase: string, cdnUrl: string, filename: string): string | null {
  if (!VIDLINK_SIGN_SECRET) return null;
  const encoded = encodeProxyUrl(cdnUrl);
  const expires = Date.now() + VIDLINK_SIGN_TTL_MS;
  const sig = signVidLinkUrl(encoded, expires);
  return `${serverBase}/vidlink-stream/${encoded}/${encodeURIComponent(filename)}?sig=${sig}&exp=${expires}`;
}

const VIDLINK_HEADERS = { Referer: "https://vidlink.pro/", Origin: "https://vidlink.pro" };

// Express auto-routes HEAD requests through a GET handler and just discards the
// body it writes — it does NOT skip the handler body. Without an explicit check,
// a player's HEAD probe (common before deciding whether/how to Range-request)
// would still run the full byte-streaming loop below and could take as long as
// downloading the entire movie before ever responding, which looked exactly like
// "downloading the whole file server-side" and caused endless-loading specifically
// on large movie files (small series files finished fast enough to not notice).
// Fix: for HEAD, issue a HEAD upstream (or GET-without-body-read) and return only
// headers immediately, never touching the response body.
router.head("/vidlink-stream/:encodedUrl/:filename", async (req: Request, res: Response): Promise<void> => {
  const { encodedUrl } = req.params as { encodedUrl: string };
  const sig = req.query["sig"] as string | undefined;
  const expires = Number(req.query["exp"]);
  if (!sig || !verifyVidLinkSignature(encodedUrl, expires, sig)) {
    res.status(403).end();
    return;
  }
  let targetUrl: string;
  let parsed: URL;
  try {
    targetUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
    parsed = new URL(targetUrl);
  } catch {
    res.status(400).end();
    return;
  }
  if (parsed.protocol !== "https:" || (await isPrivateOrDisallowedHost(parsed.hostname))) {
    res.status(403).end();
    return;
  }
  try {
    let upstream = await fetch(targetUrl, {
      method: "HEAD",
      headers: VIDLINK_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    // VidLink's CDN doesn't support HEAD (returns 405) — fall back to a 1-byte
    // ranged GET, which every mp4 CDN treats like a normal request but costs
    // ~nothing to transfer, then discard the connection without reading the body.
    if (upstream.status === 405 || upstream.status === 501) {
      upstream = await fetch(targetUrl, {
        method: "GET",
        headers: { ...VIDLINK_HEADERS, Range: "bytes=0-0" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      res.status(502).end();
      return;
    }
    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 405 && upstream.status !== 501) {
      res.status(upstream.status).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
    // For the 1-byte ranged-GET fallback, report the *full* size (from
    // Content-Range's total) rather than the 1-byte Content-Length of that probe.
    const cr = upstream.headers.get("content-range");
    const totalFromRange = cr?.match(/\/(\d+)$/)?.[1];
    const cl = totalFromRange ?? upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    res.status(200).end();
  } catch (err) {
    logger.error({ err, host: parsed.hostname }, "VidLink stream proxy HEAD error");
    if (!res.headersSent) res.status(502).end();
    else res.end();
  }
});

router.get("/vidlink-stream/:encodedUrl/:filename", async (req: Request, res: Response): Promise<void> => {
  const { encodedUrl } = req.params as { encodedUrl: string; filename: string };
  const sig = req.query["sig"] as string | undefined;
  const expires = Number(req.query["exp"]);

  if (!sig || !verifyVidLinkSignature(encodedUrl, expires, sig)) {
    res.status(403).json({ error: "Invalid, missing, or expired signature" });
    return;
  }

  let targetUrl: string;
  let parsed: URL;
  try {
    targetUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
    parsed = new URL(targetUrl); // throws on malformed input
  } catch {
    res.status(400).json({ error: "Invalid proxy URL" });
    return;
  }
  if (parsed.protocol !== "https:" || (await isPrivateOrDisallowedHost(parsed.hostname))) {
    logger.warn({ host: parsed.hostname }, "VidLink stream proxy: disallowed target");
    res.status(403).json({ error: "Target not allowed" });
    return;
  }

  const fetchHeaders: Record<string, string> = { ...VIDLINK_HEADERS };
  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader as string;

  // Full VidLink mp4s can be multiple GB — a fixed whole-request timeout would
  // abort long-running playback well before it finishes. Instead we use an
  // *idle* timeout: only abort if no bytes arrive for 20s (dead connection),
  // never based on total elapsed time. connectTimeout guards a hung initial
  // connect/headers phase separately.
  const controller = new AbortController();
  const connectTimeout = setTimeout(() => controller.abort(), 20_000);
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 20_000);
  };

  try {
    // redirect: "manual" — the host check above only validated targetUrl itself;
    // silently following a redirect would let a validated public host hand us
    // off to an internal target without re-validation (classic SSRF-via-redirect).
    // VidLink's mp4 CDN never redirects for a direct file fetch, so treat any
    // redirect response as untrusted and reject it outright rather than chase it.
    const upstream = await fetch(targetUrl, { headers: fetchHeaders, signal: controller.signal, redirect: "manual" });
    clearTimeout(connectTimeout);

    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      logger.warn({ status: upstream.status, host: parsed.hostname }, "VidLink stream proxy: refusing to follow redirect");
      res.status(502).json({ error: "Upstream redirect not allowed" });
      return;
    }

    if (!upstream.ok && upstream.status !== 206) {
      logger.warn({ status: upstream.status, host: parsed.hostname }, "VidLink stream proxy: upstream error");
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.statusText}` });
      return;
    }
    if (!upstream.body) {
      res.status(502).json({ error: "No response body" });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
    const ac = upstream.headers.get("accept-ranges");
    if (ac) res.setHeader("Accept-Ranges", ac);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);

    // Use Node.js pipeline for efficient streaming — avoids the JS-level
    // reader.read() loop overhead and hands backpressure to the kernel.
    // Cancel the upstream body and abort controller when the client disconnects.
    const nodeReadable = Readable.fromWeb(
      upstream.body as import("stream/web").ReadableStream<Uint8Array>,
    );
    req.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
      nodeReadable.destroy();
    });

    // Wrap res.write to reset the idle timer on each flushed chunk — keeps the
    // 20 s idle abort working the same way as the old loop.
    const origWrite = res.write.bind(res);
    (res as unknown as { write: typeof res.write }).write = (...args: Parameters<typeof res.write>) => {
      resetIdleTimer();
      return origWrite(...args);
    };

    await pipeline(nodeReadable, res);
    if (idleTimer) clearTimeout(idleTimer);
  } catch (err) {
    clearTimeout(connectTimeout);
    if (idleTimer) clearTimeout(idleTimer);
    logger.error({ err, host: parsed.hostname }, "VidLink stream proxy error");
    if (!res.headersSent) res.status(502).json({ error: "Proxy error" });
    else res.destroy();
  }
});

router.options("/vidlink-stream/:encodedUrl/:filename", (_req, res) => {
  res
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "*")
    .status(204)
    .end();
});

export default router;
