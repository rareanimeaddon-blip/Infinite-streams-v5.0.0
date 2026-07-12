const TTL_MS = 120_000;

interface Entry {
  m3u8Url: string;
  playerCdn: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function setPlayerApiResult(hash: string, playerCdn: string, m3u8Url: string): void {
  store.set(hash, { m3u8Url, playerCdn, expiresAt: Date.now() + TTL_MS });
}

export function getPlayerApiResult(hash: string): { m3u8Url: string; playerCdn: string } | undefined {
  const entry = store.get(hash);
  if (!entry || entry.expiresAt <= Date.now()) { store.delete(hash); return undefined; }
  return { m3u8Url: entry.m3u8Url, playerCdn: entry.playerCdn };
}
