import { createHash, createHmac } from "crypto";
import { URL } from "url";

const SECRET_KEY_DEFAULT = Buffer.from(
  "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O",
  "base64",
);
const SECRET_KEY_ALT = Buffer.from(
  "XqN2nnO41/L92o1iuXhSLHTbXvY4Z5ZZ62m8mSLA",
  "base64",
);

export function md5Hex(data: Buffer | string): string {
  return createHash("md5")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

export function generateDeviceId(): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString("hex");
}

export function generateXClientToken(hardcodedTimestamp?: number): string {
  const timestamp = String(hardcodedTimestamp ?? Date.now());
  const reversed = timestamp.split("").reverse().join("");
  const hash = md5Hex(reversed);
  return `${timestamp},${hash}`;
}

const BRAND_MODELS: Record<string, string[]> = {
  Samsung: ["SM-S918B", "SM-A528B", "SM-M336B"],
  Xiaomi: ["2201117TI", "M2012K11AI", "Redmi Note 11"],
  OnePlus: ["LE2111", "CPH2449", "IN2023"],
  Google: ["Pixel 6", "Pixel 7", "Pixel 8"],
  Realme: ["RMX3085", "RMX3360", "RMX3551"],
};

export function randomBrandModel(): { brand: string; model: string } {
  const brands = Object.keys(BRAND_MODELS);
  const brand = brands[Math.floor(Math.random() * brands.length)];
  const models = BRAND_MODELS[brand];
  const model = models[Math.floor(Math.random() * models.length)];
  return { brand, model };
}

function buildCanonicalString(
  method: string,
  accept: string | undefined,
  contentType: string | undefined,
  url: string,
  body: string | undefined,
  timestamp: number,
): string {
  const parsed = new URL(url);
  const path = parsed.pathname;

  const queryParams: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });
  queryParams.sort((a, b) => a[0].localeCompare(b[0]));
  const query = queryParams.map(([k, v]) => `${k}=${v}`).join("&");

  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = "";
  let bodyLength = "";
  if (body != null) {
    const bodyBytes = Buffer.from(body, "utf8");
    const trimmed =
      bodyBytes.length > 102400 ? bodyBytes.subarray(0, 102400) : bodyBytes;
    bodyHash = md5Hex(trimmed);
    bodyLength = String(bodyBytes.length);
  }

  return [
    method.toUpperCase(),
    accept ?? "",
    contentType ?? "",
    bodyLength,
    String(timestamp),
    bodyHash,
    canonicalUrl,
  ].join("\n");
}

export function generateXTrSignature(
  method: string,
  accept: string | undefined,
  contentType: string | undefined,
  url: string,
  body?: string,
  useAltKey = false,
  hardcodedTimestamp?: number,
): string {
  const timestamp = hardcodedTimestamp ?? Date.now();
  const canonical = buildCanonicalString(
    method,
    accept,
    contentType,
    url,
    body,
    timestamp,
  );
  const secretKey = useAltKey ? SECRET_KEY_ALT : SECRET_KEY_DEFAULT;
  const signature = createHmac("md5", secretKey)
    .update(Buffer.from(canonical, "utf8"))
    .digest("base64");
  return `${timestamp}|2|${signature}`;
}
