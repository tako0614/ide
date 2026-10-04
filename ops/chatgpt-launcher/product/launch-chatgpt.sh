#!/bin/bash
set -euo pipefail
script_root="$(dirname -- "$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")")"
exec /usr/bin/python3 -I "${script_root}/session-supervisor.py" "$@"
