import { Router } from "express";

const router = Router();

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

export default router;
