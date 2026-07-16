# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.17.0

FROM node:${NODE_VERSION}-bookworm AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS builder
WORKDIR /app
COPY . .

# NEXT_PUBLIC_* values are compiled into the browser bundle by Next.js. Set
# these build args to URLs reachable from an operator's browser, not Docker
# service names.
ARG NEXT_PUBLIC_BASE_URL=http://localhost:3002
ARG NEXT_PUBLIC_INNGEST_URL=http://localhost:8288
ARG NEXT_PUBLIC_NEO4J_BROWSER_URL=
ENV NEXT_PUBLIC_BASE_URL=${NEXT_PUBLIC_BASE_URL}
ENV NEXT_PUBLIC_INNGEST_URL=${NEXT_PUBLIC_INNGEST_URL}
ENV NEXT_PUBLIC_NEO4J_BROWSER_URL=${NEXT_PUBLIC_NEO4J_BROWSER_URL}

RUN npx prisma generate
RUN npm run build

FROM node:${NODE_VERSION}-bookworm AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3002 \
    AO_LOG_DIR=/app/persist/logs

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# Keep project sources because the archiver and monitor sweeper run directly
# from their TypeScript entrypoints with tsx. The same immutable image is used
# for all three roles.
COPY --chown=node:node . .
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/node_modules/.prisma ./node_modules/.prisma

RUN mkdir -p /app/persist/logs \
    && chown -R node:node /app \
    && chmod +x /app/scripts/docker-entrypoint.sh

USER node
EXPOSE 3002

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["web"]
