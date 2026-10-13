#!/bin/bash
# DeckIDE shared desktop: a TigerVNC X server running an XFCE session.
# Started by deckide-desktop.service. DeckIDE relays the private VNC Unix
# socket to signed-in browsers; nothing listens on TCP.
set -euo pipefail

display="${DECKIDE_DESKTOP_DISPLAY:-:99}"
geometry="${DECKIDE_DESKTOP_GEOMETRY:-1600x900}"
runtime="${RUNTIME_DIRECTORY:-${DECKIDE_DESKTOP_RUNTIME:-/run/deckide-desktop}}"
here="$(dirname -- "$(realpath -e -- "${BASH_SOURCE[0]}")")"
authority="$runtime/Xauthority"
socket="$runtime/vnc.sock"

umask 077
mkdir -p "$runtime/xdg"
rm -f "$authority" "$socket"

# First start: Windows-like panel, theme and launchers that work as root.
# Files the user already has are never overwritten.
if [ -d "$here/skel" ]; then
  while IFS= read -r -d '' file; do
    target="$HOME/${file#./}"
    [ -e "$target" ] || install -D -m 0644 "$here/skel/$file" "$target"
  done < <(cd "$here/skel" && find . -type f -print0)
fi
# Links open in Chrome unless the user picked something else. XFCE apps (and
# Electron apps via xdg-open → exo-open) use the preferred WebBrowser helper;
# Chrome needs --no-sandbox as root, hence our own helper.
for type in x-scheme-handler/http x-scheme-handler/https text/html; do
  grep -qs "^$type=" "$HOME/.config/mimeapps.list" ||
    xdg-mime default google-chrome.desktop "$type" 2>/dev/null || true
done
helpers="$HOME/.config/xfce4/helpers.rc"
if ! grep -qs '^WebBrowser=' "$helpers"; then
  install -D -m 0600 /dev/null "$helpers.new"
  { grep -sv '^WebBrowserDismissed=' "$helpers" || true; echo 'WebBrowser=deckide-chrome'; } > "$helpers.new"
  mv "$helpers.new" "$helpers"
fi

touch "$authority"
xauth -f "$authority" add "$display" . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

Xvnc "$display" -geometry "$geometry" -depth 24 -auth "$authority" \
  -rfbport -1 -rfbunixpath "$socket" -rfbunixmode 0600 -SecurityTypes None \
  -AlwaysShared -nolisten tcp -desktop "Deck IDE" &
xvnc=$!

export DISPLAY="$display" XAUTHORITY="$authority" XDG_RUNTIME_DIR="$runtime/xdg"
for _ in $(seq 100); do
  kill -0 "$xvnc" 2>/dev/null || { echo "Xvnc exited during startup" >&2; exit 1; }
  [ -S "$socket" ] && xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done
xset s off 2>/dev/null || true

dbus-run-session -- xfce4-session &
session=$!
# Either side ending ends the service; systemd restarts it with a clean cgroup.
wait -n "$xvnc" "$session" || true
exit 1
