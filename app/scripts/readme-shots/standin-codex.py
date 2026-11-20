#!/usr/bin/env python3
"""A stand-in `codex` for the launch film (film.sh installs it as <root>/bin/codex): no model, no account, no network.

A Codex chat coool starts runs `codex app-server` and talks JSON-RPC to it (crates/core/src/chat/codex.rs describes
the protocol). This plays one scripted turn: a couple of commands, a short message, then a command that needs the
person's approval (`item/commandExecution/requestApproval`), so the chat shows on the Needs you page as Codex's.
It writes the rollout (<HOME>/.codex/sessions/...) as the CLI does, so the chat's session lists. `--version` answers
like the CLI; anything else exits 1. HOME must be the throwaway workspace (film.sh sees to it).
"""

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

ARGS = sys.argv[1:]
if "--version" in ARGS or "-V" in ARGS:
    print("codex-cli 0.171.0")
    sys.exit(0)
if "app-server" not in ARGS:
    sys.exit(1)

HOME = Path(os.environ["HOME"])
CWD = os.getcwd()
LOCK = threading.Lock()
MODEL = "gpt-5.6"
TID = str(uuid.uuid4())
started = time.time()
lt = time.localtime()
ROLLOUT = HOME / ".codex" / "sessions" / time.strftime("%Y/%m/%d", lt) / f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', lt)}-{TID}.jsonl"
answers: dict[str, dict] = {}
answered = threading.Condition(LOCK)


def iso(t=None):
    t = time.time() if t is None else t
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"


def out(o):
    with LOCK:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", **o}, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(method, params):
    out({"method": method, "params": {"threadId": TID, **params}})


def roll(*rows):
    ROLLOUT.parent.mkdir(parents=True, exist_ok=True)
    with open(ROLLOUT, "a") as f:
        for r in rows:
            f.write(json.dumps({"timestamp": iso(), **r}, separators=(",", ":")) + "\n")


def command(turn, cmd, output, pause=0.7):
    iid = f"item_{uuid.uuid4().hex[:12]}"
    item = {"id": iid, "type": "commandExecution", "command": cmd, "cwd": CWD, "status": "inProgress"}
    notify("item/started", {"turnId": turn, "item": item})
    call = f"call_{uuid.uuid4().hex[:20]}"
    roll({"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": cmd}), "call_id": call}})
    time.sleep(pause)
    notify("item/completed", {"turnId": turn, "item": {**item, "status": "completed", "exitCode": 0, "aggregatedOutput": output}})
    roll({"type": "response_item", "payload": {"type": "function_call_output", "call_id": call, "output": json.dumps({"output": output, "metadata": {"exit_code": 0, "duration_seconds": pause}})}})


def message(turn, text):
    notify("item/completed", {"turnId": turn, "item": {"id": f"item_{uuid.uuid4().hex[:12]}", "type": "agentMessage", "text": text}})
    roll({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}},
         {"type": "event_msg", "payload": {"type": "agent_message", "message": text}})


def turn_run(turn, prompt):
    roll({"type": "turn_context", "payload": {"model": MODEL, "cwd": CWD, "approval_policy": "on-request", "sandbox_policy": {"mode": "workspace-write"}}},
         {"type": "event_msg", "payload": {"type": "task_started"}},
         {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]}},
         {"type": "event_msg", "payload": {"type": "user_message", "message": prompt}})
    with open(HOME / ".codex" / "session_index.jsonl", "a") as f:
        f.write(json.dumps({"id": TID, "thread_name": "Rebase the v3 errors branch and push it", "updated_at": iso()}) + "\n")
    t0 = time.time()
    notify("turn/started", {"turn": {"id": turn}})
    time.sleep(0.5)
    command(turn, "git fetch origin", "From origin\n * branch main -> FETCH_HEAD")
    command(turn, "git rebase origin/main", "Successfully rebased and updated refs/heads/v3-errors.")
    command(turn, "cargo test -p atlas-api errors", "test result: ok. 14 passed; 0 failed", pause=1.0)
    message(turn, "Rebased cleanly on main and the 14 error tests pass. The branch's history changed, so the push has to replace the remote branch.")
    cmd = "git push --force origin v3-errors"
    iid = f"item_{uuid.uuid4().hex[:12]}"
    item = {"id": iid, "type": "commandExecution", "command": cmd, "cwd": CWD, "status": "inProgress"}
    notify("item/started", {"turnId": turn, "item": item})
    rid = f"req_{uuid.uuid4().hex[:8]}"
    out({"id": rid, "method": "item/commandExecution/requestApproval",
         "params": {"threadId": TID, "turnId": turn, "itemId": iid, "command": cmd, "cwd": CWD, "reason": "Replace the remote v3-errors branch with the rebased one"}})
    with answered:
        while rid not in answers:
            answered.wait()
        a = answers.pop(rid)
    ok = a.get("decision") in ("accept", "acceptForSession")
    if ok:
        time.sleep(0.8)
        notify("item/completed", {"turnId": turn, "item": {**item, "status": "completed", "exitCode": 0, "aggregatedOutput": "+ 3f2a1c0...9b7e4d2 v3-errors -> v3-errors (forced update)"}})
        message(turn, "Pushed: origin/v3-errors now has the rebased history.")
    else:
        notify("item/completed", {"turnId": turn, "item": {**item, "status": "declined"}})
        message(turn, "Left the remote branch as it is; push when you're ready.")
    notify("turn/completed", {"turn": {"id": turn, "status": "completed", "durationMs": int((time.time() - t0) * 1000)}})
    roll({"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": ""}})


def main():
    for line in sys.stdin:
        try:
            v = json.loads(line)
        except ValueError:
            continue
        m, i = v.get("method"), v.get("id")
        if m is None and i is not None:
            with answered:
                answers[i] = v.get("result") or {}
                answered.notify_all()
            continue
        if i is None:
            continue  # notifications (initialized)
        p = v.get("params") or {}
        if m == "initialize":
            r = {"userAgent": "codex_cli_rs/0.171.0 (Mac OS 26.0.0; arm64)"}
        elif m == "model/list":
            r = {"data": [{"id": "gpt-5.6", "model": "gpt-5.6", "displayName": "GPT-5.6"}, {"id": "gpt-5.6-luna", "model": "gpt-5.6-luna", "displayName": "GPT-5.6 Luna"}]}
        elif m == "config/read":
            r = {"config": {}}
        elif m in ("thread/start", "thread/resume"):
            roll({"type": "session_meta", "payload": {"id": TID, "cwd": CWD, "originator": "coool-selftest", "cli_version": "0.171.0", "timestamp": iso(), "model_provider": "openai"}})
            r = {"thread": {"id": TID}, "model": MODEL, "approvalPolicy": "on-request", "sandbox": {"type": "workspaceWrite"}}
        elif m == "turn/start":
            turn = f"turn_{uuid.uuid4().hex[:8]}"
            prompt = " ".join(x.get("text", "") for x in p.get("input", []) if isinstance(x, dict))
            out({"id": i, "result": {"turn": {"id": turn}}})
            threading.Thread(target=turn_run, args=(turn, prompt), daemon=True).start()
            continue
        else:
            r = {}
        out({"id": i, "result": r})


if __name__ == "__main__":
    main()
