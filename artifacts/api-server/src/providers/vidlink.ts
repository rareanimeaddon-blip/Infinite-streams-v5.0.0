/**
 * VidLink provider — fully self-contained.
 *
 * Exports:
 *   getVidlinkStreams()  — called by stremio.ts to fetch streams
 *   vidlinkRouter       — Express sub-router mounted at /api in routes/index.ts
 *                         Handles /vidlink/hls.m3u8 and /vidlink/seg/:sid/:idx
 *
 * All state (sessions, caches) lives in module-local Maps and is completely
 * isolated from every other provider. No shared state with other providers.
 *
 * Route prefix /vidlink/* is unique — no collision risk with any existing route.
 */

import { pipeline, Readable } from "stream";
import { Router } from "express";
import type { IRouter, Request, Response } from "express";
import { logger } from "../lib/logger.js";

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const ENC_DEC_API  = "https://enc-dec.app/api";
const VIDLINK_API  = "https://vidlink.pro/api/b";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const VIDLINK_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  "Connection": "keep-alive",
  "Referer":    "https://vidlink.pro/",
  "Origin":     "https://vidlink.pro",
};

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent":      BROWSER_UA,
  "Accept":          "application/json,*/*",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection":      "keep-alive",
};

const QUALITY_ORDER: Record<string, number> = {
  "4K": 5, "1440p": 4, "1080p": 3, "720p": 2,
  "480p": 1, "360p": 0, "240p": -1, "Auto": -2, "Unknown": -3,
};

// ════════════════════════════════════════════════════════════════════════════
// SESSION STORE  (isolated — module-local Map)
// ════════════════════════════════════════════════════════════════════════════

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface SegSession {
  segs:      string[];
  headers:   Record<string, string>;
  createdAt: number;
}

const segSessions = new Map<string, SegSession>();

function makeSessionId(): string {
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
}

function createSession(segs: string[], headers: Record<string, string>): string {
  const now = Date.now();
  for (const [sid, s] of segSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) segSessions.delete(sid);
  }
  const sid = makeSessionId();
  segSessions.set(sid, { segs, headers, createdAt: now });
  return sid;
}

// ════════════════════════════════════════════════════════════════════════════
// SEGMENT PRE-FETCH CACHE  (isolated)
// ════════════════════════════════════════════════════════════════════════════

const PRE_FETCH_WINDOW = 48;
const MAX_SEG_CACHE    = 128;
const SERVED_TTL_MS    = 30_000;

const PREFETCH_HEADERS: Record<string, string> = {
  "User-Agent":      BROWSER_UA,
  "Accept":          "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection":      "keep-alive",
};

interface CacheEntry {
  promise:  Promise<Buffer | null>;
  buf?:     Buffer | null;
  servedAt?: number;
}

const segCache = new Map<string, CacheEntry>();

function evictSegCache(): void {
  const now = Date.now();
  for (const [url, entry] of segCache) {
    if (entry.servedAt && now - entry.servedAt > SERVED_TTL_MS) segCache.delete(url);
  }
  if (segCache.size <= MAX_SEG_CACHE) return;
  const served = [...segCache.entries()].filter(([, e]) => e.servedAt).sort((a, b) => a[1].servedAt! - b[1].servedAt!);
  for (const [url] of served) {
    if (segCache.size <= MAX_SEG_CACHE) break;
    segCache.delete(url);
  }
  for (const [url] of segCache) {
    if (segCache.size <= MAX_SEG_CACHE) break;
    segCache.delete(url);
  }
}

function prefetchSeg(cdnUrl: string, extraHeaders: Record<string, string> = {}): void {
  if (segCache.get(cdnUrl)) return;
  const headers = { ...PREFETCH_HEADERS, ...extraHeaders };
  const entry: CacheEntry = { promise: Promise.resolve(null) };
  entry.promise = fetch(cdnUrl, { headers, keepalive: true })
    .then((r) => (r.ok ? r.arrayBuffer().then((ab) => Buffer.from(ab)) : null))
    .catch((): null => null)
    .then((buf) => {
      entry.buf = buf;
      if (buf === null) segCache.delete(cdnUrl);
      return buf;
    });
  segCache.set(cdnUrl, entry);
  evictSegCache();
}

function prefetchSessionSegs(sid: string, currentIdx: number): void {
  const session = segSessions.get(sid);
  if (!session) return;
  for (let i = 1; i <= PRE_FETCH_WINDOW; i++) {
    const nextIdx = currentIdx + i;
    if (nextIdx >= session.segs.length) break;
    prefetchSeg(session.segs[nextIdx]!, session.headers);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// M3U8 CACHE + IN-FLIGHT DEDUPLICATION  (isolated)
// ════════════════════════════════════════════════════════════════════════════

interface M3U8CacheEntry {
  buf:          Buffer;
  sid:          string;
  cdnSegs:      string[];
  extraHeaders: Record<string, string>;
  cachedAt:     number;
}

const M3U8_CACHE_TTL  = 10 * 60 * 1000;
const m3u8Cache       = new Map<string, M3U8CacheEntry>();
const m3u8InFlight    = new Map<string, Promise<M3U8CacheEntry>>();

function m3u8CacheKey(targetUrl: string, hParam: string | undefined): string {
  return `vl|${targetUrl}|${hParam ?? ""}`;
}

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface VLStream {
  name:          string;
  title:         string;
  url:           string;
  quality:       string;
  streamHeaders: Record<string, string>;
  subtitles?:    SubtitleEntry[];
}

interface SubtitleEntry {
  url:      string;
  language: string;
  name:     string;
}

interface MediaInfo {
  title:     string;
  year:      string | undefined;
  mediaType: string;
  season?:   number | null;
  episode?:  number | null;
}

interface PlaylistRef {
  _isPlaylist: true;
  url:         string;
  mediaInfo:   MediaInfo;
  subtitles:   SubtitleEntry[];
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function getPublicBase(req: Request): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]!.trim()}`;
  const host  = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}`;
}

/** Proxy URL uses /vidlink/ prefix — isolated from all other provider routes. */
function buildM3U8ProxyUrl(base: string, targetUrl: string, headers: Record<string, string>): string {
  const h = Buffer.from(JSON.stringify(headers)).toString("base64url");
  return `${base}/api/vidlink/hls.m3u8?url=${encodeURIComponent(targetUrl)}&h=${h}`;
}

function extractUrlHeaders(rawUrl: string): Record<string, string> {
  try {
    const u = new URL(rawUrl);
    const hParam = u.searchParams.get("headers");
    if (hParam) return JSON.parse(hParam) as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

async function makeRequest(url: string, options: RequestInit = {}): Promise<globalThis.Response> {
  const headers = { ...FETCH_HEADERS, ...(options.headers as Record<string, string> || {}) };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  return response;
}

// ════════════════════════════════════════════════════════════════════════════
// TMDB / ENCRYPTION
// ════════════════════════════════════════════════════════════════════════════

async function imdbToTmdb(imdbId: string, type: string): Promise<{ tmdbId: string; title: string; year: string | undefined }> {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const response = await makeRequest(url);
  const data = (await response.json() as unknown) as Record<string, unknown[]>;
  const result = (type === "movie" ? data["movie_results"] : data["tv_results"])?.[0] as Record<string, unknown> | undefined;
  if (!result) throw new Error(`TMDB lookup failed for ${imdbId} (type: ${type})`);
  const tmdbId = String(result["id"]);
  const title  = type === "movie"
    ? String(result["title"] || result["original_title"] || "Unknown")
    : String(result["name"]  || result["original_name"]  || "Unknown");
  const rawDate = type === "movie"
    ? String(result["release_date"]   || "")
    : String(result["first_air_date"] || "");
  const year = rawDate ? rawDate.substring(0, 4) : undefined;
  return { tmdbId, title, year };
}

async function encryptTmdbId(tmdbId: string): Promise<string> {
  const response = await makeRequest(`${ENC_DEC_API}/enc-vidlink?text=${tmdbId}`);
  const data = (await response.json() as unknown) as { result?: string };
  if (!data.result) throw new Error("Invalid response from enc-dec API");
  return data.result;
}

// ════════════════════════════════════════════════════════════════════════════
// QUALITY HELPERS
// ════════════════════════════════════════════════════════════════════════════

function getQualityFromResolution(resolution: string): string {
  const height = Number(resolution.split("x")[1]);
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720)  return "720p";
  if (height >= 480)  return "480p";
  if (height >= 360)  return "360p";
  return "240p";
}

function extractQuality(obj: Record<string, unknown>): string {
  for (const field of ["quality", "resolution", "label", "name"]) {
    const v = String(obj[field] ?? "").toLowerCase();
    if (!v) continue;
    if (v.includes("2160") || v.includes("4k"))  return "4K";
    if (v.includes("1440") || v.includes("2k"))  return "1440p";
    if (v.includes("1080") || v.includes("fhd")) return "1080p";
    if (v.includes("720")  || v.includes("hd"))  return "720p";
    if (v.includes("480")  || v.includes("sd"))  return "480p";
    if (v.includes("360"))  return "360p";
    if (v.includes("240"))  return "240p";
    const m = v.match(/(\d{3,4})[pP]?/);
    if (m) {
      const n = parseInt(m[1]!);
      if (n >= 2160) return "4K";
      if (n >= 1440) return "1440p";
      if (n >= 1080) return "1080p";
      if (n >= 720)  return "720p";
      if (n >= 480)  return "480p";
      if (n >= 360)  return "360p";
      return "240p";
    }
  }
  return "Unknown";
}

// ════════════════════════════════════════════════════════════════════════════
// M3U8 HELPERS
// ════════════════════════════════════════════════════════════════════════════

function parseM3U8Variants(content: string, baseUrl: string): Array<{ resolution: string; url: string }> {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const result: Array<{ resolution: string; url: string }> = [];
  let resolution = "";
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const m = line.match(/RESOLUTION=(\d+x\d+)/);
      resolution = m ? m[1]! : "";
    } else if (!line.startsWith("#") && resolution) {
      const url = line.startsWith("http") ? line : new URL(line, baseUrl).toString();
      result.push({ resolution, url });
      resolution = "";
    }
  }
  return result;
}

function rewriteM3U8WithSession(
  content: string,
  baseUrl: string,
  proxyBase: string,
  cdnHeaders: Record<string, string>,
): { rewritten: string; sid: string; cdnSegs: string[] } {
  const lines = content.split("\n");
  const cdnSegs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const absolute = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).toString();
    if (!absolute.includes(".m3u8")) cdnSegs.push(absolute);
  }

  const sid = createSession(cdnSegs, cdnHeaders);

  let segIdx = 0;
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-ALLOW-CACHE")) return "";
    if (!trimmed || trimmed.startsWith("#")) return line;
    const absolute = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).toString();
    if (absolute.includes(".m3u8")) {
      return buildM3U8ProxyUrl(proxyBase, absolute, cdnHeaders);
    }
    return `${proxyBase}/api/vidlink/seg/${sid}/${segIdx++}`;
  }).join("\n");

  return { rewritten, sid, cdnSegs };
}

async function fetchM3U8Streams(
  playlistUrl: string,
  mediaInfo: MediaInfo,
  subtitles: SubtitleEntry[],
  proxyBase: string,
): Promise<VLStream[]> {
  const cdnHeaders = { ...VIDLINK_HEADERS, ...extractUrlHeaders(playlistUrl) };
  try {
    const response = await makeRequest(playlistUrl, { headers: cdnHeaders });
    const content  = await (response as globalThis.Response).text();
    const variants = parseM3U8Variants(content, playlistUrl);
    if (variants.length === 0) {
      return [{
        name: "VidLink • Auto", title: buildTitle(mediaInfo),
        url: buildM3U8ProxyUrl(proxyBase, playlistUrl, cdnHeaders),
        quality: "Auto", streamHeaders: {}, subtitles,
      }];
    }
    return variants.map((v) => {
      const quality        = getQualityFromResolution(v.resolution);
      const variantHeaders = { ...cdnHeaders, ...extractUrlHeaders(v.url) };
      return {
        name: `VidLink • ${quality}`, title: buildTitle(mediaInfo),
        url: buildM3U8ProxyUrl(proxyBase, v.url, variantHeaders),
        quality, streamHeaders: {}, subtitles,
      };
    });
  } catch {
    return [{
      name: "VidLink • Auto", title: buildTitle(mediaInfo),
      url: buildM3U8ProxyUrl(proxyBase, playlistUrl, cdnHeaders),
      quality: "Auto", streamHeaders: {}, subtitles,
    }];
  }
}

function buildTitle(mediaInfo: MediaInfo): string {
  if (mediaInfo.mediaType === "tv" && mediaInfo.season && mediaInfo.episode) {
    return `${mediaInfo.title} S${String(mediaInfo.season).padStart(2, "0")}E${String(mediaInfo.episode).padStart(2, "0")}`;
  }
  return mediaInfo.year ? `${mediaInfo.title} (${mediaInfo.year})` : mediaInfo.title;
}

function extractSubtitles(data: Record<string, unknown>): SubtitleEntry[] {
  const rawSubs =
    (data["subtitles"] as unknown[]) ||
    ((data["stream"] as Record<string, unknown>)?.["subtitles"] as unknown[]) || [];
  if (!Array.isArray(rawSubs)) return [];
  return rawSubs
    .filter((s): s is Record<string, unknown> =>
      typeof s === "object" && s !== null && typeof (s as Record<string, unknown>)["url"] === "string"
    )
    .map((s) => ({
      url:      String(s["url"]),
      language: String(s["language"] || s["lang"] || s["label"] || "Unknown"),
      name:     String(s["name"] || s["label"] || s["language"] || s["lang"] || "Unknown"),
    }));
}

function processVidlinkResponse(
  data: Record<string, unknown>,
  mediaInfo: MediaInfo,
): Array<VLStream | PlaylistRef> {
  const results: Array<VLStream | PlaylistRef> = [];
  const subtitles = extractSubtitles(data);
  const title     = buildTitle(mediaInfo);
  const streamObj = data["stream"] as Record<string, unknown> | undefined;

  const push = (url: string, quality: string) => {
    results.push({ name: `VidLink • ${quality}`, title, url, quality, streamHeaders: VIDLINK_HEADERS, subtitles });
  };

  if (streamObj?.["qualities"] && typeof streamObj["qualities"] === "object") {
    for (const [key, val] of Object.entries(streamObj["qualities"] as Record<string, Record<string, unknown>>)) {
      if (val?.["url"]) push(String(val["url"]), extractQuality({ quality: key }));
    }
  } else if (streamObj?.["playlist"] && !streamObj?.["qualities"]) {
    results.push({ _isPlaylist: true, url: String(streamObj["playlist"]), mediaInfo, subtitles });
  } else if (data["url"]) {
    push(String(data["url"]), extractQuality(data));
  } else if (Array.isArray(data["streams"])) {
    for (const s of data["streams"] as Record<string, unknown>[]) {
      if (s["url"]) push(String(s["url"]), extractQuality(s));
    }
  } else if (Array.isArray(data["links"])) {
    for (const l of data["links"] as Record<string, unknown>[]) {
      if (l["url"]) push(String(l["url"]), extractQuality(l));
    }
  } else {
    const findUrls = (obj: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && (value.startsWith("http") || value.includes(".m3u8"))) {
          const lk = key.toLowerCase();
          if (value.includes(".srt") || value.includes(".vtt") || lk.includes("subtitle") || lk.includes("caption")) continue;
          push(value, extractQuality({ [key]: value }));
        } else if (typeof value === "object" && value !== null) {
          const lk = key.toLowerCase();
          if (!lk.includes("caption") && !lk.includes("subtitle")) findUrls(value as Record<string, unknown>);
        }
      }
    };
    findUrls(data);
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN STREAM FETCHER — exported for use in stremio.ts
// ════════════════════════════════════════════════════════════════════════════

export async function getVidlinkStreams(
  imdbId: string,
  type: string,
  season: number | undefined,
  episode: number | undefined,
  proxyBase: string,
): Promise<Record<string, unknown>[]> {
  const { tmdbId, title, year } = await imdbToTmdb(imdbId, type);
  const encryptedId = await encryptTmdbId(tmdbId);

  const vidlinkUrl = type === "series" && season && episode
    ? `${VIDLINK_API}/tv/${encryptedId}/${season}/${episode}`
    : `${VIDLINK_API}/movie/${encryptedId}`;

  const response = await makeRequest(vidlinkUrl, { headers: VIDLINK_HEADERS });
  const data      = (await response.json() as unknown) as Record<string, unknown>;

  const mediaInfo: MediaInfo = { title, year, mediaType: type === "series" ? "tv" : "movie", season, episode };
  const raw       = processVidlinkResponse(data, mediaInfo);

  const playlists     = raw.filter((s): s is PlaylistRef => "_isPlaylist" in s);
  const directs       = raw.filter((s): s is VLStream   => !("_isPlaylist" in s));

  const proxiedDirects: VLStream[] = directs.map((s) => {
    const cdnHeaders = { ...s.streamHeaders, ...extractUrlHeaders(s.url) };
    return { ...s, url: buildM3U8ProxyUrl(proxyBase, s.url, cdnHeaders), streamHeaders: {} };
  });

  const parsedPlaylists = await Promise.all(
    playlists.map((p) => fetchM3U8Streams(p.url, p.mediaInfo, p.subtitles, proxyBase)),
  );

  const allStreams: VLStream[] = [...proxiedDirects, ...parsedPlaylists.flat()];
  allStreams.sort((a, b) => (QUALITY_ORDER[b.quality] ?? -3) - (QUALITY_ORDER[a.quality] ?? -3));

  // Return Stremio-compatible stream objects
  return allStreams.map((s) => ({
    name:  s.name,
    title: s.title,
    url:   s.url,
    behaviorHints: { notWebReady: false, bingeGroup: "vidlink" },
    subtitles: s.subtitles?.map((sub) => ({
      url:  sub.url,
      lang: sub.language,
      id:   `${sub.language}-${sub.url}`,
    })),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// CORS
// ════════════════════════════════════════════════════════════════════════════

function setCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin",   "*");
  res.setHeader("Access-Control-Allow-Headers",  "*");
  res.setHeader("Access-Control-Allow-Methods",  "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
}

// ════════════════════════════════════════════════════════════════════════════
// M3U8 PROXY  (fetch + rewrite with session)
// ════════════════════════════════════════════════════════════════════════════

async function doFetchAndRewriteM3U8(
  targetUrl:    string,
  hParam:       string | undefined,
  extraHeaders: Record<string, string>,
  proxyBase:    string,
  cacheKey:     string,
): Promise<M3U8CacheEntry> {
  const fetchHeaders: Record<string, string> = {
    "User-Agent": BROWSER_UA, "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5", "Connection": "keep-alive",
    ...extraHeaders,
  };
  const upstream = await fetch(targetUrl, { headers: fetchHeaders, keepalive: true });
  if (!upstream.ok) throw new Error(`Upstream ${upstream.status}: ${upstream.statusText}`);

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const isM3U8 =
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegurl") ||
    targetUrl.includes(".m3u8");
  if (!isM3U8) throw new Error("Not an M3U8 response");

  const text = await upstream.text();
  const { rewritten, sid, cdnSegs } = rewriteM3U8WithSession(text, targetUrl, proxyBase, extraHeaders);

  const windowEnd = Math.min(PRE_FETCH_WINDOW, cdnSegs.length);
  for (let i = 0; i < windowEnd; i++) prefetchSeg(cdnSegs[i]!, extraHeaders);
  logger.info({ segments: cdnSegs.length, sid, prefetching: windowEnd }, "VidLink: M3U8 rewritten");

  const buf   = Buffer.from(rewritten, "utf-8");
  const entry: M3U8CacheEntry = { buf, sid, cdnSegs, extraHeaders, cachedAt: Date.now() };
  m3u8Cache.set(cacheKey, entry);
  return entry;
}

async function handleM3U8Proxy(req: Request, res: Response): Promise<void> {
  const targetUrl = req.query["url"] as string | undefined;
  const hParam    = req.query["h"]   as string | undefined;
  if (!targetUrl) { res.status(400).send("Missing url param"); return; }

  let extraHeaders: Record<string, string> = {};
  if (hParam) {
    try { extraHeaders = JSON.parse(Buffer.from(hParam, "base64url").toString("utf8")) as Record<string, string>; }
    catch { /* ignore */ }
  }

  const contentType = (req.headers["content-type"] as string | undefined) || "";
  const isM3U8Req =
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegurl") ||
    targetUrl.includes(".m3u8") ||
    !targetUrl.includes(".");

  if (!isM3U8Req) {
    const fetchHeaders: Record<string, string> = {
      "User-Agent": BROWSER_UA, "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5", "Connection": "keep-alive",
      ...extraHeaders,
    };
    try {
      const upstream = await fetch(targetUrl, { headers: fetchHeaders, keepalive: true });
      if (!upstream.ok) { res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`); return; }
      setCors(res);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Cache-Control", "no-store");
      if (!upstream.body) { res.end(); return; }
      const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
      await new Promise<void>((resolve, reject) => {
        pipeline(nodeStream, res, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") reject(err);
          else resolve();
        });
      });
    } catch (err) {
      logger.error({ err, targetUrl }, "VidLink: binary proxy failed");
      if (!res.headersSent) res.status(502).send("Proxy error");
    }
    return;
  }

  const cacheKey  = m3u8CacheKey(targetUrl, hParam);
  const proxyBase = getPublicBase(req);

  const cached = m3u8Cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < M3U8_CACHE_TTL) {
    prefetchSessionSegs(cached.sid, 0);
    setCors(res);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Content-Length", cached.buf.byteLength.toString());
    res.setHeader("Cache-Control", "no-store");
    res.end(cached.buf);
    return;
  }

  let inFlight = m3u8InFlight.get(cacheKey);
  if (!inFlight) {
    inFlight = doFetchAndRewriteM3U8(targetUrl, hParam, extraHeaders, proxyBase, cacheKey);
    m3u8InFlight.set(cacheKey, inFlight);
    inFlight.finally(() => m3u8InFlight.delete(cacheKey));
  }

  try {
    const entry = await inFlight;
    setCors(res);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Content-Length", entry.buf.byteLength.toString());
    res.setHeader("Cache-Control", "no-store");
    res.end(entry.buf);
  } catch (err) {
    logger.error({ err, targetUrl }, "VidLink: M3U8 proxy failed");
    if (!res.headersSent) res.status(502).send("Proxy error");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTER — mounted at /api in routes/index.ts
// Prefix /vidlink/* is unique; zero collision with existing routes.
// ════════════════════════════════════════════════════════════════════════════

export const vidlinkRouter: IRouter = Router();

// HEAD: quick reachability check — no CDN call
vidlinkRouter.head("/vidlink/hls.m3u8", (_req, res): void => {
  setCors(res);
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Accept-Ranges", "bytes");
  res.status(200).end();
});

// GET: fetch, cache, rewrite, and serve the M3U8
vidlinkRouter.get("/vidlink/hls.m3u8", async (req, res): Promise<void> => {
  await handleM3U8Proxy(req, res);
});

// OPTIONS
vidlinkRouter.options("/vidlink/hls.m3u8", (_req, res): void => {
  setCors(res);
  res.sendStatus(200);
});

// GET segment via session ID
vidlinkRouter.get("/vidlink/seg/:sid/:idx", async (req, res): Promise<void> => {
  setCors(res);
  const sid = req.params["sid"] as string;
  const idx = parseInt(req.params["idx"] as string);
  const session = segSessions.get(sid);

  if (!session || isNaN(idx) || idx < 0 || idx >= session.segs.length) {
    res.status(404).send("Segment not found");
    return;
  }

  const cdnUrl = session.segs[idx]!;
  const fetchHeaders: Record<string, string> = {
    "User-Agent": BROWSER_UA, "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5", "Connection": "keep-alive",
    ...session.headers,
  };

  const rangeHeader = req.headers["range"];
  if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

  if (!rangeHeader) {
    const entry = segCache.get(cdnUrl);
    if (entry && entry.buf !== undefined) {
      const buf = entry.buf;
      if (buf) {
        if (!entry.servedAt) entry.servedAt = Date.now();
        res.setHeader("Content-Type", "video/MP2T");
        res.setHeader("Content-Length", buf.length.toString());
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-store");
        prefetchSessionSegs(sid, idx);
        res.send(buf);
        return;
      }
      segCache.delete(cdnUrl);
    }
    prefetchSessionSegs(sid, idx);
  }

  try {
    const upstream = await fetch(cdnUrl, { headers: fetchHeaders, keepalive: true });
    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
      return;
    }
    const ct = upstream.headers.get("content-type") || "video/MP2T";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    if (upstream.status === 206) res.status(206);
    if (!upstream.body) { res.end(); return; }
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    await new Promise<void>((resolve, reject) => {
      pipeline(nodeStream, res, (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") reject(err);
        else resolve();
      });
    });
  } catch (err) {
    logger.error({ err, cdnUrl, sid, idx }, "VidLink: segment fetch failed");
    if (!res.headersSent) res.status(502).send("Segment proxy error");
  }
});

// HEAD segment
vidlinkRouter.head("/vidlink/seg/:sid/:idx", async (req, res): Promise<void> => {
  const sid = req.params["sid"] as string;
  const idx = parseInt(req.params["idx"] as string);
  const session = segSessions.get(sid);
  if (!session || isNaN(idx) || idx < 0 || idx >= session.segs.length) {
    res.status(404).end(); return;
  }
  try {
    const cdnUrl = session.segs[idx]!;
    const headHeaders: Record<string, string> = {
      "User-Agent": BROWSER_UA, "Accept": "*/*", "Connection": "keep-alive",
      ...session.headers,
    };
    const upstream = await fetch(cdnUrl, { method: "HEAD", headers: headHeaders });
    setCors(res);
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    res.status(upstream.status < 400 ? 200 : upstream.status).end();
  } catch { res.status(502).end(); }
});
