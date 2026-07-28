/**
 * VidLink playback relay.
 *
 * VidLink's signed CDN URLs contain the Origin/Referer that the CDN expects.
 * Passing those URLs directly to a Stremio device is unreliable because many
 * players do not apply proxyHeaders to MP4 requests.  This relay keeps the
 * signed URL and its headers server-side, forwards byte ranges for seeking,
 * and re-extracts a fresh URL once when a short-lived signature expires.
 */

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Router, type Request, type Response as ExpressResponse } from "express";
import { BASE_PATH } from "../../lib/base-path.js";
import { logger } from "../../lib/logger.js";
import { getVidlinkStreams } from "./vidlink.js";

const router = Router();

const RELAY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RELAY_ENTRIES = 2_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface VidlinkRelayContext {
  tmdbId: string;
  type: string;
  season: number;
  episode: number;
  quality?: string;
}

interface RelayEntry {
  url: string;
  headers: Record<string, string>;
  context: VidlinkRelayContext;
  createdAt: number;
  expiresAt: number;
  refreshedAt: number;
}

const relays = new Map<string, RelayEntry>();
const freshRelays = new Map<string, { context: VidlinkRelayContext; expiresAt: number }>();

function cleanupRelays(): void {
  const now = Date.now();
  for (const [token, entry] of relays) {
    if (entry.expiresAt <= now) relays.delete(token);
  }
  while (relays.size > MAX_RELAY_ENTRIES) {
    const oldest = relays.keys().next().value;
    if (!oldest) break;
    relays.delete(oldest);
  }
  for (const [token, entry] of freshRelays) {
    if (entry.expiresAt <= now) freshRelays.delete(token);
  }
  while (freshRelays.size > MAX_RELAY_ENTRIES) {
    const oldest = freshRelays.keys().next().value;
    if (!oldest) break;
    freshRelays.delete(oldest);
  }
}

function assertHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("VidLink relay only accepts HTTPS sources");
  return url.href;
}

export function registerVidlinkRelay(
  url: string,
  headers: Record<string, string>,
  context: VidlinkRelayContext,
): string {
  const token = randomBytes(18).toString("base64url");
  const now = Date.now();
  relays.set(token, {
    url: assertHttpsUrl(url),
    headers: { ...headers },
    context,
    createdAt: now,
    expiresAt: now + RELAY_TTL_MS,
    refreshedAt: 0,
  });
  cleanupRelays();
  return token;
}

/**
 * Register a play-time resolver rather than a CDN URL.  This is the preferred
 * path for VidLink because its CDN blocks cloud IPs; the viewer must follow
 * the redirect from their own device.
 */
export function registerVidlinkFreshRelay(context: VidlinkRelayContext): string {
  const token = randomBytes(18).toString("base64url");
  freshRelays.set(token, { context, expiresAt: Date.now() + RELAY_TTL_MS });
  cleanupRelays();
  return token;
}

function getRelay(token: string): RelayEntry | null {
  cleanupRelays();
  const entry = relays.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) relays.delete(token);
    return null;
  }
  return entry;
}

function upstreamHeaders(entry: RelayEntry, req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-encoding": "identity",
  };
  const referer = entry.headers["referer"] || entry.headers["Referer"];
  const origin = entry.headers["origin"] || entry.headers["Origin"];
  if (referer) headers.referer = referer;
  if (origin) headers.origin = origin;

  const range = req.headers.range;
  if (typeof range === "string") headers.range = range;
  const ifRange = req.headers["if-range"];
  if (typeof ifRange === "string") headers["if-range"] = ifRange;
  return headers;
}

async function fetchPreservingHeaders(
  entry: RelayEntry,
  req: Request,
  url: string,
): Promise<globalThis.Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const upstream = await fetch(current, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders(entry, req),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream;
    const location = upstream.headers.get("location");
    if (!location) return upstream;
    current = new URL(location, current).href;
    await upstream.body?.cancel().catch(() => {});
  }
  throw new Error("VidLink relay followed too many redirects");
}

function publicRelayBase(req: Request): string {
  const publicUrl = process.env["PUBLIC_URL"];
  if (publicUrl) return `${publicUrl.replace(/\/$/, "")}${BASE_PATH}`;
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}${BASE_PATH}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers["host"] as string | undefined) ??
    "localhost";
  return `${proto}://${host}${BASE_PATH}`;
}

function relayUrl(req: Request, target: string, headers: Record<string, string>, context: VidlinkRelayContext): string {
  const token = registerVidlinkRelay(target, headers, context);
  return `${publicRelayBase(req)}/vidlink/proxy/${token}`;
}

function getFreshRelay(token: string): VidlinkRelayContext | null {
  cleanupRelays();
  const entry = freshRelays.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) freshRelays.delete(token);
    return null;
  }
  return entry.context;
}

function signedDeviceUrl(stream: Record<string, unknown>): string | null {
  if (typeof stream.url !== "string") return null;
  try {
    const target = new URL(stream.url);
    // normalizeVidlinkMediaUrl() already resolves VidLink's `host` parameter
    // to the actual CDN host and carries over only the signed query values.
    // Do not append the browser-only `headers` JSON here: that parameter is
    // for the worker front door and can make the direct CDN reject the URL.
    return target.href;
  } catch {
    return null;
  }
}

function isPlaylist(url: string, contentType: string): boolean {
  return contentType.toLowerCase().includes("mpegurl") || /\.m3u8(?:$|[?#])/i.test(url);
}

function rewritePlaylist(
  text: string,
  effectiveUrl: string,
  entry: RelayEntry,
  req: Request,
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const uriAttr = line.match(/URI="([^"]+)"/);
      if (uriAttr) {
        const absolute = new URL(uriAttr[1]!, effectiveUrl).href;
        return line.replace(uriAttr[1]!, relayUrl(req, absolute, entry.headers, entry.context));
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absolute = new URL(trimmed, effectiveUrl).href;
      return relayUrl(req, absolute, entry.headers, entry.context);
    })
    .join("\n");
}

function copyMediaHeaders(upstream: globalThis.Response, res: ExpressResponse): void {
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function shouldRefresh(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410 ||
    status === 429 || status >= 500;
}

async function refreshRelay(token: string, entry: RelayEntry): Promise<boolean> {
  // Prevent a burst of range requests from launching several Playwright
  // extractions at once when the CDN starts rejecting an expired URL.
  if (Date.now() - entry.refreshedAt < 15_000) return false;
  entry.refreshedAt = Date.now();

  try {
    const streams = await getVidlinkStreams(
      entry.context.tmdbId,
      entry.context.type,
      entry.context.season,
      entry.context.episode,
    );
    const quality = entry.context.quality?.toLowerCase();
    const selected = streams.find((stream) => {
      if (!quality) return true;
      return String(stream.title ?? "").toLowerCase().includes(quality);
    }) ?? streams[0];
    if (!selected || typeof selected.url !== "string") return false;

    entry.url = assertHttpsUrl(selected.url);
    const hints = selected.behaviorHints as { proxyHeaders?: { request?: Record<string, string> } } | undefined;
    entry.headers = { ...(hints?.proxyHeaders?.request ?? {}) };
    entry.expiresAt = Date.now() + RELAY_TTL_MS;
    logger.info({ token, quality: entry.context.quality }, "VidLink relay refreshed signed source");
    return true;
  } catch (err) {
    logger.warn({ err, token }, "VidLink relay refresh failed");
    return false;
  }
}

router.options("/vidlink/proxy/:token", (_req: Request, res: ExpressResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.status(204).end();
});

router.options("/vidlink/fresh/:token", (_req: Request, res: ExpressResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.status(204).end();
});

router.all("/vidlink/fresh/:token", async (req: Request, res: ExpressResponse): Promise<void> => {
  const tokenParam = req.params.token;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const context = typeof token === "string" ? getFreshRelay(token) : null;
  if (!context) {
    res.status(404).send("VidLink fresh link expired");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).setHeader("Allow", "GET, HEAD, OPTIONS").end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Location");

  try {
    const streams = await getVidlinkStreams(
      context.tmdbId,
      context.type,
      context.season,
      context.episode,
    );
    const quality = context.quality?.toLowerCase();
    const selected = streams.find((stream) => {
      if (!quality) return true;
      return String(stream.title ?? "").toLowerCase().includes(quality);
    }) ?? streams[0];
    const target = selected ? signedDeviceUrl(selected) : null;
    if (!target) {
      res.status(502).send("VidLink did not return a playable source");
      return;
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Location", target);
    res.status(302).end();
  } catch (err) {
    logger.warn({ err, token }, "VidLink fresh-link extraction failed");
    res.status(502).send("VidLink source refresh failed");
  }
});

router.all("/vidlink/proxy/:token", async (req: Request, res: ExpressResponse): Promise<void> => {
  const tokenParam = req.params.token;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const entry = typeof token === "string" ? getRelay(token) : null;
  if (!entry) {
    res.status(404).send("VidLink relay expired");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).setHeader("Allow", "GET, HEAD, OPTIONS").end();
    return;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetchPreservingHeaders(entry, req, entry.url);
    if (shouldRefresh(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      if (await refreshRelay(token, entry)) {
        upstream = await fetchPreservingHeaders(entry, req, entry.url);
      }
    }
  } catch (err) {
    logger.warn({ err, token }, "VidLink relay upstream request failed");
    res.status(502).send("VidLink upstream request failed");
    return;
  }

  let contentType = upstream.headers.get("content-type") ?? "";
  let effectiveUrl = upstream.url || entry.url;
  let playlist = isPlaylist(effectiveUrl, contentType);

  // Some CDN mirrors return a 200 HTML challenge rather than an HTTP error.
  // Refresh once and retry before exposing that challenge to the player.
  if (contentType.toLowerCase().includes("text/html")) {
    await upstream.body?.cancel().catch(() => {});
    if (await refreshRelay(token, entry)) {
      try {
        upstream = await fetchPreservingHeaders(entry, req, entry.url);
        contentType = upstream.headers.get("content-type") ?? "";
        effectiveUrl = upstream.url || entry.url;
        playlist = isPlaylist(effectiveUrl, contentType);
      } catch (err) {
        logger.warn({ err, token }, "VidLink relay retry after security page failed");
      }
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    res.status(upstream.status).send("VidLink upstream denied media");
    return;
  }

  if (playlist) {
    const text = await upstream.text();
    if (!text.trimStart().startsWith("#EXTM3U")) {
      res.status(502).send("VidLink returned an invalid playlist");
      return;
    }
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritePlaylist(text, effectiveUrl, entry, req));
    return;
  }

  if (contentType.toLowerCase().includes("text/html")) {
    await upstream.body?.cancel().catch(() => {});
    res.status(502).send("VidLink CDN returned a security page");
    return;
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", contentType || "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  copyMediaHeaders(upstream, res);

  if (req.method === "HEAD" || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    res.end();
    return;
  }

  const readable = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  req.on("close", () => {
    if (!readable.destroyed) readable.destroy();
  });
  readable.on("error", (err) => {
    logger.debug({ err, token }, "VidLink relay stream ended with upstream error");
    if (!res.headersSent) res.status(502);
  });
  readable.pipe(res);
});

export default router;