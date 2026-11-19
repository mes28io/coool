#!/usr/bin/env python3
"""Live sessions for the perf scenarios: K Claude Code sessions that look busy and keep writing.

Inside a HOME made by make-home.py: for each of K sessions, starts a `sleep` (its pid stands in for the CLI's),
writes a registry entry (`.claude/sessions/<pid>.json`, status busy) and appends the lines of one of the copied
transcripts to a new transcript at --rate lines per second, for --secs. On exit (or SIGTERM) it stops its own
sleeps and removes its registry entries and transcripts. Prints its pid first.

    python3 app/scripts/perf/replay.py --out /tmp/coool-perf-1 --sessions 4 --rate 3 --secs 900
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--sessions", type=int, default=4)
    ap.add_argument("--rate", type=float, default=3.0)
    ap.add_argument("--secs", type=float, default=900)
    a = ap.parse_args()
    home = Path(a.out).resolve() / "home"
    projects = home / ".claude" / "projects"
    reg = home / ".claude" / "sessions"
    print(os.getpid(), flush=True)
    # Sources: the biggest copied top-level transcripts, one per project folder where possible.
    srcs = sorted((p for p in projects.glob("*/*.jsonl")), key=lambda p: -p.stat().st_size)
    picked, seen = [], set()
    for p in srcs:
        if p.parent not in seen:
            picked.append(p)
            seen.add(p.parent)
        if len(picked) == a.sessions:
            break
    sleeps, regs, outs = [], [], []
    stop = False

    def on_term(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    try:
        for p in picked:
            lines = p.read_text(encoding="utf-8").splitlines()
            cwd = next((json.loads(l).get("cwd") for l in lines if '"cwd"' in l), None)
            sid = str(uuid.uuid4())
            s = subprocess.Popen(["sleep", str(int(a.secs) + 60)])
            sleeps.append(s)
            now = int(time.time() * 1000)
            r = reg / f"{s.pid}.json"
            r.write_text(json.dumps({"pid": s.pid, "sessionId": sid, "cwd": cwd, "startedAt": now, "kind": "interactive", "entrypoint": "cli", "status": "busy", "name": "", "nameSource": "derived", "updatedAt": now}))
            regs.append(r)
            f = open(p.parent / f"{sid}.jsonl", "a", encoding="utf-8")
            outs.append((f, lines, sid))
        end = time.time() + a.secs
        i = 0
        while not stop and time.time() < end:
            for f, lines, sid in outs:
                # From the top again at the end: a run of any length keeps every session writing (a long scenario
                # used to measure its last minutes with the sessions busy but silent).
                src = lines[i % len(lines)]
                line = src.replace(src[src.find('"sessionId":"') + 13:].split('"', 1)[0], sid, 1) if '"sessionId":"' in src else src
                f.write(line + "\n")
                f.flush()
            i += 1
            time.sleep(1.0 / a.rate)
    finally:
        # Leave the HOME as it was, so runs before and after a change see the same sessions.
        for f, _, _ in outs:
            f.close()
            Path(f.name).unlink(missing_ok=True)
        for r in regs:
            r.unlink(missing_ok=True)
        for s in sleeps:
            s.terminate()
            s.wait()


if __name__ == "__main__":
    sys.exit(main())
