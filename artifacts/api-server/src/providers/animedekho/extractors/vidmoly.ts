import * as cheerio from "cheerio";
import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import type { Stream } from "./index.js";

const VIDMOLY_HOSTS = ["vidmoly.to", "vidmoly.net", "vidmoly.me", "vidmoly.biz", "emturbovid.com", "turbovidhls.com", "turboviplay.com", "turbosplayer.com"];
export function isVidmoly(url: string): boolean { return VIDMOLY_HOSTS.some((h) => url.includes(h)); }

export async function extractVidmoly(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "Vidmoly extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const $ = cheerio.load(html);
    const scriptContent = $("script").map((_, el) => $(el).html() || "").get().join("\n");
    const m3u8Match = scriptContent.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/) || scriptContent.match(/source\s*:\s*\{[^}]*file\s*:\s*["']([^"']+)["']/) || html.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/);
    if (m3u8Match) {
      streams.push({ name: "AnimeDekho | Vidmoly", title: "Vidmoly HLS", url: m3u8Match[1]!, type: "hls", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
    }
  } catch (err) { logger.error({ url, err }, "Vidmoly extract error"); }
  return streams;
}
