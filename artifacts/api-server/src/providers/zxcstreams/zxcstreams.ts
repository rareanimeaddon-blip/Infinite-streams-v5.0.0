/**
 * ZXCStreams provider — Stremio stream aggregation wrapper.
 * All logic is self-contained within this folder (zxc.ts + zxc-proxy.ts).
 * No imports from outside providers/zxcstreams/.
 */

import { type Request } from "express";
import {
  getMetaFromCinemeta,
  getAllStreams,
  resolutionLabel,
  formatSize,
} from "./zxc.js";

function buildProxyBase(req: Request): string {
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  if (devDomain) return `https://${devDomain}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

/**
 * Fetch ZXCStream streams for a given IMDb ID and return Stremio-compatible
 * stream objects. HLS streams are proxied through /api/zxc/hls/proxy so that
 * the required Referer/Origin headers are sent on every segment request.
 */
export async function getZxcstreamsStreams(
  type: "movie" | "series",
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  req: Request,
): Promise<Record<string, unknown>[]> {
  const cinemetaType = type === "series" ? "series" : "movie";
  const meta = await getMetaFromCinemeta(cinemetaType, imdbId);
  if (!meta) return [];

  const backendType = type === "series" ? "tv" : "movie";
  const links = await getAllStreams(backendType, meta, season ?? null, episode ?? null);
  if (!links.length) return [];

  const host = buildProxyBase(req);

  // Sort: MP4 direct first, then by resolution descending
  const scored = links.map((l) => {
    const r = typeof l.resolution === "number" ? l.resolution : 0;
    const height = r > 4 ? r : ([240, 480, 720, 1080, 2160][r] ?? 0);
    return { l, score: (l.type === "mp4" ? 10000 : 0) + height };
  });
  scored.sort((a, b) => b.score - a.score);

  const streams: Record<string, unknown>[] = [];
  for (const { l } of scored) {
    const label = resolutionLabel(l.server, l.resolution);
    const size = formatSize(l.size);
    const kind = l.type === "hls" ? "HLS" : "MP4";
    const serverName =
      l.server === "icarus" ? "Icarus" :
      l.server === "orion"  ? "Orion"  :
      l.server === "athena" ? "Athena" : "Berkas";
    const serverEmoji =
      l.server === "icarus" ? "🟢" :
      l.server === "orion"  ? "🟠" :
      l.server === "athena" ? "🟣" : "🔵";
    const title = [`${serverEmoji} ${serverName} • ${label} • ${kind}`, size].filter(Boolean).join("\n");

    if (l.type === "hls") {
      const proxied = `${host}/api/zxc/hls/proxy?${new URLSearchParams({
        url: l.url,
        ref: l.requestHeaders["Referer"] ?? "",
      }).toString()}`;
      streams.push({
        name: `ZXCStream ${serverName} ${label}`,
        title,
        url: proxied,
        behaviorHints: { notWebReady: true, bingeGroup: `zxc-${l.server}-${label}` },
      });
    } else {
      streams.push({
        name: `ZXCStream ${serverName} ${label}`,
        title,
        url: l.url,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `zxc-${l.server}-${label}`,
          proxyHeaders: { request: l.requestHeaders },
        },
      });
    }
  }
  return streams;
}
