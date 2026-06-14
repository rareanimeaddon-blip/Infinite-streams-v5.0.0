import { logger } from "../lib/logger.js";

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

export async function getHtml(
  url: string,
  headers: Record<string, string> = {},
  timeout = 15000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...headers },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "getHtml: non-OK response");
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    logger.error({ url, err }, "getHtml: fetch failed");
    throw err;
  }
}

export async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeout = 15000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, "Accept": "application/json", ...headers },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    logger.error({ url, err }, "getJson: fetch failed");
    throw err;
  }
}

export async function getNoRedirect(
  url: string,
  headers: Record<string, string> = {},
  timeout = 10000,
): Promise<{ headers: Record<string, string>; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...headers },
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });
    return { headers: respHeaders, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    logger.error({ url, err }, "getNoRedirect: fetch failed");
    throw err;
  }
}
