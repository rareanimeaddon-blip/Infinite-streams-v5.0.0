import * as cheerio from "cheerio";
import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const STREAMRUBY_HOSTS = ["rubystm.com", "streamruby.com", "ruby.stream"];
export function isStreamRuby(url: string): boolean { return STREAMRUBY_HOSTS.some((h) => url.includes(h)); }

const NOT_FOUND_MARKERS = ["File Not Found", "file not found", "notfound", "not-found", "Server Error (Link)", "server error", "This video has been removed", "Video Not Found"];
function isNotFoundPage(html: string): boolean { return NOT_FOUND_MARKERS.some((m) => html.includes(m)); }

export async function extractStreamRuby(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "StreamRuby extract");
  const streams: Stream[] = [];
  try {
    const cleanedUrl = url.replace(/\/e\//, "/").replace(/\/e$/, "");
    const html = await fetchText(cleanedUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Referer: referer || "https://animedekho.app/" } });
    if (isNotFoundPage(html)) { logger.info({ url }, "StreamRuby: file not found — skipping"); return []; }
    const $ = cheerio.load(html);
    const scripts = $("script:not([src])").map((_, el) => $(el).html() || "").get();
    const rawScriptContent = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
    const allScriptSources = new Set([...scripts, rawScriptContent]);
    const streamUrls: string[] = [];
    for (const script of allScriptSources) {
      if (!script.trim()) continue;
      streamUrls.push(...extractUrlsFromScript(script));
      const unpacked = unpackEval(script);
      if (unpacked) streamUrls.push(...extractUrlsFromScript(unpacked));
    }
    if (streamUrls.length === 0) {
      for (const m of [...html.matchAll(/["'`](https?:\/\/[^"'`\s<>]+\.m3u8[^"'`\s<>]*?)["'`]/g), ...html.matchAll(/["'`](https?:\/\/[^"'`\s<>]+\.mp4[^"'`\s<>]*?)["'`]/g)]) {
        if (m[1] && !m[1].includes("example")) streamUrls.push(m[1]);
      }
    }
    const seen = new Set<string>();
    for (const streamUrl of streamUrls) {
      if (seen.has(streamUrl)) continue; seen.add(streamUrl);
      streams.push({ name: "AnimeDekho | StreamRuby", title: streamUrl.includes(".m3u8") ? "HLS Stream" : "MP4 Stream", url: streamUrl, type: streamUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Origin: "https://rubystm.com", Referer: "https://rubystm.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } } } });
    }
  } catch (err) { logger.error({ url, err }, "StreamRuby extract error"); }
  return streams;
}
