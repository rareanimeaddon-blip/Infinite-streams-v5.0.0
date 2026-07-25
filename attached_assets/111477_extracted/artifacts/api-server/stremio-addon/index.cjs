/**
 * Stremio addon for a.111477.xyz (served via the ldh10.971188.xyz mirror).
 *
 * Design notes
 * ------------
 * - a.111477.xyz issues a 307 -> p.111477.xyz/bulk?u=... which resolves,
 *   after a Cloudflare interstitial, to one of the ldh*.971188.xyz mirrors.
 *   The mirror ldh10.971188.xyz hosts the SAME `/movies/...` and `/tvs/...`
 *   tree, and serves .mkv / .mp4 files directly with `Accept-Ranges: bytes`
 *   and `Content-Type: video/x-matroska` -- exactly what Stremio needs.
 * - So the addon skips a.111477.xyz entirely and hits the mirror directly.
 *   No proxy, no Cloudflare challenge, streams are fetched by the Stremio
 *   app itself (never via our server) -- avoiding the 429 / access-denied
 *   issues that come from proxying.
 * - Metadata (title / year / show name / episode number) comes from TMDB
 *   using the IMDb id that Stremio passes in the stream request.
 *
 * Env vars (all optional):
 *   MIRROR_HOST   default: ldh10.971188.xyz
 *   TMDB_API_KEY  default: bundled key
 *   PORT          default: 7000
 */

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const MIRROR = process.env.MIRROR_HOST || "ldh10.971188.xyz";
const MIRROR_BASE = `https://${MIRROR}`;
const TMDB_KEY = process.env.TMDB_API_KEY || "5f39fd16e987a9e3fce30d55cf09b438";
const PORT = parseInt(process.env.PORT || "7000", 10);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
  id: "community.xyz111477",
  version: "1.0.0",
  name: "111477 Direct",
  description:
    "Direct .mkv/.mp4 streams from a.111477.xyz (via the ldh10.971188.xyz mirror). No proxy - Stremio fetches the file itself, so no rate-limit or access-denied errors.",
  logo: "https://a.111477.xyz/favicon.ico",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ---------------------------------------------------------------------------
// Directory listing cache
// ---------------------------------------------------------------------------
const listingCache = new Map(); // url -> { at, entries }
const LISTING_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function fetchListing(url) {
  const cached = listingCache.get(url);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`listing ${url} -> ${res.status}`);
  const html = await res.text();
  const entries = [];
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
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

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Normalize a title so "Marvel's Agents of S.H.I.E.L.D." and
// "Marvel Agents of SHIELD" collide.
function norm(s) {
  return decode(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// TMDB metadata lookup (imdb -> title/year/type)
// ---------------------------------------------------------------------------
const metaCache = new Map();

async function tmdbFind(imdbId) {
  if (metaCache.has(imdbId)) return metaCache.get(imdbId);
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`tmdb ${imdbId} -> ${res.status}`);
  const j = await res.json();
  let meta = null;
  if (j.movie_results && j.movie_results[0]) {
    const m = j.movie_results[0];
    meta = {
      kind: "movie",
      title: m.title,
      altTitle: m.original_title,
      year: (m.release_date || "").slice(0, 4),
    };
  } else if (j.tv_results && j.tv_results[0]) {
    const t = j.tv_results[0];
    meta = {
      kind: "series",
      title: t.name,
      altTitle: t.original_name,
      year: (t.first_air_date || "").slice(0, 4),
    };
  }
  metaCache.set(imdbId, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

// Match "Title (Year)" folder for movies
function findMovieFolder(entries, title, altTitle, year) {
  const wanted = [norm(title), altTitle ? norm(altTitle) : null].filter(Boolean);
  const matches = [];
  for (const href of entries) {
    // shape: /movies/<Folder>/
    const m = href.match(/^\/movies\/([^/]+)\/$/);
    if (!m) continue;
    const folderRaw = m[1];
    const folderDec = decode(folderRaw);
    const ym = folderDec.match(/\((\d{4})\)\s*$/);
    if (!ym) continue;
    const folderYear = ym[1];
    const folderTitle = folderDec.replace(/\s*\(\d{4}\)\s*$/, "");
    const nft = norm(folderTitle);
    if (!wanted.includes(nft)) continue;
    matches.push({ href, folderYear, exactYear: folderYear === year });
  }
  if (!matches.length) return null;
  const exact = matches.find((x) => x.exactYear);
  return (exact || matches[0]).href;
}

// Match series folder. Site uses just the show name (no year), sometimes with
// "(Year)" appended. Ignore year in the folder if present.
function findSeriesFolder(entries, title, altTitle) {
  const wanted = [norm(title), altTitle ? norm(altTitle) : null].filter(Boolean);
  const matches = [];
  for (const href of entries) {
    const m = href.match(/^\/tvs\/([^/]+)\/$/);
    if (!m) continue;
    const folderDec = decode(m[1]).replace(/\s*\(\d{4}\)\s*$/, "");
    if (wanted.includes(norm(folderDec))) matches.push(href);
  }
  return matches[0] || null;
}

// Extract quality/tag info from a filename for the Stremio stream title.
function describeFile(filename) {
  const name = decode(filename).replace(/\.(mkv|mp4|avi|webm|mov)$/i, "");
  const bits = [];
  const q = name.match(/\b(2160p|1080p|720p|480p|4k)\b/i);
  if (q) bits.push(q[1].toUpperCase());
  const src = name.match(/\b(BluRay|BDRip|WEB[- ]?DL|WEBRip|HDRip|HDTV|DVDRip|Remux)\b/i);
  if (src) bits.push(src[1]);
  const codec = name.match(/\b(x265|x264|HEVC|H\.?264|H\.?265|AV1)\b/i);
  if (codec) bits.push(codec[1]);
  const audio = name.match(/\b(DTS[- ]?HD|DTS|Atmos|TrueHD|DDP?5\.1|AC3|EAC3|AAC|Opus)\b/i);
  if (audio) bits.push(audio[1]);
  return bits.join(" ");
}

function fileSizeLabel(bytes) {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

// Fetch listing and produce Stremio stream objects for the given files.
async function buildStreams(folderPath, fileFilter) {
  const entries = await fetchListing(MIRROR_BASE + folderPath);
  const files = entries
    .filter((h) => /\.(mkv|mp4|avi|webm|mov)$/i.test(h))
    .filter((h) => (fileFilter ? fileFilter(h) : true));

  // Fetch HEAD in parallel (best-effort) for file sizes.
  const sizes = await Promise.all(
    files.map((h) =>
      fetch(MIRROR_BASE + h, { method: "HEAD", headers: { "User-Agent": UA } })
        .then((r) => (r.ok ? parseInt(r.headers.get("content-length") || "0", 10) : 0))
        .catch(() => 0)
    )
  );

  return files.map((href, i) => {
    const filename = decode(href.split("/").pop());
    const info = describeFile(filename);
    const size = fileSizeLabel(sizes[i]);
    const titleLine = [info, size].filter(Boolean).join(" · ");
    return {
      name: `111477\n${titleLine || filename.slice(0, 40)}`,
      title: `${filename}${size ? `\n${size}` : ""}`,
      url: MIRROR_BASE + href,
      behaviorHints: {
        bingeGroup: `xyz111477-${folderPath}`,
        notWebReady: true, // MKV / HEVC often not web-playable
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] ${type} ${id}`);
  try {
    const [imdbId, sStr, eStr] = id.split(":");
    if (!imdbId.startsWith("tt")) return { streams: [] };

    const meta = await tmdbFind(imdbId);
    if (!meta) {
      console.log(`  no tmdb meta for ${imdbId}`);
      return { streams: [] };
    }

    if (type === "movie" && meta.kind === "movie") {
      const rootEntries = await fetchListing(`${MIRROR_BASE}/movies/`);
      const folder = findMovieFolder(rootEntries, meta.title, meta.altTitle, meta.year);
      if (!folder) {
        console.log(`  movie folder not found: ${meta.title} (${meta.year})`);
        return { streams: [] };
      }
      const streams = await buildStreams(folder);
      console.log(`  -> ${streams.length} stream(s) from ${folder}`);
      return { streams };
    }

    if (type === "series" && meta.kind === "series") {
      const season = parseInt(sStr || "0", 10);
      const episode = parseInt(eStr || "0", 10);
      if (!season || !episode) return { streams: [] };

      const rootEntries = await fetchListing(`${MIRROR_BASE}/tvs/`);
      const folder = findSeriesFolder(rootEntries, meta.title, meta.altTitle);
      if (!folder) {
        console.log(`  show folder not found: ${meta.title}`);
        return { streams: [] };
      }

      // Season folder: "Season {N}" (also try zero-padded).
      const seasonEntries = await fetchListing(MIRROR_BASE + folder);
      const seasonHref =
        seasonEntries.find((h) =>
          new RegExp(`/Season%20${season}(?:/|$)`, "i").test(h)
        ) ||
        seasonEntries.find((h) =>
          new RegExp(`/Season%200*${season}(?:/|$)`, "i").test(h)
        );
      if (!seasonHref) {
        console.log(`  season ${season} not found in ${folder}`);
        return { streams: [] };
      }

      const epTag = new RegExp(
        `S0*${season}E0*${episode}(?!\\d)`,
        "i"
      );
      const streams = await buildStreams(seasonHref, (h) => epTag.test(decode(h)));
      console.log(`  -> ${streams.length} stream(s) from ${seasonHref} for S${season}E${episode}`);
      return { streams };
    }

    return { streams: [] };
  } catch (e) {
    console.error(`  error: ${e.message}`);
    return { streams: [] };
  }
});

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------
if (require.main === module) {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Addon running: http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`Install URL:   stremio://127.0.0.1:${PORT}/manifest.json`);
}

module.exports = builder;
