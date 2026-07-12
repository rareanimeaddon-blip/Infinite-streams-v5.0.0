import {
  generateXClientToken,
  generateXTrSignature,
  generateDeviceId,
  randomBrandModel,
} from "./moviebox-crypto.js";
import { logger } from "../../lib/logger.js";

// ── Host pool (api6sg.aoneroom.com is geo-blocked from Replit) ────────────────
const HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api.inmoviebox.com",
];

const DEVICE_ID = generateDeviceId();

// ── JWT token cache ───────────────────────────────────────────────────────────
// The mobile API requires a JWT (obtained from the homepage bootstrap) in the
// Authorization header. Without it ALL endpoints return 441 "miss token".
let cachedToken: string | null = null;
let tokenExpiresAt = 0;  // epoch ms

async function ensureToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  // Bootstrap: call the homepage to get a fresh JWT from the x-user header.
  for (const base of HOST_POOL) {
    const url = `${base}/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=`;
    const hdrs = mobileHeaders("GET", url, undefined, undefined);
    try {
      const r = await fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(12_000),
      });
      const xu = r.headers.get("x-user");
      if (xu) {
        const tok = tryParseXUser(xu);
        if (tok) {
          cachedToken = tok;
          tokenExpiresAt = now + 50 * 60 * 1000; // 50 min TTL
          logger.info({ host: base }, "MovieBox: bootstrapped JWT token");
          return cachedToken;
        }
      }
      // If x-user was absent, still count this as a working host
      if (r.ok) {
        logger.warn({ host: base }, "MovieBox: bootstrap got 200 but no x-user token");
        return null;
      }
    } catch (err) {
      logger.warn({ host: base, err }, "MovieBox: bootstrap host failed");
    }
  }

  logger.error("MovieBox: all bootstrap hosts failed");
  return null;
}

function tryParseXUser(header: string): string | null {
  try {
    const d = JSON.parse(header) as { token?: string };
    return d.token ?? null;
  } catch {
    return null;
  }
}

// ── Request helpers ───────────────────────────────────────────────────────────

export interface Stream {
  url: string;
  format: string;
  resolutions: string;
  signCookie?: string;
  id: string;
  codecName?: string;
  lang?: string;
}

export interface Subject {
  subjectId: string;
  title: string;
  subjectType: number;
  coverUrl?: string;
  imdbRating?: string;
  /**
   * Release year, parsed from the API's `releaseDate` field. MovieBox search
   * results frequently contain several subjects with the exact same title
   * (e.g. "Don", "Race", "Vikram", "Animal" all have multiple unrelated films
   * sharing the name across languages/regions). Without a per-candidate year,
   * the shared scoring system (`utils/match.ts`) can't tell them apart via its
   * year signal and effectively picks an arbitrary one among identical-score
   * ties. This field lets `scoreResults` in stremio.ts populate
   * `MatchCandidate.year` so the existing year-scoring logic actually
   * discriminates between same-titled-but-different subjects.
   */
  year?: number;
}

/** Extract a 4-digit year from a `releaseDate` string like "2006-10-20". */
function parseYear(releaseDate: unknown): number | undefined {
  if (typeof releaseDate !== "string") return undefined;
  const m = releaseDate.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}

function buildClientInfo(
  packageName: string,
  versionName: string,
  versionCode: number,
  brand: string,
  model: string,
): string {
  return JSON.stringify({
    package_name: packageName,
    version_name: versionName,
    version_code: versionCode,
    os: "android",
    os_version: "13",
    install_ch: "ps",
    device_id: DEVICE_ID,
    install_store: "ps",
    gaid: "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",
    brand,
    model,
    system_language: "en",
    net: "NETWORK_WIFI",
    region: "US",
    timezone: "Asia/Kolkata",
    sp_code: "40401",
    "X-Play-Mode": "2",
  });
}

function mobileHeaders(
  method: string,
  url: string,
  body?: string,
  token?: string | null,
): Record<string, string> {
  const { brand, model } = randomBrandModel();
  const ts = Date.now();
  const xClientToken = generateXClientToken(ts);
  const xTrSignature = generateXTrSignature(
    method,
    "application/json",
    "application/json",
    url,
    body,
    false,
    ts,
  );

  const headers: Record<string, string> = {
    "user-agent":
      "com.community.oneroom/50020045 (Linux; U; Android 13; en_US; " +
      brand +
      "; Build/TQ2A.230405.003; Cronet/135.0.7012.3)",
    accept: "application/json",
    "content-type": "application/json",
    connection: "keep-alive",
    "x-client-token": xClientToken,
    "x-tr-signature": xTrSignature,
    "x-client-info": buildClientInfo(
      "com.community.oneroom",
      "3.0.03.0529.03",
      50020045,
      brand,
      model,
    ),
    "x-client-status": "0",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

// ── Multi-host GET/POST with automatic JWT bootstrap ─────────────────────────

async function apiGet(
  path: string,
  token?: string | null,
): Promise<{ data: unknown; responseToken?: string }> {
  const authToken = token ?? await ensureToken();

  for (const base of HOST_POOL) {
    const url = `${base}${path}`;
    const headers = mobileHeaders("GET", url, undefined, authToken);
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });

      // Absorb a fresh JWT if provided
      const xu = response.headers.get("x-user");
      let responseToken: string | undefined;
      if (xu) {
        const tok = tryParseXUser(xu);
        if (tok) {
          responseToken = tok;
          cachedToken = tok;
          tokenExpiresAt = Date.now() + 50 * 60 * 1000;
        }
      }

      if (response.ok) {
        const json = (await response.json()) as { data: unknown };
        return { data: json.data, responseToken };
      }

      const text = await response.text();
      logger.warn({ url, status: response.status, text: text.slice(0, 200) }, "MovieBox GET non-OK");
      // 441 = auth error — try refreshing token on next attempt
      if (response.status === 441) {
        cachedToken = null;
        tokenExpiresAt = 0;
      }
    } catch (err) {
      logger.warn({ url, err }, "MovieBox GET host failed");
    }
  }

  throw new Error("MovieBox: all hosts failed for GET " + path);
}

async function apiPost(
  path: string,
  body: string,
  token?: string | null,
): Promise<{ data: unknown; responseToken?: string }> {
  const authToken = token ?? await ensureToken();

  for (const base of HOST_POOL) {
    const url = `${base}${path}`;
    const headers = mobileHeaders("POST", url, body, authToken);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(12_000),
      });

      const xu = response.headers.get("x-user");
      let responseToken: string | undefined;
      if (xu) {
        const tok = tryParseXUser(xu);
        if (tok) {
          responseToken = tok;
          cachedToken = tok;
          tokenExpiresAt = Date.now() + 50 * 60 * 1000;
        }
      }

      if (response.ok) {
        const json = (await response.json()) as { data: unknown };
        return { data: json.data, responseToken };
      }

      const text = await response.text();
      logger.warn({ url, status: response.status, text: text.slice(0, 200) }, "MovieBox POST non-OK");
      if (response.status === 441) {
        cachedToken = null;
        tokenExpiresAt = 0;
      }
    } catch (err) {
      logger.warn({ url, err }, "MovieBox POST host failed");
    }
  }

  throw new Error("MovieBox: all hosts failed for POST " + path);
}

// ── Result parsers ────────────────────────────────────────────────────────────

/** Parse the v1 search response: data.items[] */
function parseSearchResultsV1(data: unknown): Subject[] {
  const d = data as { items?: Array<Record<string, unknown>> };
  if (!Array.isArray(d?.items)) return [];

  return d.items
    .map((item): Subject | null => {
      const subjectId = item["subjectId"] as string | undefined;
      // Strip "[Hindi]", "[Dubbed]" etc. suffixes for cleaner matching
      const rawTitle = item["title"] as string | undefined;
      const title = rawTitle?.split("[")[0]?.trim() ?? "";
      if (!subjectId || !title) return null;
      return {
        subjectId,
        title,
        subjectType: (item["subjectType"] as number | undefined) ?? 1,
        coverUrl: (item["cover"] as { url?: string } | undefined)?.url,
        imdbRating: item["imdbRatingValue"] as string | undefined,
        year: parseYear(item["releaseDate"]),
      };
    })
    .filter((s): s is Subject => s !== null);
}

/** Parse the v2 search response: data.results[].subjects[] */
function parseSearchResultsV2(data: unknown): Subject[] {
  const d = data as {
    results?: Array<{ subjects?: Array<Record<string, unknown>> }>;
  };
  if (!Array.isArray(d?.results)) return [];

  const subjects: Subject[] = [];
  for (const result of d.results) {
    for (const subject of result.subjects ?? []) {
      const subjectId = subject["subjectId"] as string | undefined;
      const rawTitle = subject["title"] as string | undefined;
      const title = rawTitle?.split("[")[0]?.trim() ?? "";
      if (!subjectId || !title) continue;
      subjects.push({
        subjectId,
        title,
        subjectType: (subject["subjectType"] as number | undefined) ?? 1,
        coverUrl: (subject["cover"] as { url?: string } | undefined)?.url,
        imdbRating: subject["imdbRatingValue"] as string | undefined,
        year: parseYear(subject["releaseDate"]),
      });
    }
  }
  return subjects;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function searchMovieBox(query: string, page = 1): Promise<Subject[]> {
  const body = JSON.stringify({
    keyword: query,
    page,
    perPage: 15,
    subjectType: 0,
  });

  try {
    // Try v1 search first (simpler, direct items[] response)
    const { data } = await apiPost(
      "/wefeed-mobile-bff/subject-api/search",
      body,
    );
    const results = parseSearchResultsV1(data);
    if (results.length > 0) return results;

    // Fall back to v2 if v1 returned empty
    const { data: data2 } = await apiPost(
      "/wefeed-mobile-bff/subject-api/search/v2",
      body,
    );
    return parseSearchResultsV2(data2);
  } catch (err) {
    logger.error({ err, query, page }, "searchMovieBox failed");
    return [];
  }
}

export async function getSubjectDetails(subjectId: string): Promise<{
  subject: Record<string, unknown>;
  token?: string;
  dubs: Array<{ subjectId: string; lanName: string }>;
}> {
  const { data, responseToken } = await apiGet(
    `/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`,
  );
  const d = data as Record<string, unknown>;

  const dubs: Array<{ subjectId: string; lanName: string }> = [];
  const dubsRaw = d["dubs"] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(dubsRaw)) {
    for (const dub of dubsRaw) {
      const sid = dub["subjectId"] as string | undefined;
      const lanName = dub["lanName"] as string | undefined;
      if (sid && lanName && sid !== subjectId) {
        dubs.push({ subjectId: sid, lanName });
      }
    }
  }

  return { subject: d, token: responseToken, dubs };
}

export async function getPlayInfo(
  subjectId: string,
  season: number,
  episode: number,
  token?: string,
): Promise<Stream[]> {
  try {
    const { data } = await apiGet(
      `/wefeed-mobile-bff/subject-api/play-info?subjectId=${subjectId}&se=${season}&ep=${episode}`,
      token,
    );
    const d = data as { streams?: Array<Record<string, unknown>> };
    if (!d?.streams || !Array.isArray(d.streams)) return [];

    return d.streams
      .map((s) => ({
        url: s["url"] as string,
        format: (s["format"] as string | undefined) ?? "",
        resolutions: (s["resolutions"] as string | undefined) ?? "",
        signCookie: (s["signCookie"] as string | undefined) ?? undefined,
        id:
          (s["id"] as string | undefined) ??
          `${subjectId}|${season}|${episode}`,
        codecName: (s["codecName"] as string | undefined) ?? undefined,
        lang: (
          (s["lang"] as string | undefined) ??
          (s["lanName"] as string | undefined) ??
          (s["language"] as string | undefined)
        ) || undefined,
      }))
      .filter((s) => !!s.url);
  } catch (err) {
    logger.error({ err, subjectId, season, episode }, "getPlayInfo failed");
    return [];
  }
}

export async function getExtCaptions(
  subjectId: string,
  streamId: string,
  token?: string,
): Promise<Array<{ url: string; lang: string }>> {
  try {
    const { data } = await apiGet(
      `/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${subjectId}&streamId=${streamId}`,
      token,
    );
    const d = data as {
      extCaptions?: Array<Record<string, unknown>>;
    };
    if (!d?.extCaptions) return [];
    return d.extCaptions
      .map((c) => ({
        url: (c["url"] as string | undefined) ?? "",
        lang:
          (c["language"] as string | undefined) ??
          (c["lanName"] as string | undefined) ??
          (c["lan"] as string | undefined) ??
          "Unknown",
      }))
      .filter((c) => !!c.url);
  } catch {
    return [];
  }
}
