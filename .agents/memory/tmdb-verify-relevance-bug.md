---
name: tmdb-verify top-result relevance bug (holistic mismatch-rejection fix)
description: tmdbTitleToImdbId used to trust TMDB's search results[0], which ranks by popularity not title similarity — caused false "IMDB mismatch" rejections for correct provider candidates whenever a generic/short title shared a name with a more popular show/movie.
---

## The bug (root cause of "provider clearly has it but we return nothing")
`lib/tmdb-verify.ts` `tmdbTitleToImdbId(title, year, type)` is the shared Layer-2 ID
cross-check used by nearly every title-search provider (HDHub4U, 4KHDHub, HDGharTV,
NetMirror, MovieBox, CastleTV, MoviesDrive, etc.) to confirm a provider's matched
title actually corresponds to the requested IMDB ID, rejecting on a confirmed mismatch.

It used to take `searchData.results[0]` unconditionally. TMDB's `/search/tv` and
`/search/movie` endpoints rank by relevance/popularity, NOT string similarity to the
query — for any generic or short title ("Brown", "Don", "Race", "Animal", "It") a
much more popular unrelated show/movie routinely outranks the exact title being
verified (e.g. querying "Brown" returns "Father Brown" (pop. 32) and "Murphy Brown"
(pop. 19) ahead of the actual 2026 Indian series literally titled "Brown" (pop. 2.8)).

Effect: the provider's own site search would correctly find the right title, but our
verification step "confirmed" a totally different IMDB ID from the wrong, more
popular show — a *false positive mismatch* — and the correct candidate was rejected
outright. This was silent: the provider looked broken (0 streams) even though the
source site had the content.

## The fix (2026-07-12)
`tmdbTitleToImdbId` now scores every result (up to the first 10) against the query
title+year using the same shared matcher every provider already uses
(`findBestMatch` in `utils/match.ts`) instead of trusting result order. If nothing
clears the normal threshold, it returns `null` (inconclusive) rather than guessing —
consistent with the existing "null = pass-through, never reject" contract.

**Why this is the holistic fix, not a one-off patch:** every provider that calls
`tmdbTitleToImdbId` inherits the fix automatically, since it's one shared utility.
Verified end-to-end: HDGharTV's "Brown" (tt26766517, 2026 Indian series) streams,
previously silently rejected by this exact bug, now return correctly.

**How to apply / watch for regressions:** if a provider search clearly has a title on
the source site but the addon returns zero streams for it, check the provider's debug
logs for `"IMDB mismatch — rejecting"` / `"IMDB ID mismatch"` before assuming the
provider's own search or scraping is broken — the rejection may be coming from this
shared verification layer, not the provider itself.
