import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import type { Stream } from "./index.js";

const STREAMTAPE_HOSTS = ["streamtape.com", "streamtape.to", "streamtape.net", "streamtape.xyz", "streamtape.cc", "streamtape.ca", "tapecontent.net"];
export function isStreamTape(url: string): boolean { return STREAMTAPE_HOSTS.some((h) => url.includes(h)); }

export async function extractStreamTape(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "StreamTape extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const part1Match = html.match(/getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]/);
    const part2Match = html.match(/\+\s*\(['"]([^'"]+)['"]\)\.substring\((\d+)\)/);
    if (part1Match && part2Match) {
      const videoUrl = "https:" + part1Match[1]! + part2Match[1]!.substring(parseInt(part2Match[2]!));
      streams.push({ name: "AnimeDekho | StreamTape", title: "StreamTape MP4", url: videoUrl, type: "url", behaviorHints: { notWebReady: true, headers: { Referer: url }, proxyHeaders: { request: { Referer: url } } } });
      return streams;
    }
    const directMatch = html.match(/["'](https?:\/\/[^"'\s]+tapecontent[^"'\s]+\.mp4[^"'\s]*)["']/);
    if (directMatch) {
      streams.push({ name: "AnimeDekho | StreamTape", title: "StreamTape MP4", url: directMatch[1]!, type: "url", behaviorHints: { notWebReady: true, headers: { Referer: url }, proxyHeaders: { request: { Referer: url } } } });
    }
  } catch (err) { logger.error({ url, err }, "StreamTape extract error"); }
  return streams;
}
