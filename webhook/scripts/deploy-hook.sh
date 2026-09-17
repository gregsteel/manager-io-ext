#!/bin/sh
# Invoked by webhook (lwlook/webhook, wrapping adnanh/webhook) after hooks.json
# has already verified the GitHub HMAC signature, event type, and branch.
# Runs inside the webhook container against the repo bind-mounted at /repo,
# and shells out to `docker compose` on the host via the mounted docker.sock.
set -e

REPO_DIR="/repo"
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
