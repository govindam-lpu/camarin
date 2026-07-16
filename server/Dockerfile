# ── Stage 1: build the SPA ───────────────────────────────────────────────────
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── Stage 2: server dependencies (prod only) ─────────────────────────────────
FROM node:22-alpine AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 3: runtime — one image, two entrypoints (api / worker, D-010) ─────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package.json server/tsconfig.json server/openapi.yaml ./
COPY server/src ./src
# The built SPA is served by the API itself (single origin, no CORS).
COPY --from=web-build /web/dist ./public

# Non-root: the local storage dir must be writable by the runtime user.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node

EXPOSE 8080

# Container-level liveness; compose/k8s point at /api/health for readiness.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx directly (not via npm) so signals reach the process and shutdown is graceful.
# Worker containers override this with: ["./node_modules/.bin/tsx", "src/worker/index.ts"]
CMD ["./node_modules/.bin/tsx", "src/api/index.ts"]
