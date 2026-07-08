import { spawn, execSync } from "node:child_process";
import { tmdbTitleToImdbId } from "../lib/tmdb-verify.js";
import { logger } from "../lib/logger.js";
import { BASE_PATH } from "../lib/base-path.js";
import { findBestMatch, type MatchCandidate } from "../utils/match.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_URL =
  "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
const FALLBACK_NF_API = "https://tv.imgcdn.kim/newtv";
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const NETMIRROR_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0";

const NETMIRROR_ORIGIN = "https://net22.cc";
const NETMIRROR_REFERER = "https://net22.cc/";

export const OTT_SERVICES = [
  { code: "nf", name: "Netflix" },
  { code: "pv", name: "PrimeVideo" },
  { code: "hs", name: "Hotstar" },
];

// ─── ffmpeg availability ───────────────────────────────────────────────────────

export let FFMPEG_PATH: string | null = null;
try {
  FFMPEG_PATH = execSync("which ffmpeg", { encoding: "utf8" }).trim() || null;
} catch {
  FFMPEG_PATH = null;
}

// ─── Public base URL ──────────────────────────────────────────────────────────

type NmReq = { headers: Record<string, string | string[] | undefined> };

export function nmGetPublicBase(req?: NmReq): string {
  if (process.env["REPLIT_DOMAINS"]) {
    return `https://${process.env["REPLIT_DOMAINS"].split(",")[0]}`;
  }
  if (process.env["REPLIT_DEV_DOMAIN"]) {
    return `https://${process.env["REPLIT_DEV_DOMAIN"]}`;
  }
  if (process.env["PUBLIC_URL"]) {
    return process.env["PUBLIC_URL"];
  }
  if (req) {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
    return `${proto}://${host}`;
  }
  return "http://localhost:8080";
}

// ─── Proxy URL builders ───────────────────────────────────────────────────────

export function nmBuildProxyUrl(targetUrl: string, referer: string, req?: NmReq): string {
  const params = new URLSearchParams({ url: targetUrl, referer });
  return `${nmGetPublicBase(req)}${BASE_PATH}/nm-proxy?${params.toString()}`;
}

export function nmBuildStreamUrl(targetUrl: string, referer: string, req?: NmReq): string {
  const params = new URLSearchParams({ url: targetUrl, referer });
  return `${nmGetPublicBase(req)}${BASE_PATH}/hls/stream.m3u8?${params.toString()}`;
}

export function nmBuildSegUrl(variantUrl: string, referer: string, seq: number, req?: NmReq): string {
  const params = new URLSearchParams({ v: variantUrl, r: referer, s: String(seq) });
  return `${nmGetPublicBase(req)}${BASE_PATH}/nm-seg?${params.toString()}`;
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

export async function nmFetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── HLS detection ────────────────────────────────────────────────────────────

export function nmIsHlsPlaylist(url: string, contentType: string): boolean {
  const lowerUrl = url.toLowerCase().split("?")[0] ?? "";
  if (lowerUrl.endsWith(".m3u8") || lowerUrl.endsWith(".m3u")) return true;
  const lowerCt = contentType.toLowerCase();
  return (
    lowerCt.includes("mpegurl") ||
    lowerCt.includes("x-mpegurl") ||
    lowerCt.includes("vnd.apple.mpegurl")
  );
}

// ─── M3U8 rewriter ────────────────────────────────────────────────────────────

export function nmRewriteM3u8(text: string, sourceUrl: string, referer: string, req?: NmReq): string {
  const base = new URL(sourceUrl);
  const isMaster = text.includes("#EXT-X-STREAM-INF");
  let segSeq = 0;

  function proxify(uri: string): string {
    if (!uri || uri.startsWith("data:")) return uri;
    try {
      const tripleSlashMatch = /^https?:\/\/\/(.+)$/.exec(uri);
      if (tripleSlashMatch) {
        const abs = `${base.origin}/${tripleSlashMatch[1]}`;
        return nmBuildProxyUrl(abs, referer, req);
      }
      const parsed = new URL(uri, base);
      return nmBuildProxyUrl(parsed.toString(), referer, req);
    } catch {
      return uri;
    }
  }

  function proxifyTagUris(line: string): string {
    return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxify(uri)}"`);
  }

  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    const t = rawLine.trim();

    if (t.startsWith("#EXT-X-VERSION:")) {
      const v = parseInt(t.split(":")[1] ?? "0", 10);
      out.push(`#EXT-X-VERSION:${Math.max(v, 7)}`);
      continue;
    }

    if (isMaster) {
      // Keep SUBTITLES tracks — proxify their URI so our nm-proxy fetches the
      // subtitle .m3u8, which in turn rewrites each .webvtt segment URL.
      // Stremio's HLS.js player can then render embedded subtitle tracks natively.
      if (t.startsWith("#EXT-X-MEDIA:") && t.includes("TYPE=SUBTITLES")) {
        out.push(proxifyTagUris(rawLine));
        continue;
      }
      // CLOSED-CAPTIONS without a URI are in-band mux tracks — strip them to
      // avoid player confusion (they have no fetchable URL to proxify).
      if (t.startsWith("#EXT-X-MEDIA:") && t.includes("TYPE=CLOSED-CAPTIONS") && !t.includes("URI=")) continue;
      if (t.startsWith("#EXT-X-STREAM-INF:")) {
        let cleaned = t
          .replace(/,?CLOSED-CAPTIONS="[^"]*"/g, "");
        cleaned = proxifyTagUris(cleaned);
        out.push(cleaned);
        continue;
      }
    }

    if (t.startsWith("#")) {
      out.push(proxifyTagUris(rawLine));
      continue;
    }

    if (!t) {
      out.push(rawLine);
      continue;
    }

    // For variant playlists (not master), route each segment through nm-seg which
    // re-fetches the variant playlist fresh on every request to get unexpired tokens.
    // For master playlists, keep proxying variant playlist URLs through nm-proxy.
    if (!isMaster) {
      out.push(nmBuildSegUrl(sourceUrl, referer, segSeq++, req));
    } else {
      out.push(proxify(t));
    }
  }

  return out.join("\n");
}

// ─── CDN header detection ─────────────────────────────────────────────────────

export function nmBuildFetchHeaders(
  targetUrl: string,
  defaultReferer: string
): Record<string, string> {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    // All freecdnN.top nodes require Origin/Referer matching their own domain.
    // Previously restricted to >= 30, but freecdn13 (and others below 30) also
    // return 404 when Origin is net22.cc — they need self-referential headers.
    if (/freecdn\d+\.top$/.test(host)) {
      return {
        "User-Agent": NETMIRROR_UA,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Origin": `https://${host}`,
        "Referer": `https://${host}/`,
        "Connection": "keep-alive",
      };
    }
  } catch {
    // fallthrough
  }
  return {
    "User-Agent": NETMIRROR_UA,
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": NETMIRROR_ORIGIN,
    "Referer": defaultReferer,
    "Connection": "keep-alive",
  };
}

// ─── TMDB / Cinemeta helpers ──────────────────────────────────────────────────

let cachedApiBase: string | null = null;
let cacheExpiry = 0;

async function getNfMirrorApi(): Promise<string> {
  const now = Date.now();
  if (cachedApiBase && now < cacheExpiry) return cachedApiBase;
  try {
    const resp = await nmFetchWithRetry(
      CONFIG_URL,
      { signal: AbortSignal.timeout(5000) },
      2
    );
    const data = (await resp.json()) as Record<string, string>;
    const base = data["nfmirror"] || FALLBACK_NF_API;
    cachedApiBase = base;
    cacheExpiry = now + 5 * 60 * 1000;
    return base;
  } catch {
    return FALLBACK_NF_API;
  }
}

const CINEMETA_BASE = "https://cinemeta-live.strem.io/meta";

async function resolveTitleFromCinemeta(
  id: string,
  mediaType: "movie" | "series"
): Promise<string | null> {
  try {
    const url = `${CINEMETA_BASE}/${mediaType}/${id}.json`;
    const resp = await nmFetchWithRetry(url, { signal: AbortSignal.timeout(8000) }, 2);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { meta?: { name?: string } };
    return data.meta?.name ?? null;
  } catch {
    return null;
  }
}

async function resolveNmTitle(
  id: string,
  mediaType: "movie" | "series"
): Promise<string | null> {
  const tmdbType = mediaType === "series" ? "tv" : "movie";

  try {
    if (id.startsWith("tmdb:")) {
      const tmdbId = id.slice(5);
      const url = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const resp = await nmFetchWithRetry(url, { signal: AbortSignal.timeout(8000) }, 2);
      const data = (await resp.json()) as { title?: string; name?: string };
      return data.title ?? data.name ?? null;
    }

    if (id.startsWith("tt")) {
      const url = `${TMDB_BASE_URL}/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      const resp = await nmFetchWithRetry(url, { signal: AbortSignal.timeout(8000) }, 2);
      const data = (await resp.json()) as {
        movie_results?: Array<{ title?: string }>;
        tv_results?: Array<{ name?: string }>;
      };
      const tmdbTitle =
        tmdbType === "movie"
          ? (data.movie_results?.[0]?.title ?? null)
          : (data.tv_results?.[0]?.name ?? null);
      if (tmdbTitle) return tmdbTitle;
      return resolveTitleFromCinemeta(id, mediaType);
    }
  } catch {
    if (id.startsWith("tt")) {
      return resolveTitleFromCinemeta(id, mediaType);
    }
  }

  return null;
}

// ─── Title matching ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rankCandidates(
  candidates: Array<{ t?: string; id?: string }>,
  target: string
): Array<{ t?: string; id?: string }> {
  const targetLow = target.toLowerCase();
  const targetNorm = normalize(target);
  const targetWords = targetNorm.split(" ").filter((w) => w.length > 2);

  const scored: Array<{ c: { t?: string; id?: string }; score: number }> = [];

  for (const c of candidates) {
    const tl = (c.t ?? "").toLowerCase();
    const tn = normalize(c.t ?? "");

    let score = 0;
    if (tl === targetLow) {
      score = 4;
    } else if (tn === targetNorm) {
      score = 3;
    } else if (tn && targetNorm && (tn.startsWith(targetNorm) || targetNorm.startsWith(tn))) {
      score = 2;
    } else if (targetWords.length >= 2) {
      const cnWords = tn.split(" ");
      if (targetWords.every((w) => cnWords.includes(w))) score = 1;
    }

    // Require at least score 2 (prefix match) — score 1 (word overlap) is too loose
    // and causes NetMirror to return streams for unrelated content like cartoons
    // that aren't on Netflix/Prime/Hotstar.
    if (score >= 2) scored.push({ c, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

function matchesSeason(label: string, season: number): boolean {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  const n = String(season);
  const padded = n.padStart(2, "0");
  // Use word-boundary regex to prevent "season 1" matching "season 10", "season 11", etc.
  return (
    new RegExp(`\\bseason\\s+0*${n}\\b`).test(l) ||
    new RegExp(`\\bs${padded}\\b`).test(l) ||
    new RegExp(`\\bs${n}\\b`).test(l) ||
    l === n ||
    l === padded
  );
}

function matchesEpisode(label: string, episode: number): boolean {
  const l = (label ?? "").toString().toLowerCase().trim();
  const n = String(episode);
  const padded = n.padStart(2, "0");
  // Use word-boundary regex to prevent "episode 1" matching "episode 10", "episode 11", etc.
  return (
    l === n ||
    l === padded ||
    new RegExp(`\\bep\\s*0*${n}\\b`).test(l) ||
    new RegExp(`\\bepisode\\s+0*${n}\\b`).test(l)
  );
}

// ─── Stream objects ───────────────────────────────────────────────────────────

export interface NetmirrorStream {
  name: string;
  description: string;
  url: string;
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
  };
  [key: string]: unknown;
}

// ─── Stream extraction ────────────────────────────────────────────────────────

async function extractServiceStreams(
  apiBase: string,
  service: { code: string; name: string },
  title: string,
  mediaType: "movie" | "series",
  season: number | null,
  episode: number | null,
  req?: NmReq,
  expectedImdbId?: string,
): Promise<NetmirrorStream[]> {
  const apiHeaders: Record<string, string> = {
    ott: service.code,
    "user-agent": NETMIRROR_UA,
    "x-requested-with": "NetmirrorNewTV v1.0",
    "origin": NETMIRROR_ORIGIN,
    "referer": NETMIRROR_REFERER,
  };

  const searchQuery = title.replace(/\s*[:\u2013\u2014]\s*.+$/, "").trim() || title;

  const searchResp = await nmFetchWithRetry(
    `${apiBase}/search.php?s=${encodeURIComponent(searchQuery)}`,
    { headers: apiHeaders, signal: AbortSignal.timeout(12000) },
    2
  );
  const searchJson = (await searchResp.json()) as {
    searchResult?: Array<{ t?: string; id?: string }>;
  };
  const rawCandidates = searchJson.searchResult ?? [];
  if (rawCandidates.length === 0) return [];

  const matchCandidates: MatchCandidate<{ t?: string; id?: string }>[] = rawCandidates.map((c) => ({
    title: c.t ?? "",
    type: mediaType,
    raw: c,
  }));

  const { best: bestCandidate } = findBestMatch(
    { title, type: mediaType },
    matchCandidates,
    { provider: "NetMirror" },
  );
  if (!bestCandidate) return [];

  const ranked = [bestCandidate.raw];
  let finalId = bestCandidate.raw.id!;

  // IMDB ID cross-check (movies): verify ranked[0] title maps to the expected IMDB ID.
  // Guards against same-named remakes / regional variants (null = unverified → pass through).
  if (expectedImdbId && mediaType === "movie" && ranked[0]?.t) {
    const resolvedId = await tmdbTitleToImdbId(ranked[0].t, undefined, "movie").catch(() => null);
    if (resolvedId && resolvedId !== expectedImdbId) {
      logger.info(
        { expectedImdbId, resolvedId, candidate: ranked[0].t, service: service.name },
        "NetMirror: IMDB ID mismatch — rejecting candidate",
      );
      return [];
    }
  }

  if (mediaType === "series" && season != null && episode != null) {
    let seasonEntry: { s?: string; id?: string } | undefined;

    // Collect all candidates that have a matching season, tracking total season
    // count so we can prefer the one with the most seasons. This prevents a
    // regional remake (e.g. "The Office" India, 1 season) from winning over the
    // original series ("The Office" US, 9 seasons) when both appear in search.
    const seasonMatches: Array<{ entry: { s?: string; id?: string }; totalSeasons: number }> = [];

    for (const candidate of ranked) {
      if (!candidate.id) continue;
      const postResp = await nmFetchWithRetry(
        `${apiBase}/post.php?id=${candidate.id}`,
        { headers: apiHeaders, signal: AbortSignal.timeout(12000) },
        2
      );
      const postData = (await postResp.json()) as {
        type?: string;
        season?: Array<{ s?: string; id?: string }>;
      };
      if (postData.type === "m" || !postData.season?.length) continue;
      const entry = postData.season.find((s) => matchesSeason(s.s ?? "", season));
      if (entry?.id) {
        // IMDB ID cross-check (series): verify this candidate's title maps to the
        // expected IMDB ID. Skips mismatched candidates so the correct one can still
        // win (e.g. "The Office" US wins over "The Office" India).
        if (expectedImdbId && candidate.t) {
          const resolvedId = await tmdbTitleToImdbId(candidate.t, undefined, "series").catch(() => null);
          if (resolvedId && resolvedId !== expectedImdbId) {
            logger.info(
              { expectedImdbId, resolvedId, candidate: candidate.t, service: service.name },
              "NetMirror: series candidate IMDB ID mismatch — skipping",
            );
            continue;
          }
        }
        seasonMatches.push({ entry, totalSeasons: postData.season.length });
      }
    }

    if (seasonMatches.length === 0) return [];

    // Pick the candidate with the most total seasons (original > remake heuristic)
    seasonMatches.sort((a, b) => b.totalSeasons - a.totalSeasons);
    seasonEntry = seasonMatches[0]!.entry;

    if (!seasonEntry?.id) return [];

    let episodeId: string | null = null;
    let page = 1;
    while (!episodeId && page <= 15) {
      const epResp = await nmFetchWithRetry(
        `${apiBase}/episodes.php?id=${seasonEntry.id}&page=${page}`,
        { headers: apiHeaders, signal: AbortSignal.timeout(12000) },
        2
      );
      const epData = (await epResp.json()) as {
        episodes?: Array<{ ep?: string; id?: string }>;
        nextPageShow?: string;
      };
      const epMatch = (epData.episodes ?? []).find((e) =>
        matchesEpisode(e.ep ?? "", episode)
      );
      if (epMatch?.id) episodeId = epMatch.id;
      if (parseInt(epData.nextPageShow ?? "0") !== 1) break;
      page++;
    }
    if (!episodeId) return [];
    finalId = episodeId;
  }

  const playerResp = await nmFetchWithRetry(
    `${apiBase}/player.php?id=${finalId}`,
    { headers: apiHeaders, signal: AbortSignal.timeout(12000) },
    2
  );
  const playerData = (await playerResp.json()) as {
    video_link?: string;
    referer?: string;
  };

  if (!playerData?.video_link) return [];

  // The CDN host referenced by video_link (e.g. tv.imgcdn.kim) validates the
  // Referer/Origin against the mirror domain returned in player.php's own
  // `referer` field (e.g. net52.cc), NOT the fixed net22.cc domain used for
  // the API calls above — using the wrong one causes the CDN to 404. Fall
  // back to NETMIRROR_REFERER only if the API didn't return one.
  const referer = playerData.referer
    ? playerData.referer.endsWith("/")
      ? playerData.referer
      : `${playerData.referer}/`
    : NETMIRROR_REFERER;
  const origin = referer.replace(/\/$/, "");

  let videoUrl = playerData.video_link;
  try {
    const headResp = await nmFetchWithRetry(
      videoUrl,
      {
        method: "HEAD",
        headers: {
          "User-Agent": NETMIRROR_UA,
          "Origin": origin,
          "Referer": referer,
        },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      },
      1
    );
    if (headResp.url && headResp.url !== videoUrl) {
      videoUrl = headResp.url;
    }
  } catch {
    // use original URL
  }

  try {
    const m3u8Resp = await nmFetchWithRetry(
      videoUrl,
      {
        headers: {
          "User-Agent": NETMIRROR_UA,
          "Accept": "*/*",
          "Accept-Encoding": "identity",
          "Origin": origin,
          "Referer": referer,
        },
        signal: AbortSignal.timeout(10000),
      },
      2
    );
    if (!m3u8Resp.ok) return [];
    const m3u8Text = await m3u8Resp.text();
    // Accept both master playlists (#EXT-X-STREAM-INF) and direct media playlists (#EXTINF).
    // Previously only master playlists were accepted, which silently dropped valid single-quality streams.
    if (!m3u8Text.includes("#EXTM3U") && !m3u8Text.includes("#EXT-X-STREAM-INF") && !m3u8Text.includes("#EXTINF")) return [];
  } catch {
    return [];
  }

  return [
    {
      name: `NetMirror | ${service.name}`,
      description: "1080p · server proxy",
      url: nmBuildStreamUrl(videoUrl, referer, req),
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `netmirror-${service.code}`,
      },
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchNetmirrorStreams(
  mediaType: "movie" | "series",
  id: string,
  season: number | null,
  episode: number | null,
  req?: NmReq
): Promise<NetmirrorStream[]> {
  try {
    const title = await resolveNmTitle(id, mediaType);
    if (!title) return [];

    const apiBase = await getNfMirrorApi();

    const expectedImdbId = id.startsWith("tt") ? id : undefined;
    const results = await Promise.allSettled(
      OTT_SERVICES.map((service) =>
        extractServiceStreams(apiBase, service, title, mediaType, season, episode, req, expectedImdbId)
      )
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  } catch (err) {
    logger.error({ err, id }, "NetMirror: provider error");
    return [];
  }
}
