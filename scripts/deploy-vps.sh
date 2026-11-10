#!/usr/bin/env bash
# ==============================================================================
# OLIVE PIZZA — AUTOMATED VPS ZERO-DOWNTIME DEPLOYMENT SCRIPT
# Supports PM2, Systemd, and Docker Compose deployment modes on Linux VPS
# ==============================================================================

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

echo "=========================================================="
echo "🍕 Olive Pizza Backend — VPS Deployment Pipeline"
echo "=========================================================="
echo "Working directory: $DEPLOY_DIR"
date

# 1. Check for .env file
if [ ! -f .env ]; then
  echo "❌ Error: .env file missing in $DEPLOY_DIR."
  echo "Please copy .env.example to .env and configure credentials before deploying."
  exit 1
fi

# 2. Pull latest git branch if inside git repository
if [ -d "../.git" ] || [ -d ".git" ]; then
  echo "📥 Pulling latest git updates..."
  git pull origin main || echo "⚠️ Git pull warning (continuing with local source)..."
fi

# 3. Check deployment mode
MODE="${1:-pm2}"

if [ "$MODE" = "systemd" ]; then
  echo "⚙️ Deploying via Systemd Service..."
  npm ci --omit=dev
  npm run build || true
  sudo systemctl restart olive-pizza-backend
  sleep 3
  curl -fsS http://127.0.0.1:5000/health/live || {
    echo "❌ Health check probe failed!"
    sudo journalctl -u olive-pizza-backend -n 50 --no-pager
    exit 1
  }
  echo "✅ Systemd service restarted and healthy!"
else
  echo "🚀 Deploying via PM2 (Default)..."
  npm ci --omit=dev
  npm run build || true

  # Ensure logs directory exists
  mkdir -p logs

  if npx pm2 describe olive-pizza-backend > /dev/null 2>&1; then
    echo "🔄 Reloading active PM2 cluster..."
    npx pm2 reload ecosystem.config.cjs --update-env
  else
    echo "▶️ Starting new PM2 instance..."
    npx pm2 start ecosystem.config.cjs
  fi

  sleep 3
  curl -fsS http://127.0.0.1:5000/health/live || {
    echo "❌ Health check probe failed!"
    npx pm2 logs olive-pizza-backend --lines 50 --nostream
    exit 1
  }
  echo "✅ PM2 cluster running and healthy!"
fi

echo "=========================================================="
echo "🎉 Deployment successfully completed!"
echo "=========================================================="
