// VidSrc.sbs stream provider.
// Hits the flikhub.net aggregator directly for HLS URLs across multiple sub-sources.

const FLIKHUB = "https://proxy1.flikhub.net";

export const SOURCES = ["vidapi", "vidrift"] as const;
export type SourceKey = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<SourceKey, string> = {
  vidapi: "VidAPI",
  vidrift: "VidRift",
};

export interface FlikSource {
  source: string;
  label: string;
  url: string;
  type?: string;
}

export interface FlikSubtitle {
  url: string;
  lang?: string;
  label?: string;
}

interface FlikResponse {
  source?: FlikSource | FlikSource[] | null;
  subtitles?: FlikSubtitle[];
  meta?: unknown;
  error?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchOne(
  type: "movie" | "tv",
  tmdbId: number,
  source: SourceKey,
  season?: number,
  episode?: number,
): Promise<{ source: FlikSource; subtitles: FlikSubtitle[] } | null> {
  const qs = new URLSearchParams({
    id: String(tmdbId),
    sources: source,
    mode: "json",
  });
  if (type === "tv") {
    qs.set("season", String(season));
    qs.set("episode", String(episode));
  }
  const url = `${FLIKHUB}/${type}?${qs.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json,text/plain,*/*",
        referer: "https://player.cinezo.live/",
        origin: "https://player.cinezo.live",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FlikResponse;
    const s = data.source;
    const chosen: FlikSource | null = Array.isArray(s) ? (s[0] ?? null) : s ?? null;
    if (!chosen?.url) return null;
    return { source: chosen, subtitles: data.subtitles ?? [] };
  } catch {
    return null;
  }
}

export async function fetchAllSources(
  type: "movie" | "tv",
  tmdbId: number,
  season?: number,
  episode?: number,
): Promise<Array<{ key: SourceKey; source: FlikSource; subtitles: FlikSubtitle[] }>> {
  const results = await Promise.all(
    SOURCES.map((k) =>
      fetchOne(type, tmdbId, k, season, episode).then((r) =>
        r ? { key: k, ...r } : null,
      ),
    ),
  );
  return results.filter((r): r is NonNullable<typeof r> => !!r);
}
