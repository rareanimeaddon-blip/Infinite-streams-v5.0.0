import axios, { type AxiosRequestConfig } from "axios";
import * as cheerio from "cheerio";
import { createDecipheriv } from "crypto";
import https from "https";
import { logger } from "../lib/logger.js";

// Some scraping targets (e.g. hdhub4u.cl) send SSL alert 80 (internal_error)
// to Node.js v18+'s stricter TLS handshake even though they serve valid content
// to browsers and curl. Using a permissive agent for these specific HTML-scraping
// calls is acceptable — we're fetching public movie listing pages, not transmitting
// credentials or sensitive data.
const SCRAPE_AGENT = new https.Agent({
  rejectUnauthorized: false,
  // Allow legacy cipher suites that newer TLS stacks reject by default
  secureOptions: 0x4, // SSL_OP_LEGACY_SERVER_CONNECT
});

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

export const cache = new TTLCache();

export const TTL = {
  CATALOG: 30 * 60 * 1000,
  META: 6 * 60 * 60 * 1000,
  STREAM: 10 * 60 * 1000,
  SEARCH: 2 * 60 * 60 * 1000,
  RESOLVE: 24 * 60 * 60 * 1000,
  RESOLVE_TOKEN: 8 * 60 * 1000,
};

// ─── IMDB ID extractor ────────────────────────────────────────────────────────

// Extracts an IMDB ID (e.g. "tt1234567") from raw HTML — works on any provider
// page that embeds a link to imdb.com/title/ttXXXXXXX.
export function extractImdbIdFromHtml(html: string): string | null {
  const m = html.match(/imdb\.com\/title\/(tt\d{7,8})/i);
  return m ? m[1]! : null;
}

// ─── HTTP Utils ───────────────────────────────────────────────────────────────

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

export async function fetchHtml(
  url: string,
  extraHeaders?: Record<string, string>,
  config?: AxiosRequestConfig,
): Promise<cheerio.CheerioAPI | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 15000,
      headers: { ...DEFAULT_HEADERS, ...extraHeaders },
      maxRedirects: 5,
      httpsAgent: SCRAPE_AGENT,
      ...config,
    });
    return cheerio.load(res.data as string);
  } catch (err) {
    logger.warn({ url, err }, "hdhub4u-base: fetchHtml failed");
    return null;
  }
}

export async function fetchText(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 15000,
      headers: { ...DEFAULT_HEADERS, ...extraHeaders },
      maxRedirects: 5,
      httpsAgent: SCRAPE_AGENT,
    });
    return res.data as string;
  } catch (err) {
    logger.warn({ url, err }, "hdhub4u-base: fetchText failed");
    return null;
  }
}

// ─── String Utils ─────────────────────────────────────────────────────────────

export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+details\s*$/i, "")
    // Strip quality, format, codec, and language noise
    .replace(
      /\b(720p|1080p|2160p|480p|4k|webrip|web-dl|bluray|hdtc|hevc|x265|x264|avc|10bit|hdr|sdr|dv|dd[0-9.]+|aac|hindi|english|dual|multi|tamil|telugu|punjabi|season\s*\d+|s\d{2}|e\d{2}|full\s*(?:movie|series)|all\s*episodes?|remux|dubbed|hard\s*coded|extended|theatrical|directors?\s*cut|unrated|remastered|restored)\b/gi,
      "",
    )
    // Strip year patterns: "(2024)", "[2024]", "– 2024", "- 2024", bare "2024"
    .replace(/[([–-]\s*(?:19[5-9]\d|20[0-2]\d)\s*[\])]?/g, " ")
    .replace(/\b(?:19[5-9]\d|20[0-2]\d)\b/g, "")
    .replace(/[()[\]]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function extractYear(text: string): string | undefined {
  const m = text.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? m[1] : undefined;
}

export function extractQuality(text: string): string {
  if (/2160p|4k/i.test(text)) return "4K";
  if (/1080p/i.test(text)) return "1080p";
  if (/720p/i.test(text)) return "720p";
  if (/480p/i.test(text)) return "480p";
  return "HD";
}

export function extractLanguage(text: string): string {
  if (/multi[\s-]?audio|multi[\s-]?lang/i.test(text)) return "Multi Audio";
  if (/dual[\s-]?audio/i.test(text)) return "Dual Audio";

  const found: string[] = [];
  if (/hindi/i.test(text)) found.push("Hindi");
  if (/english/i.test(text)) found.push("English");
  if (/tamil/i.test(text)) found.push("Tamil");
  if (/telugu/i.test(text)) found.push("Telugu");
  if (/punjabi/i.test(text)) found.push("Punjabi");
  if (/korean/i.test(text)) found.push("Korean");
  if (/japanese/i.test(text)) found.push("Japanese");
  if (/french/i.test(text)) found.push("French");

  if (found.length > 1) return found.join(" + ");
  if (found.length === 1) return found[0]!;
  return "Hindi";
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

export interface ResolvedStream {
  url: string;
  quality: string;
  host: string;
  size?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

function resolveTokenTTL(url: string): number {
  if (
    /[?&]token=/.test(url) ||
    /[?&]expires?=/.test(url) ||
    url.includes("googleusercontent.com") ||
    /\?[a-f0-9]{8,}$/.test(url)
  ) {
    return TTL.RESOLVE_TOKEN;
  }
  return TTL.RESOLVE;
}

export function detectHost(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("pixeldrain.com") || u.includes("pixeldrain.dev")) return "PixelDrain";
  if (u.includes("streamtape.")) return "StreamTape";
  if (u.includes("hubcloud.")) return "HubCloud";
  if (u.includes("hubdrive.")) return "HubDrive";
  if (u.includes("hblinks.") || u.includes("hubstreamdad.")) return "Hblinks";
  if (u.includes("hdstream4u.") || u.includes("hubstream.")) return "HdStream4u";
  if (u.includes("hubcdn.")) return "HUBCDN";
  if (u.includes("drive.google.com") || u.includes("docs.google.com")) return "GDrive";
  if (u.includes("gofile.io")) return "GoFile";
  if (u.includes("mp4upload.")) return "MP4Upload";
  if (u.includes("filemoon.")) return "FileMoon";
  if (u.includes("streamwish.") || u.includes("wishfast.")) return "StreamWish";
  if (u.includes("doodstream") || /dood\./.test(u)) return "DoodStream";
  if (u.includes("upstream.to")) return "UpStream";
  if (u.includes("mixdrop")) return "MixDrop";
  if (u.includes("1fichier")) return "1Fichier";
  if (u.includes("terabox")) return "TeraBox";
  return "Direct";
}

function getBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

async function resolvePixelDrain(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:pixeldrain:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const m = url.match(/\/(?:file|u)\/([a-zA-Z0-9]+)/);
    if (!m) return null;
    const fileId = m[1]!;

    const info = await axios.get<{ success: boolean }>(
      `https://pixeldrain.com/api/file/${fileId}/info`,
      { timeout: 7000, validateStatus: (s) => s < 500, headers: { "User-Agent": DEFAULT_UA } },
    );
    if (info.status !== 200 || info.data?.success !== true) {
      logger.warn({ fileId }, "PixelDrain file not available");
      return null;
    }

    const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
    cache.set(cacheKey, directUrl, resolveTokenTTL(directUrl));
    return directUrl;
  } catch (err) {
    logger.warn({ url, err }, "PixelDrain resolve failed");
    return null;
  }
}

async function resolveHubCloud(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:hubcloud2:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const baseUrl = getBaseUrl(url);
    const headers = {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    let downloadPageUrl = url;

    if (!url.includes("hubcloud.php")) {
      const $init = await fetchHtml(url, headers);
      if (!$init) return null;

      const dlEl = $init("#download");
      const xhref = dlEl.attr("x-href") ?? "";
      const href  = dlEl.attr("href") ?? "";

      let raw = href;
      if (!raw && xhref) {
        try {
          raw = Buffer.from(xhref, "base64").toString("utf8");
        } catch {
          raw = "";
        }
      }

      if (raw) {
        downloadPageUrl = raw.startsWith("http")
          ? raw
          : `${baseUrl}/${raw.replace(/^\//, "")}`;
      }
    }

    const $page = await fetchHtml(downloadPageUrl, headers);
    if (!$page) return null;

    let result: string | null = null;

    const buttons = $page("a.btn").toArray();
    for (const btn of buttons) {
      const link = $page(btn).attr("href") ?? "";
      const label = $page(btn).text().trim().toLowerCase();
      if (!link.startsWith("http") && !link.startsWith("//")) continue;
      const fullLink = link.startsWith("//") ? "https:" + link : link;

      if (
        label.includes("fsl server") || label.includes("fslv2") ||
        label.includes("s3 server") || label.includes("mega server") ||
        label.includes("download file")
      ) {
        result = fullLink;
        break;
      }

      if (label.includes("buzzserver") || label.includes("buzz server")) {
        try {
          const buzzRes = await axios.get(`${fullLink}/download`, {
            headers: { "User-Agent": DEFAULT_UA, Referer: fullLink },
            maxRedirects: 0,
            validateStatus: (s) => s < 400 || s === 302 || s === 301,
            timeout: 10000,
          });
          const redirect =
            (buzzRes.headers["hx-redirect"] as string | undefined) ??
            (buzzRes.headers["HX-Redirect"] as string | undefined) ??
            (buzzRes.headers["location"] as string | undefined);
          if (redirect) { result = redirect; break; }
        } catch (buzzErr) {
          logger.warn({ fullLink, buzzErr }, "HubCloud BuzzServer redirect failed");
        }
        continue;
      }

      if (
        label.includes("pixeldra") || label.includes("pixel server") ||
        label.includes("pixelserver") || label.includes("pixeldrain")
      ) {
        const checked = await resolvePixelDrain(fullLink);
        if (checked) { result = checked; break; }
        const pdBase = getBaseUrl(fullLink);
        result = `${pdBase}/api/file/${fullLink.split("/").pop()}?download`;
        break;
      }
    }

    if (!result) {
      for (const btn of buttons) {
        const link = $page(btn).attr("href") ?? "";
        if (link.startsWith("http")) { result = link; break; }
      }
    }

    if (result) {
      cache.set(cacheKey, result, resolveTokenTTL(result));
      logger.info({ url, result }, "HubCloud resolved");
      return result;
    }
  } catch (err) {
    logger.warn({ url, err }, "HubCloud resolve failed");
  }
  return null;
}

async function resolveHubDrive(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:hubdrive2:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const $ = await fetchHtml(url, { "User-Agent": DEFAULT_UA });
    if (!$) return null;

    const hubCloudHref = $(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href") ?? "";

    if (hubCloudHref.startsWith("http")) {
      let resolved: string | null = null;
      if (/hubcloud/i.test(hubCloudHref)) {
        resolved = await resolveHubCloud(hubCloudHref);
      } else {
        const r = await resolveLink(hubCloudHref, "HD");
        return r ? r.url : null;
      }
      if (resolved) {
        cache.set(cacheKey, resolved, resolveTokenTTL(resolved));
        return resolved;
      }
    }

    let fallback: string | null = null;
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (/hubcloud/i.test(href) && href.startsWith("http") && !fallback) {
        fallback = href;
      }
    });
    if (fallback) {
      const resolved = await resolveHubCloud(fallback as string);
      if (resolved) {
        cache.set(cacheKey, resolved, resolveTokenTTL(resolved));
        return resolved;
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "HubDrive resolve failed");
  }
  return null;
}

async function resolveHblinks(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:hblinks:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const $ = await fetchHtml(url, { "User-Agent": DEFAULT_UA });
    if (!$) return null;

    const links = $("h3 a, h5 a, div.entry-content p a").toArray();

    for (const el of links) {
      const href = ($(el).attr("href") ?? "").trim();
      if (!href.startsWith("http")) continue;
      const lower = href.toLowerCase();

      let resolved: string | null = null;
      if (lower.includes("hubdrive")) {
        resolved = await resolveHubDrive(href);
      } else if (lower.includes("hubcloud")) {
        resolved = await resolveHubCloud(href);
      } else if (lower.includes("hubcdn")) {
        resolved = await resolveHUBCDN(href);
      } else {
        resolved = (await resolveLink(href, "HD"))?.url ?? null;
      }

      if (resolved) {
        cache.set(cacheKey, resolved, resolveTokenTTL(resolved));
        return resolved;
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "Hblinks resolve failed");
  }
  return null;
}

async function resolveHUBCDN(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:hubcdn:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const $ = await fetchHtml(url, { "User-Agent": DEFAULT_UA });
    if (!$) return null;

    const scriptText = $("script:not([src])").toArray()
      .map((el) => $(el).html() ?? "")
      .find((s) => s.includes("reurl"));

    const encodedUrl = /reurl\s*=\s*"([^"]+)"/.exec(scriptText ?? "")?.[1]?.split("?r=")[1];

    if (encodedUrl) {
      const decoded = Buffer.from(encodedUrl, "base64").toString("utf8");
      const link = decoded.includes("link=")
        ? decoded.split("link=").pop()!.trim()
        : decoded.trim();
      if (link.startsWith("http")) {
        cache.set(cacheKey, link, resolveTokenTTL(link));
        return link;
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "HUBCDN resolve failed");
  }
  return null;
}

function decryptAesCbc(hexStr: string, key: string, iv: string): string {
  const keyBuf = Buffer.from(key, "utf8");
  const ivBuf = Buffer.from(iv, "utf8");
  const dataBuf = Buffer.from(hexStr, "hex");
  const decipher = createDecipheriv("aes-128-cbc", keyBuf, ivBuf);
  const dec = Buffer.concat([decipher.update(dataBuf), decipher.final()]);
  return dec.toString("utf8");
}

async function resolveHdStream4u(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:hdstream4u:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const base = getBaseUrl(url);
    const hash = url.split("#").pop()?.split("/").pop() ?? url.split("/").pop() ?? "";
    if (!hash) return null;

    const apiRes = await axios.get<string>(`${base}/api/v1/video?id=${hash}`, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
      },
      responseType: "text",
    });
    const encoded = (apiRes.data as string).trim();

    const KEY = "kiemtienmua911ca";
    const IVS = ["1234567890oiuytr", "0123456789abcdef"];

    let decrypted: string | null = null;
    for (const iv of IVS) {
      try {
        decrypted = decryptAesCbc(encoded, KEY, iv);
        break;
      } catch {
        continue;
      }
    }

    if (!decrypted) return null;

    const m3u8 = /"source"\s*:\s*"([^"]+)"/.exec(decrypted)?.[1]?.replace(/\\\//g, "/");
    if (m3u8) {
      const final = m3u8.replace(/^https/, "http");
      cache.set(cacheKey, final, resolveTokenTTL(final));
      return final;
    }
  } catch (err) {
    logger.warn({ url, err }, "HdStream4u resolve failed");
  }
  return null;
}

async function resolveStreamTape(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:streamtape:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const normalizedUrl = url.replace(/https?:\/\/[^/]*streamtape[^/]*/, "https://streamtape.com");
    const html = await fetchText(normalizedUrl, {
      Referer: normalizedUrl,
      Accept: "text/html,application/xhtml+xml",
    });
    if (!html) return null;

    for (const pat of [
      /getElementById\(['"]\s*videolink\s*['"]\)[^]*?innerHTML\s*=\s*['"](\/\/[^'"]+)['"]/,
      /robotlink['"]\s*\)\s*\.innerHTML\s*=\s*['"](\/\/[^'"]+)['"]/,
      /"(\/\/[^'"]+streamtape[^'"]+get_video[^'"]*)"/,
      /src:\s*['"](https?:\/\/[^'"]+\.(?:mp4|m3u8)[^'"]*)['"]/i,
    ]) {
      const m = pat.exec(html);
      if (m?.[1]) {
        const resolved = m[1].startsWith("//") ? "https:" + m[1] : m[1];
        if (resolved.startsWith("http")) {
          cache.set(cacheKey, resolved, resolveTokenTTL(resolved));
          return resolved;
        }
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "StreamTape resolve failed");
  }
  return null;
}

async function resolveFileMoon(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:filemoon:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const $ = await fetchHtml(url, { Referer: url });
    if (!$) return null;
    const html = $.html();
    for (const pat of [
      /file\s*:\s*['"]([^'"]+\.(?:mp4|mkv|m3u8)[^'"]*)['"]/i,
      /"sources"\s*:\s*\[.*?"file"\s*:\s*"([^"]+)"/is,
    ]) {
      const m = pat.exec(html);
      if (m?.[1]?.startsWith("http")) {
        cache.set(cacheKey, m[1]!, resolveTokenTTL(m[1]!));
        return m[1];
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "FileMoon resolve failed");
  }
  return null;
}

async function resolveStreamWish(url: string): Promise<string | null> {
  const cacheKey = `hdhub4u-resolve:streamwish:${url}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  try {
    const $ = await fetchHtml(url, { Referer: url });
    if (!$) return null;
    const html = $.html();
    for (const pat of [
      /file\s*:\s*['"]([^'"]+\.(?:mp4|mkv|m3u8)[^'"]*)['"]/i,
      /"sources"\s*:\s*\[.*?"file"\s*:\s*"([^"]+)"/is,
    ]) {
      const m = pat.exec(html);
      if (m?.[1]?.startsWith("http")) {
        cache.set(cacheKey, m[1]!, resolveTokenTTL(m[1]!));
        return m[1];
      }
    }
  } catch (err) {
    logger.warn({ url, err }, "StreamWish resolve failed");
  }
  return null;
}

export async function resolveLink(url: string, qualityHint = "HD"): Promise<ResolvedStream | null> {
  if (!url || !url.startsWith("http")) return null;

  const host = detectHost(url);
  let resolved: string | null = null;

  switch (host) {
    case "PixelDrain":
      resolved = await resolvePixelDrain(url);
      break;
    case "HubCloud":
      resolved = await resolveHubCloud(url);
      break;
    case "HubDrive":
      resolved = await resolveHubDrive(url);
      break;
    case "Hblinks":
      resolved = await resolveHblinks(url);
      break;
    case "HdStream4u":
      resolved = await resolveHdStream4u(url);
      break;
    case "HUBCDN":
      resolved = await resolveHUBCDN(url);
      break;
    case "StreamTape":
      resolved = await resolveStreamTape(url);
      break;
    case "FileMoon":
      resolved = await resolveFileMoon(url);
      break;
    case "StreamWish":
      resolved = await resolveStreamWish(url);
      break;
    case "GDrive":
    case "GoFile":
      resolved = null;
      break;
    case "Direct":
      if (/\.(mp4|mkv|avi|m3u8)/i.test(url)) resolved = url;
      break;
    default:
      resolved = url;
  }

  if (!resolved) return null;
  return { url: resolved, quality: qualityHint, host };
}
