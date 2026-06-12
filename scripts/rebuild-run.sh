#!/usr/bin/env bash
# Rebuild local images and (re)start the dev compose stack.
#
# Rebuilds the two images built from this repo — ongrid (Go manager,
# deploy/Dockerfile.ongrid) and ongrid-web (SPA + nginx, deploy/Dockerfile.web)
# — then brings the stack up via `make compose-up` (which also generates the
# local self-signed TLS certs on first run). `docker compose up -d` only
# recreates containers whose image changed, so this is safe to re-run.
#
# Usage:
#   scripts/rebuild-run.sh             # rebuild ongrid + nginx(web), then up
#   scripts/rebuild-run.sh nginx       # frontend-only change: rebuild web image
#   scripts/rebuild-run.sh ongrid      # backend-only change
#
# Service names are the compose service names (see deploy/docker-compose.yml):
# the SPA image is built by the `nginx` service.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/docker-compose.yml"
SERVICES=("${@:-ongrid nginx}")
# shellcheck disable=SC2206 # 默认值是带空格的单串，按词拆开
SERVICES=(${SERVICES[@]})

echo "==> 重建镜像: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" build "${SERVICES[@]}"

echo "==> 启动 compose 栈 (make compose-up)"
make -C "$REPO_ROOT" compose-up

echo "==> 当前容器状态"
docker compose -f "$COMPOSE_FILE" ps
