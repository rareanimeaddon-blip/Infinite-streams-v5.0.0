import * as cheerio from "cheerio";
import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

export type NestedResolver = (url: string, referer: string, depth: number) => Promise<Stream[]>;

export async function extractGeneric(url: string, referer?: string, nestedResolver?: NestedResolver, depth = 0, prefetchedHtml?: string): Promise<Stream[]> {
  logger.info({ url }, "Generic extract");
  const streams: Stream[] = [];
  try {
    const html = prefetchedHtml ?? await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" }, timeout: 10000 });
    const $ = cheerio.load(html);
    const scripts = $("script:not([src])").map((_, el) => $(el).html() || "").get();
    const seen = new Set<string>();
    for (const script of scripts) {
      for (const streamUrl of [...extractUrlsFromScript(script), ...(extractUrlsFromScript(unpackEval(script) || ""))]) {
        if (seen.has(streamUrl)) continue; seen.add(streamUrl);
        streams.push({ name: "AnimeDekho | Stream", title: streamUrl.includes(".m3u8") ? "HLS Stream" : "MP4 Stream", url: streamUrl, type: streamUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
      }
    }
    if (streams.length === 0) {
      for (const m of [...html.matchAll(/["'`](https?:\/\/[^"'`\s<>]+\.m3u8[^"'`\s<>]*?)["'`]/g), ...html.matchAll(/["'`](https?:\/\/[^"'`\s<>]+\.mp4[^"'`\s<>]*?)["'`]/g)]) {
        if (seen.has(m[1])) continue; seen.add(m[1]);
        streams.push({ name: "AnimeDekho | Stream", title: m[1].includes(".m3u8") ? "HLS Stream" : "MP4 Stream", url: m[1], type: m[1].includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } } });
      }
    }
    if (streams.length === 0 && nestedResolver && depth < 1) {
      const iframeSrcs = $("iframe[src], iframe[data-src]").map((_, el) => $(el).attr("src") || $(el).attr("data-src") || "").get().map((s) => s.startsWith("//") ? "https:" + s : s).filter((s) => s.startsWith("http") && !s.includes("animedekho.app/aaa/"));
      if (iframeSrcs.length > 0) {
        const resolved = await Promise.allSettled(iframeSrcs.map((src) => nestedResolver(src, url, depth + 1)));
        for (const r of resolved) { if (r.status === "fulfilled") streams.push(...r.value); }
      }
    }
  } catch (err) { logger.error({ url, err }, "Generic extract error"); }
  return streams;
}
