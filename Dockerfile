# ── deps ──────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ── build ─────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ── runtime (shared by api + worker) ──────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
CMD ["node", "dist/main"]
