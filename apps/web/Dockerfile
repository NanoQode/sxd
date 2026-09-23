# Production image for the SimplexD web app (Next.js standalone output).
# Build from the repository root:  docker build -f apps/web/Dockerfile -t simplexd-web .

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
COPY packages/finance/package.json packages/finance/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY tests/e2e/package.json tests/e2e/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
# sharp needs its native binary; run only its build script.
RUN pnpm rebuild sharp

FROM deps AS build
COPY . .
ARG APP_VERSION=dev
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_VERSION=$APP_VERSION
# Build-time placeholders only: server environment is read at runtime and is
# never inlined into the bundle. They satisfy import-time validation.
ENV APP_ENV=production \
    APP_URL=https://build.invalid \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    AUTH_SECRET=build-placeholder-secret-build-placeholder-secret \
    SECRETS_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    STORAGE_PROVIDER=s3 \
    MALWARE_SCANNER=clamav \
    SMTP_SECURITY=starttls
RUN pnpm --filter @simplexd/web build

FROM ${BASE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=app:app /repo/IMPLEMENTATION-STATUS.md ./IMPLEMENTATION-STATUS.md
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
