#!/usr/bin/env python3
"""Ladder A/B benchmark (APP_SPEC "Ladder"): the same tasks with Ladder off and on, one fresh repo copy per run.

    python3 -I run_ab.py --out <dir> --lead sonnet --ladder-args <args.json> [--tasks feature,fix,rename,multi] [--arms off,on]
        [--usage <usage_print binary>] [--max-session 60] [--max-session-rise 15] [--max-weekly-rise 3]

<args.json>: what `cargo run -p coool-core --example ladder_args` prints for the repo: a JSON array of flags, or
`{"args": [...], "env": {...}}` for a full Ladder 2 setup (so the "on" arm gets exactly what a coool chat gets, the
nesting limit in its environment included).

Ladder 2 additions: the `multi` task (four independent modules, each specified by tests), Codex lanes counted (the
lead's `codex exec` calls, with the tokens Codex recorded for that run's folder in ~/.codex/sessions, read only),
helpers per tier and provider, and the plan usage before and after each run (`--usage`: the usage_print example,
which reads the CLIs' own usage surfaces without a model turn). Budget guard: no run starts while Claude's 5-hour
window is above --max-session; the benchmark stops once the 5-hour window rose by more than --max-session-rise
points or the weekly by more than --max-weekly-rise since it began. Each run is one `claude -p` turn in stream-json mode, in a throwaway copy of
the repo made by make_repo.py, with the same flags coool's chats use for output, `--model <lead>`, edits accepted
and Bash limited to the commands the tasks need (no bypass). Records per run, in <out>/results.jsonl:
wall time, the CLI's duration and turn count, tokens per model from the result's `modelUsage` (lead and delegates
apart), each delegate call (model asked for, model it answered on), whether `make test` passes afterwards, the files
changed, and the final answer with a check of its claims about tests against the real outcome.
Nothing is written outside <out>; the transcripts land in ~/.claude/projects/<the run folder> (listed at the end).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_repo import TASKS, FAIL_AT_START  # noqa: E402

ALLOWED = ",".join(["Read", "Edit", "Write", "Glob", "Grep", "Agent", "TodoWrite", "Skill", "Bash(codex exec *)", "Bash(mkdir *)", "Bash(make *)", "Bash(python3 *)", "Bash(python *)", "Bash(pytest *)", "Bash(tail *)", "Bash(head *)", "Bash(wc *)", "Bash(git diff*)", "Bash(git status*)", "Bash(ls *)", "Bash(grep *)", "Bash(sed *)", "Bash(find *)", "Bash(cat *)"])


def sh(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def tests_pass(repo):
    r = sh(["make", "test"], repo)
    tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
    return r.returncode == 0, " | ".join(tail)


def claims(text):
    t = text.lower()
    if re.search(r"(tests?|suite)[^.\n]{0,60}(fail|failing|broken)|not (all )?pass", t) and not re.search(r"(all|every)[^.\n]{0,30}pass", t):
        return "fail"
    if re.search(r"(all|\d+)[^.\n]{0,40}(tests?)[^.\n]{0,30}pass|tests? (now )?pass|passing|\bok\b \(|ran \d+ tests", t):
        return "pass"
    return "none"


LANE = re.compile(r"(^|[\s;&|(])codex\s+(exec|e)\b")
MODEL = re.compile(r"\s(?:-m|--model)[=\s]+[\"']?([\w.:-]+)")


def codex_usage(run_dir, since):
    """Tokens Codex recorded for runs in `run_dir` since `since` (its rollout files' last token_count, read only)."""
    home = os.path.expanduser("~/.codex/sessions")
    total, runs = {}, 0
    for root, _, files in os.walk(home):
        for f in files:
            p = os.path.join(root, f)
            if not f.startswith("rollout-") or os.path.getmtime(p) < since:
                continue
            cwd, model, last = None, None, None
            for line in open(p, errors="ignore"):
                try:
                    v = json.loads(line)
                except ValueError:
                    continue
                pl = v.get("payload") or {}
                if v.get("type") == "session_meta":
                    cwd = pl.get("cwd")
                if v.get("type") == "turn_context":
                    model = pl.get("model") or model
                if pl.get("type") == "token_count" and (pl.get("info") or {}).get("total_token_usage"):
                    last = pl["info"]["total_token_usage"]
            if not cwd or not os.path.realpath(cwd).startswith(os.path.realpath(run_dir)) or not last:
                continue
            runs += 1
            t = total.setdefault(model or "codex", {"input": 0, "cached": 0, "output": 0, "total": 0})
            t["input"] += last.get("input_tokens", 0)
            t["cached"] += last.get("cached_input_tokens", 0)
            t["output"] += last.get("output_tokens", 0)
            t["total"] += last.get("total_tokens", 0)
    return total, runs


def read_usage(binary):
    """Plan usage as coool reads it: {provider: {window id: percent}}; {} without --usage."""
    if not binary:
        return {}
    r = subprocess.run([binary], capture_output=True, text=True, timeout=90)
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return {}
    return {p: {w["id"]: w.get("used_percent") for w in (d.get(p) or {}).get("windows", [])} for p in ("claude", "codex")}


def run_one(task, arm, base_repo, out, lead, ladder_args, timeout, ladder_env=None, usage_bin=None):
    run_dir = os.path.join(out, f"{task}-{arm}")
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.copytree(base_repo, run_dir, symlinks=True)
    # Only this task's failing tests: the other tasks' test modules leave this copy (committed, so the diff is the run's).
    for t, mods in FAIL_AT_START.items():
        if t != task:
            for mod in mods:
                os.remove(os.path.join(run_dir, mod.replace(".", "/") + ".py"))
    sh(["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qam", f"only {task}"], run_dir)
    args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--forward-subagent-text", "--model", lead, "--permission-mode", "acceptEdits", f"--allowedTools={ALLOWED}"]
    env = dict(os.environ)
    if arm == "on":
        args += ladder_args
        env.update(ladder_env or {})
    usage_before = read_usage(usage_bin)
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": TASKS[task]}})
    t0 = time.time()
    p = subprocess.Popen(args, cwd=run_dir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    lanes = []
    p.stdin.write(msg + "\n")
    p.stdin.flush()
    result, agents, models_by_parent, final = None, {}, {}, ""
    log = open(os.path.join(out, f"{task}-{arm}.jsonl"), "w")
    deadline = t0 + timeout
    for line in p.stdout:
        log.write(line)
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if v.get("type") == "assistant":
            m = v.get("message", {})
            parent = v.get("parent_tool_use_id")
            if parent and m.get("model"):
                models_by_parent.setdefault(parent, m["model"])
            for b in m.get("content", []) or []:
                if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                    # Nested helpers (a helper's own helpers) are counted too, with their depth's parent.
                    agents[b["id"]] = {"asked": (b.get("input") or {}).get("model"), "type": (b.get("input") or {}).get("subagent_type"), "parent": parent}
                if b.get("type") == "tool_use" and b.get("name") == "Bash":
                    cmd = str((b.get("input") or {}).get("command", ""))
                    if LANE.search(cmd):
                        m = MODEL.search(cmd[LANE.search(cmd).start():])
                        lanes.append({"model": m.group(1) if m else None, "parent": parent})
                if b.get("type") == "text" and not parent:
                    final = b.get("text", "")
        if v.get("type") == "result":
            result = v
            break
        if time.time() > deadline:
            break
    wall = time.time() - t0
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.terminate()
        p.wait(timeout=10)
    log.close()
    for k, a in agents.items():
        a["answered_on"] = models_by_parent.get(k)
    ok, tail = tests_pass(run_dir)
    codex_tokens, codex_runs = codex_usage(run_dir, t0)
    usage_after = read_usage(usage_bin)
    changed = sh(["git", "diff", "--stat"], run_dir).stdout.strip().splitlines()
    usage = {}
    for m, u in ((result or {}).get("modelUsage") or {}).items():
        usage[m] = {k: u.get(k, 0) for k in ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")}
        usage[m]["total"] = sum(usage[m].values())
    lead_tokens = sum(u["total"] for m, u in usage.items() if lead in m)
    claim = claims(final or (result or {}).get("result", ""))
    rec = {
        "task": task,
        "arm": arm,
        "lead": lead,
        "wall_s": round(wall, 1),
        "duration_ms": (result or {}).get("duration_ms"),
        "num_turns": (result or {}).get("num_turns"),
        "ok": result is not None and not result.get("is_error"),
        "tokens_by_model": usage,
        "lead_tokens": lead_tokens,
        "delegate_tokens": sum(u["total"] for m, u in usage.items() if lead not in m),
        "total_tokens": sum(u["total"] for u in usage.values()),
        "delegates": list(agents.values()),
        "nested_delegates": sum(1 for a in agents.values() if a.get("parent")),
        "codex_lanes": lanes,
        "codex_tokens": codex_tokens,
        "codex_runs": codex_runs,
        "usage_before": usage_before,
        "usage_after": usage_after,
        "tests_pass": ok,
        "tests_tail": tail,
        "files_changed": changed[-1] if changed else "",
        "claim": claim,
        "claim_matches": claim == "none" or (claim == "pass") == ok,
        "final": (final or (result or {}).get("result", ""))[-1200:],
        "session_id": (result or {}).get("session_id"),
        "run_dir": run_dir,
    }
    with open(os.path.join(out, "results.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--lead", default="sonnet")
    ap.add_argument("--ladder-args", required=True)
    ap.add_argument("--tasks", default="feature,fix,rename")
    ap.add_argument("--arms", default="off,on")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--usage", default=None, help="the usage_print example binary (plan usage before/after each run)")
    ap.add_argument("--max-session", type=float, default=60)
    ap.add_argument("--max-session-rise", type=float, default=15)
    ap.add_argument("--max-weekly-rise", type=float, default=3)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    base = os.path.join(out, "base")
    if not os.path.isdir(base):
        subprocess.run([sys.executable, "-I", os.path.join(HERE, "make_repo.py"), base], check=True)
        # Sanity: the task's test module fails at the start, the rest pass.
        for t, mods in FAIL_AT_START.items():
            for mod in mods:
                r = sh([sys.executable, "-m", "unittest", mod, "-q"], base)
                assert r.returncode != 0, f"{t}: {mod} should fail before the task"
    la = json.load(open(a.ladder_args))
    ladder_args, ladder_env = (la["args"], la.get("env", {})) if isinstance(la, dict) else (la, {})
    start = read_usage(a.usage)
    print("usage at start:", json.dumps(start), flush=True)
    for task in a.tasks.split(","):
        for arm in a.arms.split(","):
            now = read_usage(a.usage)
            c0, c1 = start.get("claude", {}), now.get("claude", {})
            if a.usage and (c1.get("session") or 0) > a.max_session:
                print(f"STOP: Claude 5-hour window at {c1.get('session')}% (> {a.max_session}%)", flush=True)
                return
            if a.usage and ((c1.get("session") or 0) - (c0.get("session") or 0) > a.max_session_rise or (c1.get("weekly_all") or 0) - (c0.get("weekly_all") or 0) > a.max_weekly_rise):
                print(f"STOP: usage rose too far since the start ({json.dumps(c0)} -> {json.dumps(c1)})", flush=True)
                return
            r = run_one(task, arm, base, out, a.lead, ladder_args, a.timeout, ladder_env, a.usage)
            print(json.dumps({k: r[k] for k in ("task", "arm", "wall_s", "num_turns", "lead_tokens", "delegate_tokens", "total_tokens", "tests_pass", "claim", "claim_matches")}), flush=True)
            print("  delegates:", r["delegates"], "codex lanes:", r["codex_lanes"], "codex tokens:", r["codex_tokens"], flush=True)
            print("  usage:", json.dumps(r["usage_before"]), "->", json.dumps(r["usage_after"]), flush=True)
    print("usage at end:", json.dumps(read_usage(a.usage)), flush=True)


if __name__ == "__main__":
    main()
