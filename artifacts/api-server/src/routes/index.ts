import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import proxyRouter from "./proxy.js";
import raProxyRouter from "../providers/rareanime/rareanime-proxy.js";
import meowtvProxyRouter from "../providers/meowtv/meowtv-proxy.js";
import vidsrcProxyRouter from "../providers/vidsrc/vidsrc-proxy.js";
import animesaltProxyRouter from "../providers/animesalt/animesalt-proxy.js";
import hindmoviesProxyRouter from "../providers/hindmovies/hindmovies-proxy.js";
import kartoonsProxyRouter from "../providers/kartoons/kartoons-proxy.js";
import animedekhoProxyRouter from "../providers/animedekho/animedekho-proxy.js";
import vidlinkProxyRouter from "../providers/vidlink/vidlink-proxy.js";
import movieboxProxyRouter from "../providers/moviebox/moviebox-proxy.js";
import stremioRouter from "./stremio.js";
import debugRouter from "./debug.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(debugRouter);
// Provider-specific proxy routers are mounted FIRST so each provider's own
// copy handles its routes. proxyRouter (shared — MovieBox + generic routes)
// is mounted last and only catches paths not already claimed above.
// Folder-isolation convention: each provider's proxy lives in its own folder.
router.use(animesaltProxyRouter);
router.use(hindmoviesProxyRouter);
router.use(kartoonsProxyRouter);
router.use(animedekhoProxyRouter);
router.use(vidlinkProxyRouter);
router.use(movieboxProxyRouter);
router.use(raProxyRouter);
router.use(meowtvProxyRouter);
router.use(vidsrcProxyRouter);
router.use(proxyRouter);
router.use(stremioRouter);

export default router;
