import * as cheerio from "cheerio";
import { getHtml } from "../utils/request.js";
import { extractHubCloud } from "./hubcloud.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractHubDrive(
  url: string,
  referer = "HubDrive",
): Promise<Stream[]> {
  logger.info({ url }, "HubDrive: starting extraction");
  try {
    const html = await getHtml(url, {}, 8000);
    const $ = cheerio.load(html);
    const href = $(".btn.btn-primary.btn-user.btn-success1.m-1")
      .first()
      .attr("href") ?? "";

    if (!href) {
      logger.warn({ url }, "HubDrive: no href found");
      return [];
    }

    logger.info({ href }, "HubDrive: following link");

    if (/hubcloud/i.test(href)) {
      return extractHubCloud(href, referer);
    }

    return extractGeneric(href, referer);
  } catch (e) {
    logger.error({ err: e, url }, "HubDrive: error");
    return [];
  }
}

async function extractGeneric(url: string, _referer: string): Promise<Stream[]> {
  return [
    {
      name: "HubDrive",
      title: "Direct Link",
      url,
      type: "mp4",
    },
  ];
}
