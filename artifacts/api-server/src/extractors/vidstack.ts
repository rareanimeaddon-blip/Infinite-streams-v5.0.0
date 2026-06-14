import { getHtml } from "../utils/request.js";
import { getBaseUrl } from "../utils/index.js";
import { decryptAES } from "../utils/aes.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

const VIDSTACK_KEY = "kiemtienmua911ca";
const VIDSTACK_IVS = ["1234567890oiuytr", "0123456789abcdef"];

export async function extractVidStack(
  url: string,
  referer?: string,
): Promise<Stream[]> {
  const streams: Stream[] = [];
  try {
    const hash = url.split("#").pop()?.split("/").pop() ?? "";
    const base = getBaseUrl(url);

    logger.info({ url, hash, base }, "VidStack: fetching encrypted API");

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    };
    if (referer) headers["Referer"] = referer;

    const encoded = await getHtml(`${base}/api/v1/video?id=${hash}`, headers);

    let decryptedText: string | null = null;
    for (const iv of VIDSTACK_IVS) {
      try {
        decryptedText = decryptAES(encoded.trim(), VIDSTACK_KEY, iv);
        logger.info({ iv }, "VidStack: AES decryption succeeded");
        break;
      } catch (e) {
        logger.warn({ iv, err: e }, "VidStack: AES decryption failed with IV");
      }
    }

    if (!decryptedText) {
      logger.error({}, "VidStack: failed to decrypt with all IVs");
      return streams;
    }

    const sourceMatch = /"source":"(.*?)"/.exec(decryptedText);
    const m3u8 = sourceMatch?.[1]?.replace(/\\\//g, "/") ?? "";

    if (m3u8) {
      streams.push({
        name: "VidStack",
        title: "HLS Stream",
        url: m3u8,
        type: "hls",
        headers: { Referer: url, Origin: base },
      });
    }
  } catch (e) {
    logger.error({ err: e, url }, "VidStack: extraction error");
  }
  return streams;
}
