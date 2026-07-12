import * as cheerio from "cheerio";
import { Parser } from "m3u8-parser";
import { logger } from "../../lib/logger.js";
import { createVidsrcLink } from "./vidsrc-link-store.js";

const SOURCE_URL = "https://vidsrc-embed.ru/embed";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function baseHeaders(baseDom: string): Record<string, string> {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    Referer: `${baseDom}/`,
    "Referrer-Policy": "origin",
    "User-Agent": randomUA(),
  };
}

interface ServerEntry {
  name: string | null;
  dataHash: string | null;
}

interface QualityPlaylist {
  uri: string;
  attributes?: { BANDWIDTH?: number; RESOLUTION?: { width: number; height: number } };
}

function parseServers(html: string): { servers: ServerEntry[]; baseDom: string } {
  const $ = cheerio.load(html);
  const iframeSrc = $("#player_iframe").attr("src") ?? $("iframe").attr("src") ?? "";
  let baseDom = "https://cloudnestra.com";
  let iframeHash: string | null = null;

  try {
    const normalized = iframeSrc.startsWith("//") ? `https:${iframeSrc}` : iframeSrc;
    if (normalized) {
      const parsed = new URL(normalized);
      baseDom = parsed.origin;
      const match = parsed.pathname.match(/\/rcp\/(.+)$/);
      if (match) iframeHash = match[1] ?? null;
    }
  } catch {
    // keep default
  }

  const servers: ServerEntry[] = [];
  $(".serversList .server").each((_i, el) => {
    const server = $(el);
    servers.push({
      name: server.text().trim() || null,
      dataHash: server.attr("data-hash") ?? null,
    });
  });

  if (servers.length === 0 && iframeHash) {
    servers.push({ name: "Default", dataHash: iframeHash });
  }

  return { servers, baseDom };
}

async function resolveProrcp(baseDom: string, prorcpPath: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseDom}/prorcp/${prorcpPath}`, {
      headers: baseHeaders(baseDom),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const fileMatch = html.match(/file:\s*'([^']*)'/);
    if (fileMatch?.[1]) return fileMatch[1] ?? null;

    const masterMatch = html.match(/var master_urls\s*=\s*"([^"]+)"/);
    if (!masterMatch?.[1]) return null;
    let masterUrls = masterMatch[1];

    const genCalls = [...html.matchAll(/\$\.get\("([^"]+generate\.php)"/g)].map((m) => m[1]);
    const placeholders = [
      ...new Set([...html.matchAll(/replaceAll\("(__[A-Z]+__)",\s*token\)/g)].map((m) => m[1])),
    ];

    for (let i = 0; i < genCalls.length && i < placeholders.length; i++) {
      const genUrl = genCalls[i];
      const placeholder = placeholders[i];
      if (!genUrl || !placeholder) continue;
      try {
        const tokenRes = await fetch(genUrl, { headers: baseHeaders(baseDom) });
        if (!tokenRes.ok) continue;
        const token = (await tokenRes.text()).trim();
        masterUrls = masterUrls.split(placeholder).join(token);
      } catch (err) {
        logger.warn({ err, genUrl }, "VidSrc: token fetch failed");
      }
    }

    const firstUrl = masterUrls.split(/\s+or\s+/)[0];
    return firstUrl ?? null;
  } catch (err) {
    logger.warn({ err }, "VidSrc: prorcp resolve failed");
    return null;
  }
}

async function parseHlsQualities(masterUrl: string): Promise<Array<{ title: string; url: string }>> {
  try {
    const res = await fetch(masterUrl);
    if (!res.ok) return [];
    const content = await res.text();
    if (!content.includes("#EXT-X-STREAM-INF")) return [];

    const parser = new Parser();
    parser.push(content);
    parser.end();

    const playlists = (parser.manifest.playlists ?? []) as QualityPlaylist[];

    return playlists
      .sort((a, b) => (b.attributes?.BANDWIDTH ?? 0) - (a.attributes?.BANDWIDTH ?? 0))
      .map((pl) => {
        const resolution = pl.attributes?.RESOLUTION;
        const url = pl.uri.startsWith("http") ? pl.uri : new URL(pl.uri, masterUrl).toString();
        const title = resolution ? `${resolution.height}p` : "Auto";
        return { title, url };
      });
  } catch (err) {
    logger.warn({ err, masterUrl }, "VidSrc: HLS quality parse failed");
    return [];
  }
}

function buildProxyUrl(proxyBase: string, targetUrl: string, referer: string): string {
  const id = createVidsrcLink(targetUrl, referer);
  const isPlaylist = targetUrl.split("?")[0]?.toLowerCase().endsWith(".m3u8");
  return isPlaylist
    ? `${proxyBase}/vidsrc-proxy/m3u8/${id}.m3u8`
    : `${proxyBase}/vidsrc-proxy/seg/${id}.ts`;
}

export interface VidsrcStream {
  name: string;
  description: string;
  url: string;
  behaviorHints?: { notWebReady?: boolean };
}

export async function getVidsrcStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  proxyBase: string,
): Promise<VidsrcStream[]> {
  const embedUrl =
    type === "series" && season !== undefined && episode !== undefined
      ? `${SOURCE_URL}/tv/${imdbId}/${season}-${episode}`
      : `${SOURCE_URL}/movie/${imdbId}`;

  let embedHtml: string;
  try {
    const res = await fetch(embedUrl, { headers: baseHeaders("https://vidsrc-embed.ru") });
    if (!res.ok) {
      logger.warn({ url: embedUrl, status: res.status }, "VidSrc: embed fetch failed");
      return [];
    }
    embedHtml = await res.text();
  } catch (err) {
    logger.warn({ err, embedUrl }, "VidSrc: embed fetch error");
    return [];
  }

  const { servers, baseDom } = parseServers(embedHtml);
  if (servers.length === 0) return [];

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      if (!server.dataHash) return null;
      const rcpRes = await fetch(`${baseDom}/rcp/${server.dataHash}`, {
        headers: baseHeaders(baseDom),
      });
      if (!rcpRes.ok) return null;
      const rcpHtml = await rcpRes.text();

      const srcMatch = rcpHtml.match(/src:\s*'([^']*)'/);
      const src = srcMatch?.[1] ?? null;
      if (!src || !src.startsWith("/prorcp/")) return null;

      const streamUrl = await resolveProrcp(baseDom, src.replace("/prorcp/", ""));
      if (!streamUrl) return null;

      const referer = `${baseDom}/`;
      const serverLabel = server.name ?? "VidSrc";

      const qualities = await parseHlsQualities(streamUrl);
      if (qualities.length > 0) {
        return qualities.map((q) => ({
          name: "VidSrc",
          description: `${serverLabel} — ${q.title}`,
          url: buildProxyUrl(proxyBase, q.url, referer),
        }));
      }

      return [
        {
          name: "VidSrc",
          description: serverLabel,
          url: buildProxyUrl(proxyBase, streamUrl, referer),
        },
      ];
    }),
  );

  const streams: VidsrcStream[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      streams.push(...r.value);
    }
  }

  logger.info({ imdbId, type, count: streams.length }, "VidSrc: streams resolved");
  return streams;
}
