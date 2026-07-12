/**
 * CineFreak Scraper
 *
 * Scrapes cinefreak.nl (WordPress) for direct MKV/MP4 download links.
 *
 * Flow:
 *  1. Search cinefreak.nl WP REST API by resolved title
 *  2. Score and match the best result
 *  3. Fetch the post page HTML
 *  4. For movies: extract dlbtn-container → /generate.php?id=<base64> links
 *     For series: locate episode card by number, extract generate links
 *  5. Decode each base64 ID → raw URL (strip "newgo32" suffix) → /f/<hash>
 *  6. Resolve final URL via new5.cinecloud.site/f/<hash>
 *  7. Return stream entries with proxy headers
 */

import { logger } from "../../lib/logger.js";

const BASE_URL = "https://cinefreak.nl";
const CINECLOUD_BASE = "https://new5.cinecloud.site";

const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

function randomUA(): string {
  return MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)] as string;
}

function getHeaders(ua: string): Record<string, string> {
  return {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  };
}

interface CinefreakStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: {
    notWebReady?: boolean;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchText(url: string, ua: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: getHeaders(ua),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson<T = unknown>(url: string, ua: string): Promise<T | null> {
  try {
    const text = await fetchText(url, ua);
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

interface SearchResult {
  id: number;
  title: string;
  url: string;
}

async function searchCinefreak(
  query: string,
  ua: string,
): Promise<SearchResult[]> {
  if (!query) return [];
  const url =
    `${BASE_URL}/wp-json/wp/v2/search` +
    `?search=${encodeURIComponent(query)}&per_page=10`;

  const data = await fetchJson<Array<{ id: number; title: string; url: string }>>(url, ua);
  if (!data || !data.length) return [];

  const results: SearchResult[] = [];
  for (const item of data) {
    if (!item?.title || !item?.url) continue;
    results.push({
      id: item.id,
      title: String(item.title).replace(/Download\s*/gi, "").trim(),
      url: item.url,
    });
  }
  return results;
}

// ─── Title matching ───────────────────────────────────────────────────────────

function wordMatchScore(query: string, target: string): number {
  const words = String(query || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (words.length === 0) return 0;
  let hits = 0;
  for (const word of words) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(target)) hits++;
  }
  return hits / words.length;
}

function urlMatchScore(title: string, url: string): number {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-");
  const tokens = slug.split("-").filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const urlLc = String(url || "").toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (urlLc.includes(tok)) hits++;
  }
  return hits / tokens.length;
}

function matchResult(
  title: string,
  year: string | null,
  season: number | null,
  results: SearchResult[],
): SearchResult | null {
  if (!results.length) return null;

  const seasonRe = season ? new RegExp(`(?:season|s)\\s*${season}\\b`, "i") : null;

  function score(r: SearchResult): number {
    let s = 0;
    const t = r.title.toLowerCase();
    const titleLc = title.toLowerCase().trim();

    // Title starts with query
    if (t.indexOf(titleLc) === 0 || t.indexOf(titleLc + " ") === 0) s += 10;
    // URL slug match
    s += urlMatchScore(title, r.url) * 5;
    // Word overlap
    s += wordMatchScore(title, r.title);
    // Year boost
    if (year && t.includes(year)) s += 3;
    // Season match boost
    if (seasonRe && seasonRe.test(r.title)) s += 10;

    return s;
  }

  // If TV with season — prefer results that explicitly mention the season
  if (seasonRe) {
    let best: SearchResult | null = null;
    let bestScore = -1;
    for (const r of results) {
      if (seasonRe.test(r.title)) {
        const sc = score(r) + 10;
        if (sc > bestScore) { bestScore = sc; best = r; }
      }
    }
    if (best) return best;
  }

  let best: SearchResult | null = null;
  let bestScore = -1;
  for (const r of results) {
    const sc = score(r);
    if (sc > bestScore) { bestScore = sc; best = r; }
  }
  return bestScore >= 3 ? best : null;
}

// ─── Generate link extraction ─────────────────────────────────────────────────

interface GenerateLink {
  encodedId: string;
  decodedUrl: string;
  label: string;
  quality: string;
}

/**
 * Decode the base64 ID used in /generate.php?id=<base64>
 * Strips the "newgo32" suffix the site injects.
 */
function decodeGenerateId(b64: string): string | null {
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8").replace(/newgo32$/, "");
    return decoded || null;
  } catch {
    return null;
  }
}

function parseQuality(label: string): string {
  const lc = String(label || "").toLowerCase();
  if (lc.includes("2160") || lc.includes("4k")) return "2160p";
  if (lc.includes("1080")) return "1080p";
  if (lc.includes("720")) return "720p";
  if (lc.includes("480")) return "480p";
  return "HD";
}

/**
 * Extract all /generate.php?id= links from a chunk of HTML.
 * Returns links that contain /f/ in the decoded URL (valid FSL links).
 */
function extractAllGenerateLinks(html: string): GenerateLink[] {
  const results: GenerateLink[] = [];
  const marker = "/generate.php?id=";
  let pos = 0;

  while (true) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;

    // Find the enclosing <a> tag start
    const aStart = html.lastIndexOf("<a ", idx);
    if (aStart === -1 || aStart < pos) { pos = idx + 1; continue; }

    // Find closing </a>
    const aEnd = html.indexOf("</a>", idx);
    if (aEnd === -1) { pos = idx + 1; continue; }

    // Get link text (between > and </a>)
    const gtPos = html.indexOf(">", idx);
    if (gtPos === -1 || gtPos > aEnd) { pos = aEnd + 4; continue; }
    const label = html.substring(gtPos + 1, aEnd).trim();

    // Extract the base64 ID
    const idQuote = html.indexOf('"', idx);
    if (idQuote === -1) { pos = aEnd + 4; continue; }
    const idStr = html.substring(idx, idQuote); // e.g. "/generate.php?id=ABCxyz=="
    const idMatch = idStr.match(/id=([a-zA-Z0-9+/=]+)/);
    if (!idMatch) { pos = aEnd + 4; continue; }

    const encodedId = idMatch[1] as string;
    const decodedUrl = decodeGenerateId(encodedId);
    if (!decodedUrl || !decodedUrl.includes("/f/")) { pos = aEnd + 4; continue; }

    const quality = parseQuality(label || decodedUrl);
    results.push({ encodedId, decodedUrl, label: label || quality, quality });
    pos = aEnd + 4;
  }

  return results;
}

/** Extract quality links from a movie post page. */
function extractMovieQualities(html: string): GenerateLink[] {
  const sections = html.split("dlbtn-container");
  const seen = new Set<string>();
  const results: GenerateLink[] = [];

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i] as string;
    const prev = sections[i - 1] as string;

    const genMatch = section.match(
      /href="(?:https?:\/\/[^"]*?)?\/generate\.php\?id=([a-zA-Z0-9+/=]+)"/,
    );
    if (!genMatch) continue;

    const encodedId = genMatch[1] as string;
    const decodedUrl = decodeGenerateId(encodedId);
    if (!decodedUrl || !decodedUrl.includes("/f/")) continue;
    if (seen.has(decodedUrl)) continue;
    seen.add(decodedUrl);

    // Try to extract quality label from context before this section
    let qualLabel = "";
    let m = prev.match(/<\/span>\s*([^<]*?(?:2160|1080|720|480|4K)[^<]*?\[[^\]]+\])/i);
    if (!m) m = prev.match(/<\/span>\s*([^<]*?(?:2160|1080|720|480|4K)[^<]*?)\s*\[/i);
    if (m) qualLabel = (m[1] as string).trim();

    if (!qualLabel || !qualLabel.includes("[")) {
      const h4 = prev.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
      if (h4) qualLabel = (qualLabel + " " + (h4[1] as string).replace(/<[^>]*>/g, "")).trim();
    }
    if (!qualLabel) {
      const qm =
        prev.match(/\b(?:4K\s*2160p|UHD|2160p|1080p|720p|480p)\b/i) ??
        prev.match(/\b(?:SD|HD)\b/i);
      if (qm) qualLabel = qm[0] as string;
    }
    if (!qualLabel) qualLabel = decodedUrl;

    const quality = parseQuality(qualLabel);
    results.push({ encodedId, decodedUrl, label: qualLabel || quality, quality });
  }

  return results;
}

/** Extract quality links for a specific episode from a series post page. */
function extractEpisodeQualities(html: string, episodeNum: number): GenerateLink[] {
  const cards = html.split('<div class="ep-card"');
  let epCard: string | null = null;

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i] as string;
    const epMatch = card.match(/episode-badge[^>]*>Episode\s*(\d+)/i);
    if (epMatch && parseInt(epMatch[1] as string, 10) === episodeNum) {
      epCard = card;
      break;
    }
  }

  if (!epCard) return [];

  const links = extractAllGenerateLinks(epCard);
  const seen = new Set<string>();
  const results: GenerateLink[] = [];

  for (const link of links) {
    if (!link.decodedUrl || !link.decodedUrl.includes("/f/")) continue;
    if (seen.has(link.decodedUrl)) continue;
    seen.add(link.decodedUrl);
    results.push(link);
  }

  return results;
}

/** Remove 480p/SD, sort best quality first. */
function filterAndSort(links: GenerateLink[]): GenerateLink[] {
  const filtered = links.filter(
    (l) => l.quality !== "480p" && l.quality !== "SD",
  );
  const order: Record<string, number> = { "2160p": 0, "1080p": 1, "720p": 2, HD: 3 };
  filtered.sort((a, b) => {
    const ao = order[a.quality] ?? 99;
    const bo = order[b.quality] ?? 99;
    return ao - bo;
  });
  return filtered;
}

// ─── CDN resolution ───────────────────────────────────────────────────────────

/**
 * Extract the hash segment after /f/ or /x/ in a cinecloud URL.
 * e.g. "https://foo.bar/f/abc123" → "abc123"
 */
function extractHash(url: string): string {
  const fPos = url.indexOf("/f/");
  if (fPos >= 0) return url.substring(fPos + 3);
  const xPos = url.indexOf("/x/");
  if (xPos >= 0) return url.substring(xPos + 3);
  return "";
}

/** Only accept absolute http/https URLs as valid stream targets. */
function isAbsoluteHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Regex patterns for extracting the final CDN/storage URL from an FSL page. */
const FSL_RE =
  /href="([^"]+)"[^>]*id="fsl"|href="([^"]+(?:\.workers\.dev|\.r2\.dev|\.buzz|\.cloudflarestorage\.com)\/[^"]+)"|href="(https?:\/\/[^"]+\.(?:mkv|mp4)[^"]*)"|href="(https:\/\/pub-[^"]+)"/gi;

function extractFslUrl(html: string): string | null {
  let m: RegExpExecArray | null;
  FSL_RE.lastIndex = 0;
  while ((m = FSL_RE.exec(html)) !== null) {
    const url = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (url && !url.includes(".zip")) {
      const cleaned = url.replace(/&amp;/g, "&");
      if (isAbsoluteHttp(cleaned)) return cleaned;
    }
  }

  // Fallback: find href starting with https://pub-
  const pubMarker = 'href="https://pub-';
  const pubIdx = html.indexOf(pubMarker);
  if (pubIdx >= 0) {
    const start = pubIdx + 6; // skip href="
    const end = html.indexOf('"', start);
    if (end > start) {
      const cleaned = html.substring(start, end).replace(/&amp;/g, "&");
      if (isAbsoluteHttp(cleaned)) return cleaned;
    }
  }

  return null;
}

/**
 * Given a decoded /f/<hash> path, fetch the cinecloud page and extract the
 * final playable URL.
 */
async function resolveFslUrl(decodedPath: string, ua: string): Promise<string | null> {
  const hash = extractHash(decodedPath);
  if (!hash) return null;
  const pageUrl = `${CINECLOUD_BASE}/f/${hash}`;
  const html = await fetchText(pageUrl, ua);
  if (!html) return null;
  return extractFslUrl(html);
}

// ─── Internal stream type ─────────────────────────────────────────────────────

/** Internal shape used for sorting before returning clean stream entries. */
interface InternalCinefreakStream extends CinefreakStream {
  _resWeight: number;
  _sortWeight: number;
}

// ─── Stream building ──────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&(nbsp|amp|quot|lt|gt|#038);/g, (_, e: string) => {
      const map: Record<string, string> = {
        nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", "#038": "&",
      };
      return map[e] ?? _;
    })
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
}

function buildStream(
  postTitle: string,
  qualityLabel: string,
  resolvedUrl: string,
  quality: string,
  ua: string,
  epTag: string, // e.g. "S01E03" or ""
): InternalCinefreakStream {
  // Clean the post title
  let cleanTitle = decodeEntities(postTitle || "")
    .replace(/[\n\t]+/g, "")
    .trim();
  if (cleanTitle.includes(" - ")) cleanTitle = cleanTitle.split(" - ")[0]!.trim();
  cleanTitle = cleanTitle
    .replace(/\(\d{4}\).*$/gi, "")
    .replace(/\d{3,4}p.*$/gi, "")
    .trim();

  const labelDec = decodeEntities(qualityLabel || "")
    .replace(/[\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const labelLc = labelDec.toLowerCase();
  const urlLc = resolvedUrl.toLowerCase();

  // File size
  const sizeMatch = labelDec.match(/\[\s*(\d+(?:\.\d+)?\s*[MG]B)\s*\]/i) ??
    labelDec.match(/(\d+(?:\.\d+)?\s*[MG]B)/i);
  const sizeStr = sizeMatch
    ? (sizeMatch[1] as string).toUpperCase().replace(/\s+/g, "")
    : "N/A";

  // File format
  const fmt = urlLc.split("?")[0]?.endsWith(".mp4") ? "MP4" : "MKV";

  // Source
  const source = /\b(bluray|blu\-ray)\b/i.test(labelLc)
    ? "BluRay"
    : /\b(hdrip|webrip)\b/i.test(labelLc)
      ? "WEBRip"
      : "WEB-DL";

  // Codec
  const is4k = quality === "2160p";
  const codec =
    /\b(hevc|x265|h265)\b/i.test(labelLc) ||
    urlLc.includes("hevc") || urlLc.includes("x265") || is4k
      ? "HEVC"
      : "H.264";

  // HDR
  let hdrTag = "";
  if (/\b(dolby\s*vision|dovi|dv)\b/i.test(labelLc) || urlLc.includes("dovi")) {
    hdrTag = "Dolby Vision";
  } else if (/\bhdr10\b/i.test(labelLc) || urlLc.includes("hdr10")) {
    hdrTag = "HDR10";
  } else if (/\bhdr\b/i.test(labelLc) || urlLc.includes("hdr")) {
    hdrTag = "HDR";
  } else if (/\b(10bit|10\-bit)\b/i.test(labelLc) || urlLc.includes("10bit")) {
    hdrTag = "10Bit";
  }

  const videoInfo = hdrTag
    ? ` | 🔆 ${hdrTag} • ⚡ ${codec}`
    : ` | ⚡ ${codec}`;

  // Audio
  let audio = "DD5.1";
  if (is4k) {
    audio = "DDP5.1 • 🔊 Atmos";
  } else if (sizeMatch) {
    const mb =
      (sizeMatch[1] as string).toUpperCase().includes("GB")
        ? parseFloat(sizeMatch[1] as string) * 1024
        : parseFloat(sizeMatch[1] as string);
    if (mb < 1300) audio = "Stereo";
  } else if (urlLc.includes("hq")) {
    audio = "DDP5.1 • 🔊 Atmos";
  }

  // Audio language
  const isDual =
    /\b(dual|multi|dubbed|hindi)\b/i.test(labelLc) ||
    decodeEntities(postTitle || "").toLowerCase().includes("dual audio") ||
    urlLc.includes("dual");
  const audioType = isDual ? "Dual-Audio" : "Single Audio";
  const langInfo = isDual ? "English 🇺🇸 • Hindi 🇮🇳" : "English 🇺🇸";

  // Year from title
  const yearMatch = decodeEntities(postTitle || "").match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : new Date().getFullYear().toString();

  // Title line
  const titleLine = epTag
    ? `🎦 ${cleanTitle} (${year}) - ${epTag}`
    : `🎦 ${cleanTitle} - (${year})`;

  const name = `CineFreak | ${quality} | ${audioType}`;
  const title = [
    titleLine,
    `💎 ${quality} | 🗣️ ${langInfo} | 💾 ${sizeStr}`,
    `🎞️ ${fmt} | 🎧 ${audio}${videoInfo}`,
    `🔗 FSL Server | ☁️ ${source}`,
  ].join("\n");

  const sizeMb = sizeMatch
    ? (sizeMatch[1] as string).toUpperCase().includes("GB")
      ? parseFloat(sizeMatch[1] as string) * 1024
      : parseFloat(sizeMatch[1] as string)
    : 0;
  const baseWeight = is4k ? 9_000_000 : quality === "1080p" ? 6_000_000 : 3_000_000;

  return {
    name,
    title,
    url: resolvedUrl,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: `${CINECLOUD_BASE}/`,
          "User-Agent": ua,
        },
      },
    },
    _resWeight: baseWeight,
    _sortWeight: baseWeight + sizeMb,
  };
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Fetch CineFreak streams for a resolved title.
 *
 * @param title   - Resolved content title (from meta resolver)
 * @param year    - Resolved release year, if known
 * @param type    - "movie" or "series"
 * @param season  - Season number (series only; default 1)
 * @param episode - Episode number (series only; default 1)
 */
export async function getCinefreakStreams(
  title: string,
  year: string | null | undefined,
  type: "movie" | "series",
  season = 1,
  episode = 1,
): Promise<CinefreakStream[]> {
  try {
    if (!title) return [];
    const ua = randomUA();
    const isTv = type === "series";

    // 1. Search cinefreak.nl — try with year first, fall back to title only
    let results = await searchCinefreak(title, ua);
    if (results.length < 3) {
      const withYear = await searchCinefreak(`${title} ${year ?? ""}`.trim(), ua);
      if (withYear.length > 0) results = withYear;
    }
    if (!results.length) return [];

    // 2. Match best result
    const matched = matchResult(title, year ?? null, isTv ? season : null, results);
    if (!matched) return [];

    // 3. Fetch post page
    const postUrl = matched.url.startsWith("http")
      ? matched.url
      : `${BASE_URL}/${matched.url.replace(/^\//, "")}`;
    const html = await fetchText(postUrl, ua);
    if (!html) return [];

    // 4. Extract quality links
    const rawLinks = isTv
      ? extractEpisodeQualities(html, episode)
      : extractMovieQualities(html);

    const links = filterAndSort(rawLinks);
    if (!links.length) return [];

    // 5. Build episode tag for title line
    let epTag = "";
    if (isTv) {
      epTag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    }

    // 6. Resolve each FSL URL in parallel (cap at 5 to keep latency reasonable)
    const top = links.slice(0, 5);
    const resolved = await Promise.allSettled(
      top.map((link) => resolveFslUrl(link.decodedUrl, ua)),
    );

    const streams: InternalCinefreakStream[] = [];
    for (let i = 0; i < top.length; i++) {
      const result = resolved[i];
      const link = top[i]!;
      if (result?.status !== "fulfilled" || !result.value) continue;
      const url = result.value;
      streams.push(buildStream(matched.title, link.label, url, link.quality, ua, epTag));
    }

    // Sort highest quality + largest file first
    streams.sort((a, b) => (b._sortWeight ?? 0) - (a._sortWeight ?? 0));

    // Strip internal fields before returning clean stream entries
    return streams.map(({ _resWeight: _r, _sortWeight: _s, ...rest }) => rest);
  } catch (err) {
    logger.error({ err, title }, "CineFreak: provider error");
    return [];
  }
}
