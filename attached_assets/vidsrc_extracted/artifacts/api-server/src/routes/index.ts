import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stremioRouter from "./stremio";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stremioRouter);

export default router;
