import axios from "axios";
import { logger } from "../../lib/logger.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ARGON_BASE = "https://argon.razorshell.space";
const CODEDEW_BASE = "https://codedew.com";

// Player.js cache — cleared when patch fails so next request re-fetches
let playerJsCache: string | null = null;
let playerJsCacheTime = 0;
const PLAYER_CACHE_TTL = 3_600_000; // 1 hour

export interface StreamResult {
  url: string;
  quality?: string;
  subtitles?: SubtitleTrack[];
  cookies?: string;
}

export interface SubtitleTrack {
  url: string;
  lang: string;
  label: string;
}

// ─── Fetch argon embed page ───────────────────────────────────────────────────
async function fetchArgonEmbed(
  videoId: string,
  referer?: string
): Promise<{ html: string; cookies: string }> {
  const url = `${ARGON_BASE}/embed/${videoId}`;
  logger.info({ url }, "[ArgonExtractor] Fetching argon embed");

  const res = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      Referer: referer || CODEDEW_BASE,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 18000,
    validateStatus: () => true,
  });

  // Capture session cookies — the groovy.monster CDN validates these
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie.map((c: string) => c.split(";")[0]).join("; ")
    : typeof setCookie === "string"
      ? (setCookie as string).split(";")[0]
      : "";

  return { html: res.data as string, cookies };
}

// ─── Strategy 0: Direct URL extraction from embed HTML ───────────────────────
/**
 * Try to find m3u8 or groovy.monster URLs directly in the embed HTML
 * before attempting any JS evaluation.
 */
function tryDirectExtractFromHtml(html: string): string | null {
  const cleanHtml = html.replace(/\\\//g, "/");

  // Priority 1: groovy.monster m3u8
  const groovyM3u8 = cleanHtml.match(
    /https?:\/\/[^"'\s<>]*groovy\.monster[^"'\s<>]*\.m3u8(?:[^"'\s<>]*)?/
  );
  if (groovyM3u8) {
    logger.info(
      { url: groovyM3u8[0] },
      "[ArgonExtractor] Direct: found groovy.monster m3u8"
    );
    return groovyM3u8[0];
  }

  // Priority 2: any m3u8 URL
  const anyM3u8 = cleanHtml.match(
    /https?:\/\/[^"'\s<>]+\.m3u8(?:[^"'\s<>]*)?/
  );
  if (anyM3u8) {
    logger.info(
      { url: anyM3u8[0] },
      "[ArgonExtractor] Direct: found m3u8 URL"
    );
    return anyM3u8[0];
  }

  // Priority 3: "file" property with streaming URL
  const fileMatch = cleanHtml.match(/"file"\s*:\s*"(https?:\/\/[^"]+)"/);
  if (fileMatch && !fileMatch[1].endsWith(".vtt")) {
    logger.info(
      { url: fileMatch[1] },
      "[ArgonExtractor] Direct: found file property"
    );
    return fileMatch[1];
  }

  return null;
}

// ─── juicycodes extraction helpers ───────────────────────────────────────────
function extractJuicyCodesCall(html: string): string | null {
  const start = html.indexOf("_juicycodes(");
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start + "_juicycodes(".length - 1; i < html.length; i++) {
    if (html[i] === "(") depth++;
    else if (html[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  return html.slice(start, end + 1) + ";";
}

function extractJuicyDataFromHtml(
  html: string
): { token: string; video: string } | null {
  const idx = html.indexOf("juicyData =");
  if (idx === -1) return null;

  const braceStart = html.indexOf("{", idx);
  if (braceStart === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  try {
    const data = JSON.parse(html.slice(braceStart, end + 1)) as Record<
      string,
      unknown
    >;
    const inner = (data?.data as Record<string, unknown>) || data;
    if (inner?.token && inner?.video) {
      return {
        token: inner.token as string,
        video: inner.video as string,
      };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function extractStreamUrlFromDecodedConfig(decodedJs: string): string | null {
  const cleanJs = decodedJs.replace(/\\\//g, "/");

  // Priority 1: groovy.monster m3u8
  const groovyM3u8 = cleanJs.match(
    /https?:\/\/[^"'\s<>]*groovy\.monster[^"'\s<>]*\.m3u8[^"'\s<>]*/
  );
  if (groovyM3u8) return groovyM3u8[0];

  // Priority 2: any m3u8 URL
  const rawM3u8 = cleanJs.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/);
  if (rawM3u8) return rawM3u8[0];

  // Priority 3: "file" property inside a "sources" array/object (non-VTT)
  const sourcesBlock = cleanJs.match(/"sources"\s*:\s*[\[{]([\s\S]*?)[\]}]/);
  if (sourcesBlock) {
    const fileInSources = sourcesBlock[1].match(/"file"\s*:\s*"([^"]+)"/);
    if (fileInSources && !fileInSources[1].endsWith(".vtt")) {
      return fileInSources[1];
    }
  }

  // Priority 4: any streaming URL
  const streamUrl = cleanJs.match(
    /https?:\/\/[^"'\s<>]+(?:\.m3u8|\.mp4|\/hls\/)[^"'\s<>]*/
  );
  if (streamUrl) return streamUrl[0];

  return null;
}

function extractSubtitlesFromHtml(html: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const vttMatches = html.matchAll(/["'](https?:\/\/[^"']*\.vtt[^"']*)["']/g);
  for (const match of vttMatches) {
    const url = match[1].replace(/\\/g, "");
    if (!tracks.find((t) => t.url === url)) {
      tracks.push({ url, lang: "en", label: "Subtitles" });
    }
  }
  return tracks;
}

// ─── Player.js loading ────────────────────────────────────────────────────────
async function loadPlayerJs(embedHtml: string): Promise<string> {
  const now = Date.now();
  if (playerJsCache && now - playerJsCacheTime < PLAYER_CACHE_TTL) {
    return playerJsCache;
  }

  const playerJsMatch = embedHtml.match(/src="([^"]*\/player\.js[^"]*)"/);
  const playerJsUrl = playerJsMatch
    ? playerJsMatch[1].startsWith("http")
      ? playerJsMatch[1]
      : `${ARGON_BASE}${playerJsMatch[1]}`
    : `${ARGON_BASE}/assets/players/jwplayer/player.js`;

  try {
    const res = await axios.get(playerJsUrl, {
      headers: { "User-Agent": UA, Referer: ARGON_BASE },
      timeout: 18000,
    });
    playerJsCache = res.data as string;
    playerJsCacheTime = now;
    logger.info({ url: playerJsUrl }, "[ArgonExtractor] Loaded player.js");
    return playerJsCache;
  } catch (err) {
    logger.warn({ err }, "[ArgonExtractor] Failed to fetch player.js");
    return "";
  }
}

// ─── Strategy 1: juicycodes decode via player.js eval ────────────────────────
async function decodeJuicyCodesCall(
  juicyCodesCall: string,
  embedHtml: string,
  juicyData: { token: string; video: string } | null
): Promise<string | null> {
  const playerJs = await loadPlayerJs(embedHtml);
  if (!playerJs) {
    logger.warn({}, "[ArgonExtractor] player.js not available");
    return null;
  }

  // Try multiple patch patterns (player.js obfuscation may vary)
  const patterns = [
    /_juicycodes=function\(e\)\{return juicycodes_0x[0-9a-f]+\.init\(e\)\}/,
    /_juicycodes=function\([a-z]\)\{return [^}]+\.init\([a-z]\)\}/,
    /(_juicycodes)=function\([a-z]\)\{[^}]+\}/,
  ];

  let patchedPlayerJs = playerJs;
  let patched = false;

  for (const pattern of patterns) {
    const newJs = patchedPlayerJs.replace(
      pattern,
      (match) =>
        match.replace(
          "_juicycodes=",
          "_juicycodes=global._juicycodes="
        )
    );
    if (newJs !== patchedPlayerJs) {
      patchedPlayerJs = newJs;
      patched = true;
      break;
    }
  }

  if (!patched) {
    logger.warn(
      {},
      "[ArgonExtractor] player.js patch failed — invalidating cache for next attempt"
    );
    // Invalidate cache so next call re-fetches a potentially different version
    playerJsCache = null;
    playerJsCacheTime = 0;
    return null;
  }

  let decodedJs: string | null = null;
  const domListeners: Record<string, Array<() => void>> = {};

  const gAny = global as Record<string, unknown>;
  const savedKeys: Record<string, unknown> = {};

  const mockJuicyDataGlobal = juicyData
    ? {
        data: {
          token: juicyData.token,
          video: juicyData.video,
          routes: { ping: "" },
          firewall: {
            adblock: { enabled: false, action: "dismissible-modal" },
            devtools: { enabled: false, actions: [] },
          },
        },
      }
    : null;

  const browserGlobals: Record<string, unknown> = {
    document: {
      getElementById: (_id: string) => ({
        innerHTML: "",
        id: _id,
        className: "",
        classList: { add: () => {}, remove: () => {} },
      }),
      querySelector: () => null,
      querySelectorAll: () => ({ length: 0, forEach: () => {} }),
      createElement: () => ({
        appendChild: () => {},
        setAttribute: () => {},
        style: {},
        classList: { add: () => {}, remove: () => {} },
      }),
      addEventListener: (e: string, cb: () => void) => {
        domListeners[e] = domListeners[e] || [];
        domListeners[e].push(cb);
      },
      removeEventListener: () => {},
      cookie: "",
      readyState: "complete",
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
    },
    window: {
      location: {
        href: `${ARGON_BASE}/embed/${juicyData?.video || ""}`,
        hostname: "argon.razorshell.space",
        protocol: "https:",
        pathname: `/embed/${juicyData?.video || ""}`,
        search: "",
        hash: "",
      },
      juicyData: mockJuicyDataGlobal,
      addEventListener: (e: string, cb: () => void) => {
        domListeners[e] = domListeners[e] || [];
        domListeners[e].push(cb);
      },
      removeEventListener: () => {},
      onload: null,
      setTimeout: (fn: () => void) => {
        try {
          if (typeof fn === "function") fn();
        } catch {
          // ignore
        }
        return 1;
      },
      setInterval: () => 1,
      clearTimeout: () => {},
      clearInterval: () => {},
      screen: { width: 1920, height: 1080 },
      devicePixelRatio: 1,
      innerWidth: 1920,
      innerHeight: 1080,
      performance: {
        now: () => Date.now(),
        mark: () => {},
        measure: () => {},
      },
      navigator: { userAgent: UA, language: "en" },
      requestAnimationFrame: (fn: (t: number) => void) => {
        try {
          fn(0);
        } catch {
          // ignore
        }
        return 0;
      },
      cancelAnimationFrame: () => {},
      MutationObserver: function () {
        return { observe: () => {}, disconnect: () => {} };
      },
      ResizeObserver: function () {
        return { observe: () => {}, disconnect: () => {} };
      },
    },
    navigator: { userAgent: UA, language: "en" },
    screen: { width: 1920, height: 1080 },
    location: {
      href: `${ARGON_BASE}/embed/${juicyData?.video || ""}`,
      hostname: "argon.razorshell.space",
      protocol: "https:",
      pathname: `/embed/${juicyData?.video || ""}`,
    },
    XMLHttpRequest: function () {
      return {
        open: () => {},
        send: () => {},
        setRequestHeader: () => {},
        addEventListener: () => {},
        withCredentials: false,
        readyState: 4,
        status: 200,
        responseText: "{}",
      };
    },
    WebSocket: function () {
      return { send: () => {}, close: () => {}, addEventListener: () => {} };
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    }),
    requestAnimationFrame: (fn: (t: number) => void) => {
      try {
        fn(0);
      } catch {
        // ignore
      }
      return 0;
    },
    cancelAnimationFrame: () => {},
    HTMLElement: function () {},
    HTMLVideoElement: function () {},
    MutationObserver: function () {
      return { observe: () => {}, disconnect: () => {} };
    },
    ResizeObserver: function () {
      return { observe: () => {}, disconnect: () => {} };
    },
    IntersectionObserver: function () {
      return { observe: () => {}, disconnect: () => {} };
    },
    jwplayer: function () {
      const obj = {
        setup: (c: Record<string, unknown>) => {
          const cfgStr = JSON.stringify(c);
          if (cfgStr.includes("groovy.monster") || cfgStr.includes(".m3u8")) {
            decodedJs = decodedJs || `var config = ${cfgStr};`;
          }
          return obj;
        },
        on: () => obj,
        off: () => obj,
        once: () => obj,
        getContainer: () => ({ querySelector: () => null }),
        getPosition: () => 0,
        getState: () => "idle",
      };
      return obj;
    },
  };

  const origEval = global.eval;

  const safeSetGlobal = (key: string, val: unknown) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(global, key);
      if (desc && !desc.writable && !desc.set) {
        savedKeys[key] = desc;
        Object.defineProperty(global, key, {
          value: val,
          writable: true,
          configurable: true,
          enumerable: desc.enumerable ?? true,
        });
      } else {
        savedKeys[key] = gAny[key];
        gAny[key] = val;
      }
    } catch {
      savedKeys[key] = gAny[key];
      try {
        gAny[key] = val;
      } catch {
        // ignore
      }
    }
  };

  const safeRestoreGlobal = (key: string, saved: unknown) => {
    try {
      if (
        saved !== null &&
        typeof saved === "object" &&
        "configurable" in (saved as object)
      ) {
        Object.defineProperty(global, key, saved as PropertyDescriptor);
      } else {
        gAny[key] = saved;
      }
    } catch {
      // ignore
    }
  };

  try {
    for (const [key, val] of Object.entries(browserGlobals)) {
      safeSetGlobal(key, val);
    }

    gAny.eval = function (code: unknown) {
      if (
        typeof code === "string" &&
        code.length > 100 &&
        (code.includes("groovy.monster") ||
          code.includes(".m3u8") ||
          code.includes('"sources"'))
      ) {
        decodedJs = code;
      }
      try {
        return origEval.call(global, code);
      } catch {
        return undefined;
      }
    };

    try {
      // eslint-disable-next-line no-eval
      eval(patchedPlayerJs);
    } catch {
      // ignore eval errors in player.js
    }

    if (typeof gAny._juicycodes === "function") {
      (domListeners["DOMContentLoaded"] || []).forEach((fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      });

      try {
        // eslint-disable-next-line no-eval
        eval(juicyCodesCall);
      } catch {
        // ignore eval errors
      }

      (domListeners["DOMContentLoaded"] || []).forEach((fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      });
    } else {
      logger.warn(
        {},
        "[ArgonExtractor] _juicycodes not found after player.js eval"
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "[ArgonExtractor] player.js eval error"
    );
  } finally {
    gAny.eval = origEval;
    for (const [key, val] of Object.entries(savedKeys)) {
      safeRestoreGlobal(key, val);
    }
    delete gAny._juicycodes;
  }

  return decodedJs;
}

// ─── Main extraction entry point ──────────────────────────────────────────────
export async function extractStreamFromArgon(
  videoId: string,
  referer?: string
): Promise<StreamResult | null> {
  logger.info({ videoId }, "[ArgonExtractor] Starting stream extraction");

  try {
    const { html: embedHtml, cookies } = await fetchArgonEmbed(
      videoId,
      referer
    );

    const subtitles = extractSubtitlesFromHtml(embedHtml);

    // ── Strategy 0: Direct URL extraction from embed HTML ──────────────────
    const directUrl = tryDirectExtractFromHtml(embedHtml);
    if (directUrl) {
      logger.info(
        { videoId, url: directUrl.slice(0, 80) },
        "[ArgonExtractor] Stream found via direct extraction"
      );
      return {
        url: directUrl,
        subtitles,
        cookies: cookies || undefined,
      };
    }

    // ── Strategy 1: juicycodes decode via player.js eval ──────────────────
    const juicyCodesCall = extractJuicyCodesCall(embedHtml);
    if (!juicyCodesCall) {
      logger.warn(
        { videoId },
        "[ArgonExtractor] No _juicycodes call found in embed HTML"
      );
      return null;
    }

    const juicyData = extractJuicyDataFromHtml(embedHtml);

    logger.info(
      { videoId, hasJuicyData: !!juicyData },
      "[ArgonExtractor] Decoding _juicycodes via player.js"
    );

    const decodedJs = await decodeJuicyCodesCall(
      juicyCodesCall,
      embedHtml,
      juicyData
    );

    if (!decodedJs) {
      logger.error(
        { videoId },
        "[ArgonExtractor] Failed to decode _juicycodes — no decoded output"
      );
      return null;
    }

    // Also try direct extraction from the decoded JS (in case it's in there)
    const urlFromDecoded =
      tryDirectExtractFromHtml(decodedJs) ||
      extractStreamUrlFromDecodedConfig(decodedJs);

    if (!urlFromDecoded) {
      logger.error(
        { videoId, preview: decodedJs.slice(0, 200) },
        "[ArgonExtractor] No stream URL found in decoded config"
      );
      return null;
    }

    logger.info(
      { videoId, url: urlFromDecoded.slice(0, 80) },
      "[ArgonExtractor] Successfully extracted stream URL"
    );

    return {
      url: urlFromDecoded,
      subtitles,
      cookies: cookies || undefined,
    };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, videoId },
      "[ArgonExtractor] Extraction error"
    );
    return null;
  }
}

export { loadPlayerJs as fetchPlayerJs };
