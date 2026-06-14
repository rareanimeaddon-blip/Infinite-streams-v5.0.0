# INFINITE STREAMS

A Stremio addon (v8.3.0) that aggregates streams from 12 providers into a single manifest — movies, series, and anime with Indian-language content support.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the API server (port 8080 on Replit, proxied at `/api`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/scripts run provider-test` — run the provider health-check against all 12 providers

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, esbuild (fully self-contained ESM bundle)
- 12 stream providers: HDHub4U, 4KHDHub, HindMoviez, DahmerMovies, MovieBox, CastleTV, DooFlix, StreamFlix, NetMirror, TIK2, AnimeSalt, RareAnime, AnimeDekho
- Title matching: Typesense (HDHub4U) + custom `titleSimilarityScore` (Jaccard + length penalty)
- Health endpoint: `GET /api/healthz`

## Where things live

- `artifacts/api-server/src/providers/` — one file per stream provider
- `artifacts/api-server/src/routes/stremio.ts` — main aggregation logic, per-provider stream functions
- `artifacts/api-server/src/providers/hdhub4u-base.ts` — `cleanTitle()`, Typesense search
- `artifacts/api-server/src/utils/title-score.ts` — `titleSimilarityScore()` (Jaccard + abbreviation handling)
- `artifacts/api-server/src/lib/meta-resolver.ts` — IMDB → title via Cinemeta + TMDB
- `artifacts/api-server/src/manifest.ts` — addon manifest + provider list
- `scripts/src/provider-test.ts` — end-to-end provider health test script

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
