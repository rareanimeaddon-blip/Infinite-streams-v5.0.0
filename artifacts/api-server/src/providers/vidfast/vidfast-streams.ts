/**
 * VidFast stream formatter.
 *
 * Converts raw VidFastRawStream objects into Stremio-compatible stream objects.
 * The `name` field shows the provider name + server name (e.g. "⚡ VidFast\nCobra • 1080p")
 * so server names appear as badges in the Stremio UI.
 */

import { type VidFastRawStream, VIDFAST_BASE } from "./vidfast.js";

// ─── Quality ranking (lower = better) ────────────────────────────────────────

const QUALITY_RANK: Record<string, number> = {
  "2160p": 0,
  "1440p": 1,
  "1080p": 2,
  "720p": 3,
  "480p": 4,
  Auto: 5,
};

function rankQuality(quality: string): number {
  if (quality in QUALITY_RANK) return QUALITY_RANK[quality]!;
  const n = parseInt(quality, 10);
  return Number.isFinite(n) ? 100 - n / 100 : 99;
}

// ─── Subtitle extraction ──────────────────────────────────────────────────────

function subtitlesFrom(
  tracks: Array<{ file?: string; kind?: string; label?: string; language?: string }>,
): Array<{ id: string; url: string; lang: string }> {
  return tracks
    .filter((t) => t.file && (!t.kind || t.kind === "captions"))
    .map((t, i) => ({
      id: `vf-${i}`,
      url: t.file!,
      lang: t.label ?? t.language ?? `sub-${i + 1}`,
    }));
}

// ─── Public formatter ─────────────────────────────────────────────────────────

export interface VidFastStremioStream {
  name: string;
  title: string;
  url: string;
  subtitles?: Array<{ id: string; url: string; lang: string }>;
  behaviorHints: {
    notWebReady: boolean;
    bingeGroup?: string;
    proxyHeaders?: { request: Record<string, string> };
  };
  _idVerified: true;
}

/**
 * Build deduplicated, sorted Stremio stream objects from raw VidFast streams.
 *
 * name field format:  "⚡ VidFast\n<ServerName> • <Quality>"
 * title field format: "<ServerName> • <Description>\nvidfast.vc"
 *
 * Server names (Cobra, Dragon, Tiger, etc.) come directly from the VidFast
 * encrypted server list and are surfaced verbatim so users can identify sources.
 */
export function buildVidfastStreams(found: VidFastRawStream[]): VidFastStremioStream[] {
  const seen = new Set<string>();
  return found
    .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))
    .sort((a, b) => rankQuality(a.quality) - rankQuality(b.quality))
    .map((s): VidFastStremioStream => {
      const serverLabel = s.server && s.server !== "Default" ? s.server : "VidFast";
      const descPart = s.description ? ` • ${s.description}` : "";
      const subs = subtitlesFrom(s.tracks);

      return {
        name: `⚡ VidFast\n${serverLabel} • ${s.quality}`,
        title: `${serverLabel}${descPart}\nvidfast.vc`,
        url: s.url,
        ...(subs.length ? { subtitles: subs } : {}),
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `vidfast-${s.server}-${s.quality}`,
          proxyHeaders: {
            request: {
              "User-Agent": s.headers["User-Agent"] ?? "",
              Referer: s.headers["Referer"] ?? `${VIDFAST_BASE}/`,
              Origin: VIDFAST_BASE,
            },
          },
        },
        _idVerified: true,
      };
    });
}
