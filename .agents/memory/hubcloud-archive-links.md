---
name: HubCloud/HubDrive archive-only links
description: Some resolved HubCloud/HubDrive download links are season-pack .zip/.rar archives, not playable video — must be filtered out post-resolve.
---

**Rule:** After resolving a HubCloud/HubDrive (or similar CDN) link to its final signed URL, check whether it points at an archive file (`.zip`/`.rar`/`.7z`) before returning it as a stream. If it does, drop it — treat it as "no stream from this link," not as a broken playable link.

**Why:** Confirmed live on 4KHDHub for "House" (M.D.) S01 — every resolved HubCloud link for that season was a single `HOUSE.S01...zip` (30–99GB) bundling all episodes, because the uploader only provided a season-pack archive, not per-episode files. Stremio can't play an archive; surfacing it as a "stream" just gives the user a broken link with no indication why.

**How to apply:**
- `isArchiveFile(url)` lives in both `providers/fourkdhub/hdhub4u-base.ts` and `providers/hdhub4u/hdhub4u-base.ts` (these are separate, intentionally-duplicated per-provider files — see provider-folder-isolation memory — so the helper had to be added to both, not shared).
- It checks the URL path AND the `response-content-disposition` query param (CDN download links usually carry the real filename there, e.g. R2/S3-signed URLs), since the path itself is often an opaque object key.
- Apply the filter right after `resolveLink()`/`resolveHubCloud()` returns, before building the `StreamEntry`/stream object, in `extractStreams` for both `fourkdhub.ts` and `hdhub4u.ts`.
- If ALL of a title's resolved links turn out to be archives, the correct behavior is to return zero streams from that provider for that title — not to synthesize a fake/broken entry.
