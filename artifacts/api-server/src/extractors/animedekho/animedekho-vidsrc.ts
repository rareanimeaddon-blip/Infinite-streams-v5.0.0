import * as cheerio from "cheerio";
import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import { extractUrlsFromScript, unpackEval } from "../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

export function isAnimeDekhoVidSrc(url: string): boolean { return url.includes("animedekho.app/aaa/ad/vidsrc/"); }

export async function extractAnimeDekhoVidSrc(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "AnimeDekhoVidSrc extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    if (!html) return streams;
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const addStream = (videoUrl: string, label = "Direct Video") => {
      if (!videoUrl.startsWith("http") || seen.has(videoUrl)) return;
      seen.add(videoUrl);
      const isGD = videoUrl.includes("googleusercontent.com") || videoUrl.includes("drive.google.com");
      streams.push({ name: isGD ? "AnimeDekho | Google Drive" : "AnimeDekho | VidSrc", title: label.replace("No-Forward-Backward", "Direct Video"), url: videoUrl, type: videoUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: !isGD } });
    };
    $("select option[value]").each((_, el) => { const v = $(el).attr("value") || ""; if (v) addStream(v, $(el).attr("data-label") || $(el).text().trim() || "Direct"); });
    const scripts = $("script:not([src])").map((_, el) => $(el).html() || "").get();
    for (const script of scripts) {
      for (const u of [...extractUrlsFromScript(script), ...(extractUrlsFromScript(unpackEval(script) || ""))]) {
        if (u.includes("googleusercontent.com") || u.includes("drive.google.com") || u.includes(".m3u8") || u.includes(".mp4")) addStream(u, "Direct Video");
      }
    }
    if (streams.length === 0) {
      for (const m of html.matchAll(/["'`](https?:\/\/(?:video-downloads\.googleusercontent\.com|drive\.google\.com)\/[^"'`\s<>]{10,})["'`]/g)) addStream(m[1]!, "Direct Video");
    }
  } catch (err) { logger.error({ url, err }, "AnimeDekhoVidSrc extract error"); }
  return streams;
}
