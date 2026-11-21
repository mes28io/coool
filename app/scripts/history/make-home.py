#!/usr/bin/env python3
"""A throwaway HOME full of invented past sessions of both CLIs, for History's end-to-end run (history-e2e.sh).

Nothing is read from the real ~/.claude or ~/.codex. <out>/home/.claude/projects holds Claude Code transcripts and
<out>/home/.codex/sessions Codex rollouts (plus session_index.jsonl names and a few archived threads), across twelve
invented projects under <out>/proj and two years of dates (file times set to each session's last event). Where they
ran varies as on a real Mac: terminal, VS Code, the desktop apps, scripts (`sdk-cli`, `codex exec`).

Sessions the self-test looks for by a word only they contain:
- "zebracorn": a long Claude Code terminal session from 200 days ago in proj/atlas (400 turns, so its timeline has
  earlier history), with edits to files that exist;
- "quokkafold": a Claude session in proj/old-site, a folder that doesn't exist (deleted);
- "pangolink": a Codex session in proj/archive/billing (gone), while proj/billing exists (moved);
- "narwhalize": a Claude session compacted twice;
- "yakfluff": the person's session in proj/relay from half an hour ago and the nine sessions it started (lanes, a
  Ladder helper), linked in coool's own-sessions file (<out>/proj/.coool-selftest-own-sessions.json);
- "marmotide": an old person's session in proj/ledger and three old `claude -p` runs with the same word.

    python3 -I app/scripts/history/make-home.py --out /private/tmp/coool-history-e2e [--sessions 3000] [--seed 11]
"""

import argparse
import json
import os
import random
import sys
import time
import uuid
from pathlib import Path

PROJECTS = ["atlas", "billing", "docs-site", "mobile-shell", "notes", "pixel-lab", "relay", "search-api", "infra", "ledger", "blog", "kiosk"]
TASKS = ["fix the login redirect loop", "add rate limiting to uploads", "speed up the cold start", "port the parser to the new tokenizer",
         "write release notes for the next version", "find why the export drops the last row", "move invoice PDFs to a queue",
         "clean up warnings in the build", "add a CSV importer", "rename the billing tables", "bisect the memory leak",
         "hook up push notifications", "make search highlight the matched words", "add keyboard shortcuts to the toolbar"]
WORDS = ("the build passes after we move the config loader into its own module and keep the old entry point as a thin "
         "wrapper so callers do not change while tests cover both paths and the cache is cleared on every run").split()
FILES = ["src/main.ts", "src/config.ts", "src/routes/users.ts", "src/lib/cache.ts", "tests/config.test.ts", "README.md"]
DAY = 86400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--sessions", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    out = Path(os.path.realpath(a.out))
    home, proj = out / "home", out / "proj"
    if home.exists():
        sys.exit(f"{home} exists; remove {out} first")
    rnd = random.Random(a.seed)
    now = time.time()
    for p in PROJECTS:
        (proj / p / "src").mkdir(parents=True, exist_ok=True)
        for f in FILES:
            (proj / p / f).parent.mkdir(parents=True, exist_ok=True)
            (proj / p / f).write_text(f"// {f} of {p}\n")

    def sentence(n=None):
        return " ".join(rnd.choice(WORDS) for _ in range(n or rnd.randint(6, 16))).capitalize() + "."

    def iso(t):
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"

    def claude(cwd: Path, end: float, turns: int, entry: str, first: str, sid=None, compact=0, title=True):
        sid = sid or str(uuid.uuid4())
        t = end - turns * rnd.uniform(60, 400)
        rows = []
        parent = None

        def rec(o):
            nonlocal parent
            u = str(uuid.uuid4())
            rows.append({"parentUuid": parent, "isSidechain": False, "userType": "external", "cwd": str(cwd), "sessionId": sid, "version": "2.9.0",
                         "entrypoint": entry, **o, "uuid": u, "timestamp": iso(t)})
            parent = u

        for k in range(turns):
            prompt = first if k == 0 else f"{rnd.choice(TASKS).capitalize()}, step {k + 1}. {sentence()}"
            rec({"type": "user", "message": {"role": "user", "content": prompt}})
            for j in range(rnd.randint(1, 3)):
                t += rnd.uniform(2, 20)
                tid = f"toolu_{uuid.uuid4().hex[:20]}"
                if rnd.random() < 0.35:
                    f = str(cwd / rnd.choice(FILES))
                    use = {"type": "tool_use", "id": tid, "name": "Edit", "input": {"file_path": f, "old_string": "x", "new_string": "y"}}
                else:
                    use = {"type": "tool_use", "id": tid, "name": "Read", "input": {"file_path": str(cwd / rnd.choice(FILES))}}
                rec({"type": "assistant", "message": {"id": f"msg_{uuid.uuid4().hex[:16]}", "role": "assistant", "model": rnd.choice(["claude-opus-5-5", "claude-sonnet-5-5"]),
                                                       "content": [use], "usage": {"input_tokens": 10, "cache_read_input_tokens": 20000, "output_tokens": 80}}})
                t += rnd.uniform(0.2, 4)
                rec({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": sentence(40)}]}})
            t += rnd.uniform(2, 30)
            rec({"type": "assistant", "message": {"id": f"msg_{uuid.uuid4().hex[:16]}", "role": "assistant", "model": "claude-opus-5-5",
                                                   "content": [{"type": "text", "text": " ".join(sentence() for _ in range(rnd.randint(1, 4)))}],
                                                   "usage": {"input_tokens": 10, "cache_read_input_tokens": 30000, "output_tokens": 200}}})
            rec({"type": "system", "subtype": "turn_duration", "durationMs": 20000})
            if compact and k in (turns // 3, 2 * turns // 3):
                rec({"type": "user", "isCompactSummary": True, "message": {"role": "user", "content": "Summary:\n1. Primary Request and Intent:\n   " + first}})
            t += rnd.uniform(30, 600)
            t = min(t, end)
        lines = [json.dumps(r, separators=(",", ":")) for r in rows]
        if title:
            lines.append(json.dumps({"type": "ai-title", "aiTitle": first.split(".")[0][:50].capitalize(), "sessionId": sid}))
        d = home / ".claude" / "projects" / str(cwd).replace("/", "-").replace(".", "-")
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{sid}.jsonl"
        p.write_text("\n".join(lines) + "\n")
        os.utime(p, (end, end))
        return sid

    names = []

    def codex(cwd: Path, end: float, turns: int, originator: str, source: str, first: str, archived=False):
        cid = str(uuid.uuid4())
        t = end - turns * rnd.uniform(60, 300)
        lt = time.localtime(t)
        rows = [{"timestamp": iso(t), "type": "session_meta", "payload": {"id": cid, "cwd": str(cwd), "originator": originator, "source": source, "cli_version": "0.171.0", "timestamp": iso(t)}}]
        for k in range(turns):
            rows.append({"timestamp": iso(t), "type": "turn_context", "payload": {"model": rnd.choice(["gpt-5.6", "gpt-5.6-luna"]), "cwd": str(cwd)}})
            rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": first if k == 0 else sentence()}]}})
            if rnd.random() < 0.4:
                patch = f"*** Begin Patch\n*** Update File: {rnd.choice(FILES)}\n@@\n-x\n+y\n*** End Patch"
                rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "function_call", "name": "apply_patch", "arguments": json.dumps({"input": patch}), "call_id": f"c{k}"}})
            t += rnd.uniform(5, 60)
            rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": sentence()}]}})
            rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "task_complete"}})
            t = min(t + rnd.uniform(30, 600), end)
        d = home / ".codex" / ("archived_sessions" if archived else Path("sessions") / time.strftime("%Y/%m/%d", lt))
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', lt)}-{cid}.jsonl"
        p.write_text("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n")
        os.utime(p, (end, end))
        if rnd.random() < 0.5:
            names.append({"id": cid, "thread_name": first.split(".")[0][:48].capitalize(), "updated_at": iso(end)})
        return cid

    claude_entries = ["cli"] * 6 + ["claude-vscode"] * 2 + ["claude-desktop"] + ["sdk-cli"]
    codex_kinds = [("codex_cli_rs", "cli")] * 6 + [("codex_vscode", "vscode")] * 2 + [("Codex Desktop", "vscode")] + [("codex_exec", "exec")]
    for i in range(a.sessions):
        p = rnd.choice(PROJECTS)
        cwd = proj / p / ("src" if rnd.random() < 0.15 else "")
        cwd = Path(str(cwd).rstrip("/"))
        end = now - (rnd.random() ** 2.0) * 730 * DAY - rnd.uniform(0, 3600)
        first = f"{rnd.choice(TASKS).capitalize()} in {p}. {sentence()}"
        turns = max(1, int(rnd.lognormvariate(1.2, 0.8)))
        if rnd.random() < 0.7:
            claude(cwd, end, min(turns, 40), rnd.choice(claude_entries), first)
        else:
            o, s = rnd.choice(codex_kinds)
            codex(cwd, end, min(turns, 30), o, s, first, archived=rnd.random() < 0.03)

    # The ones the self-test finds by their words.
    claude(proj / "atlas", now - 200 * DAY, 400, "cli", "Plan the zebracorn migration for the atlas schema. " + sentence())
    claude(proj / "old-site", now - 90 * DAY, 6, "cli", "Rebuild the quokkafold gallery page. " + sentence())
    (proj / "billing").mkdir(parents=True, exist_ok=True)
    codex(proj / "archive" / "billing", now - 120 * DAY, 5, "codex_cli_rs", "cli", "Reconcile the pangolink invoices. " + sentence())
    codex(proj / "billing", now - 10 * DAY, 3, "codex_cli_rs", "cli", "Tidy the billing README. " + sentence())
    claude(proj / "relay", now - 40 * DAY, 30, "cli", "Narwhalize the relay queue retries. " + sentence(), compact=2)

    # Sessions agents started (History lists them only on asking; the sidebar nests the ones whose session it lists):
    # - "yakfluff": the person's terminal session in proj/relay from half an hour ago (LEAD), and what it started:
    #   six `claude -p` lanes, two `codex exec` lanes and a Ladder helper chat (a coool chat), linked to it in coool's
    #   own-sessions file as coool would have seen them live;
    # - three recent runs nobody's session is known for (a script's `claude -p`, `codex exec`): hidden in the sidebar;
    # - "marmotide": an old person's session, and three old agents' runs with the same word (⌘K finds one).
    sdk = {"promptSource": "sdk", "turnOrigin": "sdk"}
    human = {"promptSource": "typed", "turnOrigin": "human", "origin": {"kind": "human"}}

    def claude_as(cwd, end, turns, entry, first, extra):
        sid = claude(cwd, end, turns, entry, first)
        p = home / ".claude" / "projects" / str(cwd).replace("/", "-").replace(".", "-") / f"{sid}.jsonl"
        rows = [json.loads(l) for l in p.read_text().splitlines()]
        for r in rows:
            if r.get("type") == "user" and isinstance(r.get("message", {}).get("content"), str):
                r.update(extra)
        p.write_text("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n")
        os.utime(p, (end, end))
        return sid

    relay = proj / "relay"
    lead = claude_as(relay, now - 1800, 4, "cli", "Lead the yakfluff refactor of the relay queue. " + sentence(), human)
    parents = []
    for k in range(6):
        sid = claude_as(relay, now - 1500 + k * 60, 2, "sdk-cli", f"Yakfluff lane {k + 1}: read the brief and carry it out. " + sentence(), sdk)
        parents.append(("claude", sid))
    for k in range(2):
        parents.append(("codex", codex(relay, now - 1100 + k * 60, 2, "codex_exec", "exec", f"Yakfluff exec lane {k + 1}. " + sentence())))
    helper = claude_as(relay, now - 900, 3, "sdk-cli", "Yakfluff helper: write the migration tests. " + sentence(), sdk)
    parents.append(("claude", helper))
    claude_as(relay, now - 1300, 1, "sdk-cli", "Nightly lint of the relay repo. " + sentence(), sdk)
    claude_as(relay, now - 1250, 1, "sdk-cli", "Nightly dependency check of the relay repo. " + sentence(), sdk)
    codex(relay, now - 1200, 1, "codex_exec", "exec", "Nightly changelog draft for relay. " + sentence())
    claude_as(proj / "ledger", now - 90 * DAY, 5, "cli", "Plan the marmotide ledger export. " + sentence(), human)
    for k in range(3):
        claude_as(proj / "ledger", now - 90 * DAY + (k + 1) * 600, 1, "sdk-cli", f"Marmotide export check {k + 1}. " + sentence(), sdk)
    own = {"v": 1, "sessions": [{"provider": "claude", "id": helper, "seen": int(now)}],
           "parents": [{"provider": p, "id": i, "parent": lead, "seen": int(now)} for p, i in parents], "typed": []}
    (proj / ".coool-selftest-own-sessions.json").write_text(json.dumps(own))

    (home / ".codex").mkdir(parents=True, exist_ok=True)
    (home / ".codex" / "session_index.jsonl").write_text("".join(json.dumps(n) + "\n" for n in names))
    (home / ".claude" / "sessions").mkdir(parents=True, exist_ok=True)
    n_claude = sum(1 for _ in (home / ".claude" / "projects").rglob("*.jsonl"))
    n_codex = sum(1 for _ in (home / ".codex").rglob("rollout-*.jsonl"))
    size = sum(f.stat().st_size for f in home.rglob("*.jsonl"))
    print(f"{n_claude} Claude transcripts, {n_codex} Codex rollouts, {size / 1e6:.0f} MB in {home}")


if __name__ == "__main__":
    main()
