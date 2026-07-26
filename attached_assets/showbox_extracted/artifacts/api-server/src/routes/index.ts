import { Router, type IRouter } from "express";
import healthRouter from "./health";
import showboxRouter from "./showbox";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/showbox", showboxRouter);

export default router;
