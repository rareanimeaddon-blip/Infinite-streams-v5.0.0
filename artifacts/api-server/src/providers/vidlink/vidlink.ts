import sodium from "libsodium-wrappers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";

// WASM files live in artifacts/api-server/wasm/ – the server's CWD when started
// by the pnpm script is the package directory.
const WASM_DIR = join(process.cwd(), "wasm");
const VIDLINK_BASE = "https://vidlink.pro/api/b";

export interface VidLinkQuality {
  type: string;
  url: string;
  codecName?: string;
  size?: string;
  resourceId?: string;
}

export interface VidLinkAlternate {
  type: string;
  playlist: string;
}

export interface VidLinkCaption {
  url: string;
  language: string;
  type?: string;
}

export interface VidLinkStreamData {
  id: string;
  type: string;
  qualities?: Record<string, VidLinkQuality>;
  alternates?: Record<string, VidLinkAlternate>;
  captions?: VidLinkCaption[];
  flags?: string[];
  TTL?: number;
}

export interface VidLinkResponse {
  sourceId: string;
  stream: VidLinkStreamData;
}

// Singleton WASM state
type GetAdvFn = (id: string) => string | null;
let getAdvFn: GetAdvFn | null = null;
let initPromise: Promise<void> | null = null;

async function initVidLink(): Promise<void> {
  // 1. Initialize libsodium (the Go WASM uses window.sodium internally)
  await sodium.ready;
  (globalThis as Record<string, unknown>).sodium = sodium;

  // 2. Load and eval the Go WASM bridge – this registers the Dm (Go runtime) class
  const scriptContent = readFileSync(join(WASM_DIR, "script.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(scriptContent);

  // 3. Instantiate the Go WASM binary
  const wasmBuffer = readFileSync(join(WASM_DIR, "fu.wasm"));

  type GoClass = new () => {
    importObject: Record<string, unknown>;
    run(instance: unknown): void;
  };
  const GoRuntime = (globalThis as Record<string, unknown>).Dm as GoClass;
  const go = new GoRuntime();
  // WebAssembly is a Node.js built-in; cast through unknown for TypeScript
  const wasm = globalThis as unknown as {
    WebAssembly: {
      instantiate(
        buffer: Buffer,
        imports: Record<string, unknown>,
      ): Promise<{ instance: unknown }>;
    };
  };
  const { instance } = await wasm.WebAssembly.instantiate(
    wasmBuffer,
    go.importObject,
  );
  go.run(instance);

  // 4. Give the Go runtime time to export getAdv
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  getAdvFn = (globalThis as Record<string, unknown>).getAdv as GetAdvFn;
  if (!getAdvFn) {
    throw new Error("VidLink: getAdv not exported after WASM init");
  }

  logger.info("VidLink WASM ready");
}

export async function ensureVidLinkReady(): Promise<void> {
  if (!initPromise) {
    initPromise = initVidLink().catch((err) => {
      initPromise = null; // allow a retry next call
      throw err;
    });
  }
  return initPromise;
}

export type VidLinkParams =
  | { type: "movie"; tmdbId: string }
  | { type: "tv"; tmdbId: string; season: number; episode: number };

export async function fetchVidLinkStream(
  params: VidLinkParams,
): Promise<VidLinkResponse | null> {
  await ensureVidLinkReady();

  if (!getAdvFn) throw new Error("VidLink WASM not initialized");

  const encodedId = getAdvFn(params.tmdbId);
  if (!encodedId) {
    logger.warn({ tmdbId: params.tmdbId }, "VidLink: getAdv returned null");
    return null;
  }

  const url =
    params.type === "movie"
      ? `${VIDLINK_BASE}/movie/${encodedId}?multiLang=0`
      : `${VIDLINK_BASE}/tv/${encodedId}/${params.season}/${params.episode}?multiLang=0`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://vidlink.pro/",
      Origin: "https://vidlink.pro",
    },
  });

  if (!resp.ok) {
    logger.warn({ status: resp.status, url }, "VidLink API error");
    return null;
  }

  const text = await resp.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as VidLinkResponse;
  } catch (err) {
    logger.warn({ err }, "VidLink: failed to parse response");
    return null;
  }
}
