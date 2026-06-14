import { Router, type Request, type Response } from "express";
import axios from "axios";
import { handleCatalog, handleMeta, handleStream } from "../castle-tv/handlers.js";

const router = Router();

const MANIFEST = {
  id: "community.castletv.standalone",
  version: "1.0.15",
  name: "Castle TV + DahmerMovies + StreamFlix",
  description:
    "Castle TV, DahmerMovies & StreamFlix — Tamil, Hindi, English movies & series. Three providers in parallel, with subtitles.",
  logo: "https://github.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/raw/refs/heads/master/CastleTvProvider/icon.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "castletv-movies",
      name: "Castle TV Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "castletv-series",
      name: "Castle TV Series",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "castletv-search-movies",
      name: "Castle TV Search",
      extra: [{ name: "search", isRequired: true }],
    },
    {
      type: "series",
      id: "castletv-search-series",
      name: "Castle TV Search",
      extra: [{ name: "search", isRequired: true }],
    },
  ],
  idPrefixes: ["tt", "castletv:"],
  behaviorHints: { configurationRequired: false, adult: false },
};

function setCorsAndCache(res: Response, maxAge = 3600): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", `max-age=${maxAge}, public`);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function parseExtra(extraStr?: string): Record<string, string> {
  if (!extraStr) return {};
  const result: Record<string, string> = {};
  const pairs = extraStr.split("&");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx));
    const val = decodeURIComponent(pair.slice(eqIdx + 1));
    result[key] = val;
  }
  return result;
}

router.get("/manifest.json", (_req: Request, res: Response) => {
  setCorsAndCache(res, 86400);
  res.json(MANIFEST);
});

router.get(
  "/catalog/:type/:catalogId/:extra.json",
  async (req: Request, res: Response): Promise<void> => {
    const type = String(req.params.type ?? "");
    const catalogId = String(req.params.catalogId ?? "");
    const extra = String(req.params.extra ?? "");
    const extraParams = parseExtra(extra);
    setCorsAndCache(res, 1800);
    const result = await handleCatalog(type, catalogId, extraParams);
    res.json(result);
  },
);

router.get(
  "/catalog/:type/:catalogId.json",
  async (req: Request, res: Response): Promise<void> => {
    const type = String(req.params.type ?? "");
    const catalogId = String(req.params.catalogId ?? "");
    const extraFromQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === "string") extraFromQuery[k] = v;
    }
    setCorsAndCache(res, 1800);
    const result = await handleCatalog(type, catalogId, extraFromQuery);
    res.json(result);
  },
);

router.get("/meta/:type/:id.json", async (req: Request, res: Response): Promise<void> => {
  const type = String(req.params.type ?? "");
  const id = String(req.params.id ?? "");
  const stremioId = decodeURIComponent(id);
  setCorsAndCache(res, 3600);
  const result = await handleMeta(type, stremioId);
  res.json(result);
});

router.get("/proxy/dahmer", async (req: Request, res: Response): Promise<void> => {
  const encodedUrl = String(req.query.url ?? "");
  if (!encodedUrl) {
    res.status(400).send("Missing url parameter");
    return;
  }

  let originalUrl: string;
  try {
    originalUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
  } catch {
    res.status(400).send("Invalid url encoding");
    return;
  }

  if (!originalUrl.startsWith("https://a.111477.xyz/")) {
    res.status(403).send("Forbidden");
    return;
  }

  try {
    const bulkUrl = `https://p.111477.xyz/bulk?u=${encodeURIComponent(originalUrl)}`;
    const proxyRes = await axios.get(bulkUrl, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "identity",
        Referer: "https://a.111477.xyz/",
      },
      timeout: 10000,
    });

    const location = proxyRes.headers["location"] as string | undefined;
    if (location) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.redirect(302, location);
    } else {
      res.status(502).send("No location received from upstream");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).send(`Proxy error: ${msg}`);
  }
});

router.get("/stream/:type/:id.json", async (req: Request, res: Response): Promise<void> => {
  const type = String(req.params.type ?? "");
  const id = String(req.params.id ?? "");
  const stremioId = decodeURIComponent(id);
  setCorsAndCache(res, 900);
  const result = await handleStream(type, stremioId);
  res.json(result);
});

router.options("/{*path}", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(200);
});

export default router;
