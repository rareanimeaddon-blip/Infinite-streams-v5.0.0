---
name: hubcloud.cx download-button resolution
description: How to resolve hubcloud.cx (used by Movies4u and similar scrapers) to a real playable/downloadable CDN URL, and why matching by hostname breaks.
---

hubcloud.cx link chain: `hubcloud.cx/{video,drive}/{id}` → HTML page with a
`gamerxyt.com/hubcloud.php?...&token=...` button → that page lists several
CDN backend buttons for the same file.

**Key lesson:** the backend hostname behind hubcloud.cx's primary download
button changes over time (observed: `gpdl*.hubcloud.*` redirect chain →
`fsl.gigabytes.icu` → `hub.whistle.lat`), but the button's HTML **id
attribute stays stable** across changes seen so far:
- `id="fsl"` (class `btn-success`) = the primary/fastest CDN button.
- The historic `gpdl\d*.hubcloud.*` "10Gbps" button is an older layout,
  kept as a fallback.

**Why:** matching by hardcoded hostname (e.g. `fsl.gigabytes.icu`) silently
breaks every time hubcloud.cx swaps CDN providers, even though the page
structure (button id) hasn't changed. This caused Movies4u playback to
regress from "working" to "download page only" between site changes.

**How to apply:** when resolving hubcloud.cx (or similar aggregator/mirror
sites) links, prefer matching by button `id`/`class` attributes over
hostname substrings, and verify the resolved candidate with a live HEAD
request before trusting it, so a future hostname change degrades gracefully
into other fallbacks rather than returning an unplayable link.
