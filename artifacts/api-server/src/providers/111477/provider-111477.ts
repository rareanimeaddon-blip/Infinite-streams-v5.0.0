/**
 * 111477 provider — direct .mkv/.mp4 streams from ldh10.971188.xyz
 * (a public mirror of a.111477.xyz).
 *
 * All logic is self-contained within this folder.
 * No imports from other provider folders.
 *
 * Flow:
 *   1. Receive title / year / season / episode resolved upstream via TMDB.
 *   2. Fetch the mirror's directory listing for /movies/ or /tvs/.
 *   3. Match the correct folder by normalized title (± year for movies).
 *   4. Return direct file URLs — Stremio fetches the file itself, so there is
 *      no proxy involved and no rate-limit / access-denied issues.
 *
 * Env vars (all optional):
 *   PROVIDER_111477_MIRROR_HOST  — mirror hostname (default: ldh10.971188.xyz)
 *
 * Mirror note: if ldh10.971188.xyz stops responding, open a file URL from
 * a.111477.xyz in a browser and copy the hostname from the final URL bar,
 * then set PROVIDER_111477_MIRROR_HOST to that value.
 */

import { logger } from "../../lib/logger.js";

const MIRROR_HOST = process.env["PROVIDER_111477_MIRROR_HOST"] ?? "ldh10.971188.xyz";
const MIRROR_BASE = `https://${MIRROR_HOST}`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ── Directory listing cache ───────────────────────────────────────────────────

const listingCache = new Map<string, { at: number; entries: string[] }>();
const LISTING_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

async function fetchListing(url: string): Promise<string[]> {
  const cached = listingCache.get(url);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;

  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`111477: listing ${url} -> ${res.status}`);

  const html = await res.text();
  const entries: string[] = [];
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]!;
    if (
      href.startsWith("http") ||
      href.startsWith("#") ||
      href === "/" ||
      href.endsWith("/../")
    )
      continue;
    entries.push(href);
  }
  listingCache.set(url, { at: Date.now(), entries });
  return entries;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function norm(s: string): string {
  return safeDecodeURIComponent(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── Folder matching ───────────────────────────────────────────────────────────

function findMovieFolder(
  entries: string[],
  title: string,
  altTitle: string | undefined,
  year: string | undefined,
): string | null {
  const wanted = [norm(title), altTitle ? norm(altTitle) : null].filter(Boolean) as string[];
  const matches: { href: string; folderYear: string; exactYear: boolean }[] = [];

  for (const href of entries) {
    const m = href.match(/^\/movies\/([^/]+)\/$/);
    if (!m) continue;
    const folderDec = safeDecodeURIComponent(m[1]!);
    const ym = folderDec.match(/\((\d{4})\)\s*$/);
    if (!ym) continue;
    const folderYear = ym[1]!;
    const folderTitle = folderDec.replace(/\s*\(\d{4}\)\s*$/, "");
    if (!wanted.includes(norm(folderTitle))) continue;
    matches.push({ href, folderYear, exactYear: folderYear === year });
  }

  if (!matches.length) return null;
  return (matches.find((x) => x.exactYear) ?? matches[0]!).href;
}

function findSeriesFolder(
  entries: string[],
  title: string,
  altTitle: string | undefined,
): string | null {
  const wanted = [norm(title), altTitle ? norm(altTitle) : null].filter(Boolean) as string[];

  for (const href of entries) {
    const m = href.match(/^\/tvs\/([^/]+)\/$/);
    if (!m) continue;
    const folderDec = safeDecodeURIComponent(m[1]!).replace(/\s*\(\d{4}\)\s*$/, "");
    if (wanted.includes(norm(folderDec))) return href;
  }
  return null;
}

// ── Stream building ───────────────────────────────────────────────────────────

function describeFile(filename: string): string {
  const name = safeDecodeURIComponent(filename).replace(/\.(mkv|mp4|avi|webm|mov)$/i, "");
  const bits: string[] = [];
  const q = name.match(/\b(2160p|1080p|720p|480p|4k)\b/i);
  if (q) bits.push(q[1]!.toUpperCase());
  const src = name.match(/\b(BluRay|BDRip|WEB[- ]?DL|WEBRip|HDRip|HDTV|DVDRip|Remux)\b/i);
  if (src) bits.push(src[1]!);
  const codec = name.match(/\b(x265|x264|HEVC|H\.?264|H\.?265|AV1)\b/i);
  if (codec) bits.push(codec[1]!);
  const audio = name.match(/\b(DTS[- ]?HD|DTS|Atmos|TrueHD|DDP?5\.1|AC3|EAC3|AAC|Opus)\b/i);
  if (audio) bits.push(audio[1]!);
  return bits.join(" ");
}

function fileSizeLabel(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

async function buildStreams(
  folderPath: string,
  fileFilter?: (href: string) => boolean,
): Promise<Record<string, unknown>[]> {
  const entries = await fetchListing(MIRROR_BASE + folderPath);
  const files = entries
    .filter((h) => /\.(mkv|mp4|avi|webm|mov)$/i.test(h))
    .filter((h) => (fileFilter ? fileFilter(h) : true));

  // HEAD requests in parallel (best-effort) to get file sizes
  const sizes = await Promise.all(
    files.map((h) =>
      fetch(MIRROR_BASE + h, {
        method: "HEAD",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8_000),
      })
        .then((r) => (r.ok ? parseInt(r.headers.get("content-length") ?? "0", 10) : 0))
        .catch(() => 0),
    ),
  );

  return files.map((href, i) => {
    const filename = safeDecodeURIComponent(href.split("/").pop() ?? href);
    const info = describeFile(filename);
    const size = fileSizeLabel(sizes[i] ?? 0);
    const titleLine = [info, size].filter(Boolean).join(" · ");
    return {
      name: `111477\n${titleLine || filename.slice(0, 40)}`,
      title: `${filename}${size ? `\n${size}` : ""}`,
      url: MIRROR_BASE + href,
      behaviorHints: {
        bingeGroup: `xyz111477-${folderPath}`,
        notWebReady: true, // MKV/HEVC often not web-playable
      },
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch 111477 streams for a given title/type and return Stremio-compatible
 * stream objects. Direct file URLs are returned — Stremio fetches them itself.
 *
 * @param type       "movie" | "series"
 * @param title      Primary title (from resolved meta)
 * @param altTitle   Alternative / original title for fuzzy matching (optional)
 * @param year       Release year (used to disambiguate movie folders)
 * @param season     Season number (series only)
 * @param episode    Episode number (series only)
 */
export async function get111477Streams(
  type: "movie" | "series",
  title: string,
  altTitle: string | undefined,
  year: number | undefined,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  try {
    const yearStr = year ? String(year) : undefined;

    if (type === "movie") {
      const rootEntries = await fetchListing(`${MIRROR_BASE}/movies/`);
      const folder = findMovieFolder(rootEntries, title, altTitle, yearStr);
      if (!folder) {
        logger.debug({ title, year }, "111477: movie folder not found");
        return [];
      }
      const streams = await buildStreams(folder);
      logger.info({ title, folder, count: streams.length }, "111477: movie streams");
      return streams;
    }

    if (type === "series") {
      if (!season || !episode) return [];
      const rootEntries = await fetchListing(`${MIRROR_BASE}/tvs/`);
      const folder = findSeriesFolder(rootEntries, title, altTitle);
      if (!folder) {
        logger.debug({ title }, "111477: series folder not found");
        return [];
      }

      const seasonEntries = await fetchListing(MIRROR_BASE + folder);
      const seasonHref =
        seasonEntries.find((h) =>
          new RegExp(`/Season%20${season}(?:/|$)`, "i").test(h),
        ) ??
        seasonEntries.find((h) =>
          new RegExp(`/Season%200*${season}(?:/|$)`, "i").test(h),
        );
      if (!seasonHref) {
        logger.debug({ title, season }, "111477: season folder not found");
        return [];
      }

      const epTag = new RegExp(`S0*${season}E0*${episode}(?!\\d)`, "i");
      const streams = await buildStreams(seasonHref, (h) =>
        epTag.test(safeDecodeURIComponent(h)),
      );
      logger.info({ title, season, episode, count: streams.length }, "111477: series streams");
      return streams;
    }

    return [];
  } catch (err) {
    logger.error({ err, title, type }, "111477: provider error");
    return [];
  }
}
