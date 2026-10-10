#!/usr/bin/env bash
# Background collector loop (no crontab needed).  usage: quota-manager-supervisor.sh {start|stop|status|loop}
# Sleeps the interval the manager writes to data/quota-manager.interval (short during a battery, long when idle).
# Env: GATESWARM_ROOT (default: repo root), GATESWARM_CODEXBAR_BIN, GATESWARM_QUOTA_* (see docs/QUOTA_MANAGER.md),
#      GATESWARM_QM_RUN_DIR (pid/log dir; default $GATESWARM_ROOT/data/quota-manager)
set -u
ROOT="${GATESWARM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
RUN="${GATESWARM_QM_RUN_DIR:-$ROOT/data/quota-manager}"; mkdir -p "$RUN"
PIDF="$RUN/supervisor.pid"; LOG="$RUN/supervisor.log"
alive(){ [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
loop(){
  echo $$ >"$PIDF"; cd "$ROOT"
  while true; do
    npx tsx scripts/quota-manager.ts tick >>"$LOG" 2>&1 || echo "[supervisor] tick failed $(date -Is)" >>"$LOG"
    s=$(cat "$ROOT/data/quota-manager.interval" 2>/dev/null || echo 600); case "$s" in ''|*[!0-9]*) s=600;; esac
    [ "$(wc -c <"$LOG")" -gt 2000000 ] && tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    # sleep in slices; wake early when the manager rewrites the interval file (battery start/end)
    touch "$RUN/.stamp"; w=0
    while [ "$w" -lt "$s" ]; do sleep 5; w=$((w+5)); [ "$ROOT/data/quota-manager.interval" -nt "$RUN/.stamp" ] && break; done
  done
}
case "${1:-}" in
  loop) loop;;
  start) alive && { echo "already running pid $(cat "$PIDF")"; exit 0; }
         setsid -f "$0" loop </dev/null >/dev/null 2>&1; sleep 1; echo "started pid $(cat "$PIDF" 2>/dev/null)";;
  stop) if alive; then pkill -P "$(cat "$PIDF")" 2>/dev/null; kill "$(cat "$PIDF")" 2>/dev/null; fi; rm -f "$PIDF"; echo stopped;;
  status) alive && echo "up pid $(cat "$PIDF") interval=$(cat "$ROOT/data/quota-manager.interval" 2>/dev/null || echo ?)s" || echo down; tail -n 3 "$LOG" 2>/dev/null;;
  *) echo "usage: $0 {start|stop|status}"; exit 2;;
esac
