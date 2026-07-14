---
name: Cloudflare TLS-fingerprint block on Node fetch/axios
description: Some Cloudflare-protected hosts (e.g. gdlink.dev/gdflix.*) 403 Node's native fetch/axios but pass curl with identical headers — a JA3/JA4 TLS fingerprint check, not a header/UA problem.
---

Some Cloudflare-protected upstreams block requests from Node's native `fetch`
(undici) and `axios` (Node's `https` module) with a flat 403, while `curl`
against the exact same URL with identical headers succeeds every time. This
is Cloudflare's TLS-fingerprint (JA3/JA4) bot detection reacting to the TLS
ClientHello shape, not header content — changing User-Agent, Referer,
sec-ch-ua, etc. in Node does not help.

**Why:** Confirmed by direct A/B testing (same URL, same headers) against
`gdlink.dev`/`gdflix.*`: undici fetch → 403, axios → 403, curl → 200. This
was silently breaking Movies4u's GDFlix stream resolution ("could not
resolve to a video URL") even though the actual page content and resolution
logic were correct.

**How to apply:** If a provider's CDN/mirror resolver gets consistently
403'd fetching a specific host from Node while the same URL works fine via
curl or a browser, suspect this before debugging headers/cookies/logic
further. Fix by shelling out to curl for just that host's fetch (see
`curlFetchText()` in `artifacts/api-server/src/providers/movies4u/movies4u-proxy.ts`
for a reference implementation with a `-w` metadata marker to recover status
code + final URL + body from one curl invocation). Requires `curl` present
at runtime — add it to the Docker image (`apk add curl`) if the provider
also needs to work in the production container, not just on Replit (which
already has curl on PATH via nix).
