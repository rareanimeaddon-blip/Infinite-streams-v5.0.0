import { getHtml } from "../utils/request.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractStreamTape(url: string): Promise<Stream[]> {
  logger.info({ url }, "StreamTape: starting extraction");
  try {
    const html = await getHtml(url, { Referer: "https://streamtape.com" });

    const robotLinkMatch =
      /id="norobotlink"[^>]*>(.*?)<\/div>/s.exec(html) ??
      /robotlink'\)\.innerHTML\s*=\s*'([^']+)'/.exec(html);

    let streamUrl = "";
    if (robotLinkMatch?.[1]) {
      streamUrl = robotLinkMatch[1].trim().replace(/^\/\//, "https://");
    }

    if (!streamUrl) {
      const scriptMatch =
        /['"]\/\/streamtape\.com\/get_video[^'"]+['"]/.exec(html) ??
        /src\s*=\s*['"]\/\/(streamtape\.[a-z]+\/get_video[^'"]+)['"]/.exec(html);
      if (scriptMatch?.[0]) {
        const raw = scriptMatch[0].replace(/['"]/g, "");
        streamUrl = raw.startsWith("//") ? "https:" + raw : "https://" + raw;
      }
    }

    if (!streamUrl) {
      const concatMatch =
        /document\.getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*(['"].*?['"])\s*\+\s*(['"].*?['"]);/s.exec(html);
      if (concatMatch) {
        const p1 = concatMatch[1].replace(/['"]/g, "");
        const p2 = concatMatch[2].replace(/['"]/g, "");
        streamUrl = ("https:" + p1 + p2).replace(/\s/g, "");
      }
    }

    if (!streamUrl) {
      logger.warn({ url }, "StreamTape: could not extract stream URL");
      return [];
    }

    logger.info({ streamUrl }, "StreamTape: found stream URL");
    return [
      {
        name: "StreamTape",
        title: "StreamTape",
        url: streamUrl,
        type: "mp4",
        headers: { Referer: "https://streamtape.com" },
      },
    ];
  } catch (e) {
    logger.error({ err: e, url }, "StreamTape: error");
    return [];
  }
}
