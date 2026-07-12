import { fetchJson } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import type { Stream } from "./index.js";

const AWSSTREAM_HOSTS = ["awstream.net", "z.awstream.net", "as-cdn21.top", "zephyrflick"];

export function isAWSStream(url: string): boolean {
  return AWSSTREAM_HOSTS.some((h) => url.includes(h));
}

interface AWSResponse {
  hls?: boolean;
  videoSource?: string;
  videoImage?: string;
  securedLink?: string;
}

export async function extractAWSStream(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "AWSStream extract");
  const streams: Stream[] = [];
  try {
    const hash = url.split("/").pop()?.split("?")[0] || "";
    const origin = (() => { try { return new URL(url).origin; } catch { return "https://z.awstream.net"; } })();
    const apiUrl = `${origin}/player/index.php?data=${hash}&do=getVideo`;
    const postData = new URLSearchParams({ hash, r: referer || origin });
    const resp = await fetchJson<AWSResponse>(apiUrl, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "POST", body: postData as any,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "x-requested-with": "XMLHttpRequest", Referer: url, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (resp?.videoSource) {
      streams.push({ name: "AnimeDekho | AWSStream", title: "AWSStream 1080p", url: resp.videoSource, type: resp.hls ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: url, Origin: origin, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } } } });
    }
  } catch (err) { logger.error({ url, err }, "AWSStream extract error"); }
  return streams;
}
