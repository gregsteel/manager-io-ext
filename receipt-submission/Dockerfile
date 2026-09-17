# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_BUILD_CPUS=1
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=55666
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data

# Baked in at build time (compose.yaml passes these as build args, sourced
# from git by deploy.sh) so the running app can show what it actually is —
# not just "the app is up", which says nothing about whether a deploy
# actually shipped the latest source.
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data/files \
  && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 55666

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:55666/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
