const CF_PROXY_URL = process.env["CF_PROXY_URL"];

export function makeProxiedUrl(url: string): string {
  if (!CF_PROXY_URL) return url;
  return `${CF_PROXY_URL}?url=${encodeURIComponent(url)}`;
}

export async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(makeProxiedUrl(url), init);
}
