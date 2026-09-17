# Built locally instead of pulling lwlook/webhook: that image is amd64-only
# and fails/emulates under QEMU on an arm64 deploy host (Raspberry Pi /
# Apple Silicon under Colima). BuildKit sets TARGETARCH automatically for
# the build's own platform, so this picks the right upstream release binary
# without needing buildx or --platform.
FROM alpine:3.20

ARG WEBHOOK_VERSION=2.8.1
ARG TARGETARCH

# git + openssh-client: deploy-hook.sh's `git pull` over the SSH deploy key.
# docker-cli + docker-cli-compose: deploy.sh's `docker compose` calls,
# talking to the host daemon via the mounted /var/run/docker.sock.
# bash: deploy.sh itself is `#!/bin/bash` (uses arrays) — Alpine only ships
# /bin/sh (busybox) otherwise, which can't exec it (shebang interpreter
# missing shows up as a plain "not found", exit 127).
# tzdata: Alpine has no timezone database built in, so a TZ env var (set in
# compose.yaml) is otherwise silently ignored and logs stay in UTC.
RUN apk add --no-cache git openssh-client ca-certificates curl bash tzdata docker-cli docker-cli-compose && \
    case "$TARGETARCH" in \
        amd64) WEBHOOK_ARCH=amd64 ;; \
        arm64) WEBHOOK_ARCH=arm64 ;; \
        arm) WEBHOOK_ARCH=arm ;; \
        386) WEBHOOK_ARCH=386 ;; \
        *) echo "unsupported arch: $TARGETARCH" >&2 && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/adnanh/webhook/releases/download/${WEBHOOK_VERSION}/webhook-linux-${WEBHOOK_ARCH}.tar.gz" -o /tmp/webhook.tar.gz && \
    tar -xzf /tmp/webhook.tar.gz -C /tmp && \
    mv "/tmp/webhook-linux-${WEBHOOK_ARCH}/webhook" /usr/local/bin/webhook && \
    chmod +x /usr/local/bin/webhook && \
    rm -rf /tmp/webhook.tar.gz "/tmp/webhook-linux-${WEBHOOK_ARCH}"

ENTRYPOINT ["/usr/local/bin/webhook"]
