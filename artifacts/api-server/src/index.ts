import app from "./app.js";
import { logger } from "./lib/logger.js";
import { getAllCatalogItems, buildAtoonCatalog } from "./providers/rareanime/scraper.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  Promise.allSettled([
    getAllCatalogItems().then(() => logger.info("RareAnime catalog pre-warm done")),
    buildAtoonCatalog().then(() => logger.info("Atoon catalog pre-warm done")),
  ]).catch(() => {});
});
