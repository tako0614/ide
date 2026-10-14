#!/usr/bin/env python3
"""Disposable Codex-shaped raw TUI: deterministic queue transitions and byte log."""
import json
import os
import sys
import termios
import tty

mode, log = sys.argv[1:]
messages = ["Keep the first follow-up", "Replace the last follow-up"]
draft = ""
old = termios.tcgetattr(sys.stdin)


def render():
    lines = ["• Working (2s • esc to interrupt)", "", "• Queued follow-up inputs"]
    if messages:
        lines += ["  ↳ " + text for text in messages]
        lines += ["    ⇧← edit last queued message", ""]
    else:
        lines = lines[:2]
    if mode == "approval":
        lines += ["Would you like to run the following command?", "  1. Yes", "  2. No"]
    if mode == "question":
        lines += ["  1 question · shift+left to answer"]
    lines += ["› " + (draft or "Ask Codex to do anything"), "", "  ? for shortcuts            100% context left"]
    sys.stdout.write("\x1b[2J\x1b[H" + "\r\n".join(lines))
    sys.stdout.flush()


try:
    tty.setraw(sys.stdin)
    render()
    escape = b""
    utf8 = b""
    while True:
        byte = os.read(sys.stdin.fileno(), 1)
        if not byte:
            break
        with open(log, "a", encoding="utf-8") as output:
            output.write(json.dumps(list(byte)) + "\n")
        if escape or byte == b"\x1b":
            escape += byte
            if escape == b"\x1b[1;2D":
                if messages:
                    draft = messages.pop()
                escape = b""
            elif len(escape) > 8:
                escape = b""
        elif byte == b"\x0b":
            draft = ""
        elif byte == b"\x01":
            pass
        elif byte == b"\r":
            if draft:
                messages.append(draft)
                draft = ""
        elif byte[0] >= 32:
            utf8 += byte
            try:
                draft += utf8.decode("utf-8")
                utf8 = b""
            except UnicodeDecodeError:
                pass
        render()
finally:
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
