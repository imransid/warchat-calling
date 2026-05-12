# ==================================================
#  Build Stage
# ==================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (incl. dev) — needed for nest build + prisma generate.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Generate Prisma client.
COPY prisma ./prisma/
RUN npx prisma generate

# Build the NestJS app.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Re-install with only production deps in a sibling dir so we can copy a
# slim node_modules into the final stage. Using a separate dir avoids
# wiping the prisma client we just generated.
RUN cp -r node_modules /tmp/node_modules_all && \
  npm prune --omit=dev


# ==================================================
#  Production Stage
# ==================================================
FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

# Built artifacts.
COPY --from=builder /app/dist ./dist

# Prisma needs schema files at runtime for `migrate deploy`.
COPY --from=builder /app/prisma ./prisma

# package.json so `node` can resolve `"type"`, scripts, etc.
COPY --from=builder /app/package.json ./

# Slim, pruned node_modules — keeps the generated prisma client (it lives
# under node_modules/.prisma and node_modules/@prisma).
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# The compose file's `command:` overrides this and runs prisma migrate first.
# If you ever run this image without compose, fall back to the same chain.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]