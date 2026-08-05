---
name: Goated resolver
description: Goated's proof-of-work API and its multi-server stream behavior.
---

Goated's API requires solving `/api/challenge` before each `/api/resolve` request. The first response contains the preferred source plus `availableSources`; each advertised source must be resolved separately because the source name is the only reliable server identity for playback labels.

**Why:** The provider currently exposes two distinct playback backends, and collapsing the response to the first URL hides the second server from Stremio users.

**How to apply:** Keep Goated source resolution isolated in its provider folder, retain the returned source name in the stream badge/title, and pass the playback headers through the stream's proxy header hints.