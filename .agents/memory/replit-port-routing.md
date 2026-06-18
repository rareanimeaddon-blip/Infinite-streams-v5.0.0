---
name: Replit path-based port routing
description: Replit's dev-domain proxy routes /api/* to port 8080, not the main port (5000). Apps must bind both.
---

# Replit path-based port routing

**Rule:** Replit's internal reverse proxy routes requests by path prefix:
- `/` and all non-`/api` paths → `localPort 5000` (mapped as `externalPort 80`)
- `/api/*` paths → `localPort 8080` (mapped as `externalPort 8080`)

**Why:** Confirmed via live test — a bare `http.createServer` on port 8080 received a request for `/api/test123` when curled via the public dev domain. The same request returns 502 when nothing is on port 8080.

**How to apply:** Any Express app using `BASE_PATH="/api"` on Replit must also bind to port 8080. In `index.ts`, include 8080 in `EXTRA_PORTS`:
```typescript
const EXTRA_PORTS: number[] = [8080, 8081].filter((p) => p !== port);
```
This way, starting the server on port 5000 (for the landing page / root) still serves `/api/*` traffic correctly via port 8080.
