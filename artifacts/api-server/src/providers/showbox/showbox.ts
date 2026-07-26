/**
 * ShowBox / FebBox provider
 *
 * Resolves direct MP4 streams from showbox.media via the FebBox file-sharing API.
 * Requires the FEBBOX_TOKEN environment variable (FebBox "ui" cookie value) to
 * fetch quality-level download links.  Without it the provider returns 0 streams.
 *
 * Search strategy: passes the IMDB ID ("ttXXXXXX") as the keyword to showbox.media
 * and scrapes the first result's detail page to extract the internal media ID.
 */

import { logger } from "../../lib/logger.js";
import { logResolve } from "../../lib/debug-log.js";

const SHOWBOX  = "https://showbox.media";
const FEBBOX   = "https://www.febbox.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36";

// ─── internal types ───────────────────────────────────────────────────────────

interface ShowboxStream {
  url:     string;
  quality: string;
  size?:   string;
}

interface FebFile {
  fid:       string | number;
  is_dir:    0 | 1 | boolean;
  file_name: string;
  file_size?: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function addonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent":      USER_AGENT,
    accept:            "application/json, text/html, */*",
    "accept-language": "en",
    ...extra,
  };
}

function febboxCookie(): string {
  const token = process.env["FEBBOX_TOKEN"]?.trim();
  if (!token) return "";
  return token.startsWith("ui=") ? token : `ui=${token}`;
}

async function showboxJson<T>(
  url:   string,
  extra: Record<string, string> = {},
): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: addonHeaders(extra) });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// ─── Step 1: resolve internal ShowBox media ID from IMDB ID ──────────────────

async function searchShowbox(imdbId: string): Promise<number | null> {
  try {
    const search = await fetch(
      `${SHOWBOX}/search?keyword=${encodeURIComponent(imdbId)}`,
      { headers: addonHeaders() },
    );
    if (!search.ok) return null;
    const html = await search.text();

    const linkMatch =
      html.match(/class="film-name[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i) ||
      html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*film-name[^"]*"/i);
    if (!linkMatch) return null;

    const detail = await fetch(`${SHOWBOX}${linkMatch[1]}`, {
      headers: addonHeaders(),
    });
    if (!detail.ok) return null;
    const detailHtml = await detail.text();

    const headingMatch = detailHtml.match(
      /class="heading-name[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i,
    );
    if (!headingMatch) return null;

    const parts = headingMatch[1].split("/");
    const mediaId = Number(parts[parts.length - 1]);
    return Number.isFinite(mediaId) ? mediaId : null;
  } catch {
    return null;
  }
}

// ─── Step 2: get FebBox share key ────────────────────────────────────────────

async function shareKey(mediaId: number, type: 1 | 2): Promise<string | null> {
  const data = await showboxJson<{ data?: { link?: string } }>(
    `${SHOWBOX}/index/share_link?id=${mediaId}&type=${type}`,
  );
  const link = data?.data?.link;
  return link?.split("/").pop() || null;
}

// ─── Step 3: list FebBox files ───────────────────────────────────────────────

async function shareFiles(key: string, parentId?: string | number): Promise<FebFile[]> {
  const cookie = febboxCookie();
  let url = `${FEBBOX}/file/file_share_list?share_key=${encodeURIComponent(key)}`;
  if (parentId !== undefined) url += `&parent_id=${encodeURIComponent(String(parentId))}&page=1`;
  const data = await showboxJson<{ data?: { file_list?: FebFile[] } }>(
    url,
    cookie ? { cookie } : {},
  );
  return data?.data?.file_list ?? [];
}

// ─── Step 4: pick season folder / episode file ───────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pickSeason(files: FebFile[], season: number): FebFile | null {
  const s = pad2(season);
  return (
    files.filter((f) => f.is_dir).find((f) => {
      const name = f.file_name.toLowerCase();
      return (
        name.includes(`season ${season}`) ||
        name.includes(`s${s}`) ||
        name === `season ${season}` ||
        name === `s${s}`
      );
    }) ||
    files.find((f) => f.is_dir) ||
    null
  );
}

function pickEpisode(files: FebFile[], episode: number): FebFile | null {
  const e = pad2(episode);
  return (
    files.filter((f) => !f.is_dir).find((f) => {
      const name = f.file_name.toLowerCase();
      return (
        name.includes(`e${e}`) ||
        name.includes(`ep${e}`) ||
        name.includes(`episode ${episode}`) ||
        name.includes(`- ${e} `) ||
        name.includes(`.${e}.`)
      );
    }) ||
    files.find((f) => !f.is_dir) ||
    null
  );
}

// ─── Step 5: fetch quality-level links from FebBox ───────────────────────────

async function qualities(fid: string | number, key: string): Promise<ShowboxStream[]> {
  const cookie = febboxCookie();
  if (!cookie) return [];

  const data = await showboxJson<{ html?: string }>(
    `${FEBBOX}/console/video_quality_list?fid=${encodeURIComponent(String(fid))}&share_key=${encodeURIComponent(key)}`,
    { cookie },
  );

  const html = data?.html ?? "";
  const streams: ShowboxStream[] = [];
  const tagPattern = /<div[^>]*class="[^"]*file_quality[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    const tag = match[0];
    const url     = tag.match(/data-url="([^"]+)"/);
    const quality = tag.match(/data-quality="([^"]+)"/);
    const size    = tag.match(/data-size="([^"]+)"/);
    if (url && quality) {
      streams.push({
        url:     url[1].replace(/\\\//g, "/"),
        quality: quality[1],
        size:    size?.[1],
      });
    }
  }
  return streams;
}

// ─── quality sort rank ────────────────────────────────────────────────────────

function qualityRank(quality: string): number {
  const res = quality.match(/(\d{3,4})/);
  if (res) return Number(res[1]);
  return quality.toUpperCase() === "ORG" ? 10000 : 0;
}

// ─── Main resolver ────────────────────────────────────────────────────────────

async function resolveShowboxStreams(
  imdbId: string,
  type:   "movie" | "series",
  season?:  number,
  episode?: number,
): Promise<ShowboxStream[]> {
  const mediaId = await searchShowbox(imdbId);
  if (!mediaId) return [];

  const key = await shareKey(mediaId, type === "series" ? 2 : 1);
  if (!key) return [];

  const rootFiles = await shareFiles(key);
  if (!rootFiles.length) return [];

  let target: FebFile | null;
  if (type === "series" && season !== undefined && episode !== undefined) {
    const seasonFolder = pickSeason(rootFiles, season);
    if (!seasonFolder) return [];
    target = pickEpisode(await shareFiles(key, seasonFolder.fid), episode);
  } else {
    target = rootFiles.find((f) => !f.is_dir) ?? null;
  }

  return target ? qualities(target.fid, key) : [];
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Fetch ShowBox streams for an IMDB-identified title.
 * Returns an empty array when FEBBOX_TOKEN is not set or no streams are found.
 */
export async function getShowboxStreams(
  imdbId:   string,
  type:     "movie" | "series",
  season?:  number,
  episode?: number,
): Promise<Record<string, unknown>[]> {
  if (!process.env["FEBBOX_TOKEN"]) {
    logResolve({ imdbId, step: "showbox", status: "skip", detail: "FEBBOX_TOKEN not set" });
    return [];
  }

  if (!imdbId.startsWith("tt")) {
    logResolve({ imdbId, step: "showbox", status: "skip", detail: "no IMDB ID" });
    return [];
  }

  try {
    const raw = await resolveShowboxStreams(imdbId, type, season, episode);
    if (!raw.length) {
      logResolve({ imdbId, step: "showbox", status: "fail", detail: "no streams found" });
      return [];
    }

    raw.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));

    logResolve({ imdbId, step: "showbox", status: "ok", detail: `${raw.length} stream(s)` });

    return raw.map((s) => ({
      name:  `ShowBox ${s.quality}`,
      title: s.size ? `${s.quality} • ${s.size}` : s.quality,
      url:   s.url,
      behaviorHints: {
        bingeGroup:  `showbox-${s.quality}`,
        notWebReady: true,
        proxyHeaders: {
          request: {
            "User-Agent": USER_AGENT,
            Referer:      "https://www.febbox.com/",
            Accept:       "*/*",
          },
        },
      },
    }));
  } catch (err) {
    logger.error({ err, imdbId }, "ShowBox: provider error");
    logResolve({ imdbId, step: "showbox", status: "fail", detail: String(err) });
    return [];
  }
}
