import { createHash } from "node:crypto";

const API = process.env["GOATED_API"] || "https://api.reallyfast.xyz";
const TIMEOUT_MS = Number(process.env["SOURCE_TIMEOUT_MS"] || 20_000);

const PLAYBACK_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://goated.cx/",
  Origin: "https://goated.cx",
};

const API_HEADERS: Record<string, string> = {
  ...PLAYBACK_HEADERS,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function solveChallenge(): Promise<{ challenge: string; nonce: string }> {
  const response = await fetchWithTimeout(`${API}/api/challenge`, {
    headers: PLAYBACK_HEADERS,
  });
  if (!response.ok) throw new Error(`challenge failed: ${response.status}`);

  const data = (await response.json()) as {
    challenge?: string;
    difficulty?: number;
  };
  if (!data.challenge || typeof data.difficulty !== "number") {
    throw new Error("invalid challenge response");
  }

  const prefix = "0".repeat(data.difficulty);
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    if (
      createHash("sha256")
        .update(data.challenge + nonce)
        .digest("hex")
        .startsWith(prefix)
    ) {
      return { challenge: data.challenge, nonce: String(nonce) };
    }
  }
  throw new Error("proof-of-work timed out");
}

async function resolveOnce(
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const proof = await solveChallenge();
    const response = await fetchWithTimeout(`${API}/api/resolve`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({ ...body, ...proof }),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    return typeof data.url === "string" && data.url ? data : null;
  } catch {
    return null;
  }
}

export interface GoatedStream {
  name: string;
  title: string;
  url: string;
  behaviorHints: {
    notWebReady: boolean;
    proxyHeaders: { request: Record<string, string> };
  };
}

function qualityFor(result: Record<string, unknown>): string {
  if (result.format === "hls" || String(result.url).includes(".m3u8")) {
    return "4K";
  }
  return "1080p";
}

/**
 * Resolve all servers advertised by Goated.
 *
 * The first resolve response names the preferred server and advertises any
 * additional servers. Each server is resolved independently so one unavailable
 * backend does not hide the other server's stream.
 */
export async function getGoatedStreams({
  tmdbId,
  type,
  season,
  episode,
}: {
  tmdbId: number;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}): Promise<GoatedStream[]> {
  const isSeries = type === "series";
  const request: Record<string, unknown> = {
    mediaType: isSeries ? "tv" : "movie",
    id: String(tmdbId),
    ...(isSeries
      ? { season: season || 1, episode: episode || 1 }
      : {}),
  };

  const first = await resolveOnce(request);
  if (!first) return [];

  const sources = [
    first.source,
    ...((Array.isArray(first.availableSources)
      ? first.availableSources
      : []) as unknown[]),
  ].filter((source): source is string => typeof source === "string" && Boolean(source));

  const uniqueSources = [...new Set(sources)];
  const results = await Promise.all([
    Promise.resolve(first),
    ...uniqueSources
      .filter((source) => source !== first.source)
      .map((source) => resolveOnce({ ...request, source })),
  ]);

  const streams: GoatedStream[] = [];
  const seenUrls = new Set<string>();
  for (const result of results) {
    if (!result?.url || typeof result.url !== "string" || seenUrls.has(result.url)) {
      continue;
    }
    seenUrls.add(result.url);

    const source =
      typeof result.source === "string" && result.source
        ? result.source
        : "Default";
    const quality = qualityFor(result);
    streams.push({
      name: `🦁 Goated\n${quality} | ${source}`,
      title: `▶ ${quality} · ${source}`,
      url: result.url,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: PLAYBACK_HEADERS },
      },
    });
  }

  return streams;
}