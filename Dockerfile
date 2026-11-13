# ============================================================================
# WMS — production container image
#
# Multi-stage build against `output: "standalone"`. The final image contains the
# compiled server plus only the dependencies it actually loads — no source, no
# devDependencies, no build toolchain.
#
#   docker build -t wms .
#   docker run -d -p 3000:3000 \
#     -e NODE_ENV=production \
#     -e NEXT_PUBLIC_SITE_URL=https://wms.example.com \
#     -e WMS_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
#     -e WMS_SEED_DEMO_DATA=false \
#     -v wms-data:/app/data \
#     wms
#
# WMS_SESSION_SECRET is required: the boot-time config gate refuses to start a
# production process on the built-in development secret.
# ============================================================================

# --- Base ------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app

# pnpm is pinned through corepack so the lockfile is honoured exactly.
RUN corepack enable


# --- Dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# `--frozen-lockfile` fails the build rather than silently resolving something
# new, which is what you want in CI.
RUN pnpm install --frozen-lockfile


# --- Build -----------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here
# rather than at runtime.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

# Production build: runs ESLint and the TypeScript check, and prerenders every
# static page. Both are enforced by next.config.mjs, so a failing build here
# means the code does not ship.
RUN pnpm build


# --- Runtime ---------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WMS_DATA_DIR=/app/data

# Drop privileges. The standalone server needs no root, and the data directory
# is owned by this user so the file driver can persist.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output, static assets and public files. `next start` is not used
# with output: "standalone" — the server.js below is the entry point.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Mount point for the "file" storage driver.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs

EXPOSE 3000

# Liveness and readiness both come from /api/health, which returns 503 with
# ready: false when the configuration gate finds a fatal violation or the
# dataset is empty.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
