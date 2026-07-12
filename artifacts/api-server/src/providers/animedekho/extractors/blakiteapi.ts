import { fetchJson } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import type { Stream } from "./index.js";

const BLAKITE_HOSTS = ["blakiteapi.xyz"];
export function isBlakiteApi(url: string): boolean { return BLAKITE_HOSTS.some((h) => url.includes(h)); }

interface BlakiteResponse { success: boolean; data?: { quality?: string; format?: string; dataId?: string }; }

export async function extractBlakiteApi(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "BlakiteAPI extract");
  const streams: Stream[] = [];
  try {
    const parts = url.split("/");
    const id = parts.pop() || "";
    const tmdbId = url.includes("embed/") ? url.split("embed/")[1]?.split("/")[0] || "" : "";
    const resp = await fetchJson<BlakiteResponse>(`https://blakiteapi.xyz/api/get.php?id=${id}&tmdbId=${tmdbId}`, { headers: { "User-Agent": "Mozilla/5.0", Referer: referer || "https://animedekho.app/" } });
    if (resp?.success && resp.data?.dataId) {
      const { quality = "480p", format = "MP4", dataId } = resp.data;
      streams.push({ name: `AnimeDekho | BlakiteAPI ${quality}`, title: `BlakiteAPI ${quality}`, url: `https://blakiteapi.xyz/stream/${dataId}.${format}`, type: format.toLowerCase() === "m3u8" ? "hls" : "url" });
    }
  } catch (err) { logger.error({ url, err }, "BlakiteAPI extract error"); }
  return streams;
}
