---
name: VidLink CDN auth & proxy strategy
description: How VidLink CDN URLs are authenticated and whether server-side proxying is needed
---

## The rule
VidLink CDN (currently `vodvidl.site`, hostname rotates) checks **only the HTTP `Referer` header** — it does NOT block by client IP.

- Bare fetch (no headers) → **403**
- Fetch with `Referer: https://vidlink.pro/` → **200**

**Why:** Verified by live test against a real VidLink stream URL (Inception, tmdbId 27205) from the Replit server. Earlier assumption that the CDN WAF blocked client IPs was wrong — the WAF is purely a Referer check.

## Current strategy
Return CDN URLs **directly** to Stremio with `behaviorHints.proxyHeaders`:

```json
{ "request": { "Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro" } }
```

No bytes go through our server. This eliminates the slow startup and mid-playback rebuffering that server-side proxying caused.

## Stream priority
1. **DASH (MPD)** — adaptive bitrate, always returned first if present in `stream.alternates.dash`. Best option: player auto-selects quality, instant start, smooth seeking.
2. **Fixed MP4** — fallback qualities (1080p → 720p → 480p → 360p) via `stream.qualities`, also returned direct with proxyHeaders.

## What NOT to do
- Do NOT proxy the video bytes through the server (`/vidlink-stream` route). It adds a double-hop, saturates server bandwidth, and causes exactly the slow load / rebuffering the user reported.
- Do NOT use `buildVidLinkStreamProxyUrl` — it is dead code now that direct delivery works.

**Why:** Server-side proxying for VidLink was built on the wrong assumption that the CDN blocks client IPs. It doesn't — it only checks Referer.
