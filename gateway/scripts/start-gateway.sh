#!/usr/bin/env bash
# GateSwarm MoA Router v0.4.3 — persistent startup with auto-restart
# Usage: scripts/start-gateway.sh [--port 8900]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

PORT=8900
if [ "$1" = "--port" ] && [ -n "$2" ]; then
  PORT="$2"
fi

# Kill existing instance if running
if lsof -i :"$PORT" -t >/dev/null 2>&1; then
  echo "⚠️  Port $PORT in use, killing existing process..."
  kill $(lsof -i :"$PORT" -t) 2>/dev/null || true
  sleep 1
fi

echo "🚀 Starting GateSwarm MoA Router v0.4 on port $PORT..."

# v0.4.3: Auto-restart on crash with exponential backoff
MAX_RESTARTS=10
RESTART_DELAY=5

while true; do
  npx tsx src/moa-gateway.ts --port "$PORT"
  EXIT_CODE=$?
  
  if [ $MAX_RESTARTS -le 0 ]; then
    echo "❌ Max restarts reached. Exiting."
    exit $EXIT_CODE
  fi
  
  echo "⚠️  Gateway exited with code $EXIT_CODE. Restarting in ${RESTART_DELAY}s... ($MAX_RESTARTS attempts left)"
  sleep $RESTART_DELAY
  
  # Exponential backoff: double the delay up to 60s
  RESTART_DELAY=$((RESTART_DELAY * 2))
  if [ $RESTART_DELAY -gt 60 ]; then
    RESTART_DELAY=60
  fi
  MAX_RESTARTS=$((MAX_RESTARTS - 1))
done
