import { fetchText } from "../../utils/fetch.js";
import * as cheerio from "cheerio";
import { logger } from "../../lib/logger.js";
import type { Stream } from "./index.js";

const VIDHIDE_HOSTS = ["animezia.cloud", "vidhide.com", "vidhidepro.com", "vidhidepro.net", "vidhidepre.com", "vidhidevip.com", "luluvdo.com", "flaswish.com"];
export function isVidHide(url: string): boolean { return VIDHIDE_HOSTS.some((h) => url.includes(h)); }

export async function extractVidHide(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "VidHide extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const $ = cheerio.load(html);
    const scripts = $("script:not([src])").map((_, el) => $(el).html() || "").get().join("\n");
    const m3u8Match = scripts.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/) || scripts.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/) || html.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/);
    if (m3u8Match) {
      streams.push({ name: "AnimeDekho | VidHide", title: "VidHide HLS", url: m3u8Match[1]!, type: "hls", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
    }
  } catch (err) { logger.error({ url, err }, "VidHide extract error"); }
  return streams;
}
