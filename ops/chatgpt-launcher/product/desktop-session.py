#!/usr/bin/python3
"""Run the explicitly configured root desktop and clean up only its children."""
import os
import signal
import subprocess
import time

if (os.geteuid(), os.getegid()) != (0, 0) or os.environ.get("HOME") != "/root" \
        or os.environ.get("CODEX_HOME") != "/root/.codex" \
        or os.environ.get("CODEX_ELECTRON_USER_DATA_PATH") != "/root/.config/chatgpt-root-deckide":
    raise SystemExit("The selected root desktop identity and locations were not verified.")
os.umask(0o077)
children = []
stopping = False

def stop(_signal=None, _frame=None):
    global stopping
    stopping = True

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop)
try:
    children.append(subprocess.Popen(["/usr/bin/openbox", "--sm-disable"]))
    children.append(subprocess.Popen(["/usr/bin/chatgpt", "--no-sandbox", "--ozone-platform=x11",
        "--user-data-dir=/root/.config/chatgpt-root-deckide"]))
    while not stopping and children[1].poll() is None:
        time.sleep(0.5)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
