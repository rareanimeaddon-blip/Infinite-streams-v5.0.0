import { fetchText } from "../../../utils/fetch.js";
import { logger } from "../../../lib/logger.js";
import type { Stream } from "./index.js";

const DOODSTREAM_HOSTS = ["dood.to", "dood.la", "dood.wf", "dood.li", "dood.pm", "dood.so", "dood.sh", "dood.cx", "dood.yt", "dood.re", "dood.ru", "doodstream.com", "doodapi.com", "ds2play.com", "doods.pro", "d0o0d.com", "do0d.com"];
export function isDoodStream(url: string): boolean { return DOODSTREAM_HOSTS.some((h) => url.includes(h)); }
function randomStr(len = 10): string { const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]!).join(""); }

export async function extractDoodStream(url: string, referer?: string): Promise<Stream[]> {
  logger.info({ url }, "DoodStream extract");
  const streams: Stream[] = [];
  try {
    const origin = (() => { try { return new URL(url).origin; } catch { return "https://dood.to"; } })();
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: referer || "https://animedekho.app/" };
    const html = await fetchText(url, { headers, timeout: 10000 });
    if (!html) return streams;
    const passMd5Match = html.match(/\$\.get\(['"]([^'"]*pass_md5[^'"]*)['"]/i) || html.match(/["'](\/pass_md5\/[^"'\s]+)["']/);
    if (!passMd5Match) { logger.warn({ url }, "DoodStream: no pass_md5"); return streams; }
    const passMd5Path = passMd5Match[1]!;
    const passMd5Url = passMd5Path.startsWith("http") ? passMd5Path : `${origin}${passMd5Path}`;
    const baseUrl = await fetchText(passMd5Url, { headers: { ...headers, Referer: url }, timeout: 8000 });
    if (!baseUrl || !baseUrl.startsWith("http")) return streams;
    const tokenMatch = html.match(/[?&]token=([a-zA-Z0-9_-]+)/) || html.match(/token\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/);
    const token = tokenMatch ? tokenMatch[1]! : randomStr(10);
    const finalUrl = `${baseUrl.trim()}${token}?expiry=${Date.now() + 3600000}&ltype=1&license_code=${randomStr(12)}`;
    streams.push({ name: "AnimeDekho | DoodStream", title: "DoodStream MP4", url: finalUrl, type: "url", behaviorHints: { notWebReady: true, headers: { Referer: `${origin}/`, "User-Agent": headers["User-Agent"] }, proxyHeaders: { request: { Referer: `${origin}/`, "User-Agent": headers["User-Agent"] } } } });
  } catch (err) { logger.error({ url, err }, "DoodStream extract error"); }
  return streams;
}
