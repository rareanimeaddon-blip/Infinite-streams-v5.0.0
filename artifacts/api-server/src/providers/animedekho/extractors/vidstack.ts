import * as cheerio from "cheerio";
import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import type { Stream } from "./index.js";

const VIDSTACK_HOSTS = ["vidstack.net", "vidcloud.upns.ink", "cloudy.upns.one", "upns.ink", "upns.one"];
export function isVidStack(url: string): boolean { return VIDSTACK_HOSTS.some((h) => url.includes(h)); }

export async function extractVidStack(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "VidStack extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const $ = cheerio.load(html);
    const scripts = $("script").map((_, el) => $(el).html() || "").get().join("\n");
    const m3u8Match = scripts.match(/src\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/) || scripts.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*?)["']/) || scripts.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/);
    if (m3u8Match) {
      let vsOrigin = "";
      try { vsOrigin = new URL(url).origin; } catch {}
      streams.push({
        name: "AnimeDekho | VidStack",
        title: "VidStack HLS",
        url: m3u8Match[1]!,
        type: "hls",
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { Referer: url, Origin: vsOrigin } },
        },
      });
    }
    const sourceEl = $("source[src]");
    if (sourceEl.length && !m3u8Match) {
      const src = sourceEl.attr("src")!;
      let vsOrigin = "";
      try { vsOrigin = new URL(url).origin; } catch {}
      streams.push({
        name: "AnimeDekho | VidStack",
        title: "VidStack",
        url: src,
        type: src.includes(".m3u8") ? "hls" : "url",
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { Referer: url, Origin: vsOrigin } },
        },
      });
    }
  } catch (err) { logger.error({ url, err }, "VidStack extract error"); }
  return streams;
}
