import { tmdbTitleToImdbId } from "../lib/tmdb-verify.js";
import { logger } from "../lib/logger.js";

const DAHMER_API = "https://a.111477.xyz";
const DAHMER_WORKER = "https://p.111477.xyz/bulk?u=";
const TIMEOUT = 20000;
const LISTING_TTL  = 6  * 60 * 60 * 1000; // 6 h — individual folder cache
const INDEX_TTL    = 12 * 60 * 60 * 1000; // 12 h — full /movies/ + /tvs/ index

// ─── Caches ───────────────────────────────────────────────────────────────────
const listingCache = new Map<string, { html: string; ts: number }>();
const inFlight     = new Map<string, Promise<string | null>>();

interface IndexEntry { name: string; url: string }
const indexCache = new Map<"movies" | "tvs", { entries: IndexEntry[]; ts: number }>();

interface ParsedLink {
  text: string;
  href: string;      // full relative path already percent-encoded, e.g. /movies/Foo%20(2019)/file.mkv
  size: string | null;
  sizeBytes: number | null;  // raw bytes from data-sort — used for probe-interception in proxy
}

// ─── HTML parser ──────────────────────────────────────────────────────────────
// The site renders a custom file browser.  Every row is a <tr> with:
//   data-entry="true"  data-name="filename.mkv"  data-url="/movies/.../filename.mkv"
// Size lives in <td class="size" data-sort="<bytes>">8.5 GB</td>
// We read data-url (already encoded) directly — no more guessing relative hrefs.

function parseLinks(html: string): ParsedLink[] {
  const links: ParsedLink[] = [];

  // Match every <tr> that carries file metadata
  const trRx = /<tr\b[^>]*data-entry="true"[^>]*>[\s\S]*?<\/tr>/gi;
  let m: RegExpExecArray | null;

  while ((m = trRx.exec(html)) !== null) {
    const tr = m[0]!;

    const nameM = tr.match(/\bdata-name="([^"]*)"/i);
    const urlM  = tr.match(/\bdata-url="([^"]*)"/i);
    if (!nameM || !urlM) continue;

    const name    = nameM[1]!;
    const dataUrl = urlM[1]!;

    // Only video files (skip sub-directories and other types)
    if (!/\.(mkv|mp4|avi|webm|m3u8)$/i.test(name)) continue;
    // Skip multi-part files (part002, part003 …) — only keep part001 or non-part
    if (/part0*[2-9]\d*\.mkv/i.test(name)) continue;

    // Size: prefer the human-readable text inside the size cell
    let size: string | null = null;
    let sizeBytes: number | null = null;
    const sizeTdM = tr.match(/<td[^>]*class="[^"]*size[^"]*"[^>]*data-sort="(\d+)"[^>]*>([^<]*)<\/td>/i);
    if (sizeTdM) {
      const rawBytes = parseInt(sizeTdM[1]!, 10);
      if (rawBytes > 0) sizeBytes = rawBytes;
      const text = sizeTdM[2]!.trim();
      if (text && text !== "-") {
        size = text;
      } else {
        // Fall back to computing from bytes
        if (rawBytes >= 1_099_511_627_776)     size = (rawBytes / 1_099_511_627_776).toFixed(2) + " TB";
        else if (rawBytes >= 1_073_741_824)    size = (rawBytes / 1_073_741_824).toFixed(2) + " GB";
        else if (rawBytes >= 1_048_576)        size = (rawBytes / 1_048_576).toFixed(0) + " MB";
      }
    }

    links.push({ text: name, href: dataUrl, size, sizeBytes });
  }

  // Fallback: plain <a href> scan (in case the site structure ever reverts)
  if (links.length === 0) {
    const lr = /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi;
    while ((m = lr.exec(html)) !== null) {
      const href = m[1]!, text = m[2]!.trim();
      if (text && href && href !== "../" && !/^\?/.test(href) &&
          /\.(mkv|mp4|avi|webm|m3u8)$/i.test(text))
        links.push({ text, href, size: null, sizeBytes: null });
    }
  }

  return links;
}

// ─── Size helpers ─────────────────────────────────────────────────────────────

function parseSizeGB(sizeStr: string | null): number | null {
  if (!sizeStr) return null;
  const m = sizeStr.match(/([\d.]+)\s*(GB|MB|TB)/i);
  if (!m) return null;
  const num = parseFloat(m[1]!);
  const unit = m[2]!.toUpperCase();
  if (unit === "TB") return num * 1024;
  if (unit === "GB") return num;
  if (unit === "MB") return num / 1024;
  return null;
}

// ─── Title normalisation ──────────────────────────────────────────────────────
// DahmerMovies folders may store "Title: Sub" as any of:
//   "Title Sub (year)"       — colon stripped
//   "Title - Sub (year)"     — colon → " - "
// We try all variants so we never miss a folder.

// Build a deduplicated list of title variants for URL lookup.
// Covers colon-styling, hyphen-removal ("Shin-chan" → "Shinchan"),
// and drop-first-word ("Crayon Shin-chan" → "Shinchan").
function titleUrlVariants(title: string): string[] {
  const noColon        = title.replace(/:/g, "").replace(/\s+/g, " ").trim();
  const dashColon      = title.replace(/:\s*/g, " - ").replace(/\s+/g, " ").trim();
  const noHyphen       = noColon.replace(/-/g, "").replace(/\s+/g, " ").trim();
  const words          = noColon.split(/\s+/);
  const dropFirst      = words.length >= 2 ? words.slice(1).join(" ") : "";
  const dropFirstNoHyp = dropFirst.replace(/-/g, "");

  const all: string[] = [noColon];
  if (dashColon !== noColon)                                all.push(dashColon);
  if (noHyphen !== noColon)                                 all.push(noHyphen);
  if (dropFirst.length > 2)                                 all.push(dropFirst);
  if (dropFirstNoHyp !== dropFirst && dropFirstNoHyp.length > 2) all.push(dropFirstNoHyp);
  return [...new Set(all)];
}

function buildMovieUrlVariants(title: string, year: number | null): string[] {
  const make = (t: string) => {
    const variants: string[] = [];
    if (year) {
      variants.push(`${DAHMER_API}/movies/${encodeURIComponent(`${t} (${year})`)}/`);
      variants.push(`${DAHMER_API}/movies/${encodeURIComponent(`${t} (${year + 1})`)}/`);
      variants.push(`${DAHMER_API}/movies/${encodeURIComponent(`${t} (${year - 1})`)}/`);
    }
    variants.push(`${DAHMER_API}/movies/${encodeURIComponent(t)}/`);
    return variants;
  };

  const all: string[] = [];
  for (const v of titleUrlVariants(title)) all.push(...make(v));
  return [...new Set(all)];
}

function buildTvUrlVariants(title: string, season: number): string[] {
  const ss = season < 10 ? `0${season}` : `${season}`;
  const make = (t: string) => [
    `${DAHMER_API}/tvs/${encodeURIComponent(t)}/Season%20${ss}/`,
    `${DAHMER_API}/tvs/${encodeURIComponent(t)}/Season%20${season}/`,
  ];

  const all: string[] = [];
  for (const v of titleUrlVariants(title)) all.push(...make(v));
  return [...new Set(all)];
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const BROWSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": `${DAHMER_API}/`,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchListing(dirUrl: string): Promise<string | null> {
  const cached = listingCache.get(dirUrl);
  if (cached && Date.now() - cached.ts < LISTING_TTL) return cached.html;

  const existing = inFlight.get(dirUrl);
  if (existing) return existing;

  const promise: Promise<string | null> = (async () => {
    try {
      const res = await fetch(dirUrl, {
        headers: BROWSE_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) return null;
      const html = await res.text();
      // Quick sanity-check: the page must have actual entries or data-entry markers
      if (!html.includes("data-entry") && !html.includes("<a href")) return null;
      listingCache.set(dirUrl, { html, ts: Date.now() });
      return html;
    } catch (err) {
      logger.warn({ err, dirUrl }, "dahmermovies: listing fetch failed");
      return null;
    } finally {
      inFlight.delete(dirUrl);
    }
  })();

  inFlight.set(dirUrl, promise);
  return promise;
}

// ─── Fuzzy index search ───────────────────────────────────────────────────────
// When all direct URL variants 404, we fall back to fetching the full /movies/
// or /tvs/ index and fuzzy-matching the folder name. Cached 12 hours.

async function buildIndex(type: "movies" | "tvs"): Promise<IndexEntry[]> {
  const cached = indexCache.get(type);
  if (cached && Date.now() - cached.ts < INDEX_TTL) return cached.entries;

  try {
    const res = await fetch(`${DAHMER_API}/${type}/`, {
      headers: BROWSE_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const entries: IndexEntry[] = [];
    // Extract directory entries only (data-url ends with "/")
    const rx = /\bdata-name="([^"]+)"[^>]*\bdata-url="([^"]+\/)"/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null) {
      entries.push({ name: m[1]!, url: m[2]! });
    }
    indexCache.set(type, { entries, ts: Date.now() });
    logger.info({ type, count: entries.length }, "dahmermovies: index built");
    return entries;
  } catch {
    return [];
  }
}

function normalise(s: string): string {
  return s.toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/-/g, "")              // merge hyphenated compounds: "Shin-chan" → "shinchan"
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the title and year embedded in a DahmerMovies folder URL.
 * Movie URL example: https://a.111477.xyz/movies/Inception%20(2010)/
 * TV URL example:    https://a.111477.xyz/tvs/Breaking%20Bad/Season%2001/
 */
function parseFolderTitleYear(
  url: string,
  isTv: boolean,
): { title: string; year: number | undefined } {
  try {
    const parts = new URL(url).pathname
      .split("/")
      .map((p) => decodeURIComponent(p))
      .filter(Boolean);
    // parts[0] = "movies" or "tvs"; parts[1] = folder name (title [+ year])
    // For TV the folder does not contain the year so just extract the show name.
    const folder = parts[1] ?? "";
    const yearMatch = !isTv ? folder.match(/\((\d{4})\)\s*$/) : null;
    const year = yearMatch ? parseInt(yearMatch[1]!, 10) : undefined;
    const title = yearMatch
      ? folder.slice(0, folder.lastIndexOf("(")).trim()
      : folder;
    return { title, year };
  } catch {
    return { title: "", year: undefined };
  }
}

function similarity(a: string, b: string): number {
  const na = normalise(a), nb = normalise(b);
  if (na === nb) return 1;
  // Strip year from folder name for comparison
  const nbNoYear = nb.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  if (na === nbNoYear) return 0.95;
  // Jaccard on words
  const wa = new Set(na.split(" ").filter(Boolean));
  const wb = nb.split(" ").filter(Boolean);
  const inter = wb.filter((w) => wa.has(w)).length;
  return inter / Math.max(wa.size, wb.length);
}

async function fuzzyFindFolder(
  title: string,
  year: number | null,
  type: "movies" | "tvs",
  season?: number,
): Promise<string | null> {
  const entries = await buildIndex(type);
  if (!entries.length) return null;

  const yearTag = year ? `(${year})` : null;
  let best: { score: number; url: string } | null = null;

  for (const e of entries) {
    let score = similarity(title, e.name);
    if (yearTag && e.name.includes(yearTag)) score += 0.08;
    else if (yearTag && /\(\d{4}\)/.test(e.name) && !e.name.includes(yearTag)) score -= 0.15;
    if (!best || score > best.score) best = { score, url: e.url };
  }

  if (best && best.score >= 0.75) {
    // For TV shows, append the season sub-folder
    let folderUrl = DAHMER_API + best.url;
    if (type === "tvs" && season != null) {
      const ss = season < 10 ? `0${season}` : `${season}`;
      folderUrl += `Season%20${ss}/`;
    }
    logger.info({ title, year, score: best.score, folderUrl }, "dahmermovies: fuzzy match");
    return folderUrl;
  }
  return null;
}

// ─── Worker URL builder ───────────────────────────────────────────────────────
// File URLs from data-url are already percent-encoded (/movies/Foo%20(2019)/f.mkv).
// We: prepend DAHMER_API → decodeURI → encodeURI → prepend WORKER.
// This exactly mirrors the original plugin's  encodeURI(decodeURI(fileUrl)) pattern.

function toWorkerUrl(dataUrl: string): string {
  const raw = DAHMER_API + dataUrl;          // e.g. https://a.111477.xyz/movies/Foo%20(2019)/f.mkv
  const decoded = decodeURI(raw);            // https://a.111477.xyz/movies/Foo (2019)/f.mkv
  const reencoded = encodeURI(decoded);      // https://a.111477.xyz/movies/Foo%20(2019)/f.mkv
  return DAHMER_WORKER + reencoded;
}

// ─── Metadata helpers ─────────────────────────────────────────────────────────

function detectQuality(filename: string): string {
  const m = filename.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
  return m ? m[0] : "1080p";
}

function detectLanguage(filename: string): string {
  if (/\b(HIN|TAM|TEL|Multi|Dual|DUB|Multi-Audio|MULTI|HINDI)\b/i.test(filename))
    return "Multi Audio";
  if (/\b(HIN|Hindi)\b/i.test(filename))
    return "Hindi";
  if (/\b(Eng|English)\b/i.test(filename))
    return "English";
  return "Original";
}

function detectExt(filename: string): string {
  const m = filename.match(/\.(mkv|mp4|m3u8|avi|webm)$/i);
  return m ? m[1]!.toUpperCase() : "MKV";
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface DahmerStream {
  url: string;
  name: string;
  title: string;
  behaviorHints?: Record<string, unknown>;
}

// Build an auto-fallback proxy URL that encodes ALL candidate file URLs.
// The /proxy/dahmer-auto endpoint tries each in order, skipping locked files.
// proxyBase e.g. "https://domain.replit.app/api"
function toAutoProxyUrl(dataUrls: string[], proxyBase: string): string {
  const rawUrls = dataUrls.map((u) => DAHMER_API + u);
  const encoded = Buffer.from(JSON.stringify(rawUrls), "utf8").toString("base64url");
  return `${proxyBase}/proxy/dahmer-auto?urls=${encoded}`;
}

export async function fetchDahmerStreams(
  title: string,
  year: string | number | null,
  season: number | null,
  episode: number | null,
  proxyBase?: string,
  imdbId?: string,
): Promise<DahmerStream[]> {
  try {
    const yearNum = year !== null ? parseInt(String(year), 10) : null;
    const isTv    = season !== null;

    // ── Step 1: try direct URL variants ───────────────────────────────────────
    const variants = isTv
      ? buildTvUrlVariants(title, season!)
      : buildMovieUrlVariants(title, yearNum);

    logger.info({ title, year: yearNum, season, episode, variants: variants.slice(0, 3) },
      "dahmermovies: trying variants");

    let html: string | null = null;
    let foundUrl = "";

    for (const url of variants) {
      html = await fetchListing(url);
      if (html) { foundUrl = url; break; }
    }

    // ── Step 2: fuzzy index search fallback ───────────────────────────────────
    if (!html) {
      const fuzzyUrl = await fuzzyFindFolder(
        title, yearNum, isTv ? "tvs" : "movies", season ?? undefined);
      if (fuzzyUrl) {
        html = await fetchListing(fuzzyUrl);
        if (html) foundUrl = fuzzyUrl;
      }
    }

    if (!html) {
      logger.info({ title, year: yearNum, season }, "dahmermovies: no matching folder");
      return [];
    }

    // IMDB ID cross-check: extract title+year from the matched folder URL and verify
    // via TMDB that it maps to the expected IMDB ID. Catches same-name remakes /
    // regional versions. Returns null on TMDB failure → passes through safely.
    if (imdbId) {
      const { title: folderTitle, year: folderYear } = parseFolderTitleYear(foundUrl, isTv);
      if (folderTitle) {
        const resolvedId = await tmdbTitleToImdbId(
          folderTitle,
          folderYear,
          isTv ? "series" : "movie",
        ).catch(() => null);
        if (resolvedId && resolvedId !== imdbId) {
          logger.info(
            { imdbId, resolvedId, folderTitle, folderYear, foundUrl },
            "dahmermovies: IMDB ID mismatch — rejecting folder",
          );
          return [];
        }
      }
    }

    // ── Step 3: parse file links ───────────────────────────────────────────────
    let links = parseLinks(html);
    logger.info({ count: links.length, foundUrl }, "dahmermovies: raw links found");

    if (!links.length) {
      logger.info({ title, foundUrl }, "dahmermovies: folder empty or no video files");
      return [];
    }

    // ── Step 4: episode filter for TV ─────────────────────────────────────────
    if (isTv && episode !== null) {
      const ep2  = episode < 10 ? `0${episode}` : `${episode}`;
      const epRx = new RegExp(`E${ep2}|E${episode}(?!\\d)`, "i");
      const epFiltered = links.filter((p) => epRx.test(p.text));
      // Only apply filter if it actually narrows results; otherwise keep all
      if (epFiltered.length) links = epFiltered;
    }

    // ── Step 4b: season guard — reject files whose filename embeds a different
    //    season number (e.g. FROM.S03E08.mkv found inside the Season 4 folder).
    //    Files without a S{n}E{n} pattern in the name are left through.
    if (isTv && season !== null) {
      const snFiltered = links.filter((p) => {
        const snMatch = /[Ss](\d{1,2})[Ee]/i.exec(p.text);
        if (!snMatch) return true; // no embedded season — keep
        return parseInt(snMatch[1]!, 10) === season;
      });
      if (snFiltered.length < links.length) {
        logger.info(
          { title, season, episode, before: links.length, after: snFiltered.length },
          "dahmermovies: season-filename guard — removed wrong-season files",
        );
        links = snFiltered; // may become empty → returns no streams (correct)
      }
    }

    // ── Step 5: size filter (exclude files > 23 GB) ───────────────────────────
    links = links.filter((p) => {
      const gb = parseSizeGB(p.size);
      return gb === null || gb <= 23;
    });

    if (!links.length) {
      logger.info({ title, season, episode }, "dahmermovies: all files filtered out");
      return [];
    }

    // ── Step 6: sort — 4K first, then 1080p, then lower ─────────────────────
    links.sort((a, b) => {
      const score = (t: string) => {
        if (/2160p|4k/i.test(t)) return 3;
        if (/1080p/i.test(t))    return 2;
        if (/720p/i.test(t))     return 1;
        return 0;
      };
      return score(b.text) - score(a.text);
    });

    // ── Step 7: up to 5 streams ────────────────────────────────────────────────
    const candidates = links.slice(0, 5);

    // ── Step 8: build streams ─────────────────────────────────────────────────
    // Route through our /proxy/dahmer when we have a proxyBase.  The proxy:
    //   • intercepts Stremio's tiny probe (bytes=0-1) locally → 0 upstream hits
    //   • forwards the real play request to the worker → 1 upstream hit total
    //   • absorbs Cloudflare 1015 rate-limiting on our server IP, not user's phone
    // Without proxyBase (e.g. direct CLI testing) fall back to the worker URL.
    const results: DahmerStream[] = candidates.map((p) => {
      const workerUrl = toWorkerUrl(p.href);
      const quality   = detectQuality(p.text);
      const lang      = detectLanguage(p.text);
      const size      = p.size ?? "N/A";
      const ext       = detectExt(p.text);

      let streamUrl: string;
      if (proxyBase) {
        const enc = Buffer.from(workerUrl, "utf8").toString("base64url");
        streamUrl  = `${proxyBase}/proxy/dahmer?url=${enc}`;
        if (p.sizeBytes) streamUrl += `&size=${p.sizeBytes}`;
      } else {
        streamUrl = workerUrl;
      }

      return {
        name:  "DahmerMovies",
        title: `📺 ${quality}  |  🌐 ${lang}  |  💾 ${size}  |  🎞️ ${ext}`,
        url:   streamUrl,
        behaviorHints: { notWebReady: true },
      };
    });

    logger.info({ count: results.length, title }, "dahmermovies: streams ready");
    return results;
  } catch (err: unknown) {
    logger.warn({ err, title }, "dahmermovies: unexpected error");
    return [];
  }
}
