#!/bin/bash
# "Google Chrome" on the desktop and the default web browser: open pages as tabs
# of the shared Chrome (deckide-browser.service), so people and agents use one
# browser with the same tabs and logins. Falls back to a separate Chrome if the
# shared one cannot be reached.
port="${AGENT_BROWSER_CDP_PORT:-9222}"
up() { curl -sf -m 2 "http://127.0.0.1:$port/json/version" >/dev/null; }
if ! up; then
  systemctl start deckide-browser.service 2>/dev/null || true
  for _ in $(seq 60); do up && break; sleep 0.25; done
fi
if up; then
  exec /usr/local/bin/node "$(dirname -- "$(realpath -e -- "${BASH_SOURCE[0]}")")/open-tab.mjs" "$port" "$@"
fi
exec /usr/bin/google-chrome-stable --no-sandbox "$@"
