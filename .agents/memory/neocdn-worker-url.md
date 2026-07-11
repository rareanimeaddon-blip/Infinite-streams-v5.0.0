---
name: AnimeDekho NeoCDN worker URL
description: How the NeoCDN myth player worker URL is resolved and why the direct trycloudflare URL doesn't work.
---

# AnimeDekho NeoCDN Worker URL

## The rule
Always use the worker URL embedded in the myth player page HTML (`const worker = "..."`), not a hardcoded one. Current fallback: `young-dust-31f3.reimoto.workers.dev/?url=`.

**Why:** The hardcoded worker `jolly-salad-69ad.zenhashi.workers.dev` went dead (error 530/502). AnimeDekho's page-embedded worker `young-dust-31f3.reimoto.workers.dev` is what they control and keep live. Update `FALLBACK_WORKER_URL` in `providers/animedekho.ts` whenever a new live worker is confirmed.

**How to apply:** `getNeoCdnStreams()` extracts `const\s+worker\s*=\s*["']([^"']+)["']` from myth player HTML. Normalise: append `?url=` if URL has no `?`. Source URLs are `encodeURIComponent`-encoded when appended.

## Direct trycloudflare URLs do NOT work
Raw `*.trycloudflare.com` URLs (`rawUrl` on `NeoCdnSource`) fail with `net::ERR_HTTP_RESPONSE_CODE_FAILURE` on all clients — the tunnel ONLY serves content through the CF Worker proxy. Never expose `rawUrl` as a playable stream.
