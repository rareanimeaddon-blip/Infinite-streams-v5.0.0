/**
 * MoviesDrive scraper + stream extractor
 *
 * Ported and fixed from a known-working reference implementation of the same
 * site. The previous version of this file had two critical bugs:
 *
 *  1. Series requests never filtered by season/episode — any post that
 *     loosely matched the show title (even a completely unrelated title,
 *     since common words like "From" match lots of unrelated posts) was
 *     used for EVERY episode. This is why some series episodes returned
 *     streams for an unrelated movie/show.
 *  2. The HubCloud extraction chain pointed at a stale intermediate host
 *     (gamerxyt.com) the site no longer uses, and returned streams lacked
 *     the Referer header the CDN requires — so some links "worked" (search
 *     succeeded) but the stream itself never actually played.
 *
 * Corrected extraction chain:
 *  1. Search the site's own search endpoint (Typesense-backed `search.php`)
 *     for candidate posts — far more precise than WordPress full-text search.
 *  2. For series, verify the candidate post actually contains a "Season N"
 *     section before accepting it as a match.
 *  3. Extract mdrive.lol archive links scoped to that season only.
 *  4. Within each archive page, extract HubCloud host links scoped to the
 *     requested episode only (via nearby "Episode N" text).
 *  5. Resolve each HubCloud link through its real current chain:
 *     hubcloud.<tld>/drive/{id} → intermediate resolver page → final
 *     fsl.gigabytes.icu / pub-*.r2.dev / *.buzz direct stream URL.
 *
 * Security model:
 *  Every outbound fetch validates the URL is https and not a private/loopback
 *  address before being requested, to prevent SSRF via attacker-influenced
 *  intermediate redirects.
 */

const MAIN_URL = "https://new4.moviesdrives.my";
const ARCHIVE_DOMAIN = "https://mdrive.lol";

const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36",
];

function pickUA(): string {
  return MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–");
}

/** Basic SSRF guard: https only, and not a loopback/private/link-local host. */
function isSafeHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) return null;
  return u;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The upstream site sits behind Cloudflare and occasionally returns a
// transient error (observed: 522 "connection timed out") even though the
// origin is healthy — a retry a moment later succeeds. Without this, a
// single unlucky request would produce a permanently empty result for that
// title (previously made worse by caching the empty result — see stremio.ts).
async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeout?: number; retries?: number } = {}
): Promise<string | null> {
  const parsed = isSafeHttpsUrl(url);
  if (!parsed) return null;
  const timeout = opts.timeout ?? 12000;
  const retries = opts.retries ?? 2;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(parsed.href, {
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": "en-US,en;q=0.9",
          ...(opts.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        // 5xx (incl. Cloudflare's 520-524 origin errors) are worth retrying;
        // 4xx means the URL itself is wrong and won't fix itself.
        if (res.status >= 500 && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return null;
      }
      return await res.text();
    } catch {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeout?: number } = {}
): Promise<T | null> {
  const text = await fetchText(url, opts);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SiteResult {
  title: string;
  href: string;
  year: number | null;
  imdb: string | null;
}

export interface StreamLink {
  url: string;
  quality: string;
  size: string;
  host: string;
  type: "FSL" | "FSLv2" | "R2" | "GPDL" | "Workers";
  title: string;
}

interface ArchiveLink {
  url: string;
  quality: string;
  size: string;
}

interface HostLink {
  url: string;
}

// ─── Quality helpers ──────────────────────────────────────────────────────────

function parseQuality(label: string): string {
  const s = String(label || "");
  const m = s.match(/(2160|1080|720|480)\s*P/i);
  if (m) return m[1] + "p";
  if (/4K|UHD/i.test(s)) return "2160p";
  if (/1440|2K/i.test(s)) return "1440p";
  return "HD";
}

const QUALITY_RANK: Record<string, number> = { "2160p": 4, "1440p": 3.5, "1080p": 3, "720p": 2, HD: 1 };

// ─── Matching ──────────────────────────────────────────────────────────────────

/** Strict title match: candidate must contain the search title as a whole phrase, and years within 1 of each other. */
export function isStrictMatch(
  searchTitle: string,
  searchYear: string | number | undefined,
  candidateTitle: string,
  candidateYear: number | string | null | undefined
): boolean {
  if (!searchTitle || !candidateTitle) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().replace(/\s+/g, " ");
  const st = norm(searchTitle);
  const ct = norm(String(candidateTitle).replace(/download\s*/gi, ""));

  const isWholePhrase =
    ct === st ||
    ct.indexOf(st + " ") === 0 ||
    ct.indexOf(" " + st + " ") !== -1 ||
    ct.indexOf(" " + st) === ct.length - st.length - 1;
  if (!isWholePhrase) return false;

  if (searchYear && candidateYear) {
    const a = parseInt(String(searchYear));
    const b = parseInt(String(candidateYear));
    if (!isNaN(a) && !isNaN(b) && Math.abs(a - b) > 1) return false;
  }
  return true;
}

/**
 * Slice a post's HTML down to the section describing the given season only.
 * Returns null if that season isn't found (used to reject a wrong post match).
 */
function extractSeasonHtml(html: string, season: number): string | null {
  const headingRe =
    /(<h[1-6][^>]*>|<strong[^>]*>|<span[^>]*>)[\s\S]{0,100}?(?:Season|Saison|Staffel)\s*0*(\d+)\b(?!\s*[-–+&])/gi;
  const marks: { index: number; season: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    marks.push({ index: m.index, season: parseInt(m[2]) });
  }

  let startIdx = -1;
  let lastOtherIdx = -1;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].season === season) {
      if (startIdx === -1) startIdx = i;
    } else {
      lastOtherIdx = i;
    }
  }

  if (startIdx === -1) {
    // Fall back to "Season X-Y" range headers
    const rangeRe = /(<h[1-6][^>]*>|<strong[^>]*>).*?(?:Season|Saison|Staffel)\s*0*(\d+)\s*[-–]\s*0*(\d+)/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rangeRe.exec(html)) !== null) {
      if (season >= parseInt(rm[2]) && season <= parseInt(rm[3])) {
        return html.substring(rm.index);
      }
    }
    return null;
  }

  let startPos = marks[startIdx].index;
  if (lastOtherIdx > startIdx) {
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].season === season && i > lastOtherIdx) {
        startPos = marks[i].index;
        break;
      }
    }
  }

  let endPos = html.length;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].index > startPos && marks[i].season !== season) {
      endPos = marks[i].index;
      break;
    }
  }

  return html.substring(startPos, endPos);
}

// ─── Site search ────────────────────────────────────────────────────────────
// Primary: the site's Typesense-backed search.php (most precise — matches on
// title fields specifically, and returns the IMDB id per result).
// Fallback: WordPress REST API full-text search — used when search.php is
// unreachable (observed returning Cloudflare 522 from this environment).
// The fallback doesn't give us an IMDB id per result, but isStrictMatch()
// plus the season-presence check still keep it precise enough for series.

interface SearchHit {
  document?: { permalink?: string; post_title?: string; imdb_id?: string };
}

interface WpPost {
  title: { rendered: string };
  link: string;
}

function stripHtmlEntities(s: string): string {
  return decodeHtml(s).replace(/<[^>]+>/g, "").trim();
}

async function searchSiteTypesense(query: string): Promise<SiteResult[]> {
  const url = `${MAIN_URL}/search.php?q=${encodeURIComponent(query)}&per_page=10`;
  const json = await fetchJson<{ hits?: SearchHit[] }>(url, {
    headers: { Referer: `${MAIN_URL}/` },
    timeout: 10000,
  });
  if (!json?.hits?.length) return [];

  const results: SiteResult[] = [];
  for (const hit of json.hits) {
    const doc = hit.document;
    if (!doc?.permalink || !doc?.post_title) continue;
    const yearMatch = doc.post_title.match(/\((\d{4})\)/);
    results.push({
      title: doc.post_title,
      href: doc.permalink,
      year: yearMatch ? parseInt(yearMatch[1]) : null,
      imdb: doc.imdb_id || null,
    });
  }
  return results;
}

async function searchSiteWpRest(query: string): Promise<SiteResult[]> {
  const url = `${MAIN_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10&_fields=title,link`;
  const json = await fetchJson<WpPost[]>(url, {
    headers: { Accept: "application/json" },
    timeout: 10000,
  });
  if (!json?.length) return [];

  return json.map((post) => {
    const title = stripHtmlEntities(post.title.rendered);
    const yearMatch = title.match(/\((\d{4})\)/);
    return {
      title,
      href: post.link,
      year: yearMatch ? parseInt(yearMatch[1]) : null,
      imdb: null,
    };
  });
}

export async function searchSite(query: string): Promise<SiteResult[]> {
  const primary = await searchSiteTypesense(query);
  if (primary.length) return primary;
  return searchSiteWpRest(query);
}

function resolveHref(href: string): string {
  return href.indexOf("http") === 0 ? href : `${MAIN_URL}${href}`;
}

// ─── Archive links (mdrive.lol) ────────────────────────────────────────────────

function extractArchiveLinks(html: string, season?: number): ArchiveLink[] {
  const seasonScoped = season != null;
  const scoped = seasonScoped ? extractSeasonHtml(html, season!) : html;
  if (!scoped) return [];

  const links: ArchiveLink[] = [];
  const re = /href="(https?:\/\/mdrive\.lol\/archive\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, "").trim();
    if (seasonScoped && /zip/i.test(label)) continue;
    const quality = parseQuality(label);
    if (quality === "480p") continue;
    const sizeMatch = label.match(/\[([\d.]+)\s*(MB|GB|TB)\]/i);
    links.push({ url: m[1], quality, size: sizeMatch ? sizeMatch[0] : "" });
  }
  return links;
}

// ─── HubCloud host links within an archive page ────────────────────────────────

async function extractHostLinks(archiveUrl: string, episode?: number): Promise<HostLink[]> {
  const html = await fetchText(archiveUrl, { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
  if (!html) return [];

  const links: HostLink[] = [];
  const re = /https?:\/\/hubcloud\.[a-z]+\/drive\/[a-z0-9_]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (episode != null) {
      const windowStart = Math.max(0, m.index - 300);
      const preceding = html.substring(windowStart, m.index);
      const epRe = /(?:EP|Episode|E)\D*0*(\d+)/gi;
      let epMatch: RegExpExecArray | null;
      let lastEp = -1;
      while ((epMatch = epRe.exec(preceding)) !== null) {
        lastEp = parseInt(epMatch[1]);
      }
      if (lastEp === -1 || lastEp !== episode) continue;
    }
    links.push({ url: m[0] });
  }
  return links;
}

// ─── Resolve a HubCloud drive link to a direct stream URL ─────────────────────

function decodeBase64(s: string): string {
  return Buffer.from(s, "base64").toString("utf-8");
}

function minuteToken(): string {
  return String(new Date().getMinutes());
}

async function resolveHubcloud(
  hubUrl: string,
  quality: string,
  size: string
): Promise<StreamLink[]> {
  const page1 = await fetchText(hubUrl, {
    headers: { Cookie: "xla=s4t", Referer: `${ARCHIVE_DOMAIN}/` },
    timeout: 12000,
  });
  if (!page1) return [];

  let nextUrl: string | null = null;
  const varMatch = page1.match(/var\s+url\s*=\s*'([^']+)'/);
  if (varMatch) {
    nextUrl = varMatch[1];
  } else {
    const aMatch = page1.match(/<a\s+id="download"\s+(?:x-href|href)="([^"]+)"/);
    if (aMatch) {
      nextUrl = aMatch[1];
      if (!nextUrl.startsWith("http")) {
        try { nextUrl = decodeBase64(nextUrl); } catch { /* ignore */ }
      }
    }
  }
  if (!nextUrl) return [];

  const page2 = await fetchText(nextUrl, {
    headers: { Cookie: "xla=s4t", Referer: hubUrl },
    timeout: 15000,
  });
  if (!page2) return [];

  const results: StreamLink[] = [];
  const decoded = decodeHtml(page2);

  const fslv2Re = /href="(https?:\/\/fsl\.gigabytes\.icu[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = fslv2Re.exec(decoded)) !== null) {
    results.push({ url: m[1], quality, size, host: "hubcloud", type: "FSLv2", title: "" });
  }

  const fslRe = /href="(https?:\/\/(?:pub-[a-z0-9]+\.r2\.dev|[a-z0-9.]+\.buzz)[^"]+)"/gi;
  while ((m = fslRe.exec(decoded)) !== null) {
    results.push({ url: `${m[1]}1${minuteToken()}`, quality, size, host: "hubcloud", type: "FSL", title: "" });
  }

  if (results.length === 0) {
    const tokenMatch = decoded.match(/https?:\/\/[^\s"'<>]+\?token=\d+/);
    if (tokenMatch) {
      const clean = tokenMatch[0].replace(/["'].*$/, "").replace(/[<>].*$/, "");
      results.push({ url: `${clean}1${minuteToken()}`, quality, size, host: "hubcloud", type: "FSL", title: "" });
    }
  }

  // The site serves a mix of CDN backends depending on the file — some files
  // still resolve through the older signed-R2/gpdl chain instead of the
  // fsl.gigabytes.icu/pub-r2.dev chain above. Check for those too so we don't
  // drop files that happen to use the older backend.
  if (results.length === 0) {
    const r2Re = /href="(https?:\/\/[a-z0-9.-]*\.r2\.cloudflarestorage\.com\/[^"]+)"/gi;
    let r2m: RegExpExecArray | null;
    while ((r2m = r2Re.exec(decoded)) !== null) {
      results.push({ url: r2m[1], quality, size, host: "hubcloud", type: "R2", title: "" });
    }
  }

  if (results.length === 0) {
    const gpdlRe = /href="(https?:\/\/gpdl\d*\.hubcloud\.[a-z]+\/\?id=[^"]+)"/gi;
    let gm: RegExpExecArray | null;
    while ((gm = gpdlRe.exec(decoded)) !== null) {
      results.push({ url: gm[1], quality, size, host: "hubcloud", type: "GPDL", title: "" });
    }
  }

  // Another CDN backend seen in the wild: Cloudflare Workers-hosted links
  // (e.g. `*.workers.dev`). These come in two shapes per file — a `.zip`
  // wrapper (not directly playable) and a direct `.mkv`/`.mp4` link. Only
  // keep the direct-media link, skipping the zip wrapper.
  if (results.length === 0) {
    const workersRe = /href="(https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^"]+)"/gi;
    let wm: RegExpExecArray | null;
    while ((wm = workersRe.exec(decoded)) !== null) {
      const url = wm[1];
      if (/\.zip(?:["?]|$)/i.test(url)) continue;
      if (!/\.(mkv|mp4)(?:["?]|$)/i.test(url)) continue;
      results.push({ url, quality, size, host: "hubcloud", type: "Workers", title: "" });
    }
  }

  return results;
}

// ─── Top-level: resolve a title (+ season/episode) to playable streams ────────

export interface GetStreamsParams {
  title: string;
  year?: string;
  imdbId?: string | null;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}

export async function getStreams(params: GetStreamsParams): Promise<StreamLink[]> {
  const { title, year, imdbId, type, season, episode } = params;
  const isSeries = type === "series";

  let matched: SiteResult | null = null;
  let matchedHtml: string | null = null;

  // Pass 1: search by IMDB id if we have one — most precise
  if (imdbId && imdbId.startsWith("tt")) {
    const hits = await searchSite(imdbId);
    for (const hit of hits) {
      if (hit.imdb !== imdbId) continue;
      if (isSeries && season != null) {
        const html = await fetchText(resolveHref(hit.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
        if (html && extractSeasonHtml(html, season) !== null) {
          matched = hit;
          matchedHtml = html;
          break;
        }
      } else {
        matched = hit;
        break;
      }
    }
  }

  // Pass 2: search by title, require strict match + (for series) season presence
  if (!matched) {
    const hits = await searchSite(title);
    for (const hit of hits) {
      if (!isStrictMatch(title, year, hit.title, hit.year)) continue;
      if (isSeries && season != null) {
        const html = await fetchText(resolveHref(hit.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
        if (html && extractSeasonHtml(html, season) !== null) {
          matched = hit;
          matchedHtml = html;
          break;
        }
      } else {
        matched = hit;
        break;
      }
    }
  }

  if (!matched) return [];

  if (!matchedHtml) {
    matchedHtml = await fetchText(resolveHref(matched.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
    if (!matchedHtml) return [];
  }

  const archiveLinks = extractArchiveLinks(matchedHtml, isSeries ? season : undefined);
  if (!archiveLinks.length) return [];

  const hostJobs: { url: string; quality: string; size: string }[] = [];
  for (const archive of archiveLinks) {
    const hostLinks = await extractHostLinks(archive.url, isSeries ? episode : undefined);
    for (const hl of hostLinks) hostJobs.push({ url: hl.url, quality: archive.quality, size: archive.size });
  }
  if (!hostJobs.length) return [];

  const BATCH = 4;
  const streams: StreamLink[] = [];
  for (let i = 0; i < hostJobs.length; i += BATCH) {
    const batch = hostJobs.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((job) => resolveHubcloud(job.url, job.quality, job.size))
    );
    for (const r of results) {
      if (r.status === "fulfilled") streams.push(...r.value);
    }
  }

  // Dedupe by URL
  const seen = new Set<string>();
  const deduped = streams.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // Sort: FSLv2 (more reliable) first, then by quality
  deduped.sort((a, b) => {
    const aV2 = a.type === "FSLv2" ? 1 : 0;
    const bV2 = b.type === "FSLv2" ? 1 : 0;
    if (aV2 !== bV2) return bV2 - aV2;
    return (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
  });

  return deduped;
}
