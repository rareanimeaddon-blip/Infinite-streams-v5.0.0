import { getBaseUrl } from "../utils/index.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractPixelDrain(url: string): Promise<Stream[]> {
  logger.info({ url }, "PixelDrain: starting extraction");
  try {
    const base = getBaseUrl(url);
    const fileId = url.split("/").pop()?.split("?")[0] ?? "";
    const directUrl = url.includes("download")
      ? url
      : `${base}/api/file/${fileId}?download`;

    return [
      {
        name: "PixelDrain",
        title: "Direct Download",
        url: directUrl,
        type: "mp4",
        behaviorHints: { notWebReady: false },
      },
    ];
  } catch (e) {
    logger.error({ err: e, url }, "PixelDrain: error");
    return [];
  }
}
