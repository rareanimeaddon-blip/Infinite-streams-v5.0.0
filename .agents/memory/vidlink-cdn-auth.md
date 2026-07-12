---
name: VidLink CDN auth & proxy strategy
description: How to safely serve VidLink CDN streams — covers M3U8 auth-token timing, mp4 CDN host rotation, and WAF client-IP blocking requiring a server-side reverse proxy.
---

## M3U8 streams: never proxy, return direct with proxyHeaders

Never proxy VidLink M3U8 URLs through the Replit server. Return CDN URLs directly to Stremio with `proxyHeaders`.

**Why:** VidLink's CDN proxy URLs (`storm.vodvidl.site/proxy/wiwii/…?auth=…`) have auth tokens that expire in ~10-15 seconds. Stream aggregation across many providers can take longer than that, so by the time our own proxy handler receives the player's request, the token has already expired → 403. The CDN is NOT IP-locked for M3U8 — fetching with `Referer: https://vidlink.pro/` from any IP works while the token is fresh.

**How to apply:**
```typescript
behaviorHints: {
  notWebReady: true,
  proxyHeaders: { request: { "Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro" } }
}
```

## mp4 direct-file streams: DO proxy server-side (opposite of M3U8 case)

VidLink's mp4 CDN (host has rotated at least once: `hakunaymatata.com` → `vodvidl.site`) is fronted by a Cloudflare-style WAF that blocks based on the **client's own IP/network reputation** (seen: Indian mobile carrier IPs blocked on 480p/360p while 1080p and other titles worked) — a "Sorry, you have been blocked" page, causing endless loading in the player.

**Why:** Since this WAF block is keyed on whoever's IP makes the request, handing the client the raw CDN URL (even with correct `proxyHeaders`) still exposes the *client's* IP directly to the CDN. Unlike the M3U8 case, there's no tight auth-token TTL forcing a direct hand-off here, so proxying is viable and actually fixes the symptom: our server's IP fetches the CDN (not subject to that per-client block) and streams bytes back.

**How to apply:** Route these through a genuine server-side streaming reverse-proxy (Range-forwarding, chunked read/write with backpressure) rather than a redirect. Never hardcode the CDN hostname into an allowlist — the host rotates without notice, so validate structurally (protocol/private-IP checks) instead of by name.

**Critical security requirement:** A reverse-proxy route that fetches an attacker-decodable URL is an open-proxy/SSRF vector by default. Required hardening:
1. HMAC-sign the encoded target URL + an expiry timestamp (keyed on a real secret, no hardcoded/fallback key — fail closed if the secret is unconfigured) and verify with a constant-time comparison before fetching.
2. Even with a valid signature, still reject non-`https` targets and private/loopback/link-local/multicast/reserved IPs — resolve hostnames via DNS (not just string-match the literal) and fail closed on lookup errors, to catch DNS rebinding.
3. IPv6 needs the same coverage as IPv4 (loopback, link-local, ULA, multicast, mapped/compatible IPv4 forms, 6to4, Teredo) — a naive prefix-string check misses embedded-IPv4 and canonical-form edge cases; parse to raw bytes and check ranges properly.
4. Fetch with `redirect: "manual"` and reject any 3xx/opaqueredirect — otherwise a validated public host can hand off to an internal target via redirect after the check already passed.
5. Use an idle/read timeout (reset per chunk), not a fixed whole-request timeout — large media files need minutes, not 30s, to fully transfer.

## Verification approach

Generate a real signed proxy URL via the exported builder function, then curl it directly (ranged and unranged) to confirm 206/200 with correct `Content-Range`; separately craft forged-but-validly-signed URLs pointing at localhost/private-IP/IPv6 special-use targets to confirm the host check still rejects them despite passing signature check.
