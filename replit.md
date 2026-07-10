# INFINITE STREAMS

A Stremio addon (v8.8.0) that aggregates streams from 18 providers into a single manifest — movies, series, and anime with Indian-language content support.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the API server (port 8080 on Replit, proxied at `/api`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/scripts run provider-test` — run the provider health-check against all 12 providers

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, esbuild (fully self-contained ESM bundle)
- 18 stream providers: Kartoons, AnimeSalt, RareAnime, AnimeDekho, PirateXplay, NetMirror, StreamFlix, DooFlix, CastleTV, VidLink, MovieBox, MeowTV, MoviesDrive, HDGharTV, VaPlayer, HindMoviez, 4KHDHub, HDHub4U
- Title matching: universal shared matcher (`utils/match.ts`) used by every provider — see "Universal matching system" below
- Health endpoint: `GET /api/healthz`

## Where things live

- `artifacts/api-server/src/providers/` — one file per stream provider (hdghartv.ts, vaplayer.ts added)
- `artifacts/api-server/src/lib/kartoons-config.ts` — Kartoons config loader (token, base URL)
- `artifacts/api-server/src/lib/kartoons-addon.ts` — Kartoons Stremio addon API client (search, episodes, streams)
- `artifacts/api-server/src/routes/stremio.ts` — main aggregation logic, per-provider stream functions
- `artifacts/api-server/src/providers/hdhub4u-base.ts` — `cleanTitle()`, Typesense search
- `artifacts/api-server/src/utils/title-score.ts` — `titleSimilarityScore()` (Jaccard + abbreviation handling)
- `artifacts/api-server/src/lib/meta-resolver.ts` — IMDB → title via Cinemeta + TMDB
- `artifacts/api-server/src/manifest.ts` — addon manifest + provider list
- `scripts/src/provider-test.ts` — end-to-end provider health test script

## Universal matching system

Every provider that scrapes a list of search results (title-search-based providers) must rank candidates with the shared matcher instead of taking `results[0]` or rolling its own ad-hoc scoring. This applies to current and future providers alike.

- `artifacts/api-server/src/utils/match.ts` — the single source of truth for "which search result is the one the user asked for."
  - `findBestMatch(query, candidates, options)` — scores every candidate with a weighted formula (exact/normalized/fuzzy/whole-word/starts-with title match 60%, year 10%, type 20%, season/episode 10%) and returns the best one, or `null` if nothing clears the threshold (default 0.45). Never blindly picks index 0.
  - `findBestMatchWithRetry(query, variantTitles, search, options)` — for providers that should retry the search itself with alternate titles (original title, aliases, IMDB/TMDB titles) when the first attempt doesn't clear the threshold.
  - `buildRetryTitleVariants({ title, originalTitle, aliases })` — builds a deduplicated variant list from a resolved-meta object (see `meta-resolver.ts`) to feed `findBestMatchWithRetry`.
  - Year/type/season are soft scoring signals, never hard filters — a slightly-off year (common with regional release dates) doesn't reject an otherwise-correct match.
  - Every call logs (pino, `[Match:<provider>]`): the query, result count, every candidate's score breakdown, the selected result (or null), and a human-readable reason.
- Wired into: `routes/stremio.ts` (HDHub4U, 4KHDHub, AnimeDekho, MovieBox/VaPlayer subject resolution, `/api/debug/hdhub4u`), `providers/hdghartv.ts`, `providers/netmirror.ts`, `providers/kartoons.ts`, `providers/animesalt.ts`, `providers/piratexplay.ts`, `providers/rareanime/scraper.ts`, `providers/hindmovies.ts`, `lib/onetouchtv.ts`, `lib/moviesdrive.ts`.
- Intentionally NOT wired in: `providers/dooflix.ts`, `providers/vaplayer.ts`, `providers/meowtv.ts` (all three resolve streams directly from an IMDB ID via an upstream API — no candidate list to rank).
- The old `titleSimilarityScore` (`utils/title-score.ts`) is still used for the Stremio catalog-search relevance filter in `routes/stremio.ts` (listing search suggestions, not stream selection) and in `lib/stream-verify.ts` — left as-is since it's a different use case, not the provider-stream-matching pipeline.
- New provider checklist: build a `MatchCandidate<T>[]` from your raw search results (title/type/year/season/episode + `raw: <original object>`), call `findBestMatch`, and use `.best.raw` — do not write a new scoring function.

## Version history

- v8.10.0 — Added a universal search-result matching system (`utils/match.ts`) used by every title-search provider, replacing each provider's own ad-hoc scoring/word-overlap/exact-match logic. See "Universal matching system" above.
- v8.9.0 — Removed VidLink provider completely. Deleted `src/providers/vidlink.ts`, removed from `routes/index.ts`, `lib/provider-config.ts` (mask now 17 chars), `manifest.ts`, `routes/stremio.ts` (both IMDB and TMDB aggregation blocks), and `app.ts` (landing page). Provider count is now 17.
- v8.8.0 — Added HDGharTV (title-search via hdghartv.cc) and VaPlayer (IMDB-direct via streamdata.vaplayer.ru) as providers 14 and 15, inserted right after MoviesDrive. Completely removed DahmerMovies — deleted from the main aggregation pipeline (`stremio.ts`, `provider-config.ts`, `manifest.ts`, `app.ts`, `routes/debug.ts`, `lib/stream-verify.ts`) and from the standalone Castle TV addon (`castle-tv/handlers.ts`, `castle-tv/dahmermovies.ts` deleted, `routes/castle-tv.ts`, `routes/proxy.ts` — removed `/proxy/dahmer` and `/proxy/dahmer-auto` routes). Provider mask is now 18 chars ("111111111111111111").
- v8.7.0 — Fixed MovieBox provider (was returning 0 streams). Root cause: mobile API requires a JWT obtained by bootstrapping via the homepage endpoint first; all other endpoints return 441 without it. Added 6-host pool, JWT caching (50 min TTL), and auto-refresh. Fixed CLIENT_INFO fields (sp_code:"40401", X-Play-Mode:"2"). Now returns multi-language streams (Hindi/Tamil/Telugu/Portuguese dubs + originals) for movies and series.
- v8.6.0 — Added VidLink as 15th provider (index 8); swapped dooflix↔castletv order (dooflix=6, castletv=7); provider mask is now 15 chars ("111111111111111"). VidLink proxy routes: `/api/vidlink/hls.m3u8`, `/api/vidlink/seg/:sid/:idx` (isolated prefix).
- v8.5.0 — Added Kartoons as 14th provider (index 0); provider mask is now 14 chars ("11111111111111"). 3 new catalogs: kartoons_anime, kartoons_cartoons, kartoons_movies. `kartoons:` added to idPrefixes/resources.

## Architecture decisions

- esbuild fully bundles all workspace dependencies into `dist/index.mjs` — no `node_modules` needed at runtime (enables tiny Docker images).
- `cleanTitle()` strips 40+ noise patterns (quality tags, platform labels, release-group markers, abbreviation dots like `K.G.F` → `KGF`) before title comparison.
- `normalize()` in `title-score.ts` collapses abbreviation dots (`([a-z])\.` → `$1`) before tokenising, so `K.G.F` and `KGF` produce identical token sets.
- Score threshold is 0.5 for correctly-typed results; relaxed to 0.7 with a type-fallback pool when a provider's catalog misclassifies a title.
- `BASE_PATH` env var (default `/api`) lets the same binary run both behind Replit's reverse proxy (`/api` prefix) and as a standalone Docker service at `/api`.

## Product

Users install the manifest URL in Stremio Desktop / Stremio Web. The addon returns streams from all enabled providers for any movie or series that Stremio asks about. Stream quality, language, and server are shown in each stream's name label.

**Manifest URL (Replit dev):**
`https://<your-replit-domain>/api/manifest.json`

**Manifest URL (Docker, local):**
`http://localhost:7000/api/manifest.json`

## Docker deployment

```bash
# Build and start (detached)
docker compose up -d --build

# View logs
docker compose logs -f

# Stop
docker compose down
```

The addon will be available at `http://localhost:7000/api/manifest.json`.

To run without Compose:
```bash
docker build -t infinite-streams .
docker run -d -p 7000:7000 --name infinite-streams \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  infinite-streams
```

**Image size:** ~170 MB (Alpine + Node 24 + compiled bundle only).

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | HTTP listen port |
| `BASE_PATH` | `/api` | URL prefix (set `""` if a proxy strips it) |
| `NODE_ENV` | `production` | Node environment |
| `LOG_LEVEL` | `info` | Pino log level: `trace\|debug\|info\|warn\|error` |
| `SESSION_SECRET` | — | Optional; set a strong random value in production |

## Gotchas

- VidLink Docker deploys (VPS/self-hosted): the Dockerfile's runtime stage must copy `artifacts/api-server/wasm/` alongside `dist/` — `lib/vidlink.ts` reads `wasm/script.js` and `wasm/fu.wasm` relative to `process.cwd()` at runtime. Without it, VidLink WASM init fails with ENOENT and the provider returns zero streams (works fine on Replit since it runs from source, so this only surfaces on Docker/VPS hosting).

- HDHub4U title matching uses `cleanTitle()` before scoring — if a title scores below 0.5, check the raw Typesense title via `GET /api/debug/hdhub4u?title=…&type=movie`.
- Cache TTL for stream results is 30 min. After a code change, clear cache by restarting the server.
- IMDB IDs must be correct — wrong IDs cause MetaResolver to resolve to unrelated titles. Verify with TMDB: `https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id&api_key=5f39fd16e987a9e3fce30d55cf09b438`
- The `series` token is stripped from HDHub4U titles (e.g. "Mirzapur PrimeVideo **Series**" → "Mirzapur"). Do not use `series` as a meaningful word in provider title matching.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
