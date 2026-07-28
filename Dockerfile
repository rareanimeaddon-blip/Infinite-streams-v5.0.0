# ─── Stage 1: Build ───────────────────────────────────────────────────────────
# The full monorepo is required so pnpm can resolve workspace:* dependencies
# and honour the lockfile.  esbuild then inlines everything into a single bundle.
FROM node:24-alpine AS builder

# Activate pnpm via corepack (matches the version in use on Replit)
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /workspace

# ── Copy workspace root manifests first ───────────────────────────────────────
# These change rarely, so Docker caches the expensive `pnpm install` layer until
# one of these files changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

# ── Copy all workspace packages ───────────────────────────────────────────────
# pnpm discovers packages via the globs in pnpm-workspace.yaml.
# All packages must be present for --frozen-lockfile to pass.
COPY lib/      lib/
COPY scripts/  scripts/
COPY artifacts/ artifacts/

# ── Install dependencies ───────────────────────────────────────────────────────
RUN pnpm install --frozen-lockfile

# ── Build the production bundle ────────────────────────────────────────────────
# esbuild fully bundles all JS/TS deps (workspace:* libs included) into
# artifacts/api-server/dist/index.mjs — no node_modules needed at runtime.
RUN pnpm --filter @workspace/api-server run build

# ── Pre-install playwright for the runtime stage ───────────────────────────────
# playwright is in the esbuild external list so it is NOT bundled into dist/.
# pnpm uses a virtual store with symlinks that break in a multi-stage COPY, so
# we create a separate flat npm install here that can be safely copied as-is.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 prevents the 300 MB bundled-Chromium
# download — the runtime image uses the Alpine system Chromium binary instead.
RUN mkdir /playwright-pkg && \
    cd /playwright-pkg && \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --ignore-scripts playwright@^1.62.0


# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Minimal image — only the compiled bundle + playwright module needed.
FROM node:24-alpine AS runner

# tini ensures proper PID-1 behaviour: forwards signals and reaps zombies.
# curl is required at runtime: gdlink.dev/gdflix.* sit behind Cloudflare
# TLS-fingerprint bot detection that blocks Node's native fetch/axios (403)
# but passes curl — see movies4u-proxy.ts's curlFetchText().
# chromium is required at runtime for the VidLink provider (Playwright-based
# stream extraction).  Using the Alpine system binary avoids downloading
# Playwright's bundled ~300 MB Chromium inside the image.
RUN apk add --no-cache tini curl chromium

# ── Runtime defaults (override with -e or docker-compose environment:) ────────
ENV NODE_ENV=production

# Tell Playwright not to look for its own downloaded browsers.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Point the VidLink provider at the Alpine system Chromium binary.
# This overrides the Nix-store path hardcoded in vidlink.ts for Replit.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Port the HTTP server listens on.
# Stremio addons conventionally use 7000.  Change with -e PORT=…
ENV PORT=7000

# URL prefix the addon is mounted under (matches Express router base).
# Set to "" if you are hosting behind a reverse proxy that already strips /api.
ENV BASE_PATH=/api

# Pino log level: trace | debug | info | warn | error (default: info)
ENV LOG_LEVEL=info

WORKDIR /app

# Copy the flat npm playwright install from the builder.
# Placed at /app/node_modules so Node's ESM resolver finds it when
# resolving imports from /app/dist/index.mjs.
COPY --from=builder /playwright-pkg/node_modules ./node_modules

COPY --from=builder /workspace/artifacts/api-server/dist ./dist

EXPOSE 7000

# Health check hits the /healthz endpoint.
# If PORT is changed via -e PORT=…, update this CMD accordingly (or override in compose).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:7000/api/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
