import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const MP4UPLOAD_HOSTS = ["mp4upload.com", "www.mp4upload.com"];
export function isMp4Upload(url: string): boolean { return MP4UPLOAD_HOSTS.some((h) => url.includes(h)); }

export async function extractMp4Upload(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "Mp4Upload extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" }, timeout: 10000 });
    if (!html) return streams;
    const fileMatch = html.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/) || html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/);
    if (fileMatch) {
      streams.push({ name: "AnimeDekho | Mp4Upload", title: "Mp4Upload MP4", url: fileMatch[1]!, type: "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
      return streams;
    }
    for (const sm of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]) {
      const script = sm[1]!;
      const unpacked = unpackEval(script);
      const src = unpacked ? extractUrlsFromScript(unpacked) : extractUrlsFromScript(script);
      for (const streamUrl of src) {
        if (streamUrl.includes(".mp4") || streamUrl.includes(".m3u8")) {
          streams.push({ name: "AnimeDekho | Mp4Upload", title: streamUrl.includes(".m3u8") ? "Mp4Upload HLS" : "Mp4Upload MP4", url: streamUrl, type: streamUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
        }
      }
      if (streams.length > 0) break;
    }
  } catch (err) { logger.error({ url, err }, "Mp4Upload extract error"); }
  return streams;
}
