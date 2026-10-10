#!/usr/bin/env bash
# Wrap any execution battery with the quota manager.
#   scripts/with-quota-battery.sh <battery-name> [--need p1,p2] [--requests p=N,...] [--strict] -- <command...>
# Starts the battery (snapshot + pre-check, never blocks unless --strict), runs the command, always ends the battery
# (final snapshot + report + calibration), and returns the command's exit code.
# Examples:
#   scripts/with-quota-battery.sh bench-tiers --need zai,bailian -- npx tsx scripts/benchmarks/run.ts
#   scripts/with-quota-battery.sh publimatch-prod -- ./run-production-battery.sh
set -u
ROOT="${GATESWARM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NAME="${1:?battery name}"; shift
QM=(npx tsx scripts/quota-manager.ts)
START=("$NAME"); while [ $# -gt 0 ] && [ "$1" != "--" ]; do START+=("$1"); shift; done
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "no command after --" >&2; exit 2; }
(cd "$ROOT" && "${QM[@]}" battery start "${START[@]}"); rc=$?
[ $rc -eq 3 ] && { echo "[quota] strict pre-check refused to start" >&2; exit 3; }
"$ROOT/scripts/quota-manager-supervisor.sh" start >/dev/null 2>&1 || true   # make sure the short-interval collector is up
trap '(cd "$ROOT" && "${QM[@]}" battery end) || true' EXIT
"$@"
