import * as cheerio from "cheerio";
import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import { isGDMirrorbot, extractGDMirrorbot, type GDMirrorbotResolver } from "./gdmirrorbot.js";
import type { Stream } from "./index.js";

export type LoadMyFileResolver = (url: string, referer: string, depth: number) => Promise<Stream[]>;

// All known LoadMyFile / IQSmartGames domains
const LMF_HOSTS = [
  "iqsmartgames.com/files/",
  "pro.iqsmartgames.com/files/",
];

export function isLoadMyFile(url: string): boolean {
  return LMF_HOSTS.some((h) => url.includes(h));
}

// GDMirrorbot embed domains to try with the embedded gdmrid
const GDMR_EMBED_HOSTS = [
  "gdmirrorbot.nl",
  "stream.techinmind.space",
];

/**
 * Extracts streams from a LoadMyFile page (pro.iqsmartgames.com/files/...).
 *
 * Strategy (in order):
 *  1. Extract `const gdmrid = "..."` from inline JS → try each GDMirrorbot embed host.
 *  2. Parse mirror-item list; try any recognized extractable hosts (Filemoon, Voe, etc.)
 *     via the resolver if a non-CF URL can be derived.
 *  3. Fall back to `const fileurl = "..."` as a direct download URL.
 */
export async function extractLoadMyFile(
  url: string,
  referer = "https://animedekho.app/",
  resolver?: LoadMyFileResolver,
): Promise<Stream[]> {
  logger.info({ url }, "LoadMyFile: starting extraction");

  let html: string;
  try {
    html = await fetchText(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: referer,
      },
    });
  } catch (err) {
    logger.error({ url, err }, "LoadMyFile: page fetch failed");
    return [];
  }

  // ─── 1. GDMirrorbot via embedded gdmrid ──────────────────────────────────────
  const gdmridMatch = html.match(/const\s+gdmrid\s*=\s*["']([^"']+)["']/);
  if (gdmridMatch) {
    const gdmrId = gdmridMatch[1];
    logger.info({ gdmrId }, "LoadMyFile: found gdmrid, trying GDMirrorbot hosts");

    for (const host of GDMR_EMBED_HOSTS) {
      const embedUrl = `https://${host}/e/${gdmrId}`;
      if (!isGDMirrorbot(embedUrl)) continue;

      try {
        const gdmResolver: GDMirrorbotResolver | undefined = resolver
          ? (u: string, r: string) => resolver(u, r, 1)
          : undefined;
        const streams = await extractGDMirrorbot(embedUrl, url, gdmResolver);
        if (streams.length > 0) {
          logger.info({ host, count: streams.length }, "LoadMyFile: GDMirrorbot succeeded");
          return streams.map((s) => ({
            ...s,
            name: "AnimeDekho | MirrorBot",
          }));
        }
      } catch (err) {
        logger.warn({ host, err }, "LoadMyFile: GDMirrorbot host failed");
      }
    }
  }

  // ─── 2. Parse mirror list for any recognisable embed links ───────────────────
  //    The "Visit" hrefs are Cloudflare-protected (/vpage?... stays at CF), so we
  //    can't follow them server-side. But if the page embeds any video iframes
  //    directly we can try them.
  if (resolver) {
    const $ = cheerio.load(html);
    const embedIframes: string[] = [];
    const seen = new Set<string>();
    $("iframe[src], iframe[data-src]").each((_, el) => {
      const src = ($(el).attr("src") ?? $(el).attr("data-src") ?? "").trim();
      if (!src.startsWith("http")) return;
      if (src.includes("iqsmartgames.com") || src.includes("youtube.com")) return;
      if (!seen.has(src)) { seen.add(src); embedIframes.push(src); }
    });

    if (embedIframes.length > 0) {
      logger.info({ embedIframes }, "LoadMyFile: found embed iframes, resolving");
      const results = await Promise.allSettled(
        embedIframes.map((u) => resolver(u, url, 1))
      );
      const iframeStreams: Stream[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") iframeStreams.push(...r.value);
      }
      if (iframeStreams.length > 0) {
        return iframeStreams.map((s) => ({ ...s, name: "AnimeDekho | MirrorBot" }));
      }
    }
  }

  // ─── 3. fileurl fallback — direct Cloudflare worker download link ─────────────
  const fileurlMatch = html.match(/const\s+fileurl\s*=\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/);
  if (fileurlMatch) {
    const fileUrl = fileurlMatch[1].replace(/\\\//g, "/");
    if (fileUrl.startsWith("http")) {
      const filenameMatch = html.match(/const\s+filename\s*=\s*["']([^"']+)["']/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : "";
      const qualityMatch = filename.match(/(\d{3,4}p)/i);
      const quality = qualityMatch ? qualityMatch[1] : "HD";
      logger.info({ fileUrl, quality }, "LoadMyFile: using fileurl fallback");
      return [{
        name: "AnimeDekho | MirrorBot",
        title: `${quality} [Direct Link]`,
        url: fileUrl,
        type: "url",
        behaviorHints: { notWebReady: false },
      }];
    }
  }

  logger.warn({ url }, "LoadMyFile: no streams found");
  return [];
}
