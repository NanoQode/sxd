#!/usr/bin/env bash
# Build, migrate and roll out the SimplexD stack on a single server.
#
#   ./deploy/deploy.sh            # build images, migrate, restart, health check
#   ./deploy/deploy.sh --no-build # reuse existing images
#   ./deploy/deploy.sh rollback   # restart the previous image tags
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE=(docker compose -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE")
STATE_FILE=".deploy-state"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE (copy deploy/.env.production.example)" >&2
  exit 1
fi

version="${APP_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
export APP_VERSION="$version"
export WEB_IMAGE="simplexd-web:${version}"
export WORKER_IMAGE="simplexd-worker:${version}"

case "${1:-deploy}" in
  rollback)
    if [[ ! -f "$STATE_FILE" ]]; then
      echo "No previous deployment recorded" >&2
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    export WEB_IMAGE="$PREVIOUS_WEB_IMAGE" WORKER_IMAGE="$PREVIOUS_WORKER_IMAGE"
    echo "Rolling back to $WEB_IMAGE / $WORKER_IMAGE (database migrations are not reverted; see docs/operations/deployment.md)"
    "${COMPOSE[@]}" up -d web worker
    ;;
  deploy|--no-build)
    if [[ "${1:-deploy}" != "--no-build" ]]; then
      echo "Building images $WEB_IMAGE and $WORKER_IMAGE"
      "${COMPOSE[@]}" build web worker
    fi
    previous_web="$(docker inspect --format '{{index .Config.Image}}' simplexd-web-1 2>/dev/null || true)"
    previous_worker="$(docker inspect --format '{{index .Config.Image}}' simplexd-worker-1 2>/dev/null || true)"
    echo "Starting database and cache"
    "${COMPOSE[@]}" up -d db redis
    echo "Checking the runtime database role"
    "${COMPOSE[@]}" run --rm check-rls
    echo "Applying migrations"
    "${COMPOSE[@]}" run --rm migrate
    echo "Rolling out web, worker and caddy"
    "${COMPOSE[@]}" up -d web worker caddy
    printf 'PREVIOUS_WEB_IMAGE=%q\nPREVIOUS_WORKER_IMAGE=%q\n' "${previous_web:-$WEB_IMAGE}" "${previous_worker:-$WORKER_IMAGE}" > "$STATE_FILE"
    echo "Waiting for health"
    for _ in $(seq 1 30); do
      if "${COMPOSE[@]}" exec -T web node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
        echo "Web healthy"
        exit 0
      fi
      sleep 2
    done
    echo "Web did not become healthy; inspect: docker compose -f deploy/docker-compose.prod.yml logs web" >&2
    exit 1
    ;;
  *)
    echo "Usage: $0 [deploy|--no-build|rollback]" >&2
    exit 2
    ;;
esac
