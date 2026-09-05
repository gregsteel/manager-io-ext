#!/bin/bash

# Accounting stack deployment script.
# Usage:
#   ./deploy.sh                  # start; build (cached) any changed images first
#   ./deploy.sh rebuild          # force rebuild all images, then restart
#   ./deploy.sh rebuild nocache  # force rebuild with no Docker layer cache
#   ./deploy.sh stop             # stop all services
#   ./deploy.sh restart          # restart running services (no rebuild)
#   ./deploy.sh status           # show container status
#   ./deploy.sh logs [service]   # follow logs (all services, or one)

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

ACTION="${1:-up}"
BUILD_CACHE="${2:-cache}"

# BuildKit attaches provenance attestations by default. Those carry a unique
# invocation id / timestamp, so every `docker compose build` produces a new
# image-index digest even when every layer is CACHED — and Compose then
# recreates every container on `up -d`. Opt out so a no-op build is a no-op.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

# Ensure Colima is running (macOS dev; a no-op if colima isn't installed —
# e.g. on the actual Linux deployment server, which uses the system daemon).
ensure_colima() {
    if ! command -v colima >/dev/null 2>&1; then
        return 0
    fi
    if ! colima status >/dev/null 2>&1; then
        echo "🐋 Starting Colima..."
        colima start
    fi
}

ensure_docker() {
    if ! docker info >/dev/null 2>&1; then
        echo "❌ Docker is not running."
        if command -v colima >/dev/null 2>&1; then
            echo "   Try: colima start"
        else
            echo "   Start Docker Desktop and try again."
        fi
        exit 1
    fi
    if ! docker compose version >/dev/null 2>&1; then
        echo "❌ Docker Compose is not available."
        exit 1
    fi
}

check_secrets() {
    local missing=()
    for f in manager-mcp receipts gmail-relay; do
        [ -f "secrets/$f.env" ] || missing+=("secrets/$f.env")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo "❌ Missing secrets file(s): ${missing[*]}"
        echo "   cp secrets/<name>.env.example secrets/<name>.env"
        echo "   # then fill in real values"
        echo "   chmod 600 secrets/<name>.env"
        exit 1
    fi
}

wait_for_health() {
    local name="$1" url="$2" tries=30
    echo "⏳ Waiting for $name..."
    until curl -fsS "$url" >/dev/null 2>&1; do
        tries=$((tries - 1))
        if [ "$tries" -le 0 ]; then
            echo "⚠️  $name did not become healthy in time — check: docker compose logs $name"
            return 1
        fi
        sleep 2
    done
    echo "✅ $name is healthy"
}

case "$ACTION" in
status | stop | restart | logs | up | rebuild) ;;
*)
    echo "❌ Unknown action: $ACTION"
    echo "   Usage: $0 [up|rebuild [nocache]|stop|restart|status|logs [service]]"
    exit 1
    ;;
esac

check_secrets
ensure_colima
ensure_docker

case "$ACTION" in
status)
    docker compose ps
    exit 0
    ;;
stop)
    echo "🛑 Stopping services..."
    docker compose down
    exit 0
    ;;
restart)
    echo "🔧 Restarting services..."
    docker compose restart
    exit 0
    ;;
logs)
    docker compose logs -f "${2:-}"
    exit 0
    ;;
esac

if [ "$ACTION" = "rebuild" ]; then
    echo "🔄 Rebuilding all images..."
    if [ "$BUILD_CACHE" = "nocache" ]; then
        docker compose build --no-cache --pull
    else
        docker compose build --pull
    fi
    echo "🚀 Recreating containers..."
    docker compose up -d --force-recreate
else
    # Always build (cached) rather than only when an image is missing: an
    # image existing locally doesn't mean it's current — a source or
    # submodule change (e.g. docker-manager.io) with no image-tag bump
    # would otherwise go unbuilt forever. `docker compose build` detects
    # such changes via layer-cache content hashing and is a fast no-op
    # when nothing actually changed.
    echo "🔧 Building any changed images (cached)..."
    docker compose build
    echo "🚀 Starting services..."
    docker compose up -d
fi

wait_for_health "manager-mcp" "http://localhost:55668/health"
wait_for_health "receipts" "http://localhost:55666/health"
# gmail-relay has no documented health endpoint (see README) — just confirm the
# container is up.
if docker compose ps --status running gmail-relay 2>/dev/null | grep -q gmail-relay; then
    echo "✅ gmail-relay is running (no health endpoint to poll — verify manually)"
else
    echo "⚠️  gmail-relay does not appear to be running — check: docker compose logs gmail-relay"
fi
# manager has no documented health endpoint (see README) — just confirm the
# container is up.
if docker compose ps --status running manager 2>/dev/null | grep -q manager; then
    echo "✅ manager is running (no health endpoint to poll — verify manually)"
else
    echo "⚠️  manager does not appear to be running — check: docker compose logs manager"
fi

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "📱 Local ports (home-gateway proxies these — see its .env for public hostnames):"
echo "   Manager:     http://localhost:55667"
echo "   Manager MCP: http://localhost:55668"
echo "   Receipts:    http://localhost:55666"
echo "   Gmail relay: http://localhost:55669"
echo ""
echo "📋 Useful commands:"
echo "   Status:              $0 status"
echo "   Logs (all):          $0 logs"
echo "   Logs (one service):  $0 logs manager-mcp"
echo "   Restart:             $0 restart"
echo "   Force rebuild:       $0 rebuild"
echo "   Rebuild, no cache:   $0 rebuild nocache"
echo "   Stop:                $0 stop"
echo ""
docker compose ps
