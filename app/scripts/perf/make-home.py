#!/usr/bin/env python3
"""Builds a throwaway, fully synthetic HOME for the self-test's perf scenarios (docs/PERF.md).

Nothing is read from the real ~/.claude or ~/.codex. Invented projects (demo-app, sample-api, ...) under
<out>/proj, each a small git repository, some with agent worktrees; Claude Code transcripts in
<out>/home/.claude/projects and Codex rollouts in <out>/home/.codex/sessions, written in readable generated English.
Only the shape follows a real machine measured once (numbers, no content): about 120 sessions written in the last
24 h in 5 repositories with 28 agent worktrees, a quarter of the sessions with subagent transcripts, a few hundred
lines per file with a long tail (a few files of thousands of lines, a few very large tool results), hundreds of MB in
all, plus 7 small Codex rollouts.

    python3 app/scripts/perf/make-home.py --out /tmp/coool-perf-1 [--scale 1.0] [--seed 7]
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time
import uuid
from pathlib import Path

PROJECTS = ["demo-app", "sample-api", "billing-service", "docs-site", "mobile-shell"]
WORDS = ("the build now passes after we move the config loader into its own module and keep the old entry point as a thin wrapper "
         "so callers do not change while the tests cover both paths and the cache is cleared on every run which makes the "
         "numbers stable enough to compare between branches without any manual steps").split()
FILES = ["src/main.ts", "src/config.ts", "src/routes/users.ts", "src/routes/orders.ts", "src/db/schema.sql", "src/lib/cache.ts",
         "tests/config.test.ts", "tests/routes.test.ts", "README.md", "package.json", "src/ui/Button.tsx", "src/ui/Table.tsx"]
COMMANDS = ["npm test", "npm run build", "git status", "git diff --stat", "ls src", "cargo check", "pnpm lint", "rg TODO src"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=1.0, help="multiplies the number of sessions and their size")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    out = Path(a.out).resolve()
    home, proj = out / "home", out / "proj"
    if home.exists():
        sys.exit(f"{home} exists; remove {out} first")
    rnd = random.Random(a.seed)
    now = time.time()

    def sentence(n=None):
        n = n or rnd.randint(6, 18)
        w = [rnd.choice(WORDS) for _ in range(n)]
        return " ".join(w).capitalize() + "."

    def para(k=None):
        return " ".join(sentence() for _ in range(k or rnd.randint(1, 4)))

    def reply():
        parts = [para()]
        for _ in range(rnd.randint(0, 3)):
            r = rnd.random()
            if r < 0.3:
                parts.append("\n".join(f"- {sentence(rnd.randint(4, 9))}" for _ in range(rnd.randint(2, 5))))
            elif r < 0.5:
                parts.append("```ts\n" + "\n".join(f"const v{i} = load('{rnd.choice(FILES)}');" for i in range(rnd.randint(2, 8))) + "\n```")
            elif r < 0.6:
                parts.append(f"## {sentence(4)[:-1]}")
            else:
                parts.append(para())
        return "\n\n".join(parts)

    def blob():
        # Tool output sizes: mostly small, a long tail (a big file read, a large log or an image).
        r = rnd.random()
        n = rnd.randint(200, 5000) if r < 0.96 else rnd.randint(50_000, 200_000) if r < 0.995 else rnd.randint(1_000_000, 3_000_000)
        base = para(6) + "\n"
        return (base * (n // len(base) + 1))[:n]

    def iso(t):
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"

    # Folders: each project's root, its worktrees, a subfolder or two.
    folders = []
    for i, p in enumerate(PROJECTS):
        root = proj / p
        folders.append((root, root, None))
        for w in range(int([10, 8, 5, 3, 2][i] * min(1.0, a.scale) + 0.5)):
            folders.append((root / ".claude" / "worktrees" / f"agent-{rnd.getrandbits(32):08x}", root, "wt"))
        for sub in ["src", "tests"][: rnd.randint(0, 2)]:
            folders.append((root / sub, root, "sub"))

    def transcript(path: Path, cwd: Path, sid: str, lines_target: int, end: float, agent: str | None = None):
        path.parent.mkdir(parents=True, exist_ok=True)
        t = end - rnd.uniform(0.2, 1.0) * min(24 * 3600, lines_target * 6)
        parent = None
        out = []
        n = 0
        tid = 0
        prompts = 0
        while n < lines_target:
            def rec(o):
                nonlocal parent, n
                u = str(uuid.uuid4())
                o = {"parentUuid": parent, "isSidechain": agent is not None, "userType": "external", "cwd": str(cwd), "sessionId": sid,
                     "version": "2.9.0", "gitBranch": "main", **({"agentId": agent} if agent else {}), **o, "uuid": u, "timestamp": iso(t)}
                parent = u
                out.append(json.dumps(o, separators=(",", ":")))
                n += 1
            prompts += 1
            rec({"type": "user", "message": {"role": "user", "content": sentence(rnd.randint(8, 30))}})
            for _ in range(rnd.randint(1, 12)):
                t += rnd.uniform(1, 20)
                tid += 1
                tu = f"toolu_{sid[:8]}{tid:05d}"
                kind = rnd.random()
                if kind < 0.35:
                    name, inp = "Read", {"file_path": str(cwd / rnd.choice(FILES))}
                elif kind < 0.6:
                    name, inp = "Bash", {"command": rnd.choice(COMMANDS), "description": sentence(5)}
                elif kind < 0.8:
                    f = str(cwd / rnd.choice(FILES))
                    name, inp = "Edit", {"file_path": f, "old_string": sentence(6), "new_string": sentence(7)}
                elif kind < 0.9:
                    name, inp = "Grep", {"pattern": rnd.choice(WORDS), "path": str(cwd)}
                else:
                    name, inp = "Write", {"file_path": str(cwd / rnd.choice(FILES)), "content": para(3)}
                content = [{"type": "tool_use", "id": tu, "name": name, "input": inp}]
                if rnd.random() < 0.3:
                    content.insert(0, {"type": "thinking", "thinking": para(2), "signature": "sig"})
                rec({"type": "assistant", "message": {"id": f"msg_{sid[:6]}{tid}", "type": "message", "role": "assistant", "model": rnd.choice(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
                                                       "content": content, "stop_reason": "tool_use",
                                                       "usage": {"input_tokens": rnd.randint(5, 400), "cache_creation_input_tokens": rnd.randint(0, 3000), "cache_read_input_tokens": rnd.randint(10_000, 120_000), "output_tokens": rnd.randint(20, 900)}}})
                t += rnd.uniform(0.1, 8)
                rec({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu, "content": blob()}]}, "toolUseResult": {"stdout": "", "stderr": "", "interrupted": False}})
            t += rnd.uniform(2, 30)
            rec({"type": "assistant", "message": {"id": f"msg_{sid[:6]}r{prompts}", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [{"type": "text", "text": reply()}],
                                                   "stop_reason": "end_turn", "usage": {"input_tokens": 50, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 60_000, "output_tokens": rnd.randint(50, 1500)}}})
            rec({"type": "system", "subtype": "turn_duration", "durationMs": rnd.randint(5_000, 600_000)})
            t += rnd.uniform(10, 600)
            if t > end:
                t = end
        if agent is None:
            out.append(json.dumps({"type": "ai-title", "aiTitle": sentence(4)[:-1], "sessionId": sid}))
        path.write_text("\n".join(out) + "\n")
        os.utime(path, (end, end))
        return n

    claude = home / ".claude" / "projects"
    sessions = int(123 * a.scale)
    total = files = 0
    for i in range(sessions):
        cwd, _, _ = rnd.choice(folders)
        enc = str(cwd).replace("/", "-").replace(".", "-")
        sid = str(uuid.uuid4())
        lines = int(min(6000, rnd.lognormvariate(5.2, 1.0)) * a.scale) + 8
        end = now - rnd.uniform(0, 24 * 3600) * (rnd.random() ** 2)
        total += transcript(claude / enc / f"{sid}.jsonl", cwd, sid, lines, end)
        files += 1
        if rnd.random() < 0.25:
            for _ in range(rnd.randint(1, 2)):
                ag = f"a{rnd.getrandbits(40):010x}"
                d = claude / enc / sid / "subagents"
                total += transcript(d / f"agent-{ag}.jsonl", cwd, sid, rnd.randint(20, 400), end - rnd.uniform(0, 600), ag)
                (d / f"agent-{ag}.meta.json").write_text(json.dumps({"agentType": rnd.choice(["Explore", "general-purpose", "Plan"]), "description": sentence(4)[:-1]}))
                files += 1
    (home / ".claude" / "sessions").mkdir(parents=True, exist_ok=True)

    # Codex: a few small rollouts in today's folder.
    day = home / ".codex" / "sessions" / time.strftime("%Y/%m/%d", time.localtime(now))
    day.mkdir(parents=True, exist_ok=True)
    for i in range(int(7 * a.scale) or 1):
        cwd = rnd.choice(folders)[0]
        cid = str(uuid.uuid4())
        t = now - rnd.uniform(600, 20 * 3600)
        rows = [{"timestamp": iso(t), "type": "session_meta", "payload": {"id": cid, "cwd": str(cwd), "originator": "codex_cli_rs", "cli_version": "0.80.0", "timestamp": iso(t)}}]
        inp = outp = 0
        for k in range(rnd.randint(5, 40)):
            t += rnd.uniform(5, 60)
            rows.append({"timestamp": iso(t), "type": "turn_context", "payload": {"model": "gpt-5.6", "cwd": str(cwd)}})
            rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "task_started"}})
            rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": sentence(12)}]}})
            for j in range(rnd.randint(1, 4)):
                call = f"call_{k}_{j}"
                rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["bash", "-lc", rnd.choice(COMMANDS)]}), "call_id": call}})
                rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "function_call_output", "call_id": call, "output": para(3)}})
            inp += rnd.randint(2000, 20000)
            outp += rnd.randint(50, 900)
            rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": reply()}]}})
            rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": inp, "cached_input_tokens": inp // 2, "output_tokens": outp}, "last_token_usage": {"input_tokens": 3000}}}})
            rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "task_complete"}})
        p = day / f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', time.localtime(t))}-{cid}.jsonl"
        p.write_text("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n")
        os.utime(p, (t, t))

    # The folders: git repositories with a little history (a merge for the commit trail), worktrees, subfolders.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "perf", "GIT_AUTHOR_EMAIL": "perf@example.com", "GIT_COMMITTER_NAME": "perf", "GIT_COMMITTER_EMAIL": "perf@example.com"}

    def git(d, *args):
        subprocess.run(["git", *args], cwd=d, env=env, check=True, capture_output=True)

    for p in PROJECTS:
        d = proj / p
        d.mkdir(parents=True, exist_ok=True)
        git(d, "init", "-q", "-b", "main")
        (d / ".gitignore").write_text(".claude/\n")
        for i in range(14):
            (d / f"f{i % 5}.txt").write_text(f"{i}\n")
            git(d, "add", "-A")
            git(d, "commit", "-q", "-m", sentence(5)[:-1])
            if i == 8:
                git(d, "checkout", "-q", "-b", "side")
                (d / "side.txt").write_text("side\n")
                git(d, "add", "-A")
                git(d, "commit", "-q", "-m", "Side work")
                git(d, "checkout", "-q", "main")
                git(d, "merge", "-q", "--no-ff", "side", "-m", "Merge branch 'side'")
        (d / "notes.txt").write_text("uncommitted\n")
    for f, root, kind in folders:
        if kind == "wt":
            f.parent.mkdir(parents=True, exist_ok=True)
            git(root, "worktree", "add", "-q", "-b", f"wt-{f.name}", str(f))
        else:
            f.mkdir(parents=True, exist_ok=True)
    mb = sum(p.stat().st_size for p in home.rglob("*.jsonl")) / 1e6
    print(f"{files} claude transcripts ({sessions} sessions), {total} lines, {mb:.0f} MB; {len(folders)} folders in {len(PROJECTS)} repositories -> {out}")


if __name__ == "__main__":
    main()
