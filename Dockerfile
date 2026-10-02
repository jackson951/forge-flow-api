# One image for the API and the worker (Part 20):
#   API:     node dist/main.js    (default CMD)
#   worker:  node dist/worker.js
# Run with an init process (`docker run --init`, Compose `init: true`) so SIGTERM reaches Node
# and the app shuts down gracefully.

# ── deps: all dependencies (incl. dev, for building) ──────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ── build: generate the Prisma client and compile ─────────────────────────────
FROM deps AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
# Prisma's engine for this platform (linux-musl, OpenSSL 3) is selected automatically here.
RUN npx prisma generate && npm run build

# ── prod-deps: a clean production-only install ────────────────────────────────
# Not `npm prune --omit=dev`: @prisma/client lists the Prisma CLI and TypeScript as optional
# peers, so the lockfile marks them "devOptional" and --omit=dev keeps them (≈ 120 MB).
# --omit=optional drops them; optional native accelerators (e.g. msgpackr-extract) are
# skipped too and their pure-JS fallbacks are used.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

# ── migrate: one-shot `prisma migrate deploy` (needs the Prisma CLI, a dev dependency) ──
FROM node:22-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app prisma ./prisma
USER app
CMD ["npx", "prisma", "migrate", "deploy"]

# ── runtime: API + worker, production dependencies only, non-root ─────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
# The generated client and its query engine for this platform.
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
CMD ["node", "dist/main.js"]
