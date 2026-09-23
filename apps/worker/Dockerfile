# Production image for the SimplexD worker and operational CLI commands.
# Build from the repository root:  docker build -f apps/worker/Dockerfile -t simplexd-worker .

ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY tests/e2e/package.json tests/e2e/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm --filter @simplexd/worker build \
 && pnpm --filter @simplexd/worker deploy --legacy --prod /out \
 && cd /out && pnpm rebuild sharp

FROM ${BASE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV MARKET_SEED_FILE=/app/data/seed/nigeria-50-markets.seed.json
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /out/node_modules ./node_modules
COPY --from=build --chown=app:app /out/package.json ./package.json
COPY --from=build --chown=app:app /repo/apps/worker/dist ./dist
COPY --from=build --chown=app:app /repo/packages/db/migrations ./migrations
COPY --from=build --chown=app:app /repo/data/seed ./data/seed
USER app
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
