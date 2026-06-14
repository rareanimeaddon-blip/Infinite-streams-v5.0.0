import {
  generateXClientToken,
  generateXTrSignature,
  generateDeviceId,
  randomBrandModel,
} from "./moviebox-crypto.js";
import { logger } from "./logger.js";
const MAIN_URL = "https://api3.aoneroom.com";
const DEVICE_ID = generateDeviceId();

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
    brand: model,
    model: brand,
    system_language: "en",
    net: "NETWORK_WIFI",
    region: "US",
    timezone: "Asia/Calcutta",
    sp_code: "",
    "X-Play-Mode": "1",
    "X-Idle-Data": "1",
    "X-Family-Mode": "0",
    "X-Content-Mode": "0",
  });
}

function mobileHeaders(
  method: string,
  url: string,
  body?: string,
  token?: string,
): Record<string, string> {
  const { brand, model } = randomBrandModel();
  const xClientToken = generateXClientToken();
  const xTrSignature = generateXTrSignature(
    method,
    "application/json",
    "application/json",
    url,
    body,
  );

  const headers: Record<string, string> = {
    "user-agent":
      "com.community.oneroom/50020088 (Linux; U; Android 13; en_US; " +
      brand +
      "; Build/TQ3A.230901.001; Cronet/145.0.7582.0)",
    accept: "application/json",
    "content-type": "application/json",
    connection: "keep-alive",
    "x-client-token": xClientToken,
    "x-tr-signature": xTrSignature,
    "x-client-info": buildClientInfo(
      "com.community.oneroom",
      "3.0.13.0325.03",
      50020088,
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

async function apiGet(
  url: string,
  token?: string,
): Promise<{ data: unknown; responseToken?: string }> {
  const headers = mobileHeaders("GET", url, undefined, token);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });

  if (!response.ok) {
    const text = await response.text();
    logger.warn({ url, status: response.status, text }, "MovieBox GET failed");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const xUserHeader = response.headers.get("x-user");
  let responseToken: string | undefined;
  if (xUserHeader) {
    try {
      const xUserJson = JSON.parse(xUserHeader) as { token?: string };
      responseToken = xUserJson.token;
    } catch {
      // ignore
    }
  }

  const json = (await response.json()) as { data: unknown };
  return { data: json.data, responseToken };
}

async function apiPost(
  url: string,
  body: string,
  token?: string,
): Promise<{ data: unknown; responseToken?: string }> {
  const headers = mobileHeaders("POST", url, body, token);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.warn(
      { url, status: response.status, text },
      "MovieBox POST failed",
    );
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const xUserHeader = response.headers.get("x-user");
  let responseToken: string | undefined;
  if (xUserHeader) {
    try {
      const xUserJson = JSON.parse(xUserHeader) as { token?: string };
      responseToken = xUserJson.token;
    } catch {
      // ignore
    }
  }

  const json = (await response.json()) as { data: unknown };
  return { data: json.data, responseToken };
}

function parseSearchResults(data: unknown): Subject[] {
  const d = data as {
    results?: Array<{ subjects?: Array<Record<string, unknown>> }>;
  };
  if (!d?.results) return [];

  const subjects: Subject[] = [];
  for (const result of d.results) {
    for (const subject of result.subjects ?? []) {
      const subjectId = subject["subjectId"] as string | undefined;
      const title = (subject["title"] as string | undefined)?.split("[")[0]?.trim();
      if (!subjectId || !title) continue;

      subjects.push({
        subjectId,
        title,
        subjectType: (subject["subjectType"] as number | undefined) ?? 1,
        coverUrl: (subject["cover"] as { url?: string } | undefined)?.url,
        imdbRating: subject["imdbRatingValue"] as string | undefined,
      });
    }
  }
  return subjects;
}

export async function searchMovieBox(query: string, page = 1): Promise<Subject[]> {
  const url = `${MAIN_URL}/wefeed-mobile-bff/subject-api/search/v2`;
  // API silently returns 0 results when perPage > ~20; actual cap is 15.
  const body = JSON.stringify({ page, perPage: 15, keyword: query });

  try {
    const { data } = await apiPost(url, body);
    return parseSearchResults(data);
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
  const url = `${MAIN_URL}/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`;
  const { data, responseToken } = await apiGet(url);
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
  const url =
    `${MAIN_URL}/wefeed-mobile-bff/subject-api/play-info` +
    `?subjectId=${subjectId}&se=${season}&ep=${episode}`;

  try {
    const { data } = await apiGet(url, token);
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
        // lang/lanName: stream-level language tag (e.g. "en", "pt-BR")
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
  const url =
    `${MAIN_URL}/wefeed-mobile-bff/subject-api/get-stream-captions` +
    `?subjectId=${subjectId}&streamId=${streamId}`;
  try {
    const { data } = await apiGet(url, token);
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
