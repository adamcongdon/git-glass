#!/usr/bin/env bash
# Landing bar for git-glass: unit tests + live /api/health.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-7777}"
HEALTH="http://127.0.0.1:${PORT}/api/health"
echo "== bun test =="
bun test
python3 "$ROOT/scripts/live_health.py" "$HEALTH" "$PORT" "$ROOT"
