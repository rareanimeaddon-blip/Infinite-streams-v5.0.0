---
name: OneTouchTV upstream flakiness and provider-test port
description: Why OneTouchTV intermittently returned 0 streams, and why the provider-test script showed all-zero results.
---

## Upstream retries
`api3.devcorp.me` (OneTouchTV's API) intermittently returns HTTP 404 or times out on requests that succeed a moment later on plain retry — no request-shape difference, just flaky under load. `fetchEncrypted()` in `artifacts/api-server/src/lib/onetouchtv.ts` retries transient failures (2 retries with backoff) so one bad request doesn't zero out the whole provider for a title.

**Why:** without retry, a single flaky search/detail/episode call silently returned 0 streams for the entire provider on that request, which looked identical to "title genuinely not in OneTouchTV's catalog" (see below) — hard to distinguish without checking logs for the underlying HTTP error.

**How to apply:** if OneTouchTV (or any provider hitting a third-party API) is reported as unreliable, check server logs for the specific error class (404/timeout vs. clean empty result) before assuming a matching/logic bug — it may just be upstream flakiness needing a retry.

## Distinguishing "not in catalog" from a real bug
OneTouchTV's shared-matcher threshold (0.45) can accept a single weak, wrong candidate when the real title isn't in its catalog (e.g. "Breaking Bad" matches only an unrelated Chinese drama "Breaking Bad Fortune Teller" at score 0.481). This correctly yields 0 streams — not a bug — but wastes a failed episode fetch. Tightening this is tracked as a follow-up rather than fixed inline, since the matcher (`utils/match.ts`) is shared across every title-search provider.

## provider-test script port mismatch
`scripts/src/provider-test.ts` defaults to `http://localhost:5000/api`, but on Replit the API server actually binds port 8080 (see Replit port-routing memory). Running the script without `PORT=8080` reports 0 streams for every title even when the server is completely healthy — always set `PORT=8080` when running it on Replit.
