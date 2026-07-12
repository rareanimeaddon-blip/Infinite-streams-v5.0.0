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

export function createVidsrcLink(url: string, referer: string): string {
  cleanup();
  const id = randomUUID().replace(/-/g, "");
  links.set(id, { url, referer, expiresAt: Date.now() + TTL_MS });
  return id;
}

export function resolveVidsrcLink(id: string): { url: string; referer: string } | undefined {
  const link = links.get(id);
  if (!link) return undefined;
  if (link.expiresAt < Date.now()) {
    links.delete(id);
    return undefined;
  }
  return { url: link.url, referer: link.referer };
}
