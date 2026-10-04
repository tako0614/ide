#!/usr/bin/python3
"""Run only the dedicated app user's window manager and ChatGPT, then exit."""
import os
import signal
import subprocess
import time

if os.geteuid() == 0:
    raise SystemExit("Refusing to run the desktop as root.")
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
    children.append(subprocess.Popen(["/usr/bin/chatgpt", "--ozone-platform=x11"]))
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
