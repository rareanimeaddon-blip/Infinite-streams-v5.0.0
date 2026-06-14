import { logger } from "../../lib/logger.js";
import { unpackEval, extractUrlsFromScript } from "../../utils/unpack-eval.js";
import type { Stream } from "./index.js";

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const GDMIRRORBOT_HOSTS = ["gdmirrorbot.nl", "stream.techinmind.space"];
export function isGDMirrorbot(url: string): boolean { return GDMIRRORBOT_HOSTS.some((h) => url.includes(h)); }

function getBaseUrl(url: string): string { try { const p = new URL(url); return `${p.protocol}//${p.host}`; } catch { return url; } }
function isDirectVideoUrl(url: string): boolean { return url.includes(".m3u8") || url.includes(".mp4") || url.includes(".mkv") || url.includes(".webm") || url.includes("manifest.mpd"); }

export type GDMirrorbotResolver = (url: string, referer: string) => Promise<Stream[]>;

interface EmbedHelperResponse { siteUrls?: Record<string, string>; siteFriendlyNames?: Record<string, string>; mresult?: Record<string, string> | string; }

// Priority tiers: tier-0 keys are tried first; if they yield streams we skip tier-1 and tier-2.
// Keys are LOWERCASE — that is what embedhelper.php actually returns.
// tier-0: StreamHG / RPMShare / StreamP2p — 95 %+ of episodes on these
// tier-1: everything else (Voe, DoodStream, OneUpload, Krakenfiles, …)
// tier-2: FileMoon — most likely to fail; only used as last resort
const TIER0_KEYS = new Set(["smwh", "rpmshre", "strmp2", "strmph", "smwh2"]);
const TIER2_KEYS = new Set(["flmn", "flmn2", "flmn3"]);

// Some GDMirrorbot CDNs use hash-based embed URLs: https://host/#HASH
// Convert these to proper embed paths: https://host/e/HASH
function normalizeEmbedUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return url;
  const fragment = url.slice(hashIdx + 1).trim();
  if (!fragment) return url;
  const base = url.slice(0, hashIdx).replace(/\/$/, "");
  return `${base}/e/${fragment}`;
}

// Deproxy techxpremium.store modplay proxy URLs.
// URL form: https://plyr.techxpremium.store/modplay/{site}/{type}/{id}
// Logic matches plyr.techxpremium.store/app.js exactly:
//   streamhg* sites stay on techxpremium (/e/{id})
//   earnvids* sites stay on techxpremium (/embed/{id})
//   all others: https://{site}.com/{type}/{id}
function deproxyModplay(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("techxpremium.store")) return url;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] !== "modplay" || parts.length < 4) return url;
    const site = parts[1]!;
    const type = parts[2]!;
    const id = parts[3]!;
    if (site.includes("streamhg")) return `https://plyr.techxpremium.store/e/${id}`;
    if (site.includes("earnvids")) return `https://plyr.techxpremium.store/embed/${id}`;
    return `https://${site}.com/${type}/${id}`;
  } catch { return url; }
}


async function postEmbedHelper(hostUrl: string, sid: string, referer: string): Promise<EmbedHelperResponse | null> {
  const body = new URLSearchParams({ sid });
  const headers = { "User-Agent": BROWSER_UA, "Content-Type": "application/x-www-form-urlencoded", Referer: referer, Origin: hostUrl, "X-Requested-With": "XMLHttpRequest" };
  let endpoint = `${hostUrl}/embedhelper.php`;
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 300 && res.status < 400) { const loc = res.headers.get("location"); if (!loc) break; endpoint = loc.startsWith("http") ? loc : `${hostUrl}${loc}`; continue; }
      return JSON.parse(await res.text()) as EmbedHelperResponse;
    } catch (err) { clearTimeout(timer); logger.warn({ endpoint, err }, "GDMirrorbot embedhelper error"); return null; }
  }
  return null;
}

function extractJwPlayerFile(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(/["']?file["']?\s*:\s*["']([^"']+\.m3u8[^"']*)["']/g)) {
    if (m[1]) urls.push(m[1]);
  }
  for (const m of text.matchAll(/["']?file["']?\s*:\s*["']([^"']+\.mp4[^"']*)["']/g)) {
    if (m[1]) urls.push(m[1]);
  }
  return urls;
}

// Messages that indicate the CDN file was deleted/expired — no point trying further
const CDN_DEAD_MARKERS = [
  "File is no longer available as it expired or has been deleted",
  "File Not Found", "File not found", "Video Not Found",
  "This video has been removed", "This Server is Down",
];

async function inlineExtract(fullUrl: string, referer: string, name: string): Promise<Stream[] | null> {
  const subStreams: Stream[] = [];
  try {
    let embedOrigin = "";
    try { embedOrigin = new URL(fullUrl).origin; } catch {}

    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
    const embedRes = await fetch(fullUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: referer,
        ...(embedOrigin ? { Origin: embedOrigin } : {}),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const embedHtml = await embedRes.text();

    // Fast-fail: CDN file deleted or expired — signal null so callers can skip lower tiers
    if (CDN_DEAD_MARKERS.some(m => embedHtml.includes(m))) {
      logger.warn({ fullUrl, name, status: embedRes.status }, "inlineExtract: CDN file dead/expired");
      return null;
    }

    logger.info({ fullUrl, name, status: embedRes.status, htmlLen: embedHtml.length, hasEval: embedHtml.includes("eval(function") }, "inlineExtract: page fetched");
    const seen = new Set<string>();

    const addStream = (videoUrl: string) => {
      if (seen.has(videoUrl)) return;
      seen.add(videoUrl);
      subStreams.push({
        name: `AnimeDekho | ${name}`,
        title: `${name} ${videoUrl.includes(".m3u8") ? "HLS" : "MP4"}`,
        url: videoUrl,
        type: videoUrl.includes(".m3u8") ? "hls" : "url",
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: fullUrl, ...(embedOrigin ? { Origin: embedOrigin } : {}) } } },
      });
    };

    for (const sm of [...embedHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]) {
      const scriptText = sm[1]!;
      const unpacked = unpackEval(scriptText) || "";
      for (const candidate of [scriptText, unpacked]) {
        for (const videoUrl of extractUrlsFromScript(candidate)) addStream(videoUrl);
        for (const videoUrl of extractJwPlayerFile(candidate)) addStream(videoUrl);
      }
    }

    if (!seen.size) {
      for (const m of [
        ...embedHtml.matchAll(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/g),
        ...embedHtml.matchAll(/["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*?)["']/g),
      ]) {
        if (m[1]) addStream(m[1]);
      }
    }

    // Fallback: AWSStream / FileMoon-clone POST API
    if (!seen.size && embedOrigin) {
      try {
        const hash = fullUrl.split("/").pop()?.split("?")[0] || "";
        if (hash) {
          const apiUrl = `${embedOrigin}/player/index.php?data=${hash}&do=getVideo`;
          const postBody = new URLSearchParams({ hash, r: referer });
          const apiCtl = new AbortController();
          const apiTimer = setTimeout(() => apiCtl.abort(), 8000);
          const apiRes = await fetch(apiUrl, {
            method: "POST",
            headers: {
              "User-Agent": BROWSER_UA,
              "Content-Type": "application/x-www-form-urlencoded",
              "X-Requested-With": "XMLHttpRequest",
              Referer: fullUrl,
              Origin: embedOrigin,
            },
            body: postBody,
            signal: apiCtl.signal,
          });
          clearTimeout(apiTimer);
          if (apiRes.ok) {
            const apiData = await apiRes.json() as Record<string, unknown>;
            const videoSrc = apiData["videoSource"] || apiData["video_source"] || apiData["file"] || apiData["url"];
            if (typeof videoSrc === "string" && videoSrc.startsWith("http")) {
              addStream(videoSrc);
              logger.info({ fullUrl, name, videoSrc }, "GDMirrorbot: AWSStream API fallback succeeded");
            }
          }
        }
      } catch (apiErr) {
        logger.debug({ fullUrl, name, apiErr }, "GDMirrorbot: AWSStream API fallback failed");
      }
    }
  } catch (err) { logger.warn({ fullUrl, name, err }, "GDMirrorbot embed resolution failed"); }
  return subStreams;
}

async function resolveEntry(
  base: string,
  path: string,
  name: string,
  referer: string,
  resolver?: GDMirrorbotResolver,
): Promise<Stream[] | null> {
  const rawUrl = `${base}${path}`;
  if (isDirectVideoUrl(rawUrl)) {
    return [{ name: `AnimeDekho | ${name}`, title: name, url: rawUrl, type: rawUrl.includes(".m3u8") ? "hls" : "url", behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: referer } } } }] as Stream[];
  }

  // Convert hash-style embed URLs (#fragment → /e/fragment) before processing
  const hashNorm = normalizeEmbedUrl(rawUrl);
  if (hashNorm !== rawUrl) {
    logger.info({ rawUrl, hashNorm, name }, "GDMirrorbot: normalized hash-based embed URL");
  }

  // Deproxy techxpremium.store modplay → real CDN URL (e.g. https://audinifer.com/e/<id>)
  // The real URL has an eval-packed JWPlayer page — inlineExtract handles it directly.
  const fullUrl = deproxyModplay(hashNorm);
  if (fullUrl !== hashNorm) {
    logger.info({ original: rawUrl, deproxied: fullUrl, name }, "GDMirrorbot: deproxied modplay → inlineExtract");
    return inlineExtract(fullUrl, referer, name);
  }

  if (resolver) {
    try {
      const resolved = await resolver(fullUrl, referer);
      if (resolved.length > 0) return resolved;
    } catch (err) { logger.warn({ fullUrl, name, err }, "GDMirrorbot resolver failed, falling back to inline"); }
  }
  return inlineExtract(fullUrl, referer, name);
}

/** Returns true if every settled resolveEntry result was a CDN-dead null */
function allDead(results: PromiseSettledResult<Stream[] | null>[]): boolean {
  return results.length > 0 && results.every(r => r.status === "fulfilled" && r.value === null);
}

export async function extractGDMirrorbot(url: string, referer?: string, resolver?: GDMirrorbotResolver): Promise<Stream[]> {
  logger.info({ url }, "GDMirrorbot extract");
  const streams: Stream[] = [];
  try {
    const sid = url.split("embed/").pop() || url.split("/").pop() || "";
    const host = getBaseUrl(url);
    const resp = await postEmbedHelper(host, sid, url);
    if (!resp?.siteUrls || !resp?.mresult) { logger.warn({ url }, "GDMirrorbot missing siteUrls/mresult"); return streams; }

    let mresult: Record<string, string>;
    if (typeof resp.mresult === "string") {
      try { mresult = JSON.parse(Buffer.from(resp.mresult, "base64").toString("utf8")); } catch { return streams; }
    } else { mresult = resp.mresult as Record<string, string>; }

    interface Entry { key: string; base: string; path: string; name: string; }
    const allEntries: Entry[] = Object.keys(mresult)
      .map((key) => ({ key, base: resp.siteUrls![key]!, path: mresult[key]!, name: resp.siteFriendlyNames?.[key] || key }))
      .filter((e) => e.base && e.path);

    logger.info({ url, entries: allEntries.map(e => e.key) }, "GDMirrorbot sub-stream entries");

    // ── Tier 0: StreamWish / StreamHG / RPMShare (SMWH, RPMSHRE, STRMP2) ──────
    // These host 95 %+ of working episodes. Try them first; if any succeed
    // we skip lower tiers entirely to avoid returning broken FileMoon links.
    const tier0 = allEntries.filter(e => TIER0_KEYS.has(e.key));
    const tier2 = allEntries.filter(e => TIER2_KEYS.has(e.key));
    const tier1 = allEntries.filter(e => !TIER0_KEYS.has(e.key) && !TIER2_KEYS.has(e.key));

    if (tier0.length > 0) {
      logger.info({ url, tier0Keys: tier0.map(e => e.key) }, "GDMirrorbot: trying tier-0 (SMWH/RPMSHRE) first");
      const t0Results = await Promise.allSettled(
        tier0.map(e => resolveEntry(e.base, e.path, e.name, url, resolver))
      );
      for (const r of t0Results) { if (r.status === "fulfilled" && r.value) streams.push(...r.value); }
      if (streams.length > 0) {
        logger.info({ url, count: streams.length }, "GDMirrorbot: tier-0 succeeded — skipping lower tiers");
        return streams;
      }
      // If all tier-0 entries reported CDN dead (null), skip tier-1 & tier-2 immediately —
      // GDMirrorbot CDN files expire together so other CDNs will also be dead.
      if (allDead(t0Results)) {
        logger.info({ url }, "GDMirrorbot: tier-0 all CDN dead — skipping tier-1/tier-2");
        return streams;
      }
      logger.info({ url }, "GDMirrorbot: tier-0 yielded no streams, trying tier-1");
    }

    // ── Tier 1: everything else (ONUD, VOSX, KKNFL, FLLS, …) ─────────────────
    if (tier1.length > 0) {
      const t1Results = await Promise.allSettled(
        tier1.map(e => resolveEntry(e.base, e.path, e.name, url, resolver))
      );
      for (const r of t1Results) { if (r.status === "fulfilled" && r.value) streams.push(...r.value); }
      if (streams.length > 0) {
        logger.info({ url, count: streams.length }, "GDMirrorbot: tier-1 succeeded — skipping FileMoon");
        return streams;
      }
      if (allDead(t1Results)) {
        logger.info({ url }, "GDMirrorbot: tier-1 all CDN dead — skipping FileMoon");
        return streams;
      }
      logger.info({ url }, "GDMirrorbot: tier-1 yielded no streams, trying FileMoon as last resort");
    }

    // ── Tier 2: FileMoon (FLMN) — last resort ─────────────────────────────────
    if (tier2.length > 0) {
      const t2Results = await Promise.allSettled(
        tier2.map(e => resolveEntry(e.base, e.path, e.name, url, resolver))
      );
      for (const r of t2Results) { if (r.status === "fulfilled" && r.value) streams.push(...r.value); }
    }

  } catch (err) { logger.error({ url, err }, "GDMirrorbot extract error"); }
  return streams;
}
