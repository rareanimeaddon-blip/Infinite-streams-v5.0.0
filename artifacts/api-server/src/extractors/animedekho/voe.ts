import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import type { Stream } from "./index.js";

const VOE_HOSTS = ["voe.sx", "voe.bar", "voe.cx", "voe.gg", "voe.pm", "voe.al", "voe.net", "v1.voe-dn.net"];
export function isVoe(url: string): boolean { return VOE_HOSTS.some((h) => url.includes(h)); }

export async function extractVoe(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "Voe extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const hlsMatch = html.match(/'hls'\s*:\s*'([^']+\.m3u8[^']*)'/) || html.match(/"hls"\s*:\s*"([^"]+\.m3u8[^"]*)"/) || html.match(/hlsUrl\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
    if (hlsMatch) {
      streams.push({ name: "AnimeDekho | Voe", title: "Voe HLS", url: hlsMatch[1]!, type: "hls", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
      return streams;
    }
    const mp4Match = html.match(/'mp4'\s*:\s*'([^']+\.mp4[^']*)'/) || html.match(/"mp4"\s*:\s*"([^"]+\.mp4[^"]*)"/) || html.match(/["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*)["']/);
    if (mp4Match) {
      streams.push({ name: "AnimeDekho | Voe", title: "Voe MP4", url: mp4Match[1]!, type: "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
    }
  } catch (err) { logger.error({ url, err }, "Voe extract error"); }
  return streams;
}
