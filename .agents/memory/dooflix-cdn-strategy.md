---
name: DooFlix CDN strategy
description: How to filter DooFlix (play.xpass.top) sources so only playable streams are returned; TikTok CDN geo-block fix.
---

## Rule
Filter DooFlix `src.file` URLs by **source hostname** before returning them.
Block `tik.1x2.space` — its HLS segments come from `p16-sg.tiktokcdn.com` which is geo-blocked in India.
Allow everything else (e.g. `vip.1x2.space` → `s01.sapok001.site`, `cfmbox2.ax2.workers.dev`, `cflul.ax5.workers.dev`).

**Why:** Sources on `tik.1x2.space` always serve TikTok CDN segments — which are blocked in India and on most cloud IPs — causing "playback error" for users. Verified by probing master → variant → segment hostname. All non-tik sources (vip, Cloudflare Workers) work fine from user IPs.

**How to apply:**
- In `fetchPlaylistStreams()`, call `isBlockedSource(src.file)` which checks `new URL(src.file).hostname` against `BLOCKED_SOURCE_HOSTNAMES = new Set(["tik.1x2.space"])`.
- Do NOT use runtime CDN probing (fetching M3U8 chains) — adds 10–16s of latency per stream request for zero benefit on already-known-bad hostnames.
- Return passing sources as direct HLS URLs with `behaviorHints: { notWebReady: true }`. No server-side proxy needed.
- Unknown new hostnames pass through by default (only known-bad are blocked).

## Backup extraction
The `var backups=[...]` JSON in embed HTML must be extracted with **bracket-counting** (not regex `\[[\s\S]*?\];`) — regex stops early at position ~1428 on real HTML, producing truncated/invalid JSON and returning 0 backup entries.

## Embed structure
```
GET play.xpass.top/e/movie/{imdbId}
  → HTML contains:
      "playlist": "/api/playlist/xxx"      ← primary path
      var backups=[{name,url},{…},…]        ← up to 7 extra (skip dl:true entries)
  → Each path → GET play.xpass.top{path}
  → JSON: { playlist: [{ sources: [{ file, label }] }] }
  → src.file = direct M3U8 URL → check hostname → return or discard
```

## Resulting streams (verified working)
- `vip.1x2.space` → segments from `s01.sapok001.site` ✅
- `cfmbox2.ax2.workers.dev` → Cloudflare Worker ✅ (480p, 360p, 1080p variants)
- `cflul.ax5.workers.dev` → Cloudflare Worker ✅
- `tik.1x2.space` → `p16-sg.tiktokcdn.com` segments ❌ BLOCKED
