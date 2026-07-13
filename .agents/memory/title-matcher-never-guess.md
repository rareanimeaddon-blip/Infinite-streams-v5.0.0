---
name: Title-matcher never-guess principle
description: Shared/ad-hoc title matchers must return "no match" below threshold, never a best-guess; TMDB verify must use the matched candidate's own year.
---

**Rule:** Any provider title-matching function — the shared `findBestMatchWithRetry`/`findBestMatch` engine, or a provider's own bespoke scorer — must return "no match" (null) when nothing clears its confidence threshold. It must never fall back to "return the best-scoring candidate anyway."

**Why:** Returning an unrelated best-guess silently converts "not in this provider's catalog" into "here are streams for the wrong title." This is far worse than an empty result, because it looks successful to the caller and the user. Found via a real case: OneTouchTV's own matcher scored "House of Stars (2023)" at 0.47 (just above a 0.45 threshold) against a query for "House" (2004) — generic short titles are especially prone to this because whole-word/starts-with bonuses inflate the score for any "House of X" title.

**How to apply:**
- When adding or reviewing a provider matcher, confirm it returns null/no-match below threshold and that every caller actually checks for that before using the result — a caller that never checks `.score`/`.best` re-introduces the bug even if the matcher itself is correct.
- Add a Layer-2 IMDB cross-check (`tmdbTitleToImdbId` in `lib/tmdb-verify.ts`) for providers doing ad-hoc/fuzzy title matching without a native IMDB ID in their catalog data — it catches near-threshold false positives the title matcher alone can't.
- Critical detail: when calling `tmdbTitleToImdbId` to verify a MATCHED candidate, pass that candidate's own year (parsed from its own metadata), not the original query's expected year. Passing the query's year searches TMDB for the matched title constrained to a year it was never released in, which always comes back empty — making the verification permanently "inconclusive" and silently passing every mismatch through. (This bug was introduced and caught in the same session it was added for OneTouchTV.)
- `tmdbTitleToImdbId` itself already scores TMDB search results with the shared matcher and returns null (not a bad guess) when nothing clears threshold — callers must treat null as "unverified, pass through," never as a rejection signal.
