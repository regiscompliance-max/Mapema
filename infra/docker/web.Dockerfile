# [DevOps] Web image (Next.js standalone output). NEXT_PUBLIC_* values are baked in at build time.
FROM node:24-bookworm-slim AS build
WORKDIR /src
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_OIDC_ISSUER
ARG NEXT_PUBLIC_OIDC_CLIENT_ID=mapema-web
ARG NEXT_PUBLIC_DEV_SIGNIN=false
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/pricing ./packages/pricing
COPY apps/web ./apps/web
RUN npm ci --workspace @mapema/pricing --workspace @mapema/web --include-workspace-root \
 && npm run build -w @mapema/pricing && NEXT_TELEMETRY_DISABLED=1 npm run build -w @mapema/web

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 mapema
COPY --from=build --chown=mapema /src/apps/web/.next/standalone ./
COPY --from=build --chown=mapema /src/apps/web/.next/static ./apps/web/.next/static
USER 10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
