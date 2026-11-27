#!/bin/bash
set -e

check_node() {
  local bin="$1"
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    local ver
    ver=$("$bin" -p "process.versions.node" 2>/dev/null || true)
    if [ -n "$ver" ]; then
      local major="${ver%%.*}"
      if [ "$major" -ge 18 ] 2>/dev/null; then
        echo "$bin:$major"
        return 0
      fi
    fi
  fi
  return 1
}

CANDIDATES=()
if command -v node >/dev/null 2>&1; then
  CANDIDATES+=("$(command -v node)")
fi
CANDIDATES+=(
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "$HOME/.volta/bin/node"
  "$HOME/.fnm/current/bin/node"
  "$HOME/.local/share/mise/shims/node"
)

if [ -d "$HOME/.nvm/versions/node" ]; then
  while IFS= read -r p; do
    CANDIDATES+=("$p")
  done < <(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r)
fi

for app_res in \
  "/Applications/Codex.app/Contents/Resources" \
  "/Applications/Antigravity.app/Contents/Resources" \
  "/Applications/Claude.app/Contents/Resources" \
  "$HOME/Applications/Codex.app/Contents/Resources"
do
  if [ -d "$app_res" ]; then
    while IFS= read -r p; do
      CANDIDATES+=("$p")
    done < <(find "$app_res" -maxdepth 4 -name node -type f -perm +111 2>/dev/null || true)
  fi
done

BEST_FALLBACK=""
for cand in "${CANDIDATES[@]}"; do
  res=$(check_node "$cand" || true)
  if [ -n "$res" ]; then
    bin="${res%:*}"
    major="${res##*:}"
    if [ "$major" -ge 22 ] 2>/dev/null; then
      echo "$bin"
      exit 0
    fi
    if [ -z "$BEST_FALLBACK" ]; then
      BEST_FALLBACK="$bin"
    fi
  fi
done

if [ -n "$BEST_FALLBACK" ]; then
  echo "$BEST_FALLBACK"
  exit 0
fi

echo "Node.js(v18 이상)를 찾을 수 없습니다. Node.js 또는 Codex 앱을 설치해 주세요." >&2
exit 1
