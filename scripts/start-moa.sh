#!/usr/bin/env bash
# Start GateSwarm MoA Router v0.4 on port 8900
# Usage: ./scripts/start-moa.sh [--port 8900]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Load environment variables
set -a
source .env
set +a

PORT="${2:-8900}"
if [ "$1" = "--port" ]; then
  PORT="$2"
fi

# Kill existing instance if running
if lsof -i :"$PORT" -t >/dev/null 2>&1; then
  echo "⚠️  Port $PORT already in use, killing existing process..."
  kill $(lsof -i :"$PORT" -t) 2>/dev/null || true
  sleep 1
fi

echo "🚀 Starting GateSwarm MoA Router v0.4 on port $PORT..."
exec npx tsx src/moa-gateway.ts --port "$PORT"
