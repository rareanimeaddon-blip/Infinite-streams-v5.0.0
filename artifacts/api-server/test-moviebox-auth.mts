import { createHash, createHmac } from "crypto";
import { URL } from "url";

const SECRET_KEY_DEFAULT = Buffer.from("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O", "base64");
const SECRET_KEY_ALT = Buffer.from("XqN2nnO41/L92o1iuXhSLHTbXvY4Z5ZZ62m8mSLA", "base64");

function md5Hex(data: Buffer | string): string {
  return createHash("md5").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}
function generateDeviceId(): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes.toString("hex");
}
function generateXClientToken(): string {
  const ts = String(Date.now());
  return `${ts},${md5Hex(ts.split("").reverse().join(""))}`;
}
function buildCanonical(method: string, accept: string | undefined, ct: string | undefined, url: string, body: string | undefined, ts: number): string {
  const parsed = new URL(url);
  const qps: [string, string][] = [];
  parsed.searchParams.forEach((v, k) => qps.push([k, v]));
  qps.sort((a, b) => a[0].localeCompare(b[0]));
  const q = qps.map(([k, v]) => `${k}=${v}`).join("&");
  const cu = q ? `${parsed.pathname}?${q}` : parsed.pathname;
  let bh = "", bl = "";
  if (body != null) {
    const bb = Buffer.from(body, "utf8");
    bh = md5Hex(bb.length > 102400 ? bb.subarray(0, 102400) : bb);
    bl = String(bb.length);
  }
  return [method.toUpperCase(), accept ?? "", ct ?? "", bl, String(ts), bh, cu].join("\n");
}
function sig(method: string, accept: string | undefined, ct: string | undefined, url: string, body?: string, alt = false): string {
  const ts = Date.now();
  const key = alt ? SECRET_KEY_ALT : SECRET_KEY_DEFAULT;
  const s = createHmac("md5", key).update(Buffer.from(buildCanonical(method, accept, ct, url, body, ts), "utf8")).digest("base64");
  return `${ts}|2|${s}`;
}

const DEVICE_ID = generateDeviceId();
const brand = "Samsung", model = "SM-S918B";

function baseHeaders(method: string, url: string, body?: string, token?: string, altKey = false): Record<string, string> {
  const xct = generateXClientToken();
  const xtr = sig(method, "application/json", "application/json", url, body, altKey);
  const h: Record<string, string> = {
    "user-agent": `com.community.oneroom/50020088 (Linux; U; Android 13; en_US; ${brand}; Build/TQ3A.230901.001; Cronet/145.0.7582.0)`,
    "accept": "application/json",
    "content-type": "application/json",
    "x-client-token": xct,
    "x-tr-signature": xtr,
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
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function hit(label: string, url: string, method = "GET", body?: string, token?: string, altKey = false) {
  console.log(`\n=== ${label} ===`);
  const headers = baseHeaders(method, url, body, token, altKey);
  try {
    const resp = await fetch(url, {
      method, headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(20000),
    });
    console.log("Status:", resp.status);
    const rh: Record<string, string> = {};
    resp.headers.forEach((v, k) => { rh[k] = v; });
    if (rh["x-user"]) console.log("x-user:", rh["x-user"]);
    const text = await resp.text();
    console.log("Body:", text.slice(0, 2000));
    return { status: resp.status, text, headers: rh };
  } catch (e: any) {
    console.error("Error:", e.message);
    return null;
  }
}

const BASE = "https://api3.aoneroom.com/wefeed-mobile-bff";

// Try various auth endpoints
await hit("Guest login (POST)", `${BASE}/user-api/guest/login`, "POST", JSON.stringify({ deviceId: DEVICE_ID }));
await hit("Anonymous register", `${BASE}/user-api/anonymous/register`, "POST", JSON.stringify({ deviceId: DEVICE_ID }));
await hit("Guest register", `${BASE}/user-api/guest/register`, "POST", JSON.stringify({ deviceId: DEVICE_ID, brand, model, osVersion: "13" }));
await hit("Device login", `${BASE}/user-api/device/login`, "POST", JSON.stringify({ deviceId: DEVICE_ID }));
await hit("Token refresh (GET)", `${BASE}/user-api/token/refresh`);
await hit("Init (POST)", `${BASE}/user-api/init`, "POST", JSON.stringify({ deviceId: DEVICE_ID }));
await hit("App init", `${BASE}/app-api/init`, "POST", JSON.stringify({ deviceId: DEVICE_ID }));
await hit("Alt key guest login", `${BASE}/user-api/guest/login`, "POST", JSON.stringify({ deviceId: DEVICE_ID }), undefined, true);
