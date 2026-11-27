#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIDGET_DIR="$SCRIPT_DIR/widget-mac"
STATE_DIR="$HOME/.ai-desk-pet"
LOG_FILE="$STATE_DIR/mac-server.log"

mkdir -p "$STATE_DIR"
NODE_BIN="$("$WIDGET_DIR/resolve-node.sh")"
rm -f "$LOG_FILE"

nohup "$NODE_BIN" "$WIDGET_DIR/server.mjs" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

URL=""
for _ in $(seq 1 50); do
  if [ -f "$LOG_FILE" ]; then
    LINE=$(grep -m1 '^READY ' "$LOG_FILE" 2>/dev/null || true)
    if [ -n "$LINE" ]; then
      URL="${LINE#READY }"
      break
    fi
  fi
  sleep 0.1
done

if [ -z "$URL" ]; then
  echo "서버 시작 실패." >&2
  exit 1
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL"
else
  open "$URL"
fi

echo "브라우저 모니터가 열렸습니다: $URL (서버 PID: $SERVER_PID)"
