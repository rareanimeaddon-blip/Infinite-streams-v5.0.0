/**
 * VidFast provider — fully self-contained stream resolver.
 *
 * The resolution chain:
 *   1. GET https://vidfast.vc/movie/<tmdb>/ (or /tv/<tmdb>/<s>/<e>/)
 *      → the HTML embeds an encrypted config blob as \"en\":\"...\"
 *   2. enc-dec.app /enc-vidfast decodes it into { servers, stream, token }
 *   3. POST <servers> with X-CSRF-Token → encrypted server list
 *      → /dec-vidfast decodes it into [{ name, description, data }, ...]
 *   4. POST <stream>/<data> per server → encrypted payload
 *      → /dec-vidfast decodes it into { url, tracks, ... }
 *   5. If the url is an m3u8 master, its variants become per-quality streams.
 *
 * No imports outside this folder.
 */

export const VIDFAST_BASE = process.env["VIDFAST_BASE"] ?? "https://vidfast.vc";
const DECRYPT_API = process.env["VIDFAST_DECRYPT_API"] ?? "https://enc-dec.app/api";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TIMEOUT_MS = 20_000;
const CONCURRENCY = 2;
const RETRIES = 3;
const BACKOFF_MS = 700;
const JITTER_MS = 400;
const COOLDOWN_SECONDS = 3;

export const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Referer: VIDFAST_BASE + "/",
  "X-Requested-With": "XMLHttpRequest",
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface PageConfig {
  servers: string;
  stream: string;
  token: string;
}

interface ServerEntry {
  name?: string;
  description?: string;
  data?: string;
}

interface StreamPayload {
  url?: string;
  tracks?: SubTrack[];
  "4kAvailable"?: boolean;
}

interface SubTrack {
  file?: string;
  kind?: string;
  label?: string;
  language?: string;
}

export interface VidFastRawStream {
  server: string;
  description: string;
  url: string;
  quality: string;
  type: "m3u8" | "video";
  headers: Record<string, string>;
  tracks: SubTrack[];
}

// ─── Concurrency / rate-limit helpers ────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let cooldownUntil = 0;
let running = 0;
const queue: Array<() => void> = [];

function penalise(seconds: number) {
  const until = Date.now() + Math.max(seconds, 1) * 1_000;
  if (until > cooldownUntil) cooldownUntil = until;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const next = queue.shift()!;
    running += 1;
    // next() resolves the promise that was created in schedule()
    Promise.resolve().then(next).finally(() => { running -= 1; pump(); });
  }
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job = async () => {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try { resolve(await task()); } catch (e) { reject(e); }
    };
    queue.push(job);
    pump();
  });
}

async function rawFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "0", 10);
      penalise(retryAfter || COOLDOWN_SECONDS);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function httpFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await schedule(() => rawFetch(url, options));
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        const err = Object.assign(new Error(`${options.method ?? "GET"} ${url} -> ${res.status}`), { status: res.status });
        throw err;
      }
      return res;
    } catch (err) {
      lastError = err;
      const e = err as { status?: number; name?: string };
      const retryable = e.status === 429 || (e.status ?? 0) >= 500 || e.name === "AbortError" || !e.status;
      if (!retryable || attempt === RETRIES) break;
      const backoff = BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * JITTER_MS);
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function httpText(url: string, options: RequestInit = {}): Promise<string> {
  const res = await httpFetch(url, options);
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status}`);
  return res.text();
}

async function httpJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await httpFetch(url, options);
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Decryption via enc-dec.app ───────────────────────────────────────────────

async function decrypt<T>(text: string): Promise<T> {
  const data = await httpJson<{ result: T }>(`${DECRYPT_API}/dec-vidfast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ text, version: "1" }),
  });
  return data.result;
}

// ─── Step 1+2: page → PageConfig ─────────────────────────────────────────────

async function pageConfig(pageUrl: string): Promise<PageConfig> {
  const html = await httpText(pageUrl, { headers: REQUEST_HEADERS as HeadersInit });
  const match = html.match(/\\"en\\":\\"(.*?)\\"/);
  if (!match?.[1]) throw new Error("vidfast: no encoded token on page");

  const data = await httpJson<{ result: PageConfig }>(
    `${DECRYPT_API}/enc-vidfast?text=${encodeURIComponent(match[1])}&version=1`,
  );
  const cfg = data.result;
  if (!cfg?.servers || !cfg?.stream) throw new Error("vidfast: incomplete decryption config");
  return { ...cfg, token: cfg.token ?? "" };
}

// ─── HLS master → variant renditions ─────────────────────────────────────────

async function variants(
  masterUrl: string,
  headers: Record<string, string>,
): Promise<Array<{ quality: string; url: string }>> {
  try {
    const res = await httpFetch(masterUrl, { headers: headers as HeadersInit });
    if (!res.ok) return [];
    const body = await res.text();
    const base = masterUrl.slice(0, masterUrl.lastIndexOf("/") + 1);
    const out: Array<{ quality: string; url: string }> = [];
    const re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body)) !== null) {
      const height = parseInt(hit[2]!, 10);
      if (height < 720) continue;
      let url = hit[3]!.trim();
      if (!url.startsWith("http")) {
        url = url.startsWith("/") ? new URL(masterUrl).origin + url : base + url;
      }
      out.push({ quality: `${height}p`, url });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Per-server stream resolution ────────────────────────────────────────────

async function serverStreams(
  server: ServerEntry,
  streamBase: string,
  headers: Record<string, string>,
): Promise<VidFastRawStream[]> {
  if (!server.data) return [];
  const name = server.name ?? "Default";
  const description = server.description ?? "";

  let payload: string;
  try {
    payload = await httpText(`${streamBase}/${server.data}`, {
      method: "POST",
      headers: headers as HeadersInit,
    });
  } catch {
    return [];
  }
  if (!payload.trim()) return [];

  let decoded: StreamPayload;
  try {
    decoded = await decrypt<StreamPayload>(payload);
  } catch {
    return [];
  }
  if (!decoded?.url) return [];

  const url = decoded.url;
  const is4k = decoded["4kAvailable"] === true || /4k/i.test(description);
  const fallbackQuality = is4k ? "2160p" : "1080p";
  const isHls = url.includes(".m3u8");
  const tracks = Array.isArray(decoded.tracks) ? decoded.tracks : [];

  const base: Omit<VidFastRawStream, "url" | "quality" | "type"> = {
    server: name,
    description,
    headers,
    tracks,
  };

  const out: VidFastRawStream[] = [
    { ...base, url, quality: isHls ? "Auto" : fallbackQuality, type: isHls ? "m3u8" : "video" },
  ];

  if (isHls) {
    for (const v of await variants(url, headers)) {
      out.push({ ...base, url: v.url, quality: v.quality, type: "m3u8" });
    }
  }

  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve VidFast streams for a given TMDB ID.
 * @param tmdbId  Numeric TMDB ID (string or number)
 * @param type    "movie" or "series"
 * @param season  Season number (series only)
 * @param episode Episode number (series only)
 */
export async function getVidfastRawStreams(
  tmdbId: string | number,
  type: "movie" | "series",
  season?: number,
  episode?: number,
): Promise<VidFastRawStream[]> {
  const pageUrl =
    type === "series"
      ? `${VIDFAST_BASE}/tv/${tmdbId}/${season}/${episode}/`
      : `${VIDFAST_BASE}/movie/${tmdbId}/`;

  const cfg = await pageConfig(pageUrl);
  const headers: Record<string, string> = { ...REQUEST_HEADERS, "X-CSRF-Token": cfg.token };

  const encoded = await httpText(cfg.servers, { method: "POST", headers: headers as HeadersInit });
  const servers = await decrypt<ServerEntry[]>(encoded);
  if (!Array.isArray(servers) || !servers.length) throw new Error("vidfast: no servers returned");

  const results = await Promise.all(
    servers.map((s) => serverStreams(s, cfg.stream, headers).catch(() => [])),
  );
  return results.flat();
}
