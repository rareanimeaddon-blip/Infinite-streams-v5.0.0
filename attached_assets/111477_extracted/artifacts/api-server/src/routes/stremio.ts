import { Router, type IRouter } from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getRouter } = require("stremio-addon-sdk") as {
  getRouter: (addonInterface: unknown) => IRouter;
};
const addon = require("../stremio-addon/index.cjs") as {
  getInterface: () => unknown;
};

const router: IRouter = getRouter(addon.getInterface());

export default Router().use(router);