import * as cheerio from "cheerio";
import { getHtml } from "../utils/request.js";
import { extractHubCloud } from "./hubcloud.js";
import { extractHubDrive } from "./hubdrive.js";
import { extractHubCDN } from "./hubcdn.js";
import { isDirectStreamUrl } from "./stream-utils.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractHblinks(url: string): Promise<Stream[]> {
  logger.info({ url }, "Hblinks: starting extraction");
  const streams: Stream[] = [];
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const links = $("h3 a, h5 a, div.entry-content p a").toArray();

    for (const el of links) {
      const rawHref = $(el).attr("href") ?? "";
      const href = rawHref.trim();
      if (!href) continue;

      const lower = href.toLowerCase();
      logger.debug({ href }, "Hblinks: processing link");

      try {
        if (lower.includes("hubdrive")) {
          const s = await extractHubDrive(href, "Hblinks");
          streams.push(...s);
        } else if (lower.includes("hubcloud")) {
          const s = await extractHubCloud(href, "Hblinks");
          streams.push(...s);
        } else if (lower.includes("hubcdn")) {
          const s = await extractHubCDN(href);
          streams.push(...s);
        } else if (isDirectStreamUrl(href)) {
          streams.push({
            name: "Hblinks",
            title: "Direct Stream",
            url: href,
            type: "mp4",
            behaviorHints: { notWebReady: false },
          });
        } else {
          logger.debug({ href }, "Hblinks: skipping non-stream link");
        }
      } catch (e) {
        logger.warn({ err: e, href }, "Hblinks: link extraction failed");
      }
    }
  } catch (e) {
    logger.error({ err: e, url }, "Hblinks: error");
  }
  return streams;
}
