#!/usr/bin/env python3
"""A heavy, fully invented case for the Changes view's perf (docs/PERF.md "Changes view"): one long Claude Code
session that edited many files, in a throwaway HOME, and (`live`) a working terminal session writing to it.

    python3 -I app/scripts/perf/make-changes-home.py make --out /tmp/coool-chperf-1 [--turns 300] [--files 60]
    python3 -I app/scripts/perf/make-changes-home.py live --out /tmp/coool-chperf-1 [--rate 4] [--edit-every 20] [--secs 900]

`make`: <out>/proj/heavy-app, a git repository of `--files` generated source files (most 80-900 lines, three of
4000-9000 lines), committed; then a transcript of `--turns` turns, each a prompt, a few Reads and Bash calls with
filler output, 1-5 Edit / Write calls on the files (applied on disk as the CLI does, with `originalFile`), a reply; one
subagent transcript that edits a few of the same files. Everything is generated English and code-shaped filler.

`live`: the session marked busy in the registry (a `sleep` stands in for the CLI's pid) and transcript lines appended at
`--rate` lines a second: tool calls and results, text, and every `--edit-every` lines a real Edit of one of the files.
Prints its pid first; on SIGTERM it stops its sleep and removes the registry entry (the transcript keeps what it wrote).
"""

import argparse
import json
import os
import random
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

WORDS = ("the loader keeps a cache of parsed entries and clears it when the config changes so tests see fresh values "
         "while the router maps each request to a handler that validates input and returns a typed response").split()
SID = "5e55c0de-0000-4000-8000-00000000c0de"
AGENT = "a0c0ffee00"


def cwd_of(out: Path) -> Path:
    return out / "proj" / "heavy-app"


def enc(p: Path) -> str:
    return str(p).replace("/", "-").replace(".", "-")


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"


class Gen:
    def __init__(self, rnd, cwd, sid, agent=None):
        self.rnd, self.cwd, self.sid, self.agent = rnd, cwd, sid, agent
        self.parent = None
        self.tid = 0

    def sentence(self, n=None):
        n = n or self.rnd.randint(6, 16)
        return " ".join(self.rnd.choice(WORDS) for _ in range(n)).capitalize() + "."

    def rec(self, o, t):
        u = str(uuid.uuid4())
        o = {"parentUuid": self.parent, "isSidechain": self.agent is not None, "userType": "external", "cwd": str(self.cwd), "sessionId": self.sid,
             "version": "2.9.0", "gitBranch": "main", **({"agentId": self.agent} if self.agent else {}), **o, "uuid": u, "timestamp": iso(t)}
        self.parent = u
        return json.dumps(o, separators=(",", ":"))

    def prompt(self, t):
        return [self.rec({"type": "user", "message": {"role": "user", "content": self.sentence(self.rnd.randint(8, 24))}}, t)]

    def tool(self, t, name, inp, result, tur=None):
        self.tid += 1
        tu = f"toolu_{self.sid[:6]}{self.agent or ''}{self.tid:05d}"
        a = self.rec({"type": "assistant", "message": {"id": f"msg_{tu}", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [{"type": "tool_use", "id": tu, "name": name, "input": inp}],
                                                         "stop_reason": "tool_use", "usage": {"input_tokens": 20, "cache_read_input_tokens": 80_000, "output_tokens": 300}}}, t)
        u = self.rec({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu, "content": result}]}, **({"toolUseResult": tur} if tur else {})}, t + 0.5)
        return [a, u]

    def filler(self, t):
        r = self.rnd.random()
        if r < 0.5:
            return self.tool(t, "Bash", {"command": self.rnd.choice(["npm test", "pnpm lint", "git status", "cargo check"])}, (self.sentence(12) + "\n") * self.rnd.randint(5, 60), {"stdout": "", "stderr": "", "interrupted": False})
        return self.tool(t, "Read", {"file_path": str(self.cwd / "src" / "mod0.ts")}, (self.sentence(10) + "\n") * self.rnd.randint(10, 120))

    def text(self, t):
        return [self.rec({"type": "assistant", "message": {"id": f"msg_txt{self.tid}{self.rnd.getrandbits(16)}", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                                                           "content": [{"type": "text", "text": " ".join(self.sentence() for _ in range(3))}], "stop_reason": "end_turn",
                                                           "usage": {"input_tokens": 20, "cache_read_input_tokens": 80_000, "output_tokens": 300}}}, t)]

    def edit(self, t, path: Path):
        """A real Edit of `path` on disk (a few lines changed somewhere), recorded as Claude Code does."""
        before = path.read_text()
        lines = before.split("\n")
        i = self.rnd.randrange(0, max(1, len(lines) - 4))
        old = "\n".join(lines[i:i + 2])
        if not old.strip() or before.count(old) != 1:
            old = lines[i] if before.count(lines[i]) == 1 and lines[i] else None
        if old is None:
            return self.write(t, path, before + f"// appended {self.tid}: {self.sentence(5)}\n")
        new = old + f"\n  // {self.sentence(6)}" + (f"\n  const v{self.tid} = load('{self.rnd.choice(WORDS)}');" if self.rnd.random() < 0.5 else "")
        after = before.replace(old, new, 1)
        path.write_text(after)
        return self.tool(t, "Edit", {"file_path": str(path), "old_string": old, "new_string": new, "replace_all": False}, "The file has been updated.",
                         {"filePath": str(path), "oldString": old, "newString": new, "originalFile": before, "structuredPatch": [], "userModified": False, "replaceAll": False})

    def write(self, t, path: Path, content: str):
        before = path.read_text() if path.exists() else None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        tur = {"type": "create", "filePath": str(path), "content": content, "originalFile": None} if before is None else {"type": "update", "filePath": str(path), "content": content, "originalFile": before}
        return self.tool(t, "Write", {"file_path": str(path), "content": content}, "File written.", tur)


def source(rnd, n, name):
    out = [f"// {name}: generated for the Changes perf case", "import { load } from './lib';", ""]
    while len(out) < n:
        f = f"fn{len(out)}"
        out.append(f"export function {f}(input: Record<string, unknown>): number {{")
        for _ in range(rnd.randint(3, 12)):
            out.append(f"  const {rnd.choice(WORDS)}{len(out)} = load('{rnd.choice(WORDS)}') ?? {rnd.randint(0, 999)};")
        out.append(f"  return {len(out)};")
        out.append("}")
        out.append("")
    return "\n".join(out[:n]) + "\n"


def make(a):
    out = Path(a.out).resolve()
    cwd = cwd_of(out)
    home = out / "home"
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} exists; remove it first")
    rnd = random.Random(a.seed)
    cwd.mkdir(parents=True)
    files = []
    for i in range(a.files):
        big = i in (7, 23, 41)
        n = rnd.randint(4000, 9000) if big else rnd.randint(80, 900)
        p = cwd / ("src/big" if big else f"src/m{i % 6}") / f"mod{i}.ts"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(source(rnd, n, p.name))
        files.append(p)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "perf", "GIT_AUTHOR_EMAIL": "perf@example.com", "GIT_COMMITTER_NAME": "perf", "GIT_COMMITTER_EMAIL": "perf@example.com"}
    git = lambda *x: subprocess.run(["git", *x], cwd=cwd, env=env, check=True, capture_output=True)
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-q", "-m", "Start")
    proj = home / ".claude" / "projects" / enc(cwd)
    proj.mkdir(parents=True)
    (home / ".claude" / "sessions").mkdir(parents=True)
    g = Gen(rnd, cwd, SID)
    lines = []
    t = time.time() - a.turns * 90
    # Weighted: a third of the files take most edits (as a real session circles back to the same modules).
    hot = files[: len(files) // 3]
    edits = 0
    sub_turn = a.turns // 2
    for turn in range(a.turns):
        lines += g.prompt(t)
        for _ in range(rnd.randint(1, 4)):
            t += rnd.uniform(1, 6)
            lines += g.filler(t)
        for _ in range(rnd.randint(1, 5)):
            t += rnd.uniform(1, 6)
            p = rnd.choice(hot) if rnd.random() < 0.7 else rnd.choice(files)
            if rnd.random() < 0.01:
                p = cwd / "src" / "new" / f"added{turn}.ts"
                lines += g.write(t, p, source(rnd, rnd.randint(20, 200), p.name))
                files.append(p)
            else:
                lines += g.edit(t, p)
            edits += 1
        if turn == sub_turn:
            # A subagent that edits a few of the same files.
            sg = Gen(rnd, cwd, SID, AGENT)
            sub = []
            st = t
            sub.append(sg.rec({"type": "user", "message": {"role": "user", "content": "Tidy the helpers"}}, st))
            for _ in range(12):
                st += 2
                sub += sg.edit(st, rnd.choice(hot))
                edits += 1
            d = proj / SID / "subagents"
            d.mkdir(parents=True)
            (d / f"agent-{AGENT}.jsonl").write_text("\n".join(sub) + "\n")
            (d / f"agent-{AGENT}.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "Tidy the helpers"}))
            lines += g.tool(t, "Task", {"description": "Tidy the helpers", "prompt": "Tidy the helpers", "subagent_type": "general-purpose"}, "Done.")
            t = st
        t += rnd.uniform(2, 10)
        lines += g.text(t)
        lines.append(json.dumps({"type": "system", "subtype": "turn_duration", "durationMs": rnd.randint(5_000, 200_000), "timestamp": iso(t), "sessionId": SID}))
        t += rnd.uniform(5, 60)
    lines.append(json.dumps({"type": "ai-title", "aiTitle": "Heavy changes session", "sessionId": SID}))
    tp = proj / f"{SID}.jsonl"
    tp.write_text("\n".join(lines) + "\n")
    state = {"seed": a.seed, "tid": g.tid, "parent": g.parent}
    (out / "changes-perf.json").write_text(json.dumps(state))
    mb = tp.stat().st_size / 1e6
    touched = len({json.loads(l).get("toolUseResult", {}).get("filePath") for l in lines if '"originalFile"' in l} - {None})
    print(f"{a.turns} turns, {edits} edits on {touched} files ({len(files)} in the repository), transcript {len(lines)} lines {mb:.1f} MB -> {tp}")


def live(a):
    out = Path(a.out).resolve()
    cwd = cwd_of(out)
    home = out / "home"
    st = json.loads((out / "changes-perf.json").read_text())
    rnd = random.Random(st["seed"] + int(time.time()))
    tp = home / ".claude" / "projects" / enc(cwd) / f"{SID}.jsonl"
    files = sorted(p for p in (cwd / "src").rglob("*.ts") if "big" not in p.parts)[:20]
    g = Gen(rnd, cwd, SID)
    g.tid = st["tid"] + 100_000 + rnd.randint(0, 10_000)
    g.parent = st["parent"]
    print(os.getpid(), flush=True)
    s = subprocess.Popen(["sleep", str(int(a.secs) + 60)])
    reg = home / ".claude" / "sessions" / f"{s.pid}.json"
    now = int(time.time() * 1000)
    reg.write_text(json.dumps({"pid": s.pid, "sessionId": SID, "cwd": str(cwd), "startedAt": now, "kind": "interactive", "entrypoint": "cli", "status": "busy", "name": "", "nameSource": "derived", "updatedAt": now}))
    stop = False

    def on_term(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    end = time.time() + a.secs
    n = 0
    try:
        with open(tp, "a", encoding="utf-8") as f:
            f.write("\n".join(g.prompt(time.time())) + "\n")
            while not stop and time.time() < end:
                n += 1
                t = time.time()
                if a.edit_every and n % a.edit_every == 0:
                    rows = g.edit(t, rnd.choice(files))
                elif n % 3 == 0:
                    rows = g.text(t)
                else:
                    rows = g.filler(t)
                # One line per tick: the call now, its result on the next tick.
                for r in rows:
                    f.write(r + "\n")
                    f.flush()
                    time.sleep(1.0 / a.rate)
    finally:
        reg.unlink(missing_ok=True)
        s.terminate()
        s.wait()


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    m = sp.add_parser("make")
    m.add_argument("--out", required=True)
    m.add_argument("--turns", type=int, default=300)
    m.add_argument("--files", type=int, default=60)
    m.add_argument("--seed", type=int, default=11)
    lv = sp.add_parser("live")
    lv.add_argument("--out", required=True)
    lv.add_argument("--rate", type=float, default=4.0)
    lv.add_argument("--edit-every", type=int, default=20)
    lv.add_argument("--secs", type=float, default=900)
    a = ap.parse_args()
    make(a) if a.cmd == "make" else live(a)


if __name__ == "__main__":
    sys.exit(main())
