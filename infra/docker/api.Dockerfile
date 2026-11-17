# [DevOps] API + worker image (same image, different command). Not built in Phase 1 (no Docker on the build box).
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN npm ci --workspace @mapema/pricing --workspace @mapema/adapters --workspace @mapema/api --workspace @mapema/worker --include-workspace-root \
 && npm run build -w @mapema/pricing -w @mapema/adapters -w @mapema/api -w @mapema/worker \
 && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 mapema
COPY --from=build --chown=mapema /src/node_modules ./node_modules
COPY --from=build --chown=mapema /src/packages ./packages
COPY --from=build --chown=mapema /src/apps/api/dist ./apps/api/dist
COPY --from=build --chown=mapema /src/apps/api/package.json ./apps/api/
COPY --from=build --chown=mapema /src/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=mapema /src/apps/worker/package.json ./apps/worker/
COPY db ./db
COPY scripts/migrate.mjs ./scripts/
USER 10001
EXPOSE 4000
CMD ["node", "--enable-source-maps", "apps/api/dist/main.js"]
