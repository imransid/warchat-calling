# ==================================================
#  Build Stage
# ==================================================
FROM node:20-slim AS builder

WORKDIR /app

# Prisma needs libssl3 + ca-certs at install/generate time on Debian slim.
# These come pre-installed on most slim images, but pin them explicitly so
# the build is reproducible across base-image updates.
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends openssl ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Install all deps (incl. dev) — needed for nest build + prisma generate.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Generate Prisma client. Done after deps but before app source so this
# layer caches when only src/ changes.
COPY prisma ./prisma/
RUN npx prisma generate

# Build the NestJS app.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prune dev deps in place. `npm prune --omit=dev` removes dev-only packages
# but preserves the prisma client files at node_modules/.prisma/* and
# node_modules/@prisma/* generated above — those live alongside the runtime
# @prisma/client package and survive pruning.
RUN npm prune --omit=dev


# ==================================================
#  Production Stage
# ==================================================
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production

# Same runtime libs Prisma needs to talk to its query engine binary.
# Without libssl3 the engine starts but can't load and returns the
# non-JSON "Error loading..." message you saw on alpine.
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends openssl ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Built artifacts.
COPY --from=builder /app/dist ./dist

# Prisma needs schema + migration files at runtime for `migrate deploy`.
COPY --from=builder /app/prisma ./prisma

# package.json so node can resolve "main", scripts, and module fields.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./

# Pruned node_modules — keeps the generated prisma client.
COPY --from=builder /app/node_modules ./node_modules

# Drop root for runtime.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# The compose file's `command:` overrides this and runs prisma migrate first.
# If you ever run this image without compose, fall back to the same chain.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]