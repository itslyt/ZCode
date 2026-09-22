#!/bin/sh
# todo-closeout 启动器。
#
# 为什么需要它：桌面 App 的 Host 是 Electron utility process，从 Finder/Dock 启动时 PATH 只有
# /usr/bin:/bin:/usr/sbin:/sbin，而 node 通常装在 nvm（~/.nvm/versions/node/<v>/bin）下，
# 直接写 "command": "node" 会让 hook 静默找不到可执行文件。这里自己定位 node 再 exec。
#
# 查找顺序：$ZCODE_HOOK_NODE → PATH → nvm 的 default alias → nvm 里版本号最大的一个 →
# Homebrew（Apple Silicon / Intel）→ /usr/local/bin。找不到就记一行日志并退出 0（fail-open）。
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOOK="$SCRIPT_DIR/todo-closeout.mjs"
STATE_DIR="${ZCODE_TODO_CLOSEOUT_STATE_DIR:-$HOME/.zcode/hooks/state/todo-closeout}"
LOG="$STATE_DIR/hook.log"

log_and_exit() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s launcher: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG" 2>/dev/null || true
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 65536 ]; then
    tail -n 50 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
  fi
  exit 0
}

nvm_node() {
  [ -d "$HOME/.nvm/versions/node" ] || return 1
  # 1) nvm 的 default alias（内容可能是 "24"、"v24.21.0" 或 "lts/*"）
  if [ -f "$HOME/.nvm/alias/default" ]; then
    alias_value=$(cat "$HOME/.nvm/alias/default" 2>/dev/null | tr -d '[:space:]')
    alias_value=${alias_value#v}
    alias_value=${alias_value%%/*}
    if [ -n "$alias_value" ]; then
      for candidate in "$HOME"/.nvm/versions/node/v"$alias_value"*/bin/node; do
        [ -x "$candidate" ] && printf '%s' "$candidate" && return 0
      done
    fi
  fi
  # 2) 版本号最大的一个；macOS 自带 sort 没有 -V，退回字典序
  newest=$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -n 1)
  [ -z "$newest" ] && newest=$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort | tail -n 1)
  [ -n "$newest" ] && [ -x "$newest" ] && printf '%s' "$newest" && return 0
  return 1
}

find_node() {
  if [ -n "${ZCODE_HOOK_NODE:-}" ] && [ -x "${ZCODE_HOOK_NODE}" ]; then
    printf '%s' "$ZCODE_HOOK_NODE"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  nvm_node && return 0
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && printf '%s' "$candidate" && return 0
  done
  return 1
}

[ -f "$HOOK" ] || log_and_exit "hook script missing: $HOOK"
NODE_BIN=$(find_node) || log_and_exit "node not found (set ZCODE_HOOK_NODE to fix)"
exec "$NODE_BIN" "$HOOK"
