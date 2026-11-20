#!/usr/bin/env python3
"""Ladder A/B benchmark (APP_SPEC "Ladder"): the same tasks with Ladder off and on, one fresh repo copy per run.

    python3 -I run_ab.py --out <dir> --lead sonnet --ladder-args <args.json> [--tasks feature,fix,rename] [--arms off,on]

<args.json>: the JSON array `cargo run -p coool-core --example ladder_args` prints for the repo (so the "on" arm
gets exactly what a coool chat gets). Each run is one `claude -p` turn in stream-json mode, in a throwaway copy of
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

ALLOWED = ",".join(["Read", "Edit", "Write", "Glob", "Grep", "Agent", "TodoWrite", "Skill", "Bash(make *)", "Bash(python3 *)", "Bash(python *)", "Bash(pytest *)", "Bash(tail *)", "Bash(head *)", "Bash(wc *)", "Bash(git diff*)", "Bash(git status*)", "Bash(ls *)", "Bash(grep *)", "Bash(sed *)", "Bash(find *)", "Bash(cat *)"])


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


def run_one(task, arm, base_repo, out, lead, ladder_args, timeout):
    run_dir = os.path.join(out, f"{task}-{arm}")
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.copytree(base_repo, run_dir, symlinks=True)
    # Only this task's failing tests: the other tasks' test modules leave this copy (committed, so the diff is the run's).
    for t, mod in FAIL_AT_START.items():
        if t != task:
            os.remove(os.path.join(run_dir, mod.replace(".", "/") + ".py"))
    sh(["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qam", f"only {task}"], run_dir)
    args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--forward-subagent-text", "--model", lead, "--permission-mode", "acceptEdits", f"--allowedTools={ALLOWED}"]
    if arm == "on":
        args += ladder_args
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": TASKS[task]}})
    t0 = time.time()
    p = subprocess.Popen(args, cwd=run_dir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
                if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task") and not parent:
                    agents[b["id"]] = {"asked": (b.get("input") or {}).get("model"), "type": (b.get("input") or {}).get("subagent_type")}
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
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    base = os.path.join(out, "base")
    if not os.path.isdir(base):
        subprocess.run([sys.executable, "-I", os.path.join(HERE, "make_repo.py"), base], check=True)
        # Sanity: the task's test module fails at the start, the rest pass.
        for t, mod in FAIL_AT_START.items():
            r = sh([sys.executable, "-m", "unittest", mod, "-q"], base)
            assert r.returncode != 0, f"{t}: {mod} should fail before the task"
    ladder_args = json.load(open(a.ladder_args))
    for task in a.tasks.split(","):
        for arm in a.arms.split(","):
            r = run_one(task, arm, base, out, a.lead, ladder_args, a.timeout)
            print(json.dumps({k: r[k] for k in ("task", "arm", "wall_s", "num_turns", "lead_tokens", "delegate_tokens", "total_tokens", "tests_pass", "claim", "claim_matches")}), flush=True)
            print("  delegates:", r["delegates"], flush=True)


if __name__ == "__main__":
    main()
