import * as cheerio from "cheerio";
import { logger } from "../lib/logger.js";

interface FetchOptions {
  timeout?: number;
  headers?: Record<string, string>;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { timeout = 10000, headers = {} } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    logger.error({ url, err }, "fetchText: error");
    throw err;
  }
}

export async function fetchDoc(
  url: string,
  options: FetchOptions = {},
): Promise<ReturnType<typeof cheerio.load>> {
  const html = await fetchText(url, options);
  return cheerio.load(html);
}

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const { timeout = 10000, headers = {} } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/json",
        ...headers,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    logger.error({ url, err }, "fetchJson: error");
    throw err;
  }
}
