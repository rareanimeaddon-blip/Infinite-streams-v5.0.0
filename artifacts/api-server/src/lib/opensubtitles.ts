// Uses yifysubtitles.ch — no API key required.
// Covers movies. Returns empty array for unrecognised IDs (series, anime, etc.)
// so the player still loads; Stremio just shows no subtitle option.

import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { logger } from "./logger.js";

const inflateRawAsync = promisify(inflateRaw);

const YIFY_BASE = "https://yifysubtitles.ch";
const ADDON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PRIORITY_LANGS = ["english", "hindi"];

const LANG_MAP: Record<string, string> = {
  arabic: "Arabic", bengali: "Bengali", bulgarian: "Bulgarian",
  chinese: "Chinese", croatian: "Croatian", czech: "Czech",
  danish: "Danish", dutch: "Dutch", english: "English",
  finnish: "Finnish", french: "French", german: "German",
  greek: "Greek", hebrew: "Hebrew", hindi: "Hindi",
  hungarian: "Hungarian", indonesian: "Indonesian", italian: "Italian",
  japanese: "Japanese", korean: "Korean", malay: "Malay",
  norwegian: "Norwegian", persian: "Persian", polish: "Polish",
  portuguese: "Portuguese", romanian: "Romanian", russian: "Russian",
  serbian: "Serbian", slovak: "Slovak", slovenian: "Slovenian",
  spanish: "Spanish", swedish: "Swedish", thai: "Thai",
  turkish: "Turkish", ukrainian: "Ukrainian", urdu: "Urdu",
  vietnamese: "Vietnamese",
};

export interface SubtitleResult {
  fileId: string;
  downloadUrl: string;
  language: string;
  langCode: string;
}

const cache = new Map<string, { results: SubtitleResult[]; ts: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 h

export async function searchSubtitles(
  imdbId: string,
  _season: number | null,
  _episode: number | null,
): Promise<SubtitleResult[]> {
  const cacheKey = imdbId;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.results;

  const pageUrl = `${YIFY_BASE}/movie-imdb/${imdbId}`;
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": ADDON_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, imdbId }, "yifysubtitles: page not found");
      cache.set(cacheKey, { results: [], ts: Date.now() });
      return [];
    }

    const html = await res.text();

    // href="/subtitles/movie-name-year-LANG-yify-ID"
    const slugRe = /href="\/subtitles\/([a-z0-9-]+-yify-(\d+))"/g;
    const all: { slug: string; id: string; lang: string; name: string }[] = [];

    for (const m of html.matchAll(slugRe)) {
      const slug = m[1]!;
      const id   = m[2]!;
      // Language is the last word-segment before "-yify-NNN"
      const langMatch = slug.match(/-([a-z]+)-yify-\d+$/);
      const lang = langMatch?.[1];
      if (!lang || lang === "yify") continue;

      all.push({
        slug,
        id,
        lang,
        name: LANG_MAP[lang] ?? (lang[0]!.toUpperCase() + lang.slice(1)),
      });
    }

    // Priority languages first, then rest alphabetically by lang name
    const sorted = [
      ...all.filter((s) => PRIORITY_LANGS.includes(s.lang)),
      ...all.filter((s) => !PRIORITY_LANGS.includes(s.lang)),
    ];

    // Top 2 per language
    const seen = new Map<string, number>();
    const results: SubtitleResult[] = [];
    for (const s of sorted) {
      const n = seen.get(s.lang) ?? 0;
      if (n < 2) {
        results.push({
          fileId:      s.id,
          downloadUrl: `${YIFY_BASE}/subtitle/${s.slug}.zip`,
          language:    s.name,
          langCode:    s.lang,
        });
        seen.set(s.lang, n + 1);
      }
    }

    cache.set(cacheKey, { results, ts: Date.now() });
    logger.info({ imdbId, count: results.length }, "yifysubtitles: found subtitles");
    return results;
  } catch (err) {
    logger.warn({ err, imdbId }, "yifysubtitles: fetch error");
    return [];
  }
}

// Decompress a ZIP file in memory and return the first entry as a UTF-8 string.
// Uses node:zlib inflateRaw — no npm packages needed.
export async function extractSrtFromZip(zipBytes: Buffer | Uint8Array): Promise<string> {
  const buf = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  const v   = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Local file header signature: 0x04034b50 (little-endian "PK\x03\x04")
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error("Not a ZIP file");

  const method      = v.getUint16(8,  true); // 0 = STORE, 8 = DEFLATE
  const compSize    = v.getUint32(18, true);
  const filenameLen = v.getUint16(26, true);
  const extraLen    = v.getUint16(28, true);
  const dataOffset  = 30 + filenameLen + extraLen;
  const compressed  = buf.slice(dataOffset, dataOffset + compSize);

  if (method === 0) {
    return compressed.toString("utf8");
  }
  if (method === 8) {
    const decompressed = await inflateRawAsync(compressed);
    return decompressed.toString("utf8");
  }
  throw new Error(`Unsupported ZIP compression method: ${method}`);
}
