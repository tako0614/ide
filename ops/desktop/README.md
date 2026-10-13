# Shared desktop (XFCE)

The web UI's デスクトップ pane shows a full XFCE desktop. It runs as its own
systemd unit, `deckide-desktop.service`, so restarting or updating DeckIDE never
closes the GUI apps. DeckIDE only relays the desktop's VNC stream to signed-in
browsers (`/api/desktop/vnc`); nothing listens on TCP.

- X/VNC server: TigerVNC `Xvnc :99`, VNC on the Unix socket
  `/run/deckide-desktop/vnc.sock` (0600, `-rfbport -1`), X cookie in
  `/run/deckide-desktop/Xauthority`.
- Session: `xfce4-session` under its own D-Bus session. On first start
  `session.sh` copies `skel/` into `$HOME` (bottom taskbar with a Whisker start
  menu, Greybird theme, launchers that add `--no-sandbox` for Chrome, ChatGPT
  and Grok Bot as root). Existing files are never overwritten.
- Resolution: in 自動サイズ mode the browser asks the VNC server to match the
  pane (RFB SetDesktopSize). The client resized last wins, like terminals.
- One Chrome: `deckide-browser.service` (`browser.sh`) runs the shared Chrome
  on the desktop with CDP on 127.0.0.1:9222 and the agent profile
  (`~/.local/share/agent-browser/profile`). Deck IDE attaches to it
  (`AGENT_BROWSER_ATTACH_ONLY=true`), Codex/Claude Code reach it through
  chrome-devtools-mcp, and the desktop's "Google Chrome" launcher and default
  browser (`chrome.sh` → `open-tab.mjs`) open tabs in it. So people and agents
  share tabs and logins, and the browser outlives Deck IDE restarts.
- Agents on the desktop: `deckide desktop mcp` is a stdio MCP server
  (screenshot, click, drag, scroll, type, key, open) for agents without their
  own Linux computer use, e.g. Grok Bot:
  `{"mcpServers": {"deckide-desktop": {"type": "stdio", "command": "deckide", "args": ["desktop", "mcp"]}}}`.

## Install

```sh
apt-get install --no-install-recommends xfce4 xfce4-terminal xfce4-whiskermenu-plugin \
  tigervnc-standalone-server dbus-x11 greybird-gtk-theme elementary-xfce-icon-theme
ops/desktop/install.sh            # copies to /usr/local/lib/deckide-desktop, enables both units
```

Give the DeckIDE unit the desktop, so agent Chrome and GUI apps started from
terminals open there (drop-in for `deckide.service`):

```ini
[Unit]
Wants=deckide-desktop.service deckide-browser.service
After=deckide-desktop.service deckide-browser.service

[Service]
Environment=DISPLAY=:99
Environment=XAUTHORITY=/run/deckide-desktop/Xauthority
Environment=AGENT_BROWSER_ATTACH_ONLY=true
```

`install.sh` never restarts the desktop: `systemctl restart deckide-desktop`
closes every open app.
