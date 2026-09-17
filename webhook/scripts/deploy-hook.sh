#!/bin/sh
# Invoked by webhook (lwlook/webhook, wrapping adnanh/webhook) after hooks.json
# has already verified the GitHub HMAC signature, event type, and branch.
# Runs inside the webhook container against the repo, mirror-mounted at the
# same absolute path it has on the host (see HOST_REPO_DIR/compose.yaml) so
# that `docker compose`'s relative bind-mount paths resolve correctly when
# it shells out to the host daemon via the mounted docker.sock — resolving
# them against an in-container-only path like /repo would make the host
# daemon create/mount a bogus directory at that literal path instead.
set -e

: "${HOST_REPO_DIR:?HOST_REPO_DIR must be set to the repo's absolute path on the host}"
REPO_DIR="$HOST_REPO_DIR"
LOCK_FILE="/tmp/webhook-deploy.lock"

if [ -e "$LOCK_FILE" ]; then
    echo "Deploy already in progress, skipping this trigger."
    exit 0
fi
trap 'rm -f "$LOCK_FILE"' EXIT
touch "$LOCK_FILE"

cd "$REPO_DIR"

# The repo is bind-mounted from the host, so ownership won't match the
# container's user — git refuses to operate on it otherwise.
git config --global --add safe.directory "$REPO_DIR"

echo "Pulling latest main..."
git pull --ff-only origin main

echo "Running deploy.sh..."
./deploy.sh

echo "Deploy complete."
