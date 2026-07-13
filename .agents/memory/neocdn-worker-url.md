---
name: AnimeDekho NeoCDN worker URL
description: CF Worker rotation problem and the stable /adneoproxy solution that's immune to rotation.
---

# AnimeDekho NeoCDN — Stable Proxy Architecture

## Rule
NeoCDN streams must go through our own `/api/adneoproxy` server proxy — never returned to Stremio as a direct CF Worker URL. The proxy re-fetches the myth player page at play time to get the CURRENT live worker URL.

**Why:** AnimeDekho rotates their CF Worker URL every few minutes (observed: reimoto → zenhashi → polarisro → ryoyama within one session). Baking the worker URL into a cached stream object causes "Origin error: 503" as soon as the worker rotates. Direct trycloudflare.com URLs get 403 from our cloud server IP — only works via the CF Worker.

## Architecture (as implemented)

1. `getNeoCdnStreams()` in `animedekho.ts` — populates `mythUrl` on each `NeoCdnSource`
2. `neoCdnSourceToStream()` in `stremio.ts` — returns `url = "neocdn:BASE64URL_MYTH:TYPE_ENC"` (not a live URL)
3. `adStreamToStremio()` in `stremio.ts` — detects `neocdn:` prefix, rewrites to `${base}/api/adneoproxy?m=...&t=...`
4. `GET /api/adneoproxy` in `animedekho-proxy.ts`:
   - Decodes myth URL from `m` (base64url) + type from `t` (url-encoded)
   - Cache: `mythUrl → { workerUrl, fetchId }`, TTL 3 min (keyed by mythUrl)
   - Fetches myth page (cached) → gets current live worker URL + fetchId
   - Fetches `fetch.php?id=fetchId` (always fresh) → gets current trycloudflare source URLs
   - Proxies MP4 through `workerUrl + encodeURIComponent(sourceUrl)` with range request support
   - On worker failure: busts cache, re-fetches myth page, retries once

## Confirmed dead workers (do not use as fallback)
- `young-dust-31f3.reimoto.workers.dev` — dead as of 2026-07-13
- `jolly-salad-69ad.zenhashi.workers.dev` — was briefly live 2026-07-13, may be dead now
- `late-mud-43fb.polarisro.workers.dev` — transient, 2026-07-13
- `weathered-wildflower-12a4.ryoyama.workers.dev` — transient, 2026-07-13

## How to apply
- The stable fix is already in place. Never hardcode worker URLs in stream objects.
- If NeoCDN stops working: check `/api/adneoproxy` logs for "worker returned error" → check if myth page is still returning a valid `const worker = "..."` line.
- The `/api/adneoproxy` endpoint supports HEAD and Range requests (required for Stremio seeking).
