import * as cheerio from "cheerio";
import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import type { Stream } from "./index.js";

const ANIMEDEKHOCO_HOSTS = ["animedekho.co", "animedekho.online"];
export function isAnimeDekhoCoHost(url: string): boolean { return ANIMEDEKHOCO_HOSTS.some((h) => url.includes(h)); }

export async function extractAnimeDekhoCoHost(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "AnimeDekhoCoHost extract");
  const streams: Stream[] = [];
  try {
    const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" };
    if (url.includes("url=")) {
      const html = await fetchText(url, { headers });
      const $ = cheerio.load(html);
      $("select#serverSelector option").each((_, el) => {
        const link = $(el).attr("value") || "";
        const name = $(el).text().trim() || "Unknown";
        if (link.trim()) streams.push({ name: `AnimeDekho | ${name}`, title: name, url: link, type: link.includes(".m3u8") ? "hls" : "url" });
      });
    } else {
      const text = await fetchText(url, { headers });
      const fileMatch = text.match(/file\s*:\s*["']([^"']+)["']/);
      if (fileMatch) streams.push({ name: "AnimeDekho | AnimeDekhoCoHost", title: "Player File", url: fileMatch[1]!, type: fileMatch[1]!.includes(".m3u8") ? "hls" : "url" });
    }
  } catch (err) { logger.error({ url, err }, "AnimeDekhoCoHost extract error"); }
  return streams;
}
