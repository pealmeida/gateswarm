#!/usr/bin/env bash
# GateSwarm MoMA Router v0.5.1 — persistent startup with auto-restart
# Usage: scripts/start-gateway.sh [--port 8900] [--replace]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Load environment variables from .env without reparsing or word splitting.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT=8900
REPLACE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --replace)
      REPLACE=true
      shift
      ;;
    *)
      echo "Usage: $0 [--port PORT] [--replace]" >&2
      exit 2
      ;;
  esac
done

# Do not replace a process the caller did not explicitly authorize.
PIDS="$(lsof -t -i :"$PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  if [ "$REPLACE" != true ]; then
    echo "❌ Port $PORT is already in use by PID(s): $PIDS. Re-run with --replace to stop them." >&2
    exit 1
  fi
  echo "⚠️  Replacing process(es) on port $PORT: $PIDS"
  kill $PIDS
fi

echo "🚀 Starting GateSwarm MoMA Router v0.5.1 on port $PORT..."

# v0.4.3: Auto-restart on crash with exponential backoff
MAX_RESTARTS=10
RESTART_DELAY=5

while true; do
  npx tsx src/moma-gateway.ts --port "$PORT"
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
