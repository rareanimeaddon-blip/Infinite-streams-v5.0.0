import { Router, type IRouter } from "express";
import {
  addonCorsHeaders,
  addonJson,
  buildAddonCatalog,
  buildAddonMeta,
  buildAddonStreams,
  SHOWBOX_MANIFEST,
} from "../lib/showbox-addon";

const router: IRouter = Router();

router.use((_req, res, next) => {
  for (const [key, value] of Object.entries(addonCorsHeaders)) {
    res.setHeader(key, value);
  }
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

router.get("/manifest.json", (_req, res) => {
  res.type("application/json").send(JSON.stringify(SHOWBOX_MANIFEST));
});

router.get("/catalog/:type/:id", async (req, res) => {
  const id = req.params.id.replace(/\.json$/, "");
  try {
    res.type("application/json").send(
      JSON.stringify({ metas: await buildAddonCatalog(req.params.type, id, {}) }),
    );
  } catch {
    res.status(502).type("application/json").send(JSON.stringify({ metas: [] }));
  }
});

router.get("/catalog/:type/:id/:extra", async (req, res) => {
  const extraRaw = req.params.extra.replace(/\.json$/, "");
  const extra: Record<string, string> = {};
  for (const part of extraRaw.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    extra[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(
      part.slice(separator + 1),
    );
  }
  try {
    res.type("application/json").send(
      JSON.stringify({
        metas: await buildAddonCatalog(req.params.type, req.params.id, extra),
      }),
    );
  } catch {
    res.status(502).type("application/json").send(JSON.stringify({ metas: [] }));
  }
});

router.get("/meta/:type/:id", async (req, res) => {
  const id = req.params.id.replace(/\.json$/, "");
  const type = req.params.type === "series" ? "series" : "movie";
  try {
    const meta = await buildAddonMeta(id, type);
    if (!meta) {
      res.status(404).type("application/json").send(JSON.stringify({ meta: null }));
      return;
    }
    res.type("application/json").send(JSON.stringify({ meta }));
  } catch {
    res.status(502).type("application/json").send(JSON.stringify({ meta: null }));
  }
});

router.get("/stream/:type/:id", async (req, res) => {
  const id = req.params.id.replace(/\.json$/, "");
  const type = req.params.type === "series" ? "series" : "movie";
  res.type("application/json").send(
    JSON.stringify(await buildAddonStreams(id, type)),
  );
});

export default router;