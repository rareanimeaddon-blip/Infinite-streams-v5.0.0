---
name: AnimeDekho slow search endpoint
description: animedekho.app's /search endpoint can take 15-25s for broad/popular queries; the shared 10s fetch default silently drops real results.
---

**Rule:** AnimeDekho's `search()` needs a longer timeout (25s) than the shared `fetchText`/`fetchDoc` default (10s), plus one retry on failure, specifically for its search endpoint.

**Why:** Confirmed empirically and reproducibly (3/3 attempts) — searching "Naruto" on animedekho.app consistently took ~19-22s server-side before responding with a normal 200 and valid results. The site isn't blocking or erroring, it's just slow for large/popular-title queries (likely a heavy server-side search over its catalog). The generic 10s `AbortController` timeout in `utils/fetch.ts` aborted the request every time, and `search()`'s catch-and-return-`[]` turned that into a silent, indistinguishable-from-"not found" empty result.

**How to apply:**
- `search()` in `providers/animedekho/animedekho.ts` passes `{ timeout: 25000 }` to `fetchDoc` and retries once on any thrown error before giving up.
- If other AnimeDekho endpoints (catalog, meta, episode pages) show the same symptom (results that work via direct curl/node fetch but fail via the app with an AbortError at ~10s), apply the same pattern there rather than raising the global default (which would slow down timeout detection for genuinely-dead providers).
