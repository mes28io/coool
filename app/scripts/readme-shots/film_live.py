"""`workspace.py live --film`: the invented workspace kept live for the launch film (film.sh), with moments on cue.

Like `live` (read workspace.py first), and also watches the self-test log for `CUE <name>` lines written by the film
scenario (app/src/selftestFilm.ts), so each moment happens while a burst is recording:

  terminal        a new Claude Code session starts "in a terminal" in atlas-api (its own process, the CLI's registry
                  entry, a transcript growing step by step) and shows up in coool with no setup
  terminal-codex  the same for a Codex session (a rollout growing step by step)
  changes         atlas-api: the `terminal` session writes, edits, commits on its own branch, pushes and merges it
  overlap         a second atlas-api session edits src/config.rs, which another live session has uncommitted edits to
  needs           sessions that were working stop and wait for the person (registry `waiting`), one after another
  commit-atlas    atlas-api: a session commits its work for real (git) and pushes it to the local origin
  commit-pixel    pixelforge: a session writes a shader, commits, then merges its branch into main (all real git)

Sessions that wait for the person in the README start out working here; `needs` makes them wait. What a terminal
would show for `terminal` / `terminal-codex` is written to <root>/terminal-<name>.json (seconds after the cue, line).
"""

import json
import os
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

LOCK = threading.RLock()
# Sessions that also wait for the person once `needs` comes (besides the README's waiting ones).
FILM_WAITS = {"Make limiter budgets follow config reloads": "permission to run `cargo run -- --watch-config`"}


def run(root: Path, cues: Path, ws):
    home = root / "home"
    reg = home / ".claude" / "sessions"
    # The film plays the scene `slow` times slower than real time while it records (film.sh writes .film-slow).
    slow = float((home / ".film-slow").read_text()) if (home / ".film-slow").exists() else 1.0

    def nap(s):
        time.sleep(s * slow)

    def until(t0, at):
        time.sleep(max(0, t0 + at * slow - time.time()))

    entries = json.loads((root / "live.json").read_text())
    procs, regs = [], []
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    print(os.getpid(), flush=True)

    def title_of(e):
        if e["provider"] != "claude":
            return ""
        rows = [json.loads(line) for line in Path(e["path"]).read_text().splitlines()]
        return next((r["aiTitle"] for r in rows if r.get("type") == "ai-title"), "")

    for e in entries:
        e["title"] = title_of(e)

    def by_title(t):
        return next(e for e in entries if e["title"] == t)

    def registry(e, status, waiting=None):
        now = int(time.time() * 1000)
        e["reg"].write_text(json.dumps({"pid": e["pid"], "sessionId": e["sessionId"], "cwd": e["cwd"], "startedAt": e.get("started", now), "kind": "interactive", "entrypoint": "cli",
                                        "status": status, **({"waitingFor": waiting} if waiting else {}), "name": "", "nameSource": "derived", "updatedAt": now}))

    def spawn(e):
        s = subprocess.Popen(["sleep", "7200"])
        procs.append(s)
        e["pid"], e["reg"], e["started"] = s.pid, reg / f"{s.pid}.json", int(time.time() * 1000)
        regs.append(e["reg"])

    # ---------------------------------------------------------------- transcripts

    def append_claude(e, recs):
        """Rows appended to a Claude transcript. Only ever appended (as the CLI does): coool reads a transcript from
        where it left off, so rewriting the file (moving its title line) would cut the first new row."""
        with LOCK:
            p = Path(e["path"])
            rows_now = [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []
            parent = next((r.get("uuid") for r in reversed(rows_now) if r.get("uuid")), None)
            base = {"isSidechain": False, "userType": "external", "cwd": e["cwd"], "sessionId": e["sessionId"], "version": ws.VERSION, "gitBranch": e.get("branch", "main"), "entrypoint": "cli"}
            with open(p, "a") as f:
                for o in recs:
                    u = str(uuid.uuid4())
                    f.write(json.dumps({**base, "parentUuid": parent, **o, "uuid": u, "timestamp": ws.iso(time.time())}, separators=(",", ":")) + "\n")
                    parent = u

    def msg(e, content):
        return {"id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": e["model"], "content": content, "stop_reason": None,
                "usage": {"input_tokens": 8, "cache_read_input_tokens": 42000, "output_tokens": 140}}

    def open_ids(e):
        recs = [json.loads(line) for line in Path(e["path"]).read_text().splitlines()]
        done = {c.get("tool_use_id") for r in recs if r.get("type") == "user" and isinstance(r["message"]["content"], list) for c in r["message"]["content"]}
        return [c["id"] for r in recs if r.get("type") == "assistant" for c in r["message"]["content"] if c.get("type") == "tool_use" and c["id"] not in done]

    def result(tid, out):
        return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": out}]}, "toolUseResult": {"stdout": out, "stderr": "", "interrupted": False}}

    def claude_step(e, kind, inp, out=None):
        """Close the session's open steps, then a new step (finished when `out` is given)."""
        with LOCK:
            recs = [result(i, "ok") for i in open_ids(e)]
            if kind == "thinking":
                recs.append({"type": "assistant", "message": msg(e, [{"type": "thinking", "thinking": inp, "signature": "sig"}])})
            elif kind == "text":
                recs.append({"type": "assistant", "message": msg(e, [{"type": "text", "text": inp}])})
            else:
                tid = f"toolu_{uuid.uuid4().hex[:24]}"
                recs.append({"type": "assistant", "message": msg(e, [{"type": "tool_use", "id": tid, "name": kind, "input": inp}])})
                if out is not None:
                    recs.append(result(tid, out))
            append_claude(e, recs)

    def append_codex(e, rows):
        with LOCK:
            with open(e["path"], "a") as f:
                for r in rows:
                    f.write(json.dumps({"timestamp": ws.iso(time.time()), **r}, separators=(",", ":")) + "\n")

    def codex_call(e, cmd, out=None):
        call = f"call_{uuid.uuid4().hex[:20]}"
        rows = [{"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": cmd}), "call_id": call}}]
        if out is not None:
            rows.append({"type": "response_item", "payload": {"type": "function_call_output", "call_id": call, "output": json.dumps({"output": out, "metadata": {"exit_code": 0, "duration_seconds": 0.8}})}})
            e["tok"] = e.get("tok", 30000) + 4200
            rows.append({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": e["tok"], "cached_input_tokens": e["tok"] // 2, "output_tokens": e["tok"] // 40},
                                                                                         "last_token_usage": {"input_tokens": 3000}, "model_context_window": 272000}}})
        append_codex(e, rows)

    def git(cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=ws.git_env(home, time.time()), check=True, capture_output=True, text=True).stdout.strip()

    def terminal_log(name, t0, lines):
        p = root / f"terminal-{name}.json"
        rows = json.loads(p.read_text()) if p.exists() else []
        rows += [[round((time.time() - t0) / slow, 2), line] for line in lines]
        p.write_text(json.dumps(rows, indent=1))

    # ---------------------------------------------------------------- the moments

    def terminal():
        t0 = time.time()
        cwd = home / "code" / "atlas-api"
        sid = str(uuid.uuid4())
        path = home / ".claude" / "projects" / ws.enc(cwd) / f"{sid}.jsonl"
        e = {"provider": "claude", "sessionId": sid, "cwd": str(cwd), "path": str(path), "state": "busy", "model": "claude-opus-5-5", "branch": "rate-limit", "title": "Add request IDs to every log line", "scripted": True}
        prompt = "Give every request an id: put it on every log line and return it in an X-Request-Id header."
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"type": "ai-title", "aiTitle": e["title"], "sessionId": sid}) + "\n")
        spawn(e)
        registry(e, "busy")
        append_claude(e, [{"type": "user", "message": {"role": "user", "content": prompt}, "promptId": str(uuid.uuid4())}])
        entries.append(e)
        terminal_log("claude", t0, ["~/code/atlas-api (rate-limit) $ claude", f"> {prompt}"])
        steps = [
            (0.9, "thinking", "tower-http has a request-id layer; the span needs the id so every log line in the request carries it.", None, "Thinking…"),
            (2.2, "Read", {"file_path": "src/main.rs"}, "     1\tmod config;\n     2\tmod error;", "Read src/main.rs"),
            (3.6, "Grep", {"pattern": "tracing::", "output_mode": "files_with_matches"}, "src/main.rs\nsrc/routes/search.rs", "Grep \"tracing::\""),
            (5.0, "Write", {"file_path": "src/middleware/request_id.rs", "content": "pub fn layer() {}\n"}, "File created successfully at: src/middleware/request_id.rs", "Write src/middleware/request_id.rs"),
            (6.4, "Edit", {"file_path": "src/main.rs", "old_string": "mod routes;", "new_string": "mod routes;\nmod request_id;"}, "The file src/main.rs has been updated.", "Update src/main.rs"),
            (7.8, "Bash", {"command": "cargo test -p atlas-api request_id", "description": "Run the request id tests"}, None, "Bash cargo test -p atlas-api request_id"),
        ]
        for at, kind, inp, out, line in steps:
            until(t0, at)
            claude_step(e, kind, inp, out)
            terminal_log("claude", t0, [f"● {line}"])
        e["scripted"] = False

    def terminal_codex():
        t0 = time.time()
        cwd = home / "code" / "atlas-api"
        cid = str(uuid.uuid4())
        lt = time.localtime()
        day = home / ".codex" / "sessions" / time.strftime("%Y/%m/%d", lt)
        day.mkdir(parents=True, exist_ok=True)
        path = day / f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', lt)}-{cid}.jsonl"
        prompt = "Document the v3 error format in docs/errors.md with one example per error type."
        e = {"provider": "codex", "sessionId": cid, "cwd": str(cwd), "path": str(path), "state": "busy", "model": "gpt-5.6", "title": "Document the v3 error format"}
        with open(home / ".codex" / "session_index.jsonl", "a") as f:
            f.write(json.dumps({"id": cid, "thread_name": e["title"], "updated_at": ws.iso(time.time())}) + "\n")
        append_codex(e, [
            {"type": "session_meta", "payload": {"id": cid, "cwd": str(cwd), "originator": "codex_cli_rs", "cli_version": "0.80.0", "timestamp": ws.iso(t0), "model_provider": "openai"}},
            {"type": "turn_context", "payload": {"model": e["model"], "cwd": str(cwd), "approval_policy": "on-request", "sandbox_policy": {"mode": "workspace-write"}}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": prompt}},
        ])
        entries.append(e)
        terminal_log("codex", t0, ["~/code/atlas-api (rate-limit) $ codex", f"> {prompt}"])
        for at, cmd, out in [(1.4, "rg -n 'ApiError::' src", "src/error.rs:3\nsrc/routes/search.rs:12"), (3.0, "sed -n 1,60p src/error.rs", "pub enum ApiError {"),
                             (4.6, "apply_patch docs/errors.md", "Success. Updated docs/errors.md"), (6.2, "cargo doc --no-deps -p atlas-api", None)]:
            until(t0, at)
            codex_call(e, cmd, out)
            terminal_log("codex", t0, [f"• Ran {cmd}"])

    def overlap():
        e = by_title("Make limiter budgets follow config reloads")
        # (It may be waiting for the person since `needs`: answered in its terminal, it goes on and edits the file.)
        e["hold"] = False
        registry(e, "busy")
        claude_step(e, "Edit", {"file_path": "src/config.rs", "old_string": "pub fn load() -> Config {", "new_string": "pub fn load() -> Config {\n    // watched: see reload()"}, "The file src/config.rs has been updated.")
        nap(1.2)
        claude_step(e, "thinking", "A watch channel from the loader keeps the limiter lock-free on the hot path.")

    def needs():
        order = ["Make limiter budgets follow config reloads"]
        for e in sorted([x for x in entries if x.get("waiting")], key=lambda x: x["title"] not in order):
            e["hold"] = True
            registry(e, "waiting", e["waiting"])
            nap(1.6)

    def changes():
        """atlas-api: the session started in a terminal (`terminal`) writes a test, edits the router, commits on a
        branch of its own, pushes it and merges it into rate-limit (all real git, only its own files)."""
        e = by_title("Add request IDs to every log line")
        e["scripted"] = True
        cwd = Path(e["cwd"])
        t0 = time.time()
        (cwd / "src" / "middleware" / "request_id.rs").write_text("pub fn layer() {}\n")
        (cwd / "tests").mkdir(exist_ok=True)
        (cwd / "tests" / "request_id.rs").write_text("#[test]\nfn every_response_has_an_id() {}\n")
        until(t0, 0.5)
        claude_step(e, "Write", {"file_path": "tests/request_id.rs", "content": "#[test]\nfn every_response_has_an_id() {}\n"}, "File created successfully at: tests/request_id.rs")
        mod = cwd / "src" / "routes" / "mod.rs"
        mod.write_text(mod.read_text() + "// every route gets the request id layer\n")
        until(t0, 3.0)
        claude_step(e, "Edit", {"file_path": "src/routes/mod.rs", "old_string": "pub mod search;", "new_string": "pub mod search;\n// request ids on every route"}, "The file src/routes/mod.rs has been updated.")
        until(t0, 5.5)
        msg_ = "Request ids on every log line and response"
        claude_step(e, "Bash", {"command": f"git checkout -b request-ids && git add src/middleware/request_id.rs src/routes/mod.rs tests/request_id.rs && git commit -m '{msg_}'", "description": "Commit on a branch"})
        git(cwd, "checkout", "-q", "-b", "request-ids")
        git(cwd, "add", "src/middleware/request_id.rs", "src/routes/mod.rs", "tests/request_id.rs")
        git(cwd, "commit", "-q", "-m", msg_)
        h = git(cwd, "rev-parse", "--short", "HEAD")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], f"[request-ids {h}] {msg_}\n 3 files changed, 9 insertions(+)")])
        until(t0, 8.0)
        claude_step(e, "Bash", {"command": "git push -u origin request-ids", "description": "Push the branch"})
        git(cwd, "push", "-q", "-u", "origin", "request-ids")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], "To origin\n * [new branch]      request-ids -> request-ids")])
        until(t0, 10.5)
        claude_step(e, "Bash", {"command": "git checkout rate-limit && git merge --no-ff request-ids", "description": "Merge it into rate-limit"})
        git(cwd, "checkout", "-q", "rate-limit")
        git(cwd, "merge", "-q", "--no-ff", "request-ids", "-m", "Merge branch 'request-ids' into rate-limit")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], "Merge made by the 'ort' strategy.\n 3 files changed, 9 insertions(+)")])
        until(t0, 12.5)
        claude_step(e, "Bash", {"command": "cargo test -p atlas-api", "description": "Run all tests"})
        e["scripted"] = False

    def commit_atlas():
        e = by_title("Add rate limiting to /v2/search")
        e["scripted"] = True
        cwd = e["cwd"]
        msg_ = "Return 429 when a key is over budget"
        cmd = f"git add -A && git commit -m '{msg_}'"
        claude_step(e, "Bash", {"command": cmd, "description": "Commit the limiter"})
        nap(1.0)
        git(cwd, "add", "-A")
        git(cwd, "commit", "-q", "-m", msg_)
        h = git(cwd, "rev-parse", "--short", "HEAD")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], f"[rate-limit {h}] {msg_}\n 2 files changed, 6 insertions(+), 2 deletions(-)")])
        nap(2.5)
        claude_step(e, "Bash", {"command": "git push origin rate-limit", "description": "Push the branch"})
        nap(1.0)
        git(cwd, "push", "-q", "origin", "rate-limit")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], f"To origin\n   {h}..{h}  rate-limit -> rate-limit")])
        nap(1.5)
        claude_step(e, "Bash", {"command": "cargo test -p atlas-api", "description": "Run all tests"})
        e["scripted"] = False

    def commit_pixel():
        e = by_title("Port the shader pipeline to wgpu 25")
        e["scripted"] = True
        cwd = Path(e["cwd"])
        (cwd / "shaders" / "blur.wgsl").write_text("@fragment\nfn blur(uv: vec2<f32>) -> vec4<f32> {\n    return vec4<f32>(0.0);\n}\n")
        claude_step(e, "Write", {"file_path": "shaders/blur.wgsl", "content": "@fragment\nfn blur(...)"}, "File created successfully at: shaders/blur.wgsl")
        nap(2.0)
        msg_ = "Blur pass in WGSL with a pipeline cache"
        claude_step(e, "Bash", {"command": f"git add -A && git commit -m '{msg_}'", "description": "Commit the port"})
        nap(1.0)
        git(cwd, "add", "-A")
        git(cwd, "commit", "-q", "-m", msg_)
        h = git(cwd, "rev-parse", "--short", "HEAD")
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], f"[wgpu-port {h}] {msg_}\n 3 files changed, 14 insertions(+)")])
        nap(2.5)
        claude_step(e, "Bash", {"command": "git checkout main && git merge --no-ff wgpu-port", "description": "Merge the port into main"})
        nap(1.0)
        git(cwd, "checkout", "-q", "main")
        git(cwd, "merge", "-q", "--no-ff", "wgpu-port", "-m", "Merge branch 'wgpu-port'")
        e["branch"] = "main"
        with LOCK:
            append_claude(e, [result(open_ids(e)[-1], "Merge made by the 'ort' strategy.\n shaders/blur.wgsl | 4 ++++")])
        nap(1.5)
        claude_step(e, "Bash", {"command": "cargo run --example bloom -- --frames 60", "description": "Render the bloom example"})
        e["scripted"] = False

    moments = {"changes": changes, "terminal": terminal, "terminal-codex": terminal_codex, "overlap": overlap, "needs": needs, "commit-atlas": commit_atlas, "commit-pixel": commit_pixel}

    # ---------------------------------------------------------------- the run

    try:
        for e in entries:
            if e["provider"] != "claude":
                continue
            spawn(e)
            st = e["state"]
            if st.startswith("waiting:"):
                # Working until `needs` (the README's waiting sessions).
                e["waiting"] = st.split(":", 1)[1]
                e["state"] = "busy"
                e["hold"] = True
            if e["title"] in FILM_WAITS:
                # Working (thinking) until `needs`, then waiting for the person in atlas-api too.
                e["waiting"] = FILM_WAITS[e["title"]]
            registry(e, "busy" if e["state"] in ("busy", "think") else "idle")
        offset = cues.stat().st_size if cues.exists() else 0
        tick = 0
        while not stop.is_set():
            if cues.exists():
                with open(cues) as f:
                    f.seek(offset)
                    chunk = f.read()
                    offset = f.tell()
                for line in chunk.splitlines():
                    parts = line.split()
                    if len(parts) >= 3 and parts[1] == "CUE" and parts[2] in moments:
                        threading.Thread(target=moments[parts[2]], daemon=True).start()
            if tick % max(1, round(12 * slow)) == 0:
                for e in list(entries):
                    if e["state"] not in ("busy", "think") or e.get("scripted") or e.get("hold"):
                        continue
                    if e["provider"] == "codex":
                        os.utime(e["path"], None)
                        continue
                    if e["state"] == "think":
                        claude_step(e, "thinking", "Checking how the reload path reaches the limiter.")
                    else:
                        steps = ws.LIVE_STEPS["rate" if "atlas" in e["cwd"] else "default"]
                        kind, inp, _ = steps[(tick // max(1, round(12 * slow))) % len(steps)]
                        claude_step(e, kind, dict(inp))
            tick += 1
            stop.wait(0.2)
    finally:
        for r in regs:
            r.unlink(missing_ok=True)
        for s in procs:
            s.terminate()
            s.wait()
