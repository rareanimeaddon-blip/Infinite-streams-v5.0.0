---
name: Provider folder isolation convention
description: How src/providers/ and src/extractors/ are organized after the per-provider isolation refactor, and what stays shared.
---

Per explicit user decision, `artifacts/api-server/src/providers/` and `src/extractors/` were restructured so each of the 22 providers has its own folder (`providers/<name>/`) containing its main file plus any extractor/helper file used ONLY by that provider — no provider imports another provider's private files.

**Why:** the user wants any future fix to one provider's scraping/extraction logic to be guaranteed not to affect any other provider — isolation over DRY, for this specific layer only.

**How to apply / scope boundaries (confirmed with user):**
- `providers/` and `extractors/` folders: full isolation. Files used by >1 provider got duplicated into each provider's folder (e.g. `hdhub4u-base.ts` exists separately in `providers/hdhub4u/` and `providers/fourkdhub/` — keep both in sync manually if fixing shared logic there, or accept they may drift).
- `lib/` and `utils/` (logger, the universal matcher `match.ts`, fetch helpers, tmdb-verify, etc.): explicitly EXCLUDED from isolation — user confirmed these stay shared. Do not duplicate them per-provider.
- `routes/stremio.ts` (the aggregator) was explicitly excluded too. Several providers (AnimeDekho, MovieBox, RareAnime, Kartoons, DooFlix, VidLink, HDGharTV/VaPlayer, MoviesDrive, HindMoviez, PirateXPlay) still have real provider-specific logic living inline inside this 3000+ line file rather than in their own folder — extracting that is unfinished, tracked as a known gap, not part of the completed reorg.
- `src/extractors/` top-level files (hubcloud.ts, hblinks.ts, hubcdn.ts, hubdrive.ts, pixeldrain.ts, streamtape.ts, stream-utils.ts, index.ts, vidstack.ts) are dead code — nothing imports them (HDHub4U has its own inline `resolveHubCloud()` in `providers/hdhub4u-base.ts` instead). Only `extractors/types.ts` is still live (used by `routes/stremio.ts`). Left in place, not deleted, pending user confirmation.
