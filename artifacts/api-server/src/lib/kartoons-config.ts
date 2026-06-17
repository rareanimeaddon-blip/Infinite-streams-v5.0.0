import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { logger } from "./logger.js";

const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../kartoons-config.json",
);

interface KartoonsAddonConfig {
  kartoonsToken: string;
  kartoonsBase: string;
  updatedAt?: string;
}

const DEFAULT_CONFIG: KartoonsAddonConfig = {
  kartoonsToken:
    process.env["KARTOONS_TOKEN"] ?? "DNU1ZBzyTpwPldcjg09_RBKp5KgrQaMv0tdqDr9SX48",
  kartoonsBase: "https://api.kartoons.me/api/stremio",
};

let _config: KartoonsAddonConfig | null = null;

export function getAddonConfig(): KartoonsAddonConfig {
  if (_config) return _config;

  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const loaded: KartoonsAddonConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      _config = loaded;
      logger.info({ configPath: CONFIG_PATH }, "loaded kartoons config from disk");
      return loaded;
    }
  } catch (err) {
    logger.warn({ err }, "failed to read kartoons config, using defaults");
  }

  const defaults: KartoonsAddonConfig = { ...DEFAULT_CONFIG };
  _config = defaults;
  return defaults;
}

export function saveAddonConfig(updates: Partial<KartoonsAddonConfig>): KartoonsAddonConfig {
  const current = getAddonConfig();
  const next: KartoonsAddonConfig = { ...current, ...updates, updatedAt: new Date().toISOString() };
  _config = next;

  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
    logger.info({ configPath: CONFIG_PATH }, "saved kartoons config to disk");
  } catch (err) {
    logger.error({ err }, "failed to save kartoons config");
  }

  return next;
}

export function parseManifestUrl(
  manifestUrl: string,
): { base: string; token: string } | null {
  try {
    const u = new URL(manifestUrl);
    const token = u.searchParams.get("token");
    if (!token) return null;
    const base = `${u.protocol}//${u.host}${u.pathname.replace("/manifest.json", "")}`;
    return { base, token };
  } catch {
    return null;
  }
}
