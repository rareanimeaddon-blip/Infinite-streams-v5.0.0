import { extractHubCloud } from "./hubcloud.js";
import { extractHubDrive } from "./hubdrive.js";
import { extractHubCDN, extractHubcdnn } from "./hubcdn.js";
import { extractHblinks } from "./hblinks.js";

import { extractPixelDrain } from "./pixeldrain.js";
import { extractStreamTape } from "./streamtape.js";
import { logger } from "../lib/logger.js";
import { isDirectStreamUrl } from "./stream-utils.js";
import type { Stream } from "./types.js";

export type { Stream };
export { isDirectStreamUrl };

export async function extractStreams(url: string): Promise<Stream[]> {
  const lower = url.toLowerCase();
  logger.info({ url }, "Extractor: dispatching");

  if (!url || url.startsWith("magnet:") || url.startsWith("mailto:")) {
    logger.debug({ url }, "Extractor: skipping invalid scheme");
    return [];
  }

  try {
    if (/hubdrive/i.test(url)) {
      return await extractHubDrive(url);
    }
    if (/hubcloud/i.test(url)) {
      return await extractHubCloud(url);
    }
    if (/hubcdnn?/i.test(url) && /reurl/i.test(url)) {
      return await extractHubcdnn(url);
    }
    if (/hubcdn/i.test(url)) {
      return await extractHubCDN(url);
    }
    if (/hblinks|hubstreamdad/i.test(url)) {
      return await extractHblinks(url);
    }
    if (/pixeldrain/i.test(url)) {
      return await extractPixelDrain(url);
    }
    if (/streamtape/i.test(url)) {
      return await extractStreamTape(url);
    }

    if (/\.m3u8/.test(lower)) {
      return [{ name: "Stream", title: "HLS", url, type: "hls" }];
    }
    if (/\.mp4/.test(lower)) {
      return [{ name: "Stream", title: "MP4", url, type: "mp4" }];
    }

    if (isDirectStreamUrl(url)) {
      logger.info({ url }, "Extractor: passing through as direct CDN stream");
      return [
        {
          name: "Stream",
          title: "Direct Stream",
          url,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        },
      ];
    }

    logger.debug({ url }, "Extractor: skipping — not a known direct stream URL");
    return [];
  } catch (e) {
    logger.error({ err: e, url }, "Extractor: error");
    return [];
  }
}
