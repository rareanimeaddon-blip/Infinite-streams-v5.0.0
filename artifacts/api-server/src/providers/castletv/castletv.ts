/**
 * CastleTV provider
 *
 * Hits the Castle streaming API (api.hlowb.com), decrypts AES-128-CBC
 * responses, searches by title, navigates season/episode structure,
 * and returns direct video stream URLs.
 *
 * Decryption:
 *   key_bytes = base64_decode(securityKey) ++ utf8("T!BgJB") → pad/trim to 16 bytes
 *   IV = same 16 bytes as KEY   (AES-128-CBC, PKCS7)
 */

import { createDecipheriv } from "node:crypto";
import { logger } from "../../lib/logger.js";

const CASTLE_BASE = "https://api.hlowb.com";
const PKG = "com.external.castle";
const CHANNEL = "IndiaA";
const CLIENT = "1";
const LANG = "en-US";

const API_HEADERS: Record<string, string> = {
  "User-Agent": "okhttp/4.9.3",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "Keep-Alive",
  Referer: CASTLE_BASE,
};

const PLAYBACK_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept:
    "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  Connection: "keep-alive",
  "Sec-Fetch-Dest": "video",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  DNT: "1",
};

interface CastleStream {
  name: string;
  title: string;
  url: string;
  subtitles?: Array<{ url: string; lang: string; id: string }>;
  behaviorHints?: {
    proxyHeaders?: { request?: Record<string, string> };
  };
}

// ─── BigInt-safe JSON parsing ─────────────────────────────────────────────────
//
// Castle uses 16-digit integer IDs (e.g. 9028127820226681) that exceed
// Number.MAX_SAFE_INTEGER (9007199254740991).  Standard JSON.parse silently
// rounds them, corrupting the ID.  e.g. the api returns 9028127820226681 but
// JSON.parse gives back 9028127820226680 — one digit off — causing Castle's
// database lookup to return "Movie doesn't exist".
//
// Fix: before parsing, replace every bare integer literal with 16+ digits with
// a quoted string so the value is preserved exactly.  Timestamps (13 digits)
// are unaffected since they never reach 16 digits through 2100.

function castleSafeParse(text: string): Record<string, unknown> {
  const safe = text.replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"');
  return JSON.parse(safe) as Record<string, unknown>;
}

// ─── AES-128-CBC Decryption ───────────────────────────────────────────────────

/**
 * Derive the 16-byte key (also used as IV) from the Castle security key string.
 * Logic mirrors the reference plugin's crypto-js WordArray manipulation exactly:
 *   base64Parse(secKey) ++ utf8Parse("T!BgJB")  →  pad zeros / slice to 16 bytes
 */
function deriveKey(securityKey: string): Buffer {
  const keyBytes = Buffer.from(securityKey, "base64");
  const suffix = Buffer.from("T!BgJB", "utf8");
  const combined = Buffer.concat([keyBytes, suffix]);

  if (combined.length < 16) {
    return Buffer.concat([combined, Buffer.alloc(16 - combined.length, 0)]);
  }
  return combined.subarray(0, 16);
}

function decryptCastle(cipherText: string, securityKey: string): string {
  const key = deriveKey(securityKey);
  // IV equals KEY — this is the Castle protocol; not a mistake.
  const decipher = createDecipheriv("aes-128-cbc", key, key);
  decipher.setAutoPadding(true); // PKCS7
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherText, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function castleRequest(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...API_HEADERS,
      ...(options.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`[CastleTV] HTTP ${res.status}: ${res.statusText}`);
  }
  return res;
}

/**
 * Extract the cipher text from a Castle API response.
 * If the body is JSON with a string .data field → use that (most endpoints).
 * Otherwise use the raw text (some endpoints return cipher directly).
 */
async function extractCipher(res: Response): Promise<string> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("[CastleTV] Empty response body");
  try {
    const parsed = JSON.parse(trimmed) as { data?: string };
    if (parsed.data && typeof parsed.data === "string") {
      return parsed.data.trim();
    }
  } catch {
    // Not JSON — raw cipher text
  }
  return trimmed;
}

/**
 * Unwrap the optional outer .data wrapper that Castle wraps decrypted payloads in.
 * Returns the inner object if .data is an object, otherwise the whole obj.
 */
function unwrap(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj?.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    return obj.data as Record<string, unknown>;
  }
  return obj;
}

// ─── Castle API calls ─────────────────────────────────────────────────────────

async function getSecurityKey(): Promise<string> {
  const url =
    `${CASTLE_BASE}/v0.1/system/getSecurityKey/1` +
    `?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
  const res = await castleRequest(url);
  const json = (await res.json()) as { code: number; data?: string };
  if (json.code !== 200 || !json.data) {
    throw new Error(`[CastleTV] Security key error: ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function searchCastle(
  secKey: string,
  keyword: string,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    channel: CHANNEL,
    clientType: CLIENT,
    keyword,
    lang: LANG,
    mode: "1",
    packageName: PKG,
    page: "1",
    size: "30",
  });
  const res = await castleRequest(
    `${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`,
  );
  const cipher = await extractCipher(res);
  return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getDetails(
  secKey: string,
  movieId: string,
): Promise<Record<string, unknown>> {
  const url =
    `${CASTLE_BASE}/film-api/v1.9.9/movie` +
    `?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}` +
    `&movieId=${movieId}&packageName=${PKG}`;
  const res = await castleRequest(url);
  const cipher = await extractCipher(res);
  return castleSafeParse(decryptCastle(cipher, secKey));
}

/** Get a per-language video stream (includes individual dub/sub tracks). */
async function getVideoByLanguage(
  secKey: string,
  movieId: string,
  episodeId: string,
  languageId: string,
  resolution: number,
): Promise<Record<string, unknown>> {
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CLIENT,
    woolUser: "false",
    apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
    androidVersion: "13",
    movieId,
    episodeId,
    languageId,
    isNewUser: "true",
    resolution: resolution.toString(),
    packageName: PKG,
  };
  const url =
    `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2` +
    `?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
  const res = await castleRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const cipher = await extractCipher(res);
  return castleSafeParse(decryptCastle(cipher, secKey));
}

/** Get the shared/default video stream (fallback when no per-language tracks). */
async function getVideoShared(
  secKey: string,
  movieId: string,
  episodeId: string,
  resolution: number,
): Promise<Record<string, unknown>> {
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CLIENT,
    woolUser: "false",
    apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
    androidVersion: "13",
    movieId,
    episodeId,
    isNewUser: "true",
    resolution: resolution.toString(),
    packageName: PKG,
  };
  const url =
    `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2` +
    `?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
  const res = await castleRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const cipher = await extractCipher(res);
  return castleSafeParse(decryptCastle(cipher, secKey));
}

// ─── Stream building helpers ──────────────────────────────────────────────────

function resolutionLabel(res: number): string {
  const map: Record<number, string> = { 1: "480p", 2: "720p", 3: "1080p" };
  return map[res] ?? `${res}p`;
}

function formatSize(bytes: unknown): string {
  if (typeof bytes !== "number" || bytes <= 0) return "Unknown";
  if (bytes > 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

interface CastleVideo {
  url?: string;
  resolutionDescription?: string;
  resolution?: string | number;
  size?: number;
}

interface CastleSubtitle {
  url?: string;
  abbreviate?: string;
  title?: string;
  languageId?: number | string;
  isDefault?: boolean;
  isAI?: number;
}

interface VideoPayload {
  videoUrl?: string;
  videos?: CastleVideo[];
  subtitles?: CastleSubtitle[];
  size?: number;
}

/**
 * Convert a decrypted Castle video response into stream entries.
 *
 * @param raw       - Decrypted + JSON-parsed Castle video response
 * @param langLabel - Language display label, e.g. "[Hindi]" or "[Shared]"
 * @param titleLine - Content label, e.g. "Inception (2010)" or "Breaking Bad S01E01 (2008)"
 * @param resolution - Numeric resolution code (1=480p, 2=720p, 3=1080p)
 */
function buildCastleStreams(
  raw: Record<string, unknown>,
  langLabel: string,
  titleLine: string,
  resolution: number,
): CastleStream[] {
  const data = unwrap(raw) as VideoPayload;
  if (!data.videoUrl && !(data.videos?.length)) return [];

  const defaultQual = resolutionLabel(resolution);

  // Map Castle subtitle objects to Stremio's { url, lang, id } format.
  // Castle returns VTT files. `abbreviate` is the ISO 639-1 code (en, hi…).
  // Spaces in the filename (e.g. "English (CC).vtt") are percent-encoded so
  // the URL is valid for any HTTP client.
  const subtitles: CastleStream["subtitles"] = (data.subtitles ?? [])
    .filter((s): s is CastleSubtitle & { url: string } => typeof s.url === "string" && s.url.length > 0)
    .map((s, i) => ({
      url:  s.url!.replace(/ /g, "%20"),
      lang: s.abbreviate ?? s.title ?? "Unknown",
      id:   `castle-${s.languageId ?? s.abbreviate ?? i}`,
    }));

  const streams: CastleStream[] = [];

  if (data.videos && data.videos.length > 0) {
    for (const v of data.videos) {
      const videoUrl = v.url ?? data.videoUrl;
      if (!videoUrl) continue;

      // Castle's resolutionDescription is unreliable — it often returns "480P"
      // regardless of the actual stream quality. Derive the label from the URL
      // path instead (e.g. ".../720/index.m3u8" → "720p"), falling back to the
      // resolution code we requested (defaultQual) which is always accurate.
      const urlQualMatch = videoUrl.match(/\/(\d{3,4})\//);
      const qual = urlQualMatch
        ? `${urlQualMatch[1]}p`
        : String(v.resolutionDescription ?? v.resolution ?? defaultQual).replace(/^(SD|HD|FHD)\s+/i, "");

      const nameTag = langLabel ? `CastleTV ${langLabel}` : "CastleTV";
      streams.push({
        name: `🏰 ${nameTag} | ${qual}`,
        title: `🎬 ${titleLine}\n💎 ${qual} | 💾 ${formatSize(v.size)} | 🏰 Castle`,
        url: videoUrl,
        ...(subtitles.length ? { subtitles } : {}),
        behaviorHints: {
          proxyHeaders: { request: PLAYBACK_HEADERS },
        },
      });
    }
  } else {
    // No videos array — use the single videoUrl with the requested resolution label.
    const videoUrl = data.videoUrl;
    if (!videoUrl) return [];
    const urlQualMatch = videoUrl.match(/\/(\d{3,4})\//);
    const qual = urlQualMatch ? `${urlQualMatch[1]}p` : defaultQual;
    const nameTag = langLabel ? `CastleTV ${langLabel}` : "CastleTV";
    streams.push({
      name: `🏰 ${nameTag} | ${qual}`,
      title: `🎬 ${titleLine}\n💎 ${qual} | 💾 ${formatSize(data.size)} | 🏰 Castle`,
      url: videoUrl,
      ...(subtitles.length ? { subtitles } : {}),
      behaviorHints: {
        proxyHeaders: { request: PLAYBACK_HEADERS },
      },
    });
  }

  return streams;
}

// ─── Castle API response shapes ───────────────────────────────────────────────

interface SearchRow {
  id?: string | number;
  redirectId?: string | number;
  redirectIdStr?: string;
  title?: string;
  name?: string;
}

interface CastleSeason {
  number?: number;
  movieId?: string | number;
}

interface CastleTrackVideo {
  resolution?: number;
  resolutionDescription?: string;
  size?: number;
  premiumProPermission?: boolean;
}

interface CastleTrack {
  languageName?: string;
  abbreviate?: string;
  languageId?: string | number;
  existIndividualVideo?: boolean;
  videos?: CastleTrackVideo[];
}

/**
 * Episode/track metadata (from getDetails) already lists every resolution
 * a track has, each flagged with `premiumProPermission`. Explicitly
 * requesting a premium-gated resolution via getVideoByLanguage/getVideoShared
 * makes the whole call fail (the track vanishes from results entirely,
 * not just that one quality) — so we must request the highest resolution
 * that does NOT require premium. The response for that request still
 * includes the full `videos` ladder (all qualities, premium ones included)
 * with working URLs, so nothing is lost by asking for the safe tier.
 * Falls back to 720p (2) when no per-track quality metadata is available.
 */
function pickSafeResolution(videos?: CastleTrackVideo[]): number {
  if (!videos || videos.length === 0) return 2;
  const nonPremium = videos.filter((v) => !v.premiumProPermission && typeof v.resolution === "number");
  const pool = nonPremium.length > 0 ? nonPremium : videos;
  return Math.max(...pool.map((v) => v.resolution ?? 2));
}

interface CastleEpisode {
  id?: string | number;
  number?: number;
  tracks?: CastleTrack[];
}

interface DetailsPayload {
  seasons?: CastleSeason[];
  episodes?: CastleEpisode[];
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Fetch CastleTV streams for a resolved title.
 *
 * @param title   - Resolved content title (from meta resolver)
 * @param year    - Resolved release year, if known
 * @param type    - "movie" or "series"
 * @param season  - Season number (series only; default 1)
 * @param episode - Episode number (series only; default 1)
 */

/**
 * Filter Castle tracks to only those with genuine individual dubbed videos.
 *
 * Castle's API returns an `existIndividualVideo` boolean per track:
 *   true  → the track has its own separately encoded video file (a real dub)
 *   false → no individual video exists for this track; it falls back to a
 *           default stream whose audio may not match the label at all
 *           (e.g. an "English" track with Hindi audio).
 *
 * We only return tracks where existIndividualVideo=true so every stream label
 * accurately reflects the audio the user will hear.  If NO track has an
 * individual video (e.g. older titles with a single shared stream), we fall
 * back to all available tracks rather than returning nothing.
 *
 * "OST" (Original SoundTrack) is Castle's label for the original-language
 * audio — shown as-is since it meaningfully distinguishes it from dubs.
 */
function pickPreferredTracks(tracks: CastleTrack[]): CastleTrack[] {
  if (!tracks.length) return tracks;
  const withVideo = tracks.filter((t) => t.existIndividualVideo === true);
  return withVideo.length > 0 ? withVideo : tracks;
}

export async function getCastleTvStreams(
  title: string,
  year: string | null | undefined,
  type: "movie" | "series",
  season = 1,
  episode = 1,
  originalLanguage?: string,
): Promise<CastleStream[]> {
  try {
    if (!title) return [];

    const titleLine =
      type === "series"
        ? `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}${year ? ` (${year})` : ""}`
        : `${title}${year ? ` (${year})` : ""}`;

    // 1. Fetch Castle security key
    const secKey = await getSecurityKey();

    // 2. Search Castle by "Title Year" (or just title if no year)
    const keyword = year ? `${title} ${year}` : title;
    const searchResult = await searchCastle(secKey, keyword);
    const rows = (unwrap(searchResult).rows ?? []) as SearchRow[];

    if (rows.length === 0) return [];

    // 3. Find the best matching Castle movie ID
    const titleLc = title.toLowerCase();
    const match =
      rows.find((r) => {
        const name = (r.title ?? r.name ?? "").toLowerCase();
        return name.includes(titleLc) || titleLc.includes(name);
      }) ?? rows[0];

    if (!match) return [];
    const castleId = (
      match.id ??
      match.redirectId ??
      match.redirectIdStr
    )?.toString();
    if (!castleId) return [];

    // 4. Fetch movie/show details
    let details = await getDetails(secKey, castleId);
    let activeId = castleId;

    // 5. For TV series, navigate to the right season if it has its own Castle ID
    if (type === "series") {
      const seasons = (unwrap(details).seasons ?? []) as CastleSeason[];
      const seasonEntry = seasons.find((s) => s.number === season);
      if (
        seasonEntry?.movieId &&
        seasonEntry.movieId.toString() !== castleId
      ) {
        details = await getDetails(secKey, seasonEntry.movieId.toString());
        activeId = seasonEntry.movieId.toString();
      }
    }

    // 6. Locate the target episode inside the details payload
    const episodes = (unwrap(details).episodes ?? []) as CastleEpisode[];
    let episodeId: string | null = null;

    if (type === "series") {
      const ep = episodes.find((e) => e.number === episode);
      episodeId = ep?.id?.toString() ?? null;
    } else {
      // Movies store their single "episode" as the first (and only) entry
      episodeId = episodes[0]?.id?.toString() ?? null;
    }

    if (!episodeId) return [];

    // 7. Collect language tracks for the episode; keep only those with a
    //    genuine individual video (existIndividualVideo=true) so every label
    //    matches the actual audio. Falls back to all tracks for older titles.
    const epEntry = episodes.find((e) => e.id?.toString() === episodeId);
    const allTracks: CastleTrack[] = epEntry?.tracks ?? [];
    const tracks = pickPreferredTracks(allTracks);

    logger.debug(
      { totalTracks: allTracks.length, pickedTracks: tracks.map((t) => t.languageName) },
      "CastleTV: selected language tracks",
    );

    const streams: CastleStream[] = [];
    const seenUrls = new Set<string>();

    // 8. Fetch each picked track across all three quality tiers in parallel.
    //    Premium-gated or unavailable resolutions return videoUrl=null and are
    //    silently dropped. Duplicate URLs across tracks are deduplicated.
    if (tracks.length > 0) {
      const langJobs = tracks.map((track) =>
        Promise.allSettled(
          [3, 2, 1].map((resolution) =>
            getVideoByLanguage(secKey, activeId, episodeId, track.languageId!.toString(), resolution)
              .then((raw) => ({ raw, resolution, track })),
          ),
        ),
      );
      const allResults = await Promise.all(langJobs);

      for (const trackResults of allResults) {
        for (const r of trackResults) {
          if (r.status !== "fulfilled") continue;
          const { raw, resolution, track } = r.value;
          const langLabel = `[${track.languageName ?? track.abbreviate ?? "Unknown"}]`;
          for (const s of buildCastleStreams(raw, langLabel, titleLine, resolution)) {
            if (!seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              streams.push(s);
            }
          }
        }
      }
    }

    // 9. Fallback to shared stream if no per-language streams came through.
    if (streams.length === 0) {
      logger.debug({ activeId, episodeId }, "CastleTV: no per-language streams, falling back to shared");
      const sharedResults = await Promise.allSettled(
        [3, 2, 1].map((resolution) =>
          getVideoShared(secKey, activeId, episodeId, resolution)
            .then((raw) => ({ raw, resolution })),
        ),
      );
      for (const r of sharedResults) {
        if (r.status !== "fulfilled") continue;
        const { raw, resolution } = r.value;
        for (const s of buildCastleStreams(raw, "", titleLine, resolution)) {
          if (!seenUrls.has(s.url)) {
            seenUrls.add(s.url);
            streams.push(s);
          }
        }
      }
    }

    return streams;
  } catch (err) {
    logger.error({ err, title }, "CastleTV: provider error");
    return [];
  }
}
