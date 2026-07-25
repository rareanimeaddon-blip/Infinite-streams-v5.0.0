import { Router, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  addonInterface,
  extractVidlinkStreams,
  expandM3u8Masters,
  resolveTmdbId,
  parseStremioId,
  candidateCacheKey,
  cacheCandidates,
  getCachedCandidates,
  USER_AGENT,
  type Candidate,
} from "../addon.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/manifest.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(addonInterface.manifest);
});

router.get("/:resource/:type/:id.json", (req: Request, res: Response) => {
  const { resource, type } = req.params;
  const id = decodeURIComponent(req.params["id"]);
  logger.info({ resource, type, id }, "Stremio resource request");

  addonInterface
    .get(resource, type, id)
    .then((result: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.json(result);
    })
    .catch((err: Error) => {
      logger.error({ err: err.message }, "Stremio handler error");
      res.status(500).json({ error: err.message });
    });
});

const PASS_THROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
];

async function openUpstream(
  candidate: Candidate,
  rangeHeader: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    referer: candidate.headers["referer"] || "https://filmboom.top/",
    origin: candidate.headers["origin"] || "https://filmboom.top",
    "user-agent": USER_AGENT,
    accept: "*/*",
  };
  if (rangeHeader) headers["range"] = rangeHeader;
  return fetch(candidate.url, {
    method: "GET",
    headers,
    // @ts-ignore
    duplex: "half",
  });
}

// ── Server-side stream proxy ─────────────────────────────────────────────────
router.get("/stream-proxy/:type/:id", async (req: Request, res: Response) => {
  const type = decodeURIComponent(req.params["type"]);
  const id   = decodeURIComponent(req.params["id"]);
  // qi = quality index chosen in the stream handler; 0 = best quality
  const qi   = parseInt((req.query["qi"] as string) || "0", 10);
  const rangeHeader = req.headers["range"] as string | undefined;
  logger.info({ type, id, qi, range: rangeHeader }, "Stream proxy request");

  try {
    const parsed = parseStremioId(id);
    const tmdbId = await resolveTmdbId(type, parsed.baseId);
    if (!tmdbId) {
      res.status(404).json({ error: "Could not resolve TMDB ID" });
      return;
    }

    const key = candidateCacheKey(type, tmdbId, parsed.season, parsed.episode);

    // Prefer the candidate list already built by the stream handler (cache hit).
    // On cache miss (server restart, TTL expiry) re-extract + expand.
    let candidates = getCachedCandidates(key);
    if (!candidates) {
      logger.info({ key }, "Candidate cache miss — re-extracting");
      const raw = await extractVidlinkStreams({
        type,
        tmdbId,
        season: parsed.season,
        episode: parsed.episode,
      });
      candidates = await expandM3u8Masters(raw);
      if (candidates.length) cacheCandidates(key, candidates);
    }

    if (!candidates || !candidates.length) {
      res.status(502).json({ error: "No stream candidates found" });
      return;
    }

    // Start from the requested quality index; fall back to others on rate limit
    const primary  = candidates[qi] ?? candidates[0];
    const fallbacks = candidates.filter((_, i) => i !== (qi < candidates.length ? qi : 0));
    const ordered  = [primary, ...fallbacks];

    let upstream: globalThis.Response | null = null;
    let chosen:   Candidate | null = null;

    for (let round = 0; round < 2 && !upstream; round++) {
      // On the second round, re-extract to get fresh signed URLs
      if (round === 1) {
        logger.info({ key }, "All mirrors rate-limited — re-extracting fresh URLs");
        await new Promise((r) => setTimeout(r, 750));
        const raw = await extractVidlinkStreams({
          type,
          tmdbId,
          season: parsed.season,
          episode: parsed.episode,
        });
        const fresh = await expandM3u8Masters(raw);
        if (fresh.length) {
          cacheCandidates(key, fresh);
          const freshPrimary   = fresh[qi] ?? fresh[0];
          const freshFallbacks = fresh.filter((_, i) => i !== (qi < fresh.length ? qi : 0));
          ordered.splice(0, ordered.length, freshPrimary, ...freshFallbacks);
        }
      }

      for (const cand of ordered) {
        try {
          const resp = await openUpstream(cand, rangeHeader);
          if (resp.status === 429 || resp.status === 403) {
            logger.warn({ url: cand.url, status: resp.status }, "Mirror rate-limited, trying next");
            try { await (resp.body as any)?.cancel?.(); } catch (_) {}
            continue;
          }
          upstream = resp;
          chosen   = cand;
          break;
        } catch (err: any) {
          logger.warn({ err: err.message, url: cand.url }, "Mirror fetch failed, trying next");
        }
      }
    }

    if (!upstream || !chosen) {
      res.status(502).json({ error: "All mirrors rate-limited or unreachable" });
      return;
    }

    logger.info({ url: chosen.url, quality: chosen.quality, status: upstream.status }, "Proxying CDN stream");
    res.status(upstream.status);
    for (const header of PASS_THROUGH_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!upstream.body) { res.end(); return; }
    const nodeStream = Readable.fromWeb(
      upstream.body as Parameters<typeof Readable.fromWeb>[0],
    );
    nodeStream.pipe(res);
    req.on("close", () => { try { nodeStream.destroy(); } catch (_) {} });
  } catch (err: any) {
    logger.error({ err: err.stack || err.message }, "Stream proxy error");
    if (!res.headersSent) {
      res.status(502).json({ error: "Stream extraction failed", detail: err.message });
    }
  }
});

export default router;
