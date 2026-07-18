// NetMirror stream fetching logic
// Adapted from the NetMirror plugin for use as a Stremio addon

const TMDB_API_KEY = "5f39fd16e987a9e3fce30d55cf09b438";

// ─── Subtitle types ──────────────────────────────────────────────────────────

export interface SubtitleEntry {
  id: string;
  url: string;    // original download URL (caller wraps through sub-proxy)
  lang: string;   // ISO 639-2 three-letter code (e.g. "eng", "spa")
  label: string;  // human-readable name shown in Stremio
}

// ─── Rate-limit defences ─────────────────────────────────────────────────────

/**
 * Pool of realistic browser User-Agent strings.
 * Each upstream request picks a different one so the API sees varied clients
 * instead of a single bot fingerprint.
 */
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0",
];

const ACCEPT_LANG_POOL = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-CA,en;q=0.9,fr-CA;q=0.8",
  "en-AU,en;q=0.9",
  "en-IN,en;q=0.9,hi;q=0.7",
  "en-US,en;q=0.8,es;q=0.5",
  "en-US,en;q=0.7,fr;q=0.3",
];

let _uaIndex = 0;
let _langIndex = 0;

/** Returns the next User-Agent from the rotating pool. */
export function nextUA(): string {
  return UA_POOL[_uaIndex++ % UA_POOL.length];
}

/** Returns the next Accept-Language from the rotating pool. */
export function nextLang(): string {
  return ACCEPT_LANG_POOL[_langIndex++ % ACCEPT_LANG_POOL.length];
}

// ─── Subtitle cache + fetcher (OpenSubtitles.org — no API key required) ──────

const SUBTITLE_CACHE = new Map<string, { subs: SubtitleEntry[]; expiresAt: number }>();
const SUBTITLE_CACHE_TTL = 60 * 60 * 1000; // 1 hour — subtitles rarely change
const IN_FLIGHT_SUBS = new Map<string, Promise<SubtitleEntry[]>>();

function subCacheKey(imdbId: string, season: number | null, episode: number | null): string {
  return `sub:${imdbId}:${season ?? 0}:${episode ?? 0}`;
}

/**
 * Fetches subtitles from OpenSubtitles.org REST API (no key required).
 * Deduplicates by language so Stremio's subtitle menu stays clean.
 * Results are cached for 1 hour and concurrent calls are deduplicated.
 */
export async function fetchSubtitles(
  imdbId: string,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
): Promise<SubtitleEntry[]> {
  const key = subCacheKey(imdbId, season, episode);

  const cached = SUBTITLE_CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.subs;

  const existing = IN_FLIGHT_SUBS.get(key);
  if (existing) return existing;

  const fetch$ = (async (): Promise<SubtitleEntry[]> => {
    try {
      // OpenSubtitles.org expects the numeric part of the IMDB ID with leading
      // zeros preserved (e.g. tt0068646 → "0068646"), not stripped by parseInt.
      const numericId = imdbId.replace(/^tt/, "");

      let path = `/search/imdbid-${numericId}`;
      if (type === "series" && season != null && episode != null) {
        path += `/season-${season}/episode-${episode}`;
      }

      const res = await fetch(`https://rest.opensubtitles.org${path}`, {
        headers: {
          "X-User-Agent": "NetMirror Stremio Addon v1.0",
          "User-Agent": nextUA(),
          Accept: "application/json",
        },
      });

      if (!res.ok) return [];

      const data = (await res.json()) as Array<{
        IDSubtitleFile?: string;
        SubDownloadLink?: string;
        SubLanguageID?: string;
        LanguageName?: string;
      }>;

      if (!Array.isArray(data)) return [];

      // One subtitle per language (best-rated first — API returns them sorted)
      const seen = new Set<string>();
      const subs: SubtitleEntry[] = [];

      for (const item of data) {
        if (!item.SubDownloadLink || !item.SubLanguageID) continue;
        if (seen.has(item.SubLanguageID)) continue;
        seen.add(item.SubLanguageID);
        subs.push({
          id: item.IDSubtitleFile ?? `${item.SubLanguageID}-${numericId}`,
          url: item.SubDownloadLink,
          lang: item.SubLanguageID,
          label: item.LanguageName ?? item.SubLanguageID,
        });
        if (subs.length >= 40) break; // cap at 40 languages
      }

      SUBTITLE_CACHE.set(key, { subs, expiresAt: Date.now() + SUBTITLE_CACHE_TTL });
      return subs;
    } catch {
      return [];
    }
  })().finally(() => IN_FLIGHT_SUBS.delete(key));

  IN_FLIGHT_SUBS.set(key, fetch$);
  return fetch$;
}

// ─── Stream result cache ─────────────────────────────────────────────────────

interface CacheEntry {
  streams: StremioStream[];
  expiresAt: number; // epoch ms
}

/**
 * In-process cache keyed by content identity.
 * All users requesting the same content share one upstream result — the API
 * sees only 1 request per unique title rather than N (one per viewer).
 * TTL is 25 minutes, well within the CDN-signed URL expiry window.
 */
const STREAM_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 25 * 60 * 1000; // 25 minutes
const CACHE_MAX_ENTRIES = 500;        // cap memory usage

/**
 * In-flight requests map: while a fetch for key K is in progress, every
 * concurrent request for K awaits the same Promise (cache stampede prevention).
 */
const IN_FLIGHT = new Map<string, Promise<StremioStream[]>>();

function cacheKey(
  tmdbId: number,
  type: string,
  season: number | null,
  episode: number | null,
): string {
  return `${tmdbId}:${type}:${season ?? 0}:${episode ?? 0}`;
}

function getCached(key: string): StremioStream[] | null {
  const entry = STREAM_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    STREAM_CACHE.delete(key);
    return null;
  }
  return entry.streams;
}

function setCache(key: string, streams: StremioStream[]): void {
  // Evict oldest entries if we're at capacity
  if (STREAM_CACHE.size >= CACHE_MAX_ENTRIES) {
    const oldest = STREAM_CACHE.keys().next().value;
    if (oldest) STREAM_CACHE.delete(oldest);
  }
  STREAM_CACHE.set(key, { streams, expiresAt: Date.now() + CACHE_TTL_MS });
}

const PLATFORM_MAP: Record<string, { ott: string }> = {
  netflix: { ott: "nf" },
  primevideo: { ott: "pv" },
  hotstar: { ott: "hs" },
  disney: { ott: "hs" },
};

const NEW_TV_BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "X-Requested-With": "NetmirrorNewTV v1.0",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0",
  Accept: "application/json, text/plain, */*",
};

// ─── Runtime-configurable URLs ───────────────────────────────────────────────
// All mutable source domains are read from environment variables at call-time
// (not module load time), so updating a secret + hitting /nmadmin/reload brings
// the addon back without a full redeploy.

/**
 * Base URL for the NetMirror Netflix direct API.
 * Override via env:  NETMIRROR_API_BASE=https://newdomain.cc
 */
export function getNetmirrorApiBase(): string {
  return (process.env["NETMIRROR_API_BASE"] ?? "https://net27.cc").replace(/\/$/, "");
}

/**
 * Referer header sent when playing CDN-signed stream URLs.
 * Override via env:  NETMIRROR_STREAM_REFERER=https://newsite.cc/
 */
export function getStreamReferer(): string {
  return process.env["NETMIRROR_STREAM_REFERER"] ?? "https://videodownloader.site/";
}

// Base64-encoded built-in fallback domains for the NewTV API
const NEW_TV_DOMAINS_BUILTIN = [
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==",
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo=",
];

/**
 * Returns the full ordered domain list for NewTV API discovery.
 * Prepend your own domains via env:
 *   NEWTV_DOMAINS=https://domain1.com,https://domain2.net
 * Custom domains are tried first; built-in list is the fallback.
 */
function getNewTvDomainList(): string[] {
  const override = process.env["NEWTV_DOMAINS"];
  const custom = override
    ? override.split(",").map((d) => d.trim()).filter(Boolean)
    : [];
  const builtin = NEW_TV_DOMAINS_BUILTIN.map((b64) =>
    Buffer.from(b64, "base64").toString("utf-8").replace(/\/$/, ""),
  );
  return [...custom, ...builtin];
}

let resolvedApiUrl = "";

function safeAtob(b64: string): string {
  return Buffer.from(b64, "base64").toString("binary");
}

async function resolveApiUrl(): Promise<string> {
  if (resolvedApiUrl) return resolvedApiUrl;

  for (const domain of getNewTvDomainList()) {
    try {
      const res = await fetch(domain + "/checknewtv.php", {
        headers: {
          ...NEW_TV_BASE_HEADERS,
          "User-Agent": nextUA(),
        },
      });
      const data = (await res.json()) as { token_hash?: string };
      if (data.token_hash) {
        resolvedApiUrl = safeAtob(data.token_hash).replace(/\/$/, "");
        return resolvedApiUrl;
      }
    } catch {
      // try next domain
    }
  }
  throw new Error("Failed to resolve NewTV API base URL");
}

/**
 * Clears every in-process cache so the next request re-fetches from source.
 * Call this after updating NETMIRROR_API_BASE / NETMIRROR_STREAM_REFERER /
 * NEWTV_DOMAINS secrets — no redeploy needed.
 */
export function clearAllCaches(): void {
  resolvedApiUrl = "";      // force NewTV domain re-resolution
  STREAM_CACHE.clear();
  IN_FLIGHT.clear();
  SUBTITLE_CACHE.clear();
  IN_FLIGHT_SUBS.clear();
  console.info("[netmirror] All caches cleared — will re-resolve on next request");
}

function buildNewTvHeaders(
  ott: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...NEW_TV_BASE_HEADERS,
    Ott: ott,
    "User-Agent": nextUA(),          // rotated per request
    "Accept-Language": nextLang(),   // rotated per request
    ...extra,
  };
}

// Convert IMDB ID to TMDB ID
export async function imdbToTmdb(
  imdbId: string,
  type: "movie" | "series",
): Promise<{ tmdbId: number; title: string } | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      },
    );
    const data = (await res.json()) as {
      movie_results: Array<{ id: number; title?: string }>;
      tv_results: Array<{ id: number; name?: string }>;
    };

    if (type === "series" && data.tv_results?.length > 0) {
      const result = data.tv_results[0];
      return { tmdbId: result.id, title: result.name ?? "" };
    }
    if (type === "movie" && data.movie_results?.length > 0) {
      const result = data.movie_results[0];
      return { tmdbId: result.id, title: result.title ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

export interface StremioStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: {
    notWebReady?: boolean;
    headers?: Record<string, string>;
  };
  subtitles?: Array<{
    url: string;
    lang: string;
    label: string;
  }>;
}

export interface AddonConfig {
  preferredPlatform?: string;
  forceHd?: boolean;
}

// Fetch streams from Netflix direct (net27.cc)
async function fetchFromNetflixDirect(
  tmdbId: number,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
  title: string,
): Promise<StremioStream[] | null> {
  try {
    const base = getNetmirrorApiBase();
    const url =
      type === "series"
        ? `${base}/api/embed-tmdb/${tmdbId}?type=tv&s=${season}&e=${episode}`
        : `${base}/api/embed-tmdb/${tmdbId}`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `${base}/`,
        "User-Agent": nextUA(),
        "Accept-Language": nextLang(),
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      ok?: boolean;
      mp4?: string;
      streams?: Array<{ url: string; resolution: number }>;
      captions?: Array<{ url: string; lang?: string; name?: string }>;
    };

    if (data.ok !== true) return null;

    const streamHeaders = {
      Referer: getStreamReferer(),
      "User-Agent": nextUA(),
    };

    const subtitles = (data.captions ?? []).map((c) => {
      let subUrl = c.url;
      if (subUrl.startsWith("/")) subUrl = `${base}${subUrl}`;
      return {
        url: subUrl,
        lang: c.lang ?? "en",
        label: c.name ?? "English",
      };
    });

    const streams: StremioStream[] = [];

    if (data.streams && data.streams.length > 0) {
      data.streams.forEach((s) => {
        streams.push({
          name: `NetMirror | Netflix`,
          title: `${title}\n${s.resolution}p`,
          url: s.url,
          behaviorHints: { notWebReady: true, headers: streamHeaders },
          subtitles,
        });
      });
    } else if (data.mp4) {
      streams.push({
        name: `NetMirror | Netflix`,
        title: `${title}\nAuto`,
        url: data.mp4,
        behaviorHints: { notWebReady: true, headers: streamHeaders },
        subtitles,
      });
    }

    return streams.length > 0 ? streams : null;
  } catch {
    return null;
  }
}

interface EpisodeEntry {
  id: string;
  s: number | null;
  ep: number | null;
}

async function fetchEpisodesPage(
  showId: string,
  seasonId: string,
  startPage: number,
  seasonNum: number | null,
  platformConfig: { ott: string },
  apiBase: string,
): Promise<EpisodeEntry[]> {
  const results: EpisodeEntry[] = [];
  let page = startPage;

  while (true) {
    const url = `${apiBase}/newtv/episodes.php?id=${seasonId}&page=${page}`;
    const res = await fetch(url, {
      headers: buildNewTvHeaders(platformConfig.ott),
    });
    const data = (await res.json()) as {
      episodes?: Array<{
        id: string;
        ep?: string;
        epNum?: string;
        sNum?: string;
      } | null>;
      nextPageShow?: number;
    };

    if (data.episodes) {
      data.episodes
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .forEach((ep) => {
          const epNum = ep.ep
            ? parseInt(ep.ep)
            : ep.epNum
              ? parseInt(ep.epNum.replace("E", ""))
              : null;
          const sNum =
            seasonNum ??
            (ep.sNum ? parseInt(ep.sNum.replace("S", "")) : null);
          results.push({ id: ep.id, s: sNum, ep: epNum });
        });
    }

    if (data.nextPageShow !== 1) break;
    page++;
  }

  return results;
}

async function getAllEpisodes(
  showId: string,
  postData: {
    season?: Array<{ id: string; selected?: boolean }>;
    nextPageSeason?: string;
    nextPageShow?: number;
    episodes?: Array<{
      id: string;
      ep?: string;
      epNum?: string;
      sNum?: string;
    } | null>;
  },
  platformConfig: { ott: string },
  apiBase: string,
): Promise<EpisodeEntry[]> {
  const results: EpisodeEntry[] = [];

  const selectedSeasonIdx = postData.season
    ? postData.season.findIndex((s) => s.selected === true)
    : -1;
  const currentSeasonId =
    selectedSeasonIdx >= 0
      ? postData.season![selectedSeasonIdx].id
      : (postData.nextPageSeason ?? null);
  const currentSeasonNum = selectedSeasonIdx >= 0 ? selectedSeasonIdx + 1 : null;

  if (postData.episodes) {
    postData.episodes
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .forEach((ep) => {
        const epNum = ep.ep
          ? parseInt(ep.ep)
          : ep.epNum
            ? parseInt(ep.epNum.replace("E", ""))
            : null;
        const sNum =
          currentSeasonNum ??
          (ep.sNum ? parseInt(ep.sNum.replace("S", "")) : null);
        results.push({ id: ep.id, s: sNum, ep: epNum });
      });
  }

  if (postData.nextPageShow === 1 && currentSeasonId) {
    const more = await fetchEpisodesPage(
      showId,
      currentSeasonId,
      2,
      currentSeasonNum,
      platformConfig,
      apiBase,
    );
    results.push(...more);
  }

  if (postData.season) {
    for (let i = 0; i < postData.season.length; i++) {
      const s = postData.season[i];
      if (s.id !== currentSeasonId && s.id) {
        const eps = await fetchEpisodesPage(
          showId,
          s.id,
          1,
          i + 1,
          platformConfig,
          apiBase,
        );
        results.push(...eps);
      }
    }
  }

  return results;
}

// Fetch streams from a specific platform via NewTV API
async function fetchFromPlatform(
  platform: string,
  title: string,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
): Promise<StremioStream[] | null> {
  const platformConfig = PLATFORM_MAP[platform];
  if (!platformConfig) return null;

  const apiBase = await resolveApiUrl();

  const searchUrl = `${apiBase}/newtv/search.php?s=${encodeURIComponent(title)}`;
  const searchRes = await fetch(searchUrl, {
    headers: buildNewTvHeaders(platformConfig.ott),
  });
  const searchData = (await searchRes.json()) as {
    searchResult?: Array<{ id: string }>;
  };

  if (!searchData.searchResult || searchData.searchResult.length === 0) {
    return null;
  }

  const firstResult = searchData.searchResult[0];
  const showId = firstResult.id;

  const postUrl = `${apiBase}/newtv/post.php?id=${showId}`;
  const postRes = await fetch(postUrl, {
    headers: buildNewTvHeaders(platformConfig.ott, {
      Lastep: "",
      Usertoken: "",
    }),
  });
  const postData = (await postRes.json()) as {
    type?: string;
    episodes?: Array<unknown>;
    main_id?: string;
    season?: Array<{ id: string; selected?: boolean }>;
    nextPageSeason?: string;
    nextPageShow?: number;
  };

  let targetId = showId;

  if (type === "series") {
    const episodes = await getAllEpisodes(
      showId,
      postData as Parameters<typeof getAllEpisodes>[1],
      platformConfig,
      apiBase,
    );
    const match = episodes.find((e) => e.s === season && e.ep === episode);
    if (!match) return null;
    targetId = match.id;
  } else {
    // Ensure it's actually a movie, not a TV show
    const looksLikeTv =
      postData.type === "t" ||
      (postData.episodes &&
        (postData.episodes as Array<unknown>).filter((e) => e !== null).length >
          0);
    if (looksLikeTv) return null;
    targetId = postData.main_id ?? showId;
  }

  const playerUrl = `${apiBase}/newtv/player.php?id=${targetId}`;
  const playerRes = await fetch(playerUrl, {
    headers: buildNewTvHeaders(platformConfig.ott, { Usertoken: "" }),
  });
  const playerData = (await playerRes.json()) as {
    status?: string;
    video_link?: string;
    referer?: string;
  };

  if (playerData.status === "ok" && playerData.video_link) {
    const displayName =
      platform.charAt(0).toUpperCase() + platform.slice(1);
    return [
      {
        name: `NetMirror | ${displayName}`,
        title: `${title}\nAuto`,
        url: playerData.video_link,
        behaviorHints: {
          notWebReady: true,
          headers: { Referer: playerData.referer ?? apiBase },
        },
      },
    ];
  }

  return null;
}

export function applyHdFilter(
  streams: StremioStream[],
  forceHd: boolean,
): StremioStream[] {
  if (!forceHd || streams.length === 0) return streams;
  // Extract resolution from title line (e.g. "1080p", "720p")
  const hdStreams = streams.filter((s) => {
    const resMatch = s.title?.match(/(\d+)p/);
    if (!resMatch) return true; // keep streams with unknown resolution
    return parseInt(resMatch[1], 10) >= 720;
  });
  // Fall back to all streams if none qualify as HD
  return hdStreams.length > 0 ? hdStreams : streams;
}

/** Wraps a promise with a timeout — resolves null instead of hanging forever */
function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Core fetch — queries all platforms in parallel with per-platform timeouts.
 * Not called directly; always goes through the caching wrapper below.
 */
async function fetchStreamsUncached(
  tmdbId: number,
  type: "movie" | "series",
  title: string,
  season: number | null,
  episode: number | null,
  forceHd: boolean,
  platforms: string[],
): Promise<StremioStream[]> {
  const promises = platforms.map((platform) =>
    withTimeout(
      (async (): Promise<StremioStream[] | null> => {
        try {
          if (platform === "netflix") {
            const direct = await fetchFromNetflixDirect(tmdbId, type, season, episode, title);
            if (direct && direct.length > 0) return direct;
          }
          return await fetchFromPlatform(platform, title, type, season, episode);
        } catch {
          return null;
        }
      })(),
      20_000,
    ),
  );

  const results = await Promise.allSettled(promises);
  const all = results.flatMap((r) =>
    r.status === "fulfilled" && r.value ? r.value : [],
  );
  return applyHdFilter(all, forceHd);
}

/**
 * Public entry point.
 *
 * Rate-limit protections applied here:
 *  1. Result cache (25-min TTL, max 500 entries) — N users watching the same
 *     title generate exactly 1 upstream request, not N.
 *  2. In-flight deduplication — if two requests arrive for the same key while
 *     a fetch is already running, they both await the same Promise (no stampede).
 *  3. Per-request UA + Accept-Language rotation (applied inside header builders).
 */
export async function getStreams(
  tmdbId: number,
  type: "movie" | "series",
  title: string,
  season: number | null,
  episode: number | null,
  config: AddonConfig = {},
): Promise<StremioStream[]> {
  const preferredPlatform = config.preferredPlatform ?? "all";
  const forceHd = config.forceHd ?? true;

  const platforms =
    preferredPlatform !== "all"
      ? [preferredPlatform, ...["netflix", "primevideo", "hotstar", "disney"].filter((p) => p !== preferredPlatform)]
      : ["netflix", "primevideo", "hotstar", "disney"];

  const key = cacheKey(tmdbId, type, season, episode);

  // 1. Cache hit — serve instantly, zero upstream traffic
  const cached = getCached(key);
  if (cached) return applyHdFilter(cached, forceHd);

  // 2. Deduplication — re-use an already in-flight fetch for the same key
  const existing = IN_FLIGHT.get(key);
  if (existing) return existing;

  // 3. New fetch — register it so concurrent requests share this Promise
  const fetch$ = fetchStreamsUncached(tmdbId, type, title, season, episode, forceHd, platforms)
    .then((streams) => {
      setCache(key, streams);
      return streams;
    })
    .finally(() => {
      IN_FLIGHT.delete(key);
    });

  IN_FLIGHT.set(key, fetch$);
  return fetch$;
}
