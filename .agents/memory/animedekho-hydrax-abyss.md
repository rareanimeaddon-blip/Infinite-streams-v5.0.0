---
name: AnimeDekho HydraX/Abyss integration
description: How the HydraX (Abyss player) source is resolved/proxied in the AnimeDekho provider, and a header quirk that silently breaks playback.
---

## Header quirk (critical, easy to reintroduce)
The Abyss CDN behind the `sssrr.org` redirect returns a plain **404** (not a
normal block/expiry page) when the actual media-byte fetch includes an
`Origin` header — even though `Origin: https://playhydrax.com` IS required
on the earlier `abyssplayer.com` embed-page fetch during resolution.

**Why:** discovered by curling the resolved CDN url directly with different
header combos: UA+Referer-only → 302 → follow → 206 (works); adding Origin →
404. No visible error message hints at this; it just looks like an expired
link.

**How to apply:** keep two separate header sets — one for resolving (embed
page + enc-dec.app decrypt call) that includes Origin, and one for the final
byte-streaming fetch to the resolved CDN url that omits Origin (UA + Referer
only). If Abyss streams start silently 404ing again, check this first before
assuming the link expired.

## Design pattern
HydraX/Abyss is special-cased outside the generic `resolveExtractor`
pipeline, mirroring how NeoCDN is special-cased: a stable trdekho slot index
(`hydraxTrdekhoIndex`) is captured during page-server parsing, the stable
trdekho URL is reconstructed at request time from `(term, mediaType, index)`,
and resolution (trdekho → abyssplayer.com embed → enc-dec.app decrypt) runs
through a short (60s) sliding-TTL in-memory cache keyed by that stable URL.
Stream list entries never carry a raw resolved CDN url — they carry
`abyss:<base64url(trdekhoUrl)>:<qualityKey>`, rewritten at stream-list time to
a dedicated proxy route that re-resolves (cache-hit or fresh) and streams
bytes through the server, because Abyss CDN links are short-lived/limited-use
and get blocked if handed to the player directly or reused across plays.
