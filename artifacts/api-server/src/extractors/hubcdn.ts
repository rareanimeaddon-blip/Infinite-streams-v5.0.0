import * as cheerio from "cheerio";
import { getHtml } from "../utils/request.js";
import { b64Decode } from "../utils/index.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractHubCDN(url: string): Promise<Stream[]> {
  logger.info({ url }, "HUBCDN: starting extraction");
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const scriptText =
      $("script")
        .toArray()
        .map((el) => $(el).html() ?? "")
        .find((s) => s.includes("var reurl")) ?? "";

    const encodedUrl = /reurl\s*=\s*"([^"]+)"/.exec(scriptText)?.[1];
    const afterR = encodedUrl?.split("?r=").pop();

    if (afterR) {
      const decoded = b64Decode(afterR);
      const m3u8 = decoded.split("link=").pop()?.trim() ?? "";
      if (m3u8) {
        logger.info({ m3u8 }, "HUBCDN: found m3u8");
        return [
          {
            name: "HUBCDN",
            title: "HLS Stream",
            url: m3u8,
            type: "hls",
          },
        ];
      }
    }

    const encodedAlt = /r=([A-Za-z0-9+/=]+)/.exec(html)?.[1];
    if (encodedAlt) {
      const decoded = b64Decode(encodedAlt);
      const m3u8 = decoded.split("link=").pop()?.trim() ?? "";
      if (m3u8) {
        logger.info({ m3u8 }, "HUBCDN (alt): found m3u8");
        return [
          {
            name: "HUBCDN",
            title: "HLS Stream",
            url: m3u8,
            type: "hls",
          },
        ];
      }
    }

    logger.warn({ url }, "HUBCDN: no encoded URL found");
    return [];
  } catch (e) {
    logger.error({ err: e, url }, "HUBCDN: error");
    return [];
  }
}

export async function extractHubcdnn(url: string): Promise<Stream[]> {
  logger.info({ url }, "Hubcdnn: starting extraction");
  try {
    const html = await getHtml(url);
    const match = /r=([A-Za-z0-9+/=]+)/.exec(html)?.[1];
    if (match) {
      const decoded = b64Decode(match);
      const m3u8 = decoded.split("link=").pop()?.trim() ?? "";
      if (m3u8) {
        return [
          {
            name: "Hubcdnn",
            title: "HLS Stream",
            url: m3u8,
            type: "hls",
          },
        ];
      }
    }
    return [];
  } catch (e) {
    logger.error({ err: e, url }, "Hubcdnn: error");
    return [];
  }
}
