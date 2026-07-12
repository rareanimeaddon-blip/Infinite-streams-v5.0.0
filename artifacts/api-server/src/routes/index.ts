import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import proxyRouter from "./proxy.js";
import netmirrorProxyRouter from "../providers/netmirror/netmirror-proxy.js";
import raProxyRouter from "../providers/rareanime/rareanime-proxy.js";
import meowtvProxyRouter from "../providers/meowtv/meowtv-proxy.js";
import vidsrcProxyRouter from "../providers/vidsrc/vidsrc-proxy.js";
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
