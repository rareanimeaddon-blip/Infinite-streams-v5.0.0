---
name: AnimeDekho NeoCDN worker URL
description: Worker URL rotation pattern for AnimeDekho's NeoCDN CF Worker proxy; dynamic page extraction is the reliable path.
---

# AnimeDekho NeoCDN Worker URL

## Rule
The worker URL embedded in the myth player page (`const worker = "..."`) is always authoritative. The hardcoded `FALLBACK_WORKER_URL` in `animedekho.ts` is only used when page extraction fails — keep it pointed at a recently-confirmed live worker.

**Why:** AnimeDekho rotates the CF Worker URL frequently (observed at least twice in one day: `reimoto.workers.dev` → `zenhashi.workers.dev` → `polarisro.workers.dev`). The dead fallback causes "Origin error: 503" for ALL NeoCDN streams because the worker can't proxy the trycloudflare tunnel.

**How to apply:**
- When a user reports NeoCDN streams failing with "Origin error: 503", test the current fallback URL in `animedekho.ts`:
  ```
  curl -sv "https://FALLBACK_WORKER/?url=https://example.com"
  ```
  If it returns `502 "Origin error: 503"`, the fallback is dead. Find the live worker by fetching a myth player page (e.g., `https://animedekho.app/aaa/myth/play.php?id=...`) and extracting `const worker = "..."`.
- Confirmed dead workers (do not use as fallback):
  - `young-dust-31f3.reimoto.workers.dev` — dead as of 2026-07-13
- The page extraction regex `/const\s+worker\s*=\s*["']([^"']+)["']/` handles all known worker URL formats.
- Direct trycloudflare.com URLs (the `rawUrl` field) should NOT be returned directly — they require the worker proxy.
