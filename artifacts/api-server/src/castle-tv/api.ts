import axios from "axios";
import { decryptData } from "./crypto.js";
import { logger } from "../lib/logger.js";
import { makeProxiedUrl } from "../lib/proxy-fetch.js";

const BASE_URL = "https://api.fstcy.com";
const CHANNEL = "IndiaA";
const CLIENT_TYPE = "1";
const LANG = "en-US";
const PACKAGE_NAME = "com.external.castle";
const APK_SIGN_KEY = "ED0955EB04E67A1D9F3305B95454FED485261475";

const httpClient = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent": "okhttp/4.9.3",
    Accept: "*/*",
  },
});

httpClient.interceptors.request.use((config) => {
  const rawUrl = config.url ?? "";
  const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${config.baseURL ?? ""}${rawUrl}`;
  const proxied = makeProxiedUrl(fullUrl);
  if (proxied !== fullUrl) {
    config.url = proxied;
    config.baseURL = "";
  }
  return config;
});

export interface SecurityKeyResponse {
  code: number;
  msg: string;
  data: string;
}

export interface ContentItem {
  title?: string;
  coverImage?: string;
  redirectType?: number;
  redirectId?: number;
  movieType?: number;
  score?: number;
  publishTime?: number;
  briefIntroduction?: string;
}

export interface HomePageRow {
  id?: number;
  name?: string;
  coverImage?: string;
  type?: number;
  contents?: ContentItem[];
}

export interface HomePageData {
  page?: number;
  pages?: number;
  total?: number;
  rows?: HomePageRow[];
}

export interface SearchResultItem {
  id?: number;
  title?: string;
  score?: number;
  movieType?: number;
  coverHorizontalImage?: string;
  coverVerticalImage?: string;
  briefIntroduction?: string;
  publishTime?: number;
  tags?: string[];
  countries?: string[];
}

export interface SearchData {
  rows?: SearchResultItem[];
}

export interface Person {
  id?: number;
  name?: string;
}

export interface Track {
  languageId?: number;
  languageName?: string;
  abbreviate?: string;
  isDefault?: boolean;
  existIndividualVideo?: boolean;
  order?: number;
}

export interface ApiEpisode {
  id?: number;
  title?: string;
  number?: number;
  coverImage?: string;
  duration?: number;
  tracks?: Track[];
  onlineTime?: number;
}

export interface Season {
  movieId?: number;
  number?: number;
  description?: string;
  isCurrent?: boolean;
}

export interface MovieDetails {
  id?: number;
  title?: string;
  score?: number;
  movieType?: number;
  coverHorizontalImage?: string;
  coverVerticalImage?: string;
  briefIntroduction?: string;
  publishTime?: number;
  tags?: string[];
  countries?: string[];
  directors?: Person[];
  actors?: Person[];
  episodes?: ApiEpisode[];
  seasonNumber?: number;
  seasons?: Season[];
  languages?: string[];
}

export interface SubtitleData {
  languageId?: number;
  abbreviate?: string;
  title?: string;
  url?: string;
  isDefault?: boolean;
}

export interface VideoData {
  videoUrl?: string;
  expireTime?: number;
  isPreview?: boolean;
  subtitles?: SubtitleData[];
  inBlacklist?: boolean;
  permissionDenied?: boolean;
}

async function getSecurityKey(): Promise<string> {
  const url = `${BASE_URL}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&lang=${LANG}`;
  const res = await httpClient.get<SecurityKeyResponse>(url);
  if (res.data?.code === 200 && res.data?.data) {
    return res.data.data;
  }
  throw new Error(`Failed to get security key: code=${res.data?.code}`);
}

function extractAndDecrypt<T>(rawData: unknown, securityKey: string): T | null {
  let encryptedStr: string;

  if (typeof rawData === "string") {
    encryptedStr = rawData;
    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      if (typeof parsed.data === "string") {
        encryptedStr = parsed.data;
      }
    } catch {
    }
  } else if (rawData && typeof rawData === "object") {
    const obj = rawData as Record<string, unknown>;
    if (typeof obj.data === "string") {
      encryptedStr = obj.data;
    } else {
      encryptedStr = JSON.stringify(rawData);
    }
  } else {
    return null;
  }

  const decrypted = decryptData(encryptedStr, securityKey);
  if (!decrypted) return null;

  try {
    return JSON.parse(decrypted) as T;
  } catch {
    return null;
  }
}

export async function getHomePage(page = 1): Promise<{ data: HomePageData } | null> {
  const securityKey = await getSecurityKey();
  const url = `${BASE_URL}/film-api/v0.1/category/home?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&clientType=${CLIENT_TYPE}&lang=${LANG}&locationId=1001&mode=1&packageName=${PACKAGE_NAME}&page=${page}&size=17`;
  const res = await httpClient.get(url);
  return extractAndDecrypt(res.data, securityKey);
}

export async function searchMovies(query: string, page = 1): Promise<{ data: SearchData } | null> {
  const securityKey = await getSecurityKey();
  const encoded = encodeURIComponent(query);
  const url = `${BASE_URL}/film-api/v1.1.0/movie/searchByKeyword?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&clientType=${CLIENT_TYPE}&keyword=${encoded}&lang=${LANG}&mode=1&packageName=${PACKAGE_NAME}&page=${page}&size=30`;
  const res = await httpClient.get(url);
  return extractAndDecrypt(res.data, securityKey);
}

export async function getMovieDetails(movieId: string): Promise<{ data: MovieDetails } | null> {
  const securityKey = await getSecurityKey();
  const url = `${BASE_URL}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&clientType=${CLIENT_TYPE}&lang=${LANG}&movieId=${movieId}&packageName=${PACKAGE_NAME}`;
  const res = await httpClient.get(url);
  return extractAndDecrypt(res.data, securityKey);
}

export async function getVideoUrl(
  movieId: string,
  episodeId: string,
  resolution: number,
  languageId?: number,
): Promise<{ data: VideoData } | null> {
  const securityKey = await getSecurityKey();
  const url = `${BASE_URL}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT_TYPE}&packageName=${PACKAGE_NAME}&channel=${CHANNEL}&lang=${LANG}`;

  const body: Record<string, string> = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CLIENT_TYPE,
    woolUser: "false",
    apkSignKey: APK_SIGN_KEY,
    androidVersion: "13",
    movieId,
    episodeId,
    isNewUser: "true",
    resolution: String(resolution),
    packageName: PACKAGE_NAME,
  };

  if (languageId !== undefined) {
    body.languageId = String(languageId);
  }

  try {
    const res = await httpClient.post(url, body, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    return extractAndDecrypt(res.data, securityKey);
  } catch (err) {
    logger.warn({ err, movieId, episodeId, resolution }, "getVideoUrl failed");
    return null;
  }
}

export function mapMovieType(movieType?: number): "movie" | "series" {
  switch (movieType) {
    case 1:
    case 3:
    case 5:
      return "series";
    default:
      return "movie";
  }
}
