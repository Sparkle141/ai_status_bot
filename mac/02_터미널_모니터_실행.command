#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$("$SCRIPT_DIR/widget-mac/resolve-node.sh")"
RENDER_JS="$SCRIPT_DIR/collector/render-cli.mjs"

while true; do
  clear
  "$NODE_BIN" "$RENDER_JS" || true
  echo ""
  echo "[안내] 5초마다 자동 갱신됩니다. 종료하려면 Ctrl+C를 누르세요."
  sleep 5
done
