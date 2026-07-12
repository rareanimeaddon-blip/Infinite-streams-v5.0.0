---
name: MovieBox JWT Bootstrap
description: The MovieBox mobile API requires a JWT session token; all endpoints return 441 without it. Must bootstrap via homepage first.
---

# MovieBox JWT Bootstrap Requirement

## The Rule
Before calling ANY MovieBox mobile API endpoint (search, play-info, subject details, etc.), you MUST first bootstrap a JWT by calling the homepage endpoint:
```
GET /wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=
```
This endpoint works WITHOUT a prior token and returns a JWT in the `x-user` response header as `{"token": "<jwt>"}`.

**Why:** The mobile API (`*.aoneroom.com`) treats all non-bootstrap endpoints as authenticated. Without a Bearer token in the Authorization header, all calls return `HTTP 441 "miss token"`. The existing code never bootstrapped the session, causing 0 streams.

**How to apply:**
- Cache the JWT in-process with a 50-minute TTL
- Call `ensureToken()` at the start of every `apiGet`/`apiPost`
- Absorb a fresh JWT from `x-user` on every response to keep it current
- If a 441 occurs mid-session, clear the cache and re-bootstrap on the next call

## Host Pool (as of June 2026)
Accessible from Replit: `api6`, `api5`, `api4`, `api4sg`, `api3`, `api.inmoviebox.com`
Blocked from Replit: `api6sg.aoneroom.com`

Try all hosts in order for every request — rotate on network failure.

## Key CLIENT_INFO Fields
- `sp_code: "40401"` (not empty string)
- `X-Play-Mode: "2"` (not "1")
- `version_code: 50020045`, `version_name: "3.0.03.0529.03"`

## Secret Keys (for HMAC-MD5 signing)
Keys are in `moviebox-crypto.ts` — the signing implementation was already correct; the missing bootstrap was the only bug.

## Search Endpoint
- v1: `POST /wefeed-mobile-bff/subject-api/search` → `data.items[]` (simpler, use this)
- v2: `POST /wefeed-mobile-bff/subject-api/search/v2` → `data.results[].subjects[]` (fallback)

## Stream Types Returned
- DASH (H.265/HEVC): `sacdn.hakunaymatata.com/dash/...index.mpd` with CloudFront signed cookies
- MP4 (H.264): `bcdn.hakunaymatata.com/resource/...mp4?sign=...&t=...` or `hcdn3.hakunaymatata.com/...`
- Both types are valid; MP4 URLs are direct and don't need cookie injection

## Search results routinely contain duplicate titles for different films (fixed 2026-07-12)
MovieBox search returns many subjects sharing an identical generic title (e.g. "Don", "Race",
"Vikram", "Animal" — common single-word titles reused across languages/decades/regions). The
raw API item DOES include a `releaseDate` field, but the old `Subject` parser dropped it, so
every candidate got the same neutral (0.5) year score from the shared matcher
(`utils/match.ts`), and same-titled duplicates tied on score — the wrong film (arbitrary API
order) was routinely picked and its `subjectId`'s streams served under the requested title.

**Fix:** `Subject.year` now parses `releaseDate`, and `scoreResults` in `stremio.ts` passes
`year: r.year` into the `MatchCandidate`. This lets the existing year-scoring signal actually
discriminate between identically-titled subjects. Verified end-to-end for Don (2006, tt0461936),
Vikram (2022, tt9179430), and Animal (2023, tt13751694) — all now return streams for the correct
film instead of an unrelated same-titled one.

**Why this matters for future provider work:** any provider whose search results carry a
release-date/year field but whose `MatchCandidate` construction omits `year` is silently
wasting a real disambiguation signal — this is worth checking whenever "wrong stream for
right-sounding title" bugs are reported for a specific provider. `NetMirror`'s search API does
not return a year at all, so this specific fix doesn't apply there (relies on `tmdbTitleToImdbId`
verification only).
