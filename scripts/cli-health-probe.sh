#!/bin/bash
# GateSwarm CLI agent health probe — checks binary AND auth state.
# Exit 0 = healthy (binary present + auth usable), Exit 1 = unhealthy.
#
# Usage: cli-health-probe.sh <agent-id>
#
# This script auto-locates the gateswarm router root. It works whether
# the repo is at /opt/gateswarm, /root/.../gateswarm-moma-router, or
# anywhere else. The check is:
#   1. <router_root>/scripts/cli-health-probe.sh (auto-resolved from $0)
#   2. ${GATESWARM_ROOT}/scripts/cli-health-probe.sh (env override)
#   3. bare "cli-health-probe.sh" in PATH (fallback)
#
# We resolve the script's real path first, then anchor to the repo root.

# Resolve this script's real directory (follows symlinks)
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
ROUTER_ROOT="$(dirname "$SCRIPT_DIR")"
export GATESWARM_ROOT="${GATESWARM_ROOT:-$ROUTER_ROOT}"

AGENT_ID="${1:-}"

case "$AGENT_ID" in
  codex-cli)
    # Binary must exist
    command -v codex >/dev/null 2>&1 || { echo "codex binary not found"; exit 1; }
    codex --version >/dev/null 2>&1 || { echo "codex --version failed"; exit 1; }
    # Auth: must have OPENAI_API_KEY set OR a valid ChatGPT login (auth.json with non-null token)
    AUTH_FILE="$HOME/.codex/auth.json"
    if [ -n "$OPENAI_API_KEY" ]; then
      exit 0
    fi
    if [ -f "$AUTH_FILE" ]; then
      # Check that the file contains a non-null token / refresh_token / access_token field
      if grep -qE '"(OPENAI_API_KEY|access_token|refresh_token)"\s*:\s*"[^"]+' "$AUTH_FILE" 2>/dev/null; then
        exit 0
      fi
    fi
    echo "codex-cli: no API key and no ChatGPT login (auth.json has no token)"
    exit 1
    ;;
  claude-cli)
    command -v claude >/dev/null 2>&1 || { echo "claude binary not found"; exit 1; }
    claude --version >/dev/null 2>&1 || { echo "claude --version failed"; exit 1; }
    # Auth: Claude Code stores OAuth credentials in ~/.claude/.credentials.json
    CREDS="$HOME/.claude/.credentials.json"
    if [ -n "$ANTHROPIC_API_KEY" ]; then
      exit 0
    fi
    if [ -f "$CREDS" ]; then
      if grep -qE '"(accessToken|refreshToken|claudeAiOauth)"\s*:\s*"[^"]+' "$CREDS" 2>/dev/null; then
        exit 0
      fi
    fi
    echo "claude-cli: no ANTHROPIC_API_KEY and no OAuth credentials"
    exit 1
    ;;
  pi-agent)
    command -v pi >/dev/null 2>&1 || { echo "pi binary not found"; exit 1; }
    pi --version >/dev/null 2>&1 || { echo "pi --version failed"; exit 1; }
    exit 0
    ;;
  hermes-agent)
    command -v hermes >/dev/null 2>&1 || { echo "hermes binary not found"; exit 1; }
    exit 0
    ;;
  openclaw-agent)
    # openclaw is the gateway itself; if running, we're healthy
    exit 0
    ;;
  *)
    echo "unknown agent: $AGENT_ID"
    exit 1
    ;;
esac
