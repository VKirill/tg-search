#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/screens}"
mkdir -p "$OUT"

vite_pid=""
cleanup() {
  if [[ -n "$vite_pid" ]]; then kill "$vite_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

cd "$ROOT"
npx vite src/renderer --port 5180 --strictPort >/tmp/tg-ui-vite.log 2>&1 &
vite_pid=$!

for _ in $(seq 1 120); do
  if curl -sf "http://localhost:5180/" >/dev/null; then break; fi
  sleep 0.5
done
if ! curl -sf "http://localhost:5180/" >/dev/null; then
  echo "vite did not start; see /tmp/tg-ui-vite.log"
  exit 1
fi

shot() {
  local file="$1" hash="$2"
  playwright screenshot \
    "http://localhost:5180/#${hash}" \
    "$OUT/$file" \
    --viewport-size=1440,900 \
    --wait-for-selector='[data-ui-ready="1"]' \
    --wait-for-timeout=800
  echo "wrote $file"
}

shot agents-list.png shot=agents
shot agents-editor.png 'shot=agents&agent=manager'
shot agent-rules.png 'shot=agent-rules&tab=rules'
shot skills-draft.png 'shot=skills-draft&tab=draft&skill=supplier-search'
shot approvals.png shot=approvals
shot lead-repeat.png 'shot=lead-repeat&lead=2'
shot spam-templates.png shot=spam
shot publication-in-app.png shot=publication
