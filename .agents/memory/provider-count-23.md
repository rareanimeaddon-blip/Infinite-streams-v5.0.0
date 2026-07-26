---
name: Provider count is 23 with VidLink re-added
description: VidLink is provider #9 (before MovieBox); mask is 23 chars; uses Playwright browser extraction, not the /api/b/ JSON endpoint.
---

# Provider count: 23 — VidLink at index 9

VidLink was added as the 23rd provider, inserted between OneTouchTV (8) and MovieBox (10).

## Critical: Playwright is required — the JSON API returns null

`https://vidlink.pro/api/b/movie/{tmdbId}` returns HTTP 200 with body `null` for all server-side requests. The endpoint ignores all headers (User-Agent, Referer, Origin). **This endpoint cannot be used from Node.js.**

The only working approach is Playwright browser extraction:
- Navigate to `https://vidlink.pro/movie/{tmdbId}` (or `/tv/{tmdbId}/{season}/{episode}`)
- Intercept network requests/responses to find URLs matching `\.mp4` or `\.m3u8`
- vidlink.pro encodes required CDN auth headers into URL query params as `?headers=...&host=...`
- `normalizeVidlinkMediaUrl()` strips those params and returns `{ url, headers }`
- Return streams with `behaviorHints: { proxyHeaders: { request: headers } }`

## Chromium path (hardcoded in Nix)

```
/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome
```

This path is confirmed to exist. The `playwright` npm package must be in `package.json` dependencies.

**Why:** Playwright/Chromium in Nix store is not linked into node_modules automatically — the package is needed for the `chromium` import in TypeScript, but the actual binary is already on disk.

## Mask

Provider mask is now 23 characters: `"11111111111111111111111"`

## How to apply

- Any change to VidLink must use Playwright extraction (see `providers/vidlink/vidlink.ts`)
- Do not attempt to fetch `vidlink.pro/api/b/*` directly — it always returns null
- HLS master playlists must be expanded via `expandM3u8Masters()` to get per-quality variants
