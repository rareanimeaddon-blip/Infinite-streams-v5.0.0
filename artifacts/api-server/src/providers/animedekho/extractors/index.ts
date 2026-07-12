import { logger } from "../../../lib/logger.js";
import { isVidStack, extractVidStack } from "./vidstack.js";
import { isStreamWish, extractStreamWish } from "./streamwish.js";
import { isFileMoon, extractFileMoon } from "./filemoon.js";
import { isVidmoly, extractVidmoly } from "./vidmoly.js";

import { isGDMirrorbot, extractGDMirrorbot, type GDMirrorbotResolver } from "./gdmirrorbot.js";
import { isAWSStream, extractAWSStream } from "./awsstream.js";
import { isStreamRuby, extractStreamRuby } from "./streamruby.js";
import { isVidHide, extractVidHide } from "./vidhide.js";
import { isAnimeDekhoCoHost, extractAnimeDekhoCoHost } from "./animedekhoco.js";
import { isBlakiteApi, extractBlakiteApi } from "./blakiteapi.js";
import { isAsCdn, extractAsCdn } from "./ascdn.js";
import { isVoe, extractVoe } from "./voe.js";
import { isStreamTape, extractStreamTape } from "./streamtape.js";
import { isDoodStream, extractDoodStream } from "./doodstream.js";
import { isMp4Upload, extractMp4Upload } from "./mp4upload.js";
import { isAnimeDekhoVidSrc, extractAnimeDekhoVidSrc } from "./animedekho-vidsrc.js";
import { isLoadMyFile, extractLoadMyFile } from "./loadmyfile.js";
import { extractGeneric, type NestedResolver } from "./generic.js";

export interface Stream {
  name: string;
  title: string;
  url: string;
  type?: "hls" | "url" | "torrent";
  subtitles?: Array<{ lang: string; url: string; id?: string }>;
  behaviorHints?: {
    notWebReady?: boolean;
    headers?: Record<string, string>;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

export type ExtractorFn = (url: string, referer?: string) => Promise<Stream[]>;

interface Extractor {
  name: string;
  matches: (url: string) => boolean;
  extract: ExtractorFn;
}

const EXTRACTORS: Extractor[] = [
  { name: "LoadMyFile",       matches: isLoadMyFile,       extract: (url, ref) => extractLoadMyFile(url, ref, (u, r, d) => resolveExtractor(u, r, d)) },
  { name: "StreamRuby",       matches: isStreamRuby,       extract: extractStreamRuby },
  { name: "AnimeDekhoVidSrc", matches: isAnimeDekhoVidSrc, extract: extractAnimeDekhoVidSrc },
  { name: "AWSStream",        matches: isAWSStream,        extract: extractAWSStream },
  { name: "AsCdn",            matches: isAsCdn,            extract: extractAsCdn },
  { name: "GDMirrorbot",      matches: isGDMirrorbot,      extract: (url, ref) => extractGDMirrorbot(url, ref, (u, r) => resolveExtractor(u, r, 0)) },
  { name: "StreamWish",       matches: isStreamWish,       extract: extractStreamWish },
  { name: "FileMoon",         matches: isFileMoon,         extract: extractFileMoon },
  { name: "Vidmoly",          matches: isVidmoly,          extract: extractVidmoly },
  { name: "VidStack",         matches: isVidStack,         extract: extractVidStack },
  { name: "VidHide",          matches: isVidHide,          extract: extractVidHide },
  { name: "DoodStream",       matches: isDoodStream,       extract: extractDoodStream },
  { name: "Mp4Upload",        matches: isMp4Upload,        extract: extractMp4Upload },
  { name: "Voe",              matches: isVoe,              extract: extractVoe },
  { name: "StreamTape",       matches: isStreamTape,       extract: extractStreamTape },
  { name: "AnimeDekhoCoHost", matches: isAnimeDekhoCoHost, extract: extractAnimeDekhoCoHost },
  { name: "BlakiteAPI",       matches: isBlakiteApi,       extract: extractBlakiteApi },
];

export function isDirectVideoUrl(url: string): boolean {
  return (
    url.includes(".m3u8") || url.includes(".mp4") || url.includes(".mkv") ||
    url.includes(".webm") || url.includes("manifest.mpd") ||
    url.includes("googleusercontent.com") || url.includes("drive.google.com/uc")
  );
}

const SKIP_URLS = [
  "abyssplayer.com", "abysscdn.com", "abyss.to",
  "animedekho.app/aaa/ad/beta/",
  "cloudy.upns.one",
  "strmup.to",
  // mirror.xerver.xyz is a JS-rendered VidSrc player — static scraping never finds streams,
  // so fetching it just wastes timeout budget with no return.
  "mirror.xerver.xyz",
];

// Markers that indicate a down/v/ (MirrorBot relay) page is not serving content
const DOWN_V_ERROR_MARKERS = [
  "This Server is Down",
  "Server Error (Link)",
  "server error",
  "Report to Admin",
  "File Not Found",
  "file not found",
  "Video Not Found",
  "This video has been removed",
];
function isDownVErrorPage(html: string): boolean {
  return DOWN_V_ERROR_MARKERS.some((m) => html.includes(m));
}

export async function resolveExtractor(
  iframeUrl: string,
  referer = "https://animedekho.app/",
  depth = 0
): Promise<Stream[]> {
  if (depth > 3) return [];
  for (const skip of SKIP_URLS) {
    if (iframeUrl.includes(skip)) {
      logger.info({ url: iframeUrl, skip }, "skipping known-unextractable URL");
      return [];
    }
  }

  // MirrorBot relay handler: animedekho.app/aaa/down/v/ pages serve content
  // via a JS-rendered player when the server is up. Fetch the page, check for
  // error markers, and if the server is live extract any inner iframes/URLs.
  if (iframeUrl.includes("animedekho.app/aaa/down/v/")) {
    logger.info({ url: iframeUrl }, "AnimeDekho: trying MirrorBot relay (down/v/)");
    try {
      const html = await (await import("../../../utils/fetch.js")).fetchText(iframeUrl, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: referer,
        },
      });
      if (isDownVErrorPage(html)) {
        logger.info({ url: iframeUrl }, "AnimeDekho: MirrorBot relay server is down — skipping");
        return [];
      }

      // Scan HTML for LoadMyFile links (appear as <a href> or in scripts, not just iframes)
      const lmfPattern = /https?:\/\/(?:[a-z0-9-]+\.)?iqsmartgames\.com\/files\/[^\s"'<>]+/gi;
      const lmfUrls = [...new Set(Array.from(html.matchAll(lmfPattern), (m) => m[0]))];
      if (lmfUrls.length > 0) {
        logger.info({ lmfUrls }, "AnimeDekho: found LoadMyFile links in MirrorBot relay");
        const lmfResults = await Promise.allSettled(
          lmfUrls.map((u) => extractLoadMyFile(u, iframeUrl, (nu, nr, nd) => resolveExtractor(nu, nr, nd)))
        );
        const lmfStreams: Stream[] = [];
        for (const r of lmfResults) {
          if (r.status === "fulfilled") lmfStreams.push(...r.value);
        }
        if (lmfStreams.length > 0) {
          logger.info({ count: lmfStreams.length }, "AnimeDekho: LoadMyFile extraction succeeded");
          return lmfStreams;
        }
      }

      // Server is up — pass through to generic extractor at same depth
      const nestedFn: NestedResolver = (u, r, d) => resolveExtractor(u, r, d);
      const { extractGeneric } = await import("./generic.js");
      return extractGeneric(iframeUrl, referer, nestedFn, depth, html);
    } catch (err) {
      logger.warn({ url: iframeUrl, err }, "AnimeDekho: MirrorBot relay fetch failed");
      return [];
    }
  }

  const nestedResolver: NestedResolver = (u, r, d) => resolveExtractor(u, r, d);
  for (const extractor of EXTRACTORS) {
    if (extractor.matches(iframeUrl)) {
      logger.info({ extractor: extractor.name, url: iframeUrl }, "extractor matched");
      try {
        const streams = await extractor.extract(iframeUrl, referer);
        if (streams.length > 0) {
          const directStreams: Stream[] = [];
          const embedResolutions: Promise<Stream[]>[] = [];
          for (const s of streams) {
            if (isDirectVideoUrl(s.url)) {
              directStreams.push(s);
            } else {
              logger.info({ url: s.url }, "stream URL is an embed, resolving recursively");
              embedResolutions.push(resolveExtractor(s.url, iframeUrl, depth + 1));
            }
          }
          const resolved = await Promise.allSettled(embedResolutions);
          const resolvedStreams = resolved
            .filter((r): r is PromiseFulfilledResult<Stream[]> => r.status === "fulfilled")
            .flatMap((r) => r.value);
          const all = [...directStreams, ...resolvedStreams];
          if (all.length > 0) { logger.info({ extractor: extractor.name, count: all.length }, "extractor success"); return all; }
        }
        logger.warn({ extractor: extractor.name, url: iframeUrl }, "extractor returned no streams");
      } catch (err) {
        logger.error({ extractor: extractor.name, url: iframeUrl, err }, "extractor threw");
      }
      break;
    }
  }
  logger.info({ url: iframeUrl }, "no specific extractor matched, using generic");
  return extractGeneric(iframeUrl, referer, nestedResolver, depth);
}
