import * as cheerio from "cheerio";
import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const ASCDN_HOSTS = ["zephyrflick.top", "anikl.com"];
export function isAsCdn(url: string): boolean {
  if (url.includes("as-cdn21.top")) return false;
  if (url.includes("as-cdn")) return true;
  return ASCDN_HOSTS.some((h) => url.includes(h));
}

export async function extractAsCdn(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "AsCdn extract");
  const streams: Stream[] = [];
  try {
    const html = await fetchText(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" } });
    const $ = cheerio.load(html);
    const innerIframe = $("iframe").attr("src");
    if (innerIframe && innerIframe.startsWith("http")) {
      const innerHtml = await fetchText(innerIframe, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: url } });
      const $inner = cheerio.load(innerHtml);
      const innerScripts = $inner("script:not([src])").map((_, el) => $inner(el).html() || "").get();
      for (const script of innerScripts) {
        const streamUrls = [...extractUrlsFromScript(script), ...(extractUrlsFromScript(unpackEval(script) || ""))];
        for (const streamUrl of streamUrls) {
          streams.push({ name: "AnimeDekho | VidStream", title: streamUrl.includes(".m3u8") ? "HLS Stream" : "MP4 Stream", url: streamUrl, type: streamUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, headers: { Referer: innerIframe, Origin: (() => { try { return new URL(innerIframe).origin; } catch { return innerIframe; } })() }, proxyHeaders: { request: { Referer: innerIframe } } } });
        }
      }
    }
    const scripts = $("script:not([src])").map((_, el) => $(el).html() || "").get();
    const seen = new Set<string>(streams.map((s) => s.url));
    for (const script of scripts) {
      for (const streamUrl of [...extractUrlsFromScript(script), ...(extractUrlsFromScript(unpackEval(script) || ""))]) {
        if (seen.has(streamUrl)) continue; seen.add(streamUrl);
        streams.push({ name: "AnimeDekho | VidStream", title: streamUrl.includes(".m3u8") ? "HLS Stream" : "MP4 Stream", url: streamUrl, type: streamUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, headers: { Referer: url, Origin: (() => { try { return new URL(url).origin; } catch { return url; } })() }, proxyHeaders: { request: { Referer: url } } } });
      }
    }
  } catch (err) { logger.error({ url, err }, "AsCdn extract error"); }
  return streams;
}
