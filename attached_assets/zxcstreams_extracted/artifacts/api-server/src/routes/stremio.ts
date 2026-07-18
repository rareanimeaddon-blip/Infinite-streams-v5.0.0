import { Router, type IRouter, type Request, type Response } from "express";
import { ADDON_MANIFEST } from "../lib/stremio/addon.js";
import { buildCatalog } from "../lib/stremio/catalog.js";
import {
  imdbToTmdb,
  getMovie,
  getTv,
  getSeasonEpisodes,
  poster,
  backdrop,
} from "../lib/stremio/tmdb.js";
import {
  getMetaFromCinemeta,
  getAllStreams as getZxcStreams,
  resolutionLabel as zxcResLabel,
  formatSize as zxcFormatSize,
} from "../lib/stremio/zxcstreams/zxc.js";

const router: IRouter = Router();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(res: Response, data: unknown, status = 200) {
  res
    .status(status)
    .set({ "Content-Type": "application/json", "Cache-Control": "public, max-age=60", ...CORS })
    .json(data);
}

// OPTIONS preflight — use regex for Express 5 compat (no bare `*`)
router.options(/.*/, (_req: Request, res: Response) => {
  res.set(CORS).status(204).end();
});

// ── Manifest ─────────────────────────────────────────────────────────────────
router.get("/manifest.json", (_req: Request, res: Response) => {
  json(res, ADDON_MANIFEST);
});

// ── Catalog ───────────────────────────────────────────────────────────────────
// /catalog/:type/:id.json  (no extra)
router.get("/catalog/:type/:id", async (req: Request, res: Response) => {
  try {
    const id = (req.params.id as string).replace(/\.json$/, "");
    const metas = await buildCatalog(req.params.type, id, {});
    json(res, { metas });
  } catch {
    json(res, { metas: [] });
  }
});

// /catalog/:type/:id/:extra.json  (with search/skip extra)
router.get("/catalog/:type/:id/:extra", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const extraStr = (req.params.extra as string).replace(/\.json$/, "");
    const extra: Record<string, string> = {};
    for (const part of extraStr.split("&")) {
      const eq = part.indexOf("=");
      if (eq > 0) {
        extra[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
      }
    }
    const metas = await buildCatalog(req.params.type, id, extra);
    json(res, { metas });
  } catch {
    json(res, { metas: [] });
  }
});

// ── Meta ──────────────────────────────────────────────────────────────────────
router.get("/meta/:type/:id", async (req: Request, res: Response) => {
  try {
    const rawId = (req.params.id as string).replace(/\.json$/, "");
    const type = req.params.type === "series" ? "series" : "movie";

    let tmdbId: number;
    if (rawId.startsWith("tmdb:")) {
      tmdbId = Number(rawId.slice(5));
    } else if (rawId.startsWith("tt")) {
      const found = await imdbToTmdb(rawId, type);
      if (!found) { json(res, { meta: null }, 404); return; }
      tmdbId = found.tmdbId;
    } else {
      json(res, { meta: null }, 404);
      return;
    }

    if (type === "movie") {
      const m = await getMovie(tmdbId);
      json(res, {
        meta: {
          id: rawId,
          type: "movie",
          name: m.title,
          poster: poster(m.poster_path),
          background: backdrop(m.backdrop_path),
          description: m.overview,
          releaseInfo: (m.release_date || "").slice(0, 4),
          imdbRating: m.vote_average ? m.vote_average.toFixed(1) : undefined,
          runtime: m.runtime ? `${m.runtime} min` : undefined,
          genres: m.genres?.map((g) => g.name),
        },
      });
      return;
    }

    const tv = await getTv(tmdbId);
    const videos: object[] = [];
    for (const s of tv.seasons ?? []) {
      if (s.season_number === 0) continue;
      const episodes = await getSeasonEpisodes(tmdbId, s.season_number);
      for (const ep of episodes) {
        videos.push({
          id: `${rawId}:${ep.season_number}:${ep.episode_number}`,
          title: ep.name,
          season: ep.season_number,
          episode: ep.episode_number,
          released: ep.air_date || undefined,
          overview: ep.overview,
          thumbnail: ep.still_path
            ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
            : undefined,
        });
      }
    }

    json(res, {
      meta: {
        id: rawId,
        type: "series",
        name: tv.name,
        poster: poster(tv.poster_path),
        background: backdrop(tv.backdrop_path),
        description: tv.overview,
        releaseInfo: (tv.first_air_date || "").slice(0, 4),
        imdbRating: tv.vote_average ? tv.vote_average.toFixed(1) : undefined,
        genres: tv.genres?.map((g) => g.name),
        videos,
      },
    });
  } catch {
    json(res, { meta: null }, 500);
  }
});

// ── Stream ────────────────────────────────────────────────────────────────────
function qualityRank(q?: string): number {
  if (!q) return 0;
  const s = q.toLowerCase();
  if (s.includes("4k") || s.includes("2160")) return 2160;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

router.get("/stream/:type/:id", async (req: Request, res: Response) => {
  try {
    const rawId = (req.params.id as string).replace(/\.json$/, "");
    const type = req.params.type === "series" ? "series" : "movie";

    let tmdbId: number;
    let imdbId: string | undefined;
    let season: number | undefined;
    let episode: number | undefined;

    if (rawId.startsWith("tmdb:")) {
      const rest = rawId.slice(5).split(":");
      tmdbId = Number(rest[0]);
      season = rest[1] ? Number(rest[1]) : undefined;
      episode = rest[2] ? Number(rest[2]) : undefined;
    } else if (rawId.startsWith("tt")) {
      const parts = rawId.split(":");
      imdbId = parts[0]!;
      season = parts[1] ? Number(parts[1]) : undefined;
      episode = parts[2] ? Number(parts[2]) : undefined;
      const found = await imdbToTmdb(imdbId, type);
      if (!found) { json(res, { streams: [] }); return; }
      tmdbId = found.tmdbId;
    } else {
      json(res, { streams: [] });
      return;
    }

    const streams: object[] = [];
    const host = process.env["REPLIT_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
      : `${req.protocol}://${req.hostname}`;

    const zxc = await (async () => {
      if (!imdbId) return [];
      try {
        const cinemetaType = type === "series" ? "series" : "movie";
        const meta = await getMetaFromCinemeta(cinemetaType, imdbId);
        if (!meta) return [];
        const backendType = type === "series" ? "tv" : "movie";
        return await getZxcStreams(backendType, meta, season ?? null, episode ?? null);
      } catch { return []; }
    })();

    // ── ZXCStream ────────────────────────────────────────────────────────────
    // Sort: MP4 direct first, then by resolution descending
    const scoredZxc = zxc.map((l) => {
      const r = typeof l.resolution === "number" ? l.resolution : 0;
      const height = r > 4 ? r : ([240, 480, 720, 1080, 2160][r] ?? 0);
      return { l, score: (l.type === "mp4" ? 10000 : 0) + height };
    });
    scoredZxc.sort((a, b) => b.score - a.score);

    for (const { l } of scoredZxc) {
      const label = zxcResLabel(l.server, l.resolution);
      const size = zxcFormatSize(l.size);
      const kind = l.type === "hls" ? "HLS" : "MP4";
      const serverLabel =
        l.server === "icarus" ? "🟢 Icarus" :
        l.server === "orion"  ? "🟠 Orion"  : "🔵 Berkas";
      const title = [`${serverLabel} • ${label} • ${kind}`, size].filter(Boolean).join("\n");

      if (l.type === "hls") {
        const proxied = `${host}/api/zxc/hls/proxy?${new URLSearchParams({
          url: l.url,
          ref: l.requestHeaders.Referer,
        }).toString()}`;
        streams.push({
          name: `ZXCStream ${label}`,
          title,
          url: proxied,
          behaviorHints: { notWebReady: true, bingeGroup: `zxc-${l.server}-${label}` },
        });
      } else {
        streams.push({
          name: `ZXCStream ${label}`,
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

    json(res, { streams });
  } catch {
    json(res, { streams: [] });
  }
});

export default router;
