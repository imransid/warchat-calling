#!/usr/bin/env bash
# =====================================================================
#  deploy/deploy.sh — one-shot deploy from laptop → server
# =====================================================================
#
# Usage:
#   SSH_HOST=user@your-server.com ./deploy/deploy.sh
#
# Assumes you've already done the one-time setup in docs/DEPLOY_NGINX.md
# (created the warchat user, /opt/warchat-calling dir, postgres+redis,
# nginx + cert). This script handles the recurring "I changed code,
# push it" loop.
#
# What it does:
#   1. rsync the working tree (minus node_modules, dist, .env, .git)
#   2. npm ci + prisma generate + migrate deploy + build (as warchat user)
#   3. systemctl restart warchat-calling
#   4. tail the journal for 5 seconds so you see startup banner

set -euo pipefail

SSH_HOST="${SSH_HOST:?Set SSH_HOST=user@your-server.com}"
REMOTE_DIR="${REMOTE_DIR:-/opt/warchat-calling}"
SERVICE_NAME="${SERVICE_NAME:-warchat-calling}"
APP_USER="${APP_USER:-warchat}"

echo "==> Syncing source to ${SSH_HOST}:${REMOTE_DIR}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude tsconfig.tsbuildinfo \
  --exclude __MACOSX \
  ./ "${SSH_HOST}:/tmp/warchat-calling-rsync/"

echo "==> Installing on server"
ssh "${SSH_HOST}" bash <<EOF
set -euo pipefail
sudo rsync -a --delete \
  --exclude .env \
  /tmp/warchat-calling-rsync/ ${REMOTE_DIR}/
sudo chown -R ${APP_USER}:${APP_USER} ${REMOTE_DIR}

sudo -u ${APP_USER} bash -c "
  cd ${REMOTE_DIR}
  npm ci --omit=dev=false
  npx prisma generate
  npx prisma migrate deploy
  npm run build
"

sudo systemctl restart ${SERVICE_NAME}
EOF

echo "==> Tailing service logs for 5s..."
ssh "${SSH_HOST}" "sudo journalctl -u ${SERVICE_NAME} -n 50 --no-pager"

echo "==> Done."
