#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIDGET_DIR="$SCRIPT_DIR/widget-mac"
STATE_DIR="$HOME/.ai-desk-pet"
PID_FILE="$STATE_DIR/mac-pet.pid"
LOG_FILE="$STATE_DIR/mac-server.log"

mkdir -p "$STATE_DIR"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "AI Desk Pet 위젯이 이미 실행 중입니다 (PID: $OLD_PID)."
    echo "상단 메뉴바(🤖 AI) 또는 바탕화면 펫을 확인해 주세요."
    exit 0
  fi
fi

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
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "서버 시작 실패. 로그:" >&2
    cat "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.1
done

if [ -z "$URL" ]; then
  echo "서버 응답 시간 초과." >&2
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

nohup osascript -l JavaScript "$WIDGET_DIR/desk-pet-window.jxa" "$URL" "$SERVER_PID" >/dev/null 2>&1 &
UI_PID=$!
echo "$UI_PID" > "$PID_FILE"

echo "AI Desk Pet 위젯을 실행했습니다 ($URL)."
echo "이 터미널 창은 닫으셔도 위젯은 계속 실행됩니다."
