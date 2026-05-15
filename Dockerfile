# syntax=docker/dockerfile:1.7

# ---- Build stage ----
# Debian-based (glibc) image: required for sodium-native prebuilt binaries used by
# @fastify/secure-session. Alpine (musl) is not supported by sodium-native >=5.
FROM node:22-slim AS builder
WORKDIR /app

# OpenSSL is required by Prisma engines.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY tailwind.config.cjs ./
COPY styles ./styles
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

RUN npx prisma generate
RUN npm run build

# Drop dev dependencies for a smaller runtime
RUN npm prune --omit=dev


# ---- Runtime stage ----
FROM node:22-slim AS runner
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_URL=file:/data/app.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/views ./views
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Persistent data volume (SQLite DB). Container starts as root so the entrypoint can
# chown a host bind mount under /data, then gosu switches to node for Prisma + app.
RUN mkdir -p /data && chown -R node:node /app

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/docker-entrypoint.sh"]
CMD []
