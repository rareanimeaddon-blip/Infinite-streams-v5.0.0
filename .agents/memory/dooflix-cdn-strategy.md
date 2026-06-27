---
name: DooFlix CDN strategy
description: How to handle xpass.top stream sources to avoid TikTok CDN 403s on Replit server IPs
---

## The problem
xpass.top (DooFlix embed) serves streams from two CDN families:
- **1x2.space family** (tik.1x2.space, vip.1x2.space, mol.1x2.space, etc.) — M3U8 playlists are publicly accessible without any Referer header, BUT their segment CDNs (p16-sg.tiktokcdn.com) return **403** when fetched from cloud/server IPs (Replit). Regular user IPs work fine.
- **Cloudflare Worker CDNs** (cflul.bx9.workers.dev, cfvino.p1m.workers.dev, etc.) — can be fetched server-side, safe to proxy through /api/m3u8.

## The fix
In `providers/dooflix.ts`:
- For `*.1x2.space` source URLs: return the URL **directly** to Stremio (no `/api/m3u8` wrapping). User's player fetches segments from their own IP and TikTok CDN serves them fine.
- For all other source URLs (Cloudflare Workers, etc.): proxy through `/api/m3u8` as normal.
- Set `behaviorHints: { notWebReady: true }` on all DooFlix streams.

## Backup extraction
The `var backups=[...]` JSON in the embed HTML must be extracted with **bracket-counting** (not a regex like `\[[\s\S]*?\];`) because some backup entry values contain characters that trip up non-greedy regex matching. `JSON.parse` fails at ~position 1428 with the regex approach.

**Why:** The regex `\[[\s\S]*?\];` stops too early on certain embed HTML, producing truncated JSON that fails to parse and returns 0 backup entries.

## How to apply
- Check source URL against `/\.(1x2\.space)/i` to decide direct vs. proxied delivery.
- Try primary playlist + up to 5 backup entries (bracket-counted from `var backups=...`).
- The primary path matches "TIK 1" in the backups array — deduplicate using a `Set<string>`.
