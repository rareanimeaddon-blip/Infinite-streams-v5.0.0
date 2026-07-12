import * as cheerio from "cheerio";
import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const FILEMOON_HOSTS = [
  "filemoon.sx", "filemoon.nl", "filemoon.in", "filemoon.to",
  "filemoon.wf", "filemoon.lol", "moonembed.app", "filesim.com",
  "kerapoxy.cc", "crackstreams.org", "smoothpre.com", "multimoviesshg.com",
  "bysefujedu.com", "bysetayico.com", "listeamed.net", "newer.stream",
  "rubyvidhub.com", "earnvids.com",
];

export function isFileMoon(url: string): boolean {
  return FILEMOON_HOSTS.some((h) => url.includes(h));
}

function jsUnpack(packed: string): string {
  try {
    const match = packed.match(/eval\(function\(p,a,c,k,e,(?:d|r)\).*?\('(.*?)',(\d+),(\d+),'(.*?)'\.split/s);
    if (!match) return packed;
    const [, p, aStr, , kStr] = match;
    const a = parseInt(aStr!);
    const k = kStr!.split("|");
    let result = p!;
    for (let i = k.length - 1; i >= 0; i--) {
      if (k[i]) result = result.replace(new RegExp(`\\b${i.toString(a)}\\b`, "g"), k[i]!);
    }
    return result;
  } catch { return packed; }
}

export async function extractFileMoon(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "FileMoon extract");
  const streams: Stream[] = [];
  try {
    let filemoonOrigin = "https://filemoon.sx";
    try { filemoonOrigin = new URL(url).origin; } catch {}

    const html = await fetchText(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": referer || "https://animedekho.app/",
        "Origin": filemoonOrigin,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    const $ = cheerio.load(html);
    const seen = new Set<string>();

    const addStream = (streamUrl: string) => {
      if (seen.has(streamUrl)) return;
      seen.add(streamUrl);
      const isHls = streamUrl.includes(".m3u8");
      streams.push({
        name: "AnimeDekho | FileMoon",
        title: isHls ? "FileMoon HLS" : "FileMoon MP4",
        url: streamUrl,
        type: isHls ? "hls" : "url",
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              Referer: url,
              Origin: filemoonOrigin,
            },
          },
        },
      });
    };

    const subtitles: Array<{ lang: string; url: string }> = [];

    $("script:not([src])").each((_, el) => {
      const text = $(el).html() || "";
      const candidates = [text];
      const improved = unpackEval(text); if (improved) candidates.push(improved);
      const legacy = jsUnpack(text); if (legacy !== text) candidates.push(legacy);
      for (const candidate of candidates) {
        // Standard m3u8/mp4 URL extraction
        for (const streamUrl of extractUrlsFromScript(candidate)) {
          addStream(streamUrl);
        }
        // JWPlayer sources format: sources:[{file:"..."}]
        for (const m of candidate.matchAll(/["']?file["']?\s*:\s*["']([^"']+\.m3u8[^"']*)["']/g)) {
          if (m[1]) addStream(m[1]);
        }
        for (const m of candidate.matchAll(/["']?file["']?\s*:\s*["']([^"']+\.mp4[^"']*)["']/g)) {
          if (m[1]) addStream(m[1]);
        }
        // JWPlayer subtitle tracks: {file:"...vtt",label:"English",kind:"captions"}
        for (const m of candidate.matchAll(/\{[^{}]{0,300}\}/g)) {
          const chunk = m[0];
          if (!chunk.includes("captions") && !chunk.includes("subtitles")) continue;
          const fileM = chunk.match(/["']?file["']?\s*:\s*["']([^"']+\.vtt[^"']*)["']/);
          const labelM = chunk.match(/["']?label["']?\s*:\s*["']([^"']+)["']/);
          if (fileM?.[1]) {
            const subUrl = fileM[1];
            if (!subtitles.some((s) => s.url === subUrl))
              subtitles.push({ lang: labelM?.[1] ?? "Unknown", url: subUrl });
          }
        }
      }
    });

    if (subtitles.length) {
      for (const s of streams) s.subtitles = subtitles;
    }

    if (seen.size === 0) {
      for (const m of [
        ...html.matchAll(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/g),
        ...html.matchAll(/["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*?)["']/g),
      ]) {
        if (m[1]) addStream(m[1]);
      }
    }
  } catch (err) { logger.error({ url, err }, "FileMoon extract error"); }
  return streams;
}
