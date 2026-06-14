import * as cheerio from "cheerio";
import { fetchText } from "../../utils/fetch.js";
import { logger } from "../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const STREAMWISH_HOSTS = [
  "streamwish.com", "streamwish.to", "streamwish.site", "cdnwish.com",
  "multimovies.cloud", "wishfast.top", "awish.one", "filelions.top",
  "filelions.online", "strwish.com", "jodwish.com", "sfastwish.com",
  "swdyu.com", "asnwish.com", "dwish.tv", "flaswish.com",
  "playwish.xyz", "hlswish.com", "strmwish.com", "embedwish.com",
  // StreamHG (smwh key) — GDMirrorbot tier-0; uses JWPlayer + Plyr stack
  "streamhg.com", "streamhg.net", "streamhg.to", "streamhg.xyz",
  // techxpremium.store (smwh key) — live StreamHG embed host
  "techxpremium.store",
  // rpmplay.xyz (rpmshre key) — live RPMShare embed host
  "rpmplay.xyz",
  // p2pstream.vip (strmp2 key) — live StreamP2p embed host
  "p2pstream.vip",
  // rpmsphere / oneupload (rpmshre key)
  "rpmsphere.xyz", "rpmsphere.com", "rpmsphere.net",
  "oneupload.to",
  // StreamP2 fallback domains
  "streamp2.com", "streamp2.net", "streamp2.xyz",
  // Other GDMirrorbot providers
  "kknfl.xyz", "kknfl.com", "onupdates.in", "onupdates.xyz",
  "flls.xyz", "flls.com", "onud.xyz",
];

export function isStreamWish(url: string): boolean {
  return STREAMWISH_HOSTS.some((h) => url.includes(h));
}

export async function extractStreamWish(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "StreamWish extract");
  const streams: Stream[] = [];
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };
    if (referer) { headers["Referer"] = referer; try { headers["Origin"] = new URL(referer).origin; } catch {} }
    const html = await fetchText(url, { headers });
    const $ = cheerio.load(html);
    const scriptContents = $("script:not([src])").map((_, el) => $(el).html() || "").get();
    const seen = new Set<string>();
    const subtitles: Array<{ lang: string; url: string }> = [];

    const allCandidates: string[] = [];
    for (const script of scriptContents) {
      allCandidates.push(script);
      const unpacked = unpackEval(script);
      if (unpacked) allCandidates.push(unpacked);
    }

    for (const candidate of allCandidates) {
      for (const streamUrl of extractUrlsFromScript(candidate)) {
        if (seen.has(streamUrl)) continue;
        seen.add(streamUrl);
        streams.push({
          name: "AnimeDekho | StreamWish",
          title: streamUrl.includes(".m3u8") ? "StreamWish HLS" : "StreamWish MP4",
          url: streamUrl,
          type: streamUrl.includes(".m3u8") ? "hls" : "url",
          behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } },
        });
      }
      // JWPlayer / generic subtitle tracks: {file:"...vtt",label:"English",kind:"captions"}
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

    if (streams.length === 0) {
      const rawMatches = [
        ...html.matchAll(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/g),
        ...html.matchAll(/["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*?)["']/g),
      ];
      for (const m of rawMatches) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        streams.push({
          name: "AnimeDekho | StreamWish",
          title: m[1].includes(".m3u8") ? "StreamWish HLS" : "StreamWish MP4",
          url: m[1],
          type: m[1].includes(".m3u8") ? "hls" : "url",
          behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url } } },
        });
      }
    }

    if (subtitles.length) {
      for (const s of streams) s.subtitles = subtitles;
    }
  } catch (err) { logger.error({ url, err }, "StreamWish extract error"); }
  return streams;
}
