import app from "./app.js";
import { logger } from "./lib/logger.js";
import { getAllCatalogItems, buildAtoonCatalog } from "./providers/rareanime/scraper.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Extra ports that Replit's proxy may route external-port-80 traffic to.
// We bind all of them so the proxy succeeds regardless of which one it picks.
const EXTRA_PORTS: number[] = [8081].filter((p) => p !== port);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Bind extra ports silently — ignore EADDRINUSE in case they're taken
  for (const extra of EXTRA_PORTS) {
    app.listen(extra, (err2) => {
      if (err2) {
        logger.warn({ port: extra, err: err2 }, "Extra port bind failed (ignored)");
      } else {
        logger.info({ port: extra }, "Server also listening on extra port");
      }
    });
  }

  Promise.allSettled([
    getAllCatalogItems().then(() => logger.info("RareAnime catalog pre-warm done")),
    buildAtoonCatalog().then(() => logger.info("Atoon catalog pre-warm done")),
  ]).catch(() => {});
});
