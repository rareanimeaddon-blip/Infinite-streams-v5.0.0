---
name: VidLink CDN auth strategy
description: VidLink CDN proxy URLs use short-lived auth tokens; correct approach is to bypass server-side M3U8 proxy and return URLs directly with proxyHeaders.
---

## Rule

Never proxy VidLink M3U8 URLs through the Replit server. Return CDN URLs directly to Stremio with `proxyHeaders`.

**Why:** VidLink's CDN proxy URLs (`storm.vodvidl.site/proxy/wiwii/…?auth=…`) have auth tokens that expire in ~10-15 seconds. Stream aggregation across 15 providers takes ~16 seconds, so by the time our M3U8 proxy handler receives the player's request, the token has already expired → 403. The CDN is NOT IP-locked — fetching with `Referer: https://vidlink.pro/` from any IP works while the token is fresh.

**How to apply:** In `getVidlinkStreams`, return CDN URLs directly in the stream object with:
```typescript
behaviorHints: {
  notWebReady: true,
  proxyHeaders: { request: { "Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro" } }
}
```
Stremio's ExoPlayer fetches the CDN within ~1 second of receiving the stream list — auth still valid. The full chain (master M3U8 → 1080p/720p/360p variants → TS segments) all return HTTP 200.

## CDN URL structure

`https://storm.vodvidl.site/proxy/wiwii/{hash}/playlist.m3u8?auth={HMAC}&headers={JSON_ENCODED}&host={BACKEND_HOST}`

- The CDN proxy reads `headers` + `host` from the query to fetch from the real video backend
- The `auth` HMAC is time-limited (short TTL), not IP-locked
- The same `auth` value is reused across all quality variants in one session

## Verification

End-to-end test confirms (with `Referer: https://vidlink.pro/`):
- Master M3U8: 200 (3 quality variants: 1080p, 720p, 360p)
- 1080p variant M3U8: 200, 4225 segment lines
- First TS segment: 200, ~300 KB, `video/MP2T`
