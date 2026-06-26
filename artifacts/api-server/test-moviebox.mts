import { createHash, createHmac } from "crypto";
import { URL } from "url";

const SECRET_KEY_DEFAULT = Buffer.from("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O", "base64");

function md5Hex(data: Buffer | string): string {
  return createHash("md5").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

function generateDeviceId(): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes.toString("hex");
}

function generateXClientToken(): string {
  const timestamp = String(Date.now());
  const reversed = timestamp.split("").reverse().join("");
  return `${timestamp},${md5Hex(reversed)}`;
}

function buildCanonicalString(method: string, accept: string | undefined, contentType: string | undefined, url: string, body: string | undefined, timestamp: number): string {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const queryParams: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => queryParams.push([key, value]));
  queryParams.sort((a, b) => a[0].localeCompare(b[0]));
  const query = queryParams.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalUrl = query ? `${path}?${query}` : path;
  let bodyHash = "";
  let bodyLength = "";
  if (body != null) {
    const bodyBytes = Buffer.from(body, "utf8");
    const trimmed = bodyBytes.length > 102400 ? bodyBytes.subarray(0, 102400) : bodyBytes;
    bodyHash = md5Hex(trimmed);
    bodyLength = String(bodyBytes.length);
  }
  return [method.toUpperCase(), accept ?? "", contentType ?? "", bodyLength, String(timestamp), bodyHash, canonicalUrl].join("\n");
}

function generateXTrSignature(method: string, accept: string | undefined, contentType: string | undefined, url: string, body?: string): string {
  const timestamp = Date.now();
  const canonical = buildCanonicalString(method, accept, contentType, url, body, timestamp);
  const signature = createHmac("md5", SECRET_KEY_DEFAULT).update(Buffer.from(canonical, "utf8")).digest("base64");
  return `${timestamp}|2|${signature}`;
}

const DEVICE_ID = generateDeviceId();
const BRANDS: Record<string, string[]> = {
  Samsung: ["SM-S918B", "SM-A528B"],
  Xiaomi: ["2201117TI", "M2012K11AI"],
};
const brandKeys = Object.keys(BRANDS);
const brand = brandKeys[Math.floor(Math.random() * brandKeys.length)]!;
const model = BRANDS[brand]![0]!;

async function testSearch(keyword: string) {
  const url = "https://api3.aoneroom.com/wefeed-mobile-bff/subject-api/search/v2";
  const body = JSON.stringify({ page: 1, perPage: 15, keyword });
  const xClientToken = generateXClientToken();
  const xTrSignature = generateXTrSignature("POST", "application/json", "application/json", url, body);

  const headers: Record<string, string> = {
    "user-agent": `com.community.oneroom/50020088 (Linux; U; Android 13; en_US; ${brand}; Build/TQ3A.230901.001; Cronet/145.0.7582.0)`,
    "accept": "application/json",
    "content-type": "application/json",
    "x-client-token": xClientToken,
    "x-tr-signature": xTrSignature,
    "x-client-info": JSON.stringify({
      package_name: "com.community.oneroom", version_name: "3.0.13.0325.03", version_code: 50020088,
      os: "android", os_version: "13", install_ch: "ps", device_id: DEVICE_ID,
      install_store: "ps", gaid: "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",
      brand: model, model: brand, system_language: "en", net: "NETWORK_WIFI",
      region: "US", timezone: "Asia/Calcutta", sp_code: "",
      "X-Play-Mode": "1", "X-Idle-Data": "1", "X-Family-Mode": "0", "X-Content-Mode": "0",
    }),
    "x-client-status": "0",
  };

  console.log("\n=== Testing keyword:", keyword, "===");
  console.log("x-client-token:", xClientToken);
  console.log("x-tr-signature:", xTrSignature);

  const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20000) });
  console.log("HTTP Status:", resp.status, resp.statusText);
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  console.log("x-user:", respHeaders["x-user"]);
  const text = await resp.text();
  console.log("Response:", text.slice(0, 3000));
  return { status: resp.status, body: text };
}

// Also try a different API endpoint in case the search path changed
async function testAltEndpoint() {
  // Try the newer API path that some scrapers use
  const url = "https://api3.aoneroom.com/wefeed-mobile-bff/subject-api/search";
  const body = JSON.stringify({ page: 1, perPage: 15, keyword: "Inception" });
  const xClientToken = generateXClientToken();
  const xTrSignature = generateXTrSignature("POST", "application/json", "application/json", url, body);

  const headers: Record<string, string> = {
    "user-agent": `com.community.oneroom/50020088 (Linux; U; Android 13; en_US; ${brand}; Build/TQ3A.230901.001; Cronet/145.0.7582.0)`,
    "accept": "application/json",
    "content-type": "application/json",
    "x-client-token": xClientToken,
    "x-tr-signature": xTrSignature,
    "x-client-info": JSON.stringify({
      package_name: "com.community.oneroom", version_name: "3.0.13.0325.03", version_code: 50020088,
      os: "android", os_version: "13", install_ch: "ps", device_id: DEVICE_ID,
      install_store: "ps", gaid: "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",
      brand: model, model: brand, system_language: "en", net: "NETWORK_WIFI",
      region: "US", timezone: "Asia/Calcutta", sp_code: "",
      "X-Play-Mode": "1", "X-Idle-Data": "1", "X-Family-Mode": "0", "X-Content-Mode": "0",
    }),
    "x-client-status": "0",
  };

  console.log("\n=== Testing alt endpoint (v1 search) ===");
  const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20000) });
  console.log("HTTP Status:", resp.status, resp.statusText);
  const text = await resp.text();
  console.log("Response:", text.slice(0, 2000));
}

try {
  await testSearch("Inception");
  await testAltEndpoint();
} catch(e: any) {
  console.error("Fatal error:", e.message, e.stack);
}
