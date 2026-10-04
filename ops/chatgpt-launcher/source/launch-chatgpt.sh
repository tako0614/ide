#!/bin/bash
set -euo pipefail
exec /usr/bin/python3 -I /root/dev/deckide-chatgpt-20261004/session-supervisor.py "$@"
