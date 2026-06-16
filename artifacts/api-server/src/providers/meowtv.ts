import { createHash } from "crypto";
import { logger } from "../lib/logger.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const API_BASE = "https://api.meowtv.ru";
const DECRYPTION_KEY = "9b7e3d1a4f6c2e8d0a5f1c7b3e9d4a6f";
const TMDB_KEY = "adc48d20c0956934fb224de5c40bb85d";

export const MEOW_SERVERS = [
  { id: "lynx",     label: "Lynx" },
  { id: "pseudo",   label: "Pseudo" },
  { id: "tik",      label: "TCloud" },
  { id: "ipcloud",  label: "IPCloud" },
  { id: "v5:Hindi", label: "Hindi" },
  { id: "v4:Hindi", label: "Hindi v2" },
  { id: "v6:Hindi", label: "Hindi v3" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  maxnumber: number;
  signature: string;
}

interface EncryptedStream {
  n: string;
  d: string;
}

export interface MeowStreamData {
  url: string;
  language: string;
  headers?: Record<string, string>;
}

export interface MeowStream {
  name: string;
  title: string;
  url: string;
  behaviorHints: Record<string, unknown>;
  /** Raw stream data — used by the proxy for refresh-on-404 */
  _raw?: { serverId: string; imdbId: string; type: "movie" | "series"; season?: number; episode?: number };
}

// ─── TMDB ID cache ────────────────────────────────────────────────────────────

const tmdbCache = new Map<string, number>();

export async function imdbToTmdbNumeric(
  imdbId: string,
  type: "movie" | "series",
): Promise<number | null> {
  const cacheKey = `${type}:${imdbId}`;
  const cached = tmdbCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${TMDB_KEY}`,
      { headers: { "User-Agent": UA } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      movie_results: Array<{ id: number }>;
      tv_results: Array<{ id: number }>;
    };
    const id =
      type === "movie"
        ? (data.movie_results?.[0]?.id ?? null)
        : (data.tv_results?.[0]?.id ?? null);
    if (id !== null) tmdbCache.set(cacheKey, id);
    return id;
  } catch {
    return null;
  }
}

// ─── Altcha / ticket ──────────────────────────────────────────────────────────

function solveAltcha(c: AltchaChallenge): string {
  for (let n = 0; n <= c.maxnumber; n++) {
    const hash = createHash("sha256")
      .update(c.salt + n.toString())
      .digest("hex");
    if (hash === c.challenge) {
      return Buffer.from(
        JSON.stringify({
          algorithm: c.algorithm,
          challenge: c.challenge,
          number: n,
          salt: c.salt,
          signature: c.signature,
        }),
      ).toString("base64");
    }
  }
  throw new Error("Failed to solve altcha within maxnumber");
}

async function getFreshTicket(): Promise<string> {
  const challengeRes = await fetch(`${API_BASE}/altcha/challenge`, {
    headers: {
      "User-Agent": UA,
      Origin: "https://meowtv.ru",
      Referer: "https://meowtv.ru/",
    },
  });
  if (!challengeRes.ok) throw new Error("Altcha challenge fetch failed");
  const challengeData = (await challengeRes.json()) as AltchaChallenge;
  const altcha = solveAltcha(challengeData);

  const ticketRes = await fetch(`${API_BASE}/streams/ticket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Origin: "https://meowtv.ru",
      Referer: "https://meowtv.ru/",
    },
    body: JSON.stringify({ altcha }),
  });
  if (!ticketRes.ok) throw new Error("Ticket fetch failed");
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  return ticket;
}

// ─── Stream decryption ────────────────────────────────────────────────────────

function decryptStream(enc: EncryptedStream): MeowStreamData {
  const keyBytes = createHash("sha256")
    .update(DECRYPTION_KEY + enc.n)
    .digest();
  const dataBytes = Buffer.from(enc.d, "base64");
  const result = Buffer.allocUnsafe(dataBytes.length);
  for (let i = 0; i < dataBytes.length; i++) {
    result[i] = dataBytes[i]! ^ keyBytes[i % keyBytes.length]!;
  }
  return JSON.parse(result.toString("utf-8")) as MeowStreamData;
}

// ─── Fetch one server's stream ────────────────────────────────────────────────

export async function fetchMeowServerStream(
  type: "movie" | "series",
  tmdbId: number,
  serverId: string,
  season?: number,
  episode?: number,
): Promise<MeowStreamData | null> {
  try {
    const ticket = await getFreshTicket();
    const mediaType = type === "movie" ? "movie" : "tv";
    const path =
      type === "movie"
        ? `/streams/movie/${tmdbId}?s=${encodeURIComponent(serverId)}`
        : `/streams/tv/${tmdbId}/${season}/${episode}?s=${encodeURIComponent(serverId)}`;

    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        "User-Agent": UA,
        Origin: "https://meowtv.ru",
        Referer: `https://meowtv.ru/play/${mediaType}/${tmdbId}`,
        "x-stream-ticket": ticket,
      },
    });

    if (!res.ok) return null;

    const enc = (await res.json()) as EncryptedStream;
    if (!enc.n || !enc.d) return null;
    return decryptStream(enc);
  } catch (e) {
    logger.warn({ err: e, serverId }, "MeowTV: stream fetch failed");
    return null;
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isDirectVideo(url: string): boolean {
  const path = (url.split("?")[0] ?? "").toLowerCase();
  return (
    path.endsWith(".mp4") ||
    path.endsWith(".mkv") ||
    path.endsWith(".webm") ||
    path.endsWith(".avi") ||
    path.endsWith(".mov")
  );
}

export function makeMeowM3u8ProxyUrl(
  proxyBase: string,
  targetUrl: string,
  headers: Record<string, string> | undefined,
  meta?: { type: string; imdb: string; server: string; season?: number; episode?: number },
): string {
  const u = Buffer.from(targetUrl).toString("base64url");
  const h =
    headers && Object.keys(headers).length > 0
      ? "&h=" + Buffer.from(JSON.stringify(headers)).toString("base64url")
      : "";
  let m = "";
  if (meta) {
    m += `&t=${encodeURIComponent(meta.type)}&i=${encodeURIComponent(meta.imdb)}&s=${encodeURIComponent(meta.server)}`;
    if (meta.season !== undefined) m += `&sn=${meta.season}`;
    if (meta.episode !== undefined) m += `&ep=${meta.episode}`;
  }
  return `${proxyBase}/meow-proxy.m3u8?u=${u}${h}${m}`;
}

export function makeMeowBinaryProxyUrl(
  proxyBase: string,
  targetUrl: string,
  headers: Record<string, string> | undefined,
): string {
  const u = Buffer.from(targetUrl).toString("base64url");
  const h =
    headers && Object.keys(headers).length > 0
      ? "&h=" + Buffer.from(JSON.stringify(headers)).toString("base64url")
      : "";
  return `${proxyBase}/meow-proxy?u=${u}${h}`;
}

// ─── Main provider function ───────────────────────────────────────────────────

export async function getMeowTvStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  proxyBase: string,
): Promise<MeowStream[]> {
  if (!imdbId.startsWith("tt")) return [];

  const tmdbId = await imdbToTmdbNumeric(imdbId, type);
  if (!tmdbId) {
    logger.warn({ imdbId }, "MeowTV: TMDB ID not found");
    return [];
  }

  logger.info({ imdbId, tmdbId }, "MeowTV: fetching streams for all servers");

  const results = await Promise.allSettled(
    MEOW_SERVERS.map((srv) =>
      fetchMeowServerStream(type, tmdbId, srv.id, season, episode).then(
        (data) => ({ label: srv.label, serverId: srv.id, data }),
      ),
    ),
  );

  const streams: MeowStream[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { label, serverId, data } = result.value;
    if (!data?.url) continue;

    let streamUrl: string;
    let behaviorHints: Record<string, unknown>;

    if (isDirectVideo(data.url)) {
      const hdrs: Record<string, string> = {
        "User-Agent": UA,
        Referer: "https://meowtv.ru/",
        ...(data.headers ?? {}),
      };
      streamUrl = data.url;
      behaviorHints = { notWebReady: true, proxyHeaders: { request: hdrs } };
      logger.info({ label, url: data.url.slice(0, 80) }, "MeowTV: direct video stream");
    } else {
      streamUrl = makeMeowM3u8ProxyUrl(proxyBase, data.url, data.headers, {
        type,
        imdb: imdbId,
        server: serverId,
        season,
        episode,
      });
      behaviorHints = { notWebReady: true };
      logger.info({ label, url: data.url.slice(0, 80) }, "MeowTV: HLS stream (proxied)");
    }

    streams.push({
      name: `MeowTV — ${label}`,
      title: `${label} · ${data.language || "Multi"}`,
      url: streamUrl,
      behaviorHints,
    });
  }

  logger.info({ imdbId, count: streams.length }, "MeowTV: streams resolved");
  return streams;
}
