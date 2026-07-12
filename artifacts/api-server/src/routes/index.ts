import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import proxyRouter from "./proxy.js";
import netmirrorProxyRouter from "../providers/netmirror/netmirror-proxy.js";
import raProxyRouter from "../providers/rareanime/rareanime-proxy.js";
import meowtvProxyRouter from "../providers/meowtv/meowtv-proxy.js";
import vidsrcProxyRouter from "../providers/vidsrc/vidsrc-proxy.js";
import animesaltProxyRouter from "../providers/animesalt/animesalt-proxy.js";
import hindmoviesProxyRouter from "../providers/hindmovies/hindmovies-proxy.js";
import movies4uProxyRouter from "../providers/movies4u/movies4u-proxy.js";
import kartoonsProxyRouter from "../providers/kartoons/kartoons-proxy.js";
import animedekhoProxyRouter from "../providers/animedekho/animedekho-proxy.js";
import vidlinkProxyRouter from "../providers/vidlink/vidlink-proxy.js";
import stremioRouter from "./stremio.js";
import debugRouter from "./debug.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(debugRouter);
// NOTE: proxyRouter (generic + MovieBox) is mounted first, so its route
// handlers win for any path also defined in the per-provider copies below.
// Per-provider copies (animesalt/hindmovies/movies4u/kartoons/animedekho/
// vidlink) are full duplicates kept self-contained in each provider's folder
// per the folder-isolation convention — see replit.md. They're mounted too
// so each provider's block in stremio.ts can be pointed at its own copy
// independently in the future.
router.use(proxyRouter);
router.use(netmirrorProxyRouter);
router.use(raProxyRouter);
router.use(meowtvProxyRouter);
router.use(vidsrcProxyRouter);
router.use(animesaltProxyRouter);
router.use(hindmoviesProxyRouter);
router.use(movies4uProxyRouter);
router.use(kartoonsProxyRouter);
router.use(animedekhoProxyRouter);
router.use(vidlinkProxyRouter);
router.use(stremioRouter);

export default router;
