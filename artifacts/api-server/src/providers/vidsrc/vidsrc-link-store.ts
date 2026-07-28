// VidSrc link store — server-side token registry for proxy URL binding.
// Only URLs minted here (by the resolver or by the M3U8 rewriter) can be
// proxied; external callers cannot request arbitrary URLs.

import { randomUUID } from "node:crypto";

interface StoredLink {
  url: string;
  referer: string;
  expiresAt: number;
}

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const links = new Map<string, StoredLink>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, link] of links) {
    if (link.expiresAt < now) links.delete(id);
  }
}

/** Mint a token for (url, referer) and return the opaque token string. */
export function createVidsrcLink(url: string, referer: string): string {
  cleanup();
  const id = randomUUID().replace(/-/g, "");
  links.set(id, { url, referer, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** Look up a token. Returns undefined if absent or expired. */
export function resolveVidsrcLink(id: string): { url: string; referer: string } | undefined {
  const link = links.get(id);
  if (!link) return undefined;
  if (link.expiresAt < Date.now()) {
    links.delete(id);
    return undefined;
  }
  return { url: link.url, referer: link.referer };
}
