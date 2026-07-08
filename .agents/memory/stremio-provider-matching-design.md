---
name: Stremio provider matching design (Layer 1/2 + title-alias retry)
description: How title-based matching and ID verification work across providers in artifacts/api-server, and the title-drift bug class this addresses.
---

## Title-drift bug class ("content exists but no streams returned")
Cinemeta and TMDB sometimes disagree on a title for the same IMDB ID (e.g. a
regional film indexed by Cinemeta under a pre-release working title while TMDB
already reflects the theatrical retitle). Streaming-site listings usually match
whichever title is currently "live" (often TMDB's), so a provider that searches
only the single `meta.title` string returned by `resolveMeta` can get zero
search hits even though the content exists on the site under a different name.

**Fix (`lib/meta-resolver.ts`):** `resolveMeta` now cross-adds both the
Cinemeta title and the TMDB title into `ResolvedMeta.aliases`, not just
TMDB's `alternative_titles`/`original_title`. This is universal — every
provider that reads `meta.aliases` benefits automatically.

**Fix (search-retry providers):** `utils/match.ts` already exported
`findBestMatchWithRetry` + `buildRetryTitleVariants`, but as of 2026-07-08 no
provider actually called them — every title-search provider did a single-shot
search on `meta.title` only. HDHub4U, 4KHDHub (both movie+series, in
`routes/stremio.ts`) and HDGharTV (`providers/hdghartv.ts`) were rewired to
search across all `buildRetryTitleVariants(meta)` variants via
`findBestMatchWithRetry` instead of one hardcoded title.

**Why this matters for future provider work:** when wiring a *new* title-search
provider, always call `findBestMatchWithRetry` with `buildRetryTitleVariants`
rather than a single `provider.searchSite(meta.title)` call — otherwise the
same title-drift bug reappears for that provider. Also remember to actually
pass `meta` through every call site (a first pass on this fix added the
`meta` parameter to a provider wrapper but forgot to update its call sites,
so the retry never activated in production — caught only by a code-review pass
that grepped call sites, not the function signature).

## Layer 1 vs Layer 2 (verification design already in place)
- **Layer 1** (`utils/match.ts` `findBestMatch`/`scoreCandidate`): weighted
  candidate scoring — title similarity 60%, year 10%, type 20%,
  season/episode 10%. Year/type/season are soft signals with a neutral score
  when unknown; DEFAULT_THRESHOLD 0.45. Hard `.filter()`-style exclusion on
  any of these fields is an anti-pattern (see castle-tv note below).
- **Layer 2** (`lib/tmdb-verify.ts` `tmdbTitleToImdbId`): resolves a matched
  title+year to an IMDB ID via TMDB, cached 24h. Contract: `null` return means
  "inconclusive" and callers MUST treat that as pass-through, never reject.
  Only reject when a resolved ID exists AND differs from the requested ID.
  Already wired into CastleTV, NetMirror, MovieBox; extended to
  HDHub4U/4KHDHub (movie+series) on 2026-07-08 with an `_idVerified` flag
  attached to returned streams.

## Anti-pattern found and fixed: hard year filter
`castle-tv/handlers.ts` had a hard `.filter()` excluding any candidate whose
`publishTime` year differed from the requested year by more than 2 — a
genuine false-negative source for retitled/rereleased content, since a
correct title match could get thrown out before scoring ever considered it.
Converted to soft scoring (bonus for close years, small penalty for >4yr gap,
never excludes) to match the design principle used elsewhere in the codebase.

## Known remaining gap (not yet fixed)
Season-specific search + season-URL-guard combo (HDHub4U/4KHDHub series) can
still return zero streams when the site's season-specific search text ranks
same-title-different-season pages higher than the correct season (e.g.
querying "X season 1" returns hits for "Season 4"/"Season 5" of X, gets
picked as best match, then correctly rejected by the season-in-URL guard, but
the code does not fall back to a fresh plain-title search after that
rejection — it just returns `[]`). Confirmed via Breaking Bad S1E1 test where
HDHub4U yielded 0 for the episode despite HDHub4U having Breaking Bad indexed.
