import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stremioRouter from "./stremio";
import zxcHlsProxyRouter from "../lib/stremio/zxcstreams/hlsProxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(zxcHlsProxyRouter);
router.use(stremioRouter);

export default router;
