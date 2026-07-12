import { createHash } from "crypto";
import { logger } from "../../lib/logger.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const API_BASE = "https://api.meowtv.ru";
const TMDB_KEY = "adc48d20c0956934fb224de5c40bb85d";

export const MEOW_SERVERS = [
  { id: "lynx",       label: "Lynx" },
  { id: "ipcloud",    label: "IPCloud" },
  { id: "v5:Hindi",   label: "Hindi" },
  { id: "v4:Hindi",   label: "Hindi v2" },
  { id: "v6:Hindi",   label: "Hindi v3" },
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
  description?: string;
  url: string;
  behaviorHints: Record<string, unknown>;
  /** Raw stream data — used by the proxy for refresh-on-404 */
  _raw?: { serverId: string; imdbId: string; type: "movie" | "series"; season?: number; episode?: number };
}

// ─── WASM-based decryption ────────────────────────────────────────────────────
//
// MeowTV uses a WebAssembly module (compiled from AssemblyScript) for stream
// URL decryption.  The WASM binary is distributed AES-CTR encrypted on the
// meowtv.ru CDN; the key is derived from four 8-byte chunks (k0-k3) XORed
// with SHA-256("objectobjectstringfunction") — the browser fingerprint that
// mae() produces when all four browser API typeof checks return their expected
// values.
//
// We decrypt the WASM at server startup, cache the `deobfuscate` export, and
// reuse it for all stream requests.  The hardcoded WASM below is the
// decrypted binary captured from payload-CMAn0kdw.js (AES-CTR key derived
// from k0-CmyVE5HE.js … k3-BsN1Po7I.js, mae-input "objectobjectstringfunction").
// When MeowTV rotates their bundle the binary needs refreshing; the
// MEOW_WASM_KEY_CHUNKS / MEOW_PAYLOAD_* constants below can be updated
// instead of re-capturing the raw binary.

// Decrypted WASM binary (base64). Refresh when meowtv.ru rotates their bundle.
const MEOW_WASM_B64 =
  "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";

// ─── WASM loader (lazy singleton) ─────────────────────────────────────────────

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  deobfuscate: (nPtr: number, dPtr: number) => number;
  __new: (size: number, id: number) => number;
  __pin: (ptr: number) => number;
  __unpin: (ptr: number) => void;
}

let _wasmDeobfuscate: ((nonce: string, data: string) => string) | null = null;

async function loadWasmDeobfuscate(): Promise<(nonce: string, data: string) => string> {
  if (_wasmDeobfuscate) return _wasmDeobfuscate;

  const wasmBytes = Buffer.from(MEOW_WASM_B64, "base64");
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const wasmInstance = await WebAssembly.instantiate(wasmModule, {
    env: {
      abort(_msg: number, _file: number, _line: number, _col: number) {
        throw new Error("WASM abort");
      },
    },
  }) as { exports: WasmExports };

  const { memory, deobfuscate, __new, __pin, __unpin } = wasmInstance.exports;

  function writeStr(str: string): number {
    const ptr = __new(str.length << 1, 2) >>> 0;
    const mem16 = new Uint16Array(memory.buffer);
    for (let i = 0; i < str.length; i++) {
      mem16[(ptr >>> 1) + i] = str.charCodeAt(i);
    }
    return ptr;
  }

  function readStr(ptr: number): string {
    if (!ptr) return "";
    const mem32 = new Uint32Array(memory.buffer);
    const endPtr = (ptr + (mem32[(ptr - 4) >>> 2]!)) >>> 1;
    const mem16 = new Uint16Array(memory.buffer);
    let result = "";
    for (let x = ptr >>> 1; endPtr - x > 1024; x += 1024) {
      result += String.fromCharCode(...mem16.subarray(x, x + 1024));
    }
    result += String.fromCharCode(...mem16.subarray(ptr >>> 1, endPtr));
    return result;
  }

  _wasmDeobfuscate = (nonce: string, data: string): string => {
    const nPtr = __pin(writeStr(nonce));
    const dPtr = writeStr(data);
    const resPtr = deobfuscate(nPtr, dPtr) >>> 0;
    __unpin(nPtr);
    return readStr(resPtr);
  };

  logger.info("MeowTV: WASM deobfuscator loaded");
  return _wasmDeobfuscate;
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

async function decryptStream(enc: EncryptedStream): Promise<MeowStreamData> {
  const deobfuscate = await loadWasmDeobfuscate();
  const json = deobfuscate(enc.n, enc.d);
  return JSON.parse(json) as MeowStreamData;
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
        "Accept-Encoding": "identity",
      },
    });

    if (!res.ok) return null;

    const enc = (await res.json()) as EncryptedStream;
    if (!enc.n || !enc.d) return null;
    return await decryptStream(enc);
  } catch (e) {
    logger.warn({ err: e, serverId }, "MeowTV: stream fetch failed");
    return null;
  }
}

// ─── Metadata helpers ─────────────────────────────────────────────────────────

/**
 * Normalize the raw `language` field from the MeowTV API so it matches the
 * audio-language patterns that premiumFormat's regex recognises.
 */
function normalizeMeowLanguage(raw: string | undefined): string {
  const l = (raw ?? "").toLowerCase().trim();
  if (!l || l === "auto" || l === "multi" || l === "multi audio" || l === "multiple" || l === "mul") return "Multi Audio";
  if (l === "dual" || l === "dual audio") return "Dual Audio";
  if (l === "hindi" || l === "hi") return "Hindi";
  if (l === "english" || l === "en") return "English";
  if (l === "tamil" || l === "ta") return "Tamil";
  if (l === "telugu" || l === "te") return "Telugu";
  if (l === "japanese" || l === "ja") return "Japanese";
  if (l === "korean" || l === "ko") return "Korean";
  if (l === "bengali" || l === "bn") return "Bengali";
  if (l === "arabic" || l === "ar") return "Arabic";
  if (l === "chinese" || l === "zh") return "Chinese";
  if (l === "original" || l === "original audio") return "Original Audio";
  return (raw ?? "").charAt(0).toUpperCase() + (raw ?? "").slice(1);
}

/**
 * Try to extract a quality tag from the stream URL path.
 */
function qualityFromUrl(url: string): string {
  const u = url.toLowerCase().split("?")[0] ?? "";
  if (/\b(2160|4k)\b/.test(u)) return "2160p";
  if (/\b1080\b/.test(u)) return "1080p";
  if (/\b720\b/.test(u)) return "720p";
  if (/\b480\b/.test(u)) return "480p";
  if (/\b360\b/.test(u)) return "360p";
  return "";
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

// ─── URL-title mismatch guard ─────────────────────────────────────────────────
//
// Some MeowTV backend servers have wrong TMDB→content catalog mappings and
// return a completely different show (e.g. "SchoolFriends" for "Friends").
// Since the stream URL often embeds the slug of the actual content being served
// (e.g.  /SchoolFriends/S01E01/ or /Friends/S01E01/), we can extract that slug
// and compare it against the title we expect.  When the URL slug is clearly a
// different show we drop the stream entirely.
//
// Matching rules (all case-insensitive, after CamelCase / separator expansion):
//   1. Every significant word (≥4 chars) in the requested title MUST appear in
//      the URL slug words.  Missing → different show.
//   2. Every extra significant word in the URL slug that does NOT appear in the
//      requested title AND is not a generic filler term (season, complete, hindi,
//      english, dubbed, part, web, hd …) triggers a rejection.
//      e.g. "school" in SchoolFriends is not in {"friends"} → reject.
//
// Returns true when the URL looks like it belongs to a different show.

const URL_TITLE_FILLER = new Set([
  "season","complete","hindi","english","dubbed","part","web","hd","series",
  "download","full","episodes","episodes","special","episode","collection",
  "remastered","extended","edition","version","theatrical","directors","cut",
]);

function urlTitleMismatch(url: string, requestedTitle: string): boolean {
  // Extract the path (drop query string)
  const pathParts = (url.split("?")[0] ?? "").split("/").filter(Boolean);

  // Only extract a title slug when there is a clear /S{n}E{n}/ episode marker in the
  // URL path.  The segment immediately BEFORE the marker is the show title slug
  // (e.g. /SchoolFriends/S01E01/ → "SchoolFriends").
  //
  // We deliberately do NOT fall back to guessing a title from arbitrary path
  // segments — CDN URLs like /e/FQBObldSXE5cXFA/master.m3u8 use opaque hash IDs
  // and have no embedded title; a fallback would produce false positives.
  let titleSlug: string | null = null;
  for (let i = 1; i < pathParts.length; i++) {
    if (/^[Ss]\d{2}[Ee]\d{2}/.test(pathParts[i]!)) {
      titleSlug = pathParts[i - 1] ?? null;
      break;
    }
  }
  if (!titleSlug) return false; // no recognisable title slug → pass through

  // Tokenise: split CamelCase, dots, hyphens, underscores → lowercase words ≥4 chars
  const tokenise = (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[._\-+]/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 4);

  const reqWords  = new Set(tokenise(requestedTitle));
  const slugWords = tokenise(titleSlug);

  if (slugWords.length === 0 || reqWords.size === 0) return false;

  // Rule 1: every requested word must be present in the slug
  for (const w of reqWords) {
    if (!slugWords.includes(w)) {
      logger.info(
        { titleSlug, requestedTitle, missingWord: w },
        "MeowTV: url-title-guard rule1 — requested word absent from slug",
      );
      return true;
    }
  }

  // Rule 2: slug must not carry extra significant words absent from requested title
  for (const w of slugWords) {
    if (!reqWords.has(w) && !URL_TITLE_FILLER.has(w)) {
      logger.info(
        { titleSlug, requestedTitle, extraWord: w },
        "MeowTV: url-title-guard rule2 — slug has extra word not in requested title",
      );
      return true;
    }
  }

  return false;
}

// ─── Main provider function ───────────────────────────────────────────────────

export async function getMeowTvStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  proxyBase: string,
  requestedTitle?: string,
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

    // Skip decoy URLs (intentional anti-scraping fallback from WASM)
    if (data.url.includes("decoy.invalid")) continue;

    // URL-title guard: if the stream URL embeds a content slug that belongs to
    // a different show (e.g. /SchoolFriends/ when Friends was requested), drop it.
    if (requestedTitle && urlTitleMismatch(data.url, requestedTitle)) {
      logger.warn(
        { label, serverId, url: data.url.slice(0, 120), requestedTitle },
        "MeowTV: url-title-guard — dropping stream (wrong content slug in URL)",
      );
      continue;
    }

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
      behaviorHints = {};
      logger.info({ label, url: data.url.slice(0, 80) }, "MeowTV: HLS stream (proxied)");
    }

    const audio   = normalizeMeowLanguage(data.language);
    const quality = qualityFromUrl(data.url);

    streams.push({
      name: `MeowTV — ${label}`,
      title: quality || "",
      description: [audio, quality].filter(Boolean).join(" | "),
      url: streamUrl,
      behaviorHints,
    });
  }

  logger.info({ imdbId, count: streams.length }, "MeowTV: streams resolved");
  return streams;
}
