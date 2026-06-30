# Tulmi backend — production image for the VPS.
#
# Three stages keep the runtime image small and reproducible:
#   1. deps    — install ALL deps (incl. dev) deterministically from the lockfile.
#   2. build   — compile TypeScript using those deps.
#   3. runtime — copy a fresh prod-only node_modules + dist + shared prompts.

# ---- 1. deps ----------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app/tulmi
COPY tulmi/package.json tulmi/package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- 2. build ---------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app/tulmi
COPY --from=deps /app/tulmi/node_modules ./node_modules
COPY tulmi/ /app/tulmi/
COPY shared/ /app/shared/
RUN npm run build

# ---- 3. runtime -------------------------------------------------------------
FROM node:20-slim AS runtime

# wget is needed for the HEALTHCHECK below; install + clean in one layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Tell the app exactly where the shared/ dir (prompts) lives — robust regardless
# of the compiled directory layout.
ENV TULMI_SHARED_DIR=/app/shared

WORKDIR /app/tulmi
COPY --from=build /app/tulmi/package.json /app/tulmi/package-lock.json* ./
# Reinstall with prod-only deps so tsx/typescript/@types/* don't ship to prod.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /app/tulmi/dist ./dist
# Prompts (.md) are read at runtime and are not emitted by tsc.
COPY --from=build /app/shared /app/shared

# Drop root: node:20-slim ships a non-root `node` user (uid 1000). Make sure it
# owns everything the process touches.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# /healthz is the cheap liveness probe; /readyz adds upstream pings (slower).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "dist/tulmi/src/server.js"]
