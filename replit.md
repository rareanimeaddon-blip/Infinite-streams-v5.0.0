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
- Title matching: Typesense (HDHub4U) + custom `titleSimilarityScore` (Jaccard + length penalty)
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

## Version history

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

- HDHub4U title matching uses `cleanTitle()` before scoring — if a title scores below 0.5, check the raw Typesense title via `GET /api/debug/hdhub4u?title=…&type=movie`.
- Cache TTL for stream results is 30 min. After a code change, clear cache by restarting the server.
- IMDB IDs must be correct — wrong IDs cause MetaResolver to resolve to unrelated titles. Verify with TMDB: `https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id&api_key=5f39fd16e987a9e3fce30d55cf09b438`
- The `series` token is stripped from HDHub4U titles (e.g. "Mirzapur PrimeVideo **Series**" → "Mirzapur"). Do not use `series` as a meaningful word in provider title matching.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
