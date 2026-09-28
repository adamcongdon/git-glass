#!/usr/bin/env bash
# Ship gates for git-glass. Fail CI when recurring miss patterns appear.
# Env:
#   SHIP_GATE_BASE   git ref for the merge base (required for cache check)
#   SHIP_GATE_HEAD   git ref for the tip (default HEAD)
#   SHIP_GATE_TITLE  PR title (optional; enables closes check when feat/fix/perf)
#   SHIP_GATE_BODY   PR body (optional)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE="${SHIP_GATE_BASE:-}"
HEAD="${SHIP_GATE_HEAD:-HEAD}"
TITLE="${SHIP_GATE_TITLE:-}"
BODY="${SHIP_GATE_BODY:-}"

fail() {
  echo "ship-gate: $*" >&2
  exit 1
}

if [ -z "$BASE" ]; then
  fail "SHIP_GATE_BASE is required"
fi

# ── Cache bump ──────────────────────────────────────────────────────────────
# Any change under public/ other than sw.js must change const CACHE_VERSION.
public_non_sw="$(git diff --name-only "$BASE...$HEAD" -- 'public/' ':!public/sw.js' || true)"
if [ -n "$public_non_sw" ]; then
  if ! git diff "$BASE...$HEAD" -- public/sw.js | grep -qE '^[+-]const CACHE_VERSION[[:space:]]*='; then
    echo "ship-gate: public/ files changed without a CACHE_VERSION bump in public/sw.js:" >&2
    echo "$public_non_sw" >&2
    fail "bump CACHE_VERSION in public/sw.js when changing files under public/ (except sw.js itself)"
  fi
  echo "ship-gate: cache bump ok"
else
  echo "ship-gate: no public/ (non-sw) changes — cache check skipped"
fi

# ── Closing keyword ─────────────────────────────────────────────────────────
# feat/fix/perf PRs must close an issue or say No issue.
if [ -n "$TITLE" ]; then
  if echo "$TITLE" | grep -qiE '^(feat|fix|perf)(\(|:|[[:space:]])'; then
    combined="$BODY"$'\n'"$(git log --pretty=%B "$BASE...$HEAD" 2>/dev/null || true)"
    if echo "$combined" | grep -qiE '(^|[[:space:]])(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+'; then
      echo "ship-gate: closing keyword ok"
    elif echo "$combined" | grep -qiE '^[[:space:]]*no issue[[:space:]]*$'; then
      echo "ship-gate: No issue escape hatch ok"
    else
      fail "feat/fix/perf PR needs a closing keyword (Closes #N) or a line that is exactly: No issue"
    fi
  else
    echo "ship-gate: title is not feat/fix/perf — closes check skipped"
  fi
else
  echo "ship-gate: no SHIP_GATE_TITLE — closes check skipped"
fi

echo "ship-gate: all checks passed"
