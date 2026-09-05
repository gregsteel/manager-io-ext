#!/usr/bin/env bash
# Fresh build & deploy of Receipt Submission to the local Docker host.
#
#   ./deploy-docker.sh                  # build and (re)start on port 55666 (.env.local)
#   ./deploy-docker.sh prod             # use .env.prod instead of .env.local
#   PORT=9000 ./deploy-docker.sh        # different host port
#
# Auth secrets are read from .env.$APP_ENV and passed into the container at
# run time. They are never copied into the image (.dockerignore excludes
# .env*), so rebuilding does not bake secrets into a layer. Receipt files
# are stored in ./data on the host, bind-mounted to /app/data.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE=receipt-submission
CONTAINER="${CONTAINER:-receipt-submission}"
PORT="${PORT:-55666}"
# Env name from the first argument, falling back to $APP_ENV, then "local".
APP_ENV="${1:-${APP_ENV:-local}}"
ENV_FILE="${ENV_FILE:-$PWD/.env.$APP_ENV}"
TZ_NAME="${TZ_NAME:-$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||')}"
TZ_NAME="${TZ_NAME:-UTC}"

echo "==> Building $IMAGE"
docker build --pull -t "$IMAGE" .

echo "==> Replacing container $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "       cp .env.example .env.$APP_ENV   # then fill in auth values" >&2
  exit 1
fi
HOST_DATA_DIR="${HOST_DATA_DIR:-$PWD/data}"
mkdir -p "$HOST_DATA_DIR/files"

DOCKER_ENV=(-e "TZ=$TZ_NAME" --env-file "$ENV_FILE" -e "APP_ENV=$APP_ENV" -e "DATA_DIR=/app/data")

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PORT:55666" \
  -v "$HOST_DATA_DIR:/app/data" \
  "${DOCKER_ENV[@]}" \
  "$IMAGE" >/dev/null

echo "==> Deployed"
docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo
echo "Open: http://$(hostname):$PORT  (env from .env.$APP_ENV)"
