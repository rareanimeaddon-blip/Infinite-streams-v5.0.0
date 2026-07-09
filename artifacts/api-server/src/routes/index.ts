import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import proxyRouter from "./proxy.js";
import netmirrorProxyRouter from "./netmirror-proxy.js";
import raProxyRouter from "./rareanime-proxy.js";
import meowtvProxyRouter from "./meowtv-proxy.js";
import vidsrcProxyRouter from "./vidsrc-proxy.js";
import stremioRouter from "./stremio.js";
import debugRouter from "./debug.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(debugRouter);
router.use(proxyRouter);
router.use(netmirrorProxyRouter);
router.use(raProxyRouter);
router.use(meowtvProxyRouter);
router.use(vidsrcProxyRouter);
router.use(stremioRouter);

export default router;
