#!/usr/bin/python3
"""Disposable raw-PTY process for the real tmux lifecycle acceptance test."""

import json
import os
import signal
import sys
import termios
import tty
from fcntl import ioctl
from struct import unpack
from termios import TIOCGWINSZ


log_path = os.environ["DECKIDE_TMUX_PROBE_LOG"]


def record(event, **values):
    with open(log_path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, **values}, ensure_ascii=False) + "\n")
        stream.flush()


def on_resize(_signum, _frame):
    record("sigwinch")


try:
    size = unpack("HHHH", ioctl(0, TIOCGWINSZ, bytes(8)))
    rows, cols = size[0], size[1]
except OSError:
    rows, cols = 0, 0

signal.signal(signal.SIGWINCH, on_resize)
try:
    tty.setraw(0, termios.TCSANOW)
except termios.error:
    pass

record("start", pid=os.getpid(), cols=cols, rows=rows, codexHome=os.environ.get("CODEX_HOME"),
       path=os.environ.get("PATH"), testSecret=os.environ.get("DECKIDE_TEST_SECRET"))
os.write(1, "\x1b[?1049h\x1b[2J\x1b[HDECKIDE Tmux Probe 日本語 😀\r\nPROBE_READY:{}\r\n".format(os.getpid()).encode())

pending = bytearray()
while True:
    try:
        chunk = os.read(0, 4096)
    except InterruptedError:
        continue
    if not chunk:
        break
    pending.extend(chunk)
    while True:
        end = next((index for index, byte in enumerate(pending) if byte in (0x0a, 0x0d)), -1)
        if end < 0:
            break
        line = bytes(pending[:end])
        del pending[:end + 1]
        if line:
            record("input", text=line.decode("utf-8", "replace"), hex=line.hex())
            os.write(1, b"\r\nINPUT_RECEIVED:" + line + b"\r\n")
        if line == b"PROBE_EXIT":
            os.write(1, b"\x1b[?1049l\r\n")
            sys.exit(0)
