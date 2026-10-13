#!/bin/bash
# The one shared Chrome: what people use on the desktop and what agents (Deck IDE,
# Codex and Claude Code via chrome-devtools-mcp) drive over CDP 127.0.0.1:9222.
# Run by deckide-browser.service so it outlives Deck IDE restarts. Keep the flags
# in sync with src/utils/agent-browser.ts launch().
set -euo pipefail
port="${AGENT_BROWSER_CDP_PORT:-9222}"
profile="${AGENT_BROWSER_PROFILE_DIR:-$HOME/.local/share/agent-browser/profile}"
chrome="${AGENT_BROWSER_CHROME:-/usr/bin/google-chrome-stable}"
export DISPLAY="${DECKIDE_DESKTOP_DISPLAY:-:99}"
export XAUTHORITY="${DECKIDE_DESKTOP_XAUTHORITY:-/run/deckide-desktop/Xauthority}"

# A Chrome started elsewhere (e.g. by an older Deck IDE) still owns the port and
# profile: leave it alone until it exits, then take over.
while curl -sf -m 2 "http://127.0.0.1:$port/json/version" >/dev/null; do sleep 5; done

mkdir -p "$profile"
exec "$chrome" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --autoplay-policy=no-user-gesture-required --in-process-gpu --disable-gpu-sandbox \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --disable-blink-features=AutomationControlled --lang=ja-JP --window-size=1280,720 \
  --no-sandbox about:blank
