#!/bin/bash
# Install or update the DeckIDE shared desktop files (root). Enables the
# units but never starts or restarts them: a restart closes every open GUI app.
set -euo pipefail
here="$(dirname -- "$(realpath -e -- "${BASH_SOURCE[0]}")")"
dest=/usr/local/lib/deckide-desktop
install -d -m 0755 "$dest"
for file in session.sh browser.sh chrome.sh; do install -m 0755 "$here/$file" "$dest/$file"; done
install -m 0644 "$here/open-tab.mjs" "$dest/open-tab.mjs"
rm -rf "$dest/skel"
cp -r "$here/skel" "$dest/skel"
install -m 0644 "$here/deckide-desktop.service" "$here/deckide-browser.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable deckide-desktop.service deckide-browser.service
