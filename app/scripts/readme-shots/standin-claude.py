#!/usr/bin/env python3
"""A stand-in `claude` for the README screenshots: no model, no account, no network.

run.sh installs it as <root>/bin/claude, first on the PATH of a coool run whose HOME is the invented workspace, so a
chat coool starts talks to this script through the real stream-json protocol (the same one Claude Code speaks with
`--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`): coool's backend, chat
parser and UI all run as they do for the real CLI. It plays two scripted turns, chosen by the prompt:

- "invoices" (the prompt mentions March): looks around, edits src/format.ts for real, then asks to run a Bash command
  through `can_use_tool` and waits for the answer (the permission card, the Needs you page).
- "fan-out" (the prompt mentions agents): splits an audit over three subagents whose steps stream in, and keeps them
  running for a few minutes (a chat with live subagents).

With <HOME>/.standin-queue present it runs user lines through a queue as Claude Code does (lifecycle frames, notes
taken in mid-turn, background tasks whose notifications get turns of their own, interrupt, cancel_async_message;
see "queue mode" below), for the steering e2e (app/scripts/steer-e2e.sh).

Like the CLI it writes the transcript (<HOME>/.claude/projects/<folder>/<session>.jsonl) and a registry entry
(<HOME>/.claude/sessions/<pid>.json), so the session lists as it would. Anything else (other prompts, `--help`, other
control requests) gets a short, plausible answer. HOME must be the throwaway workspace: run.sh checks that.
"""

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

HOME = Path(os.environ["HOME"])
# The film (film.sh) plays the scene slower than real time while it records: every pause here stretches with it.
_SLOW = float((HOME / ".film-slow").read_text()) if (HOME / ".film-slow").exists() else 1.0
_sleep = time.sleep
time.sleep = lambda s: _sleep(s * _SLOW)
CWD = Path(os.getcwd())
ARGS = sys.argv[1:]
MODELS = [
    {"value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)", "description": "Opus 5.5 · Best for everyday, complex tasks"},
    {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5", "description": "For complex work and everyday tasks"},
    {"value": "sonnet", "resolvedModel": "claude-sonnet-5-5", "displayName": "Sonnet 5.5", "description": "Most efficient for simpler tasks"},
    {"value": "haiku", "resolvedModel": "claude-haiku-5-5", "displayName": "Haiku 5.5", "description": "Fastest for quick answers"},
]
COMMANDS = [
    {"name": "review", "description": "Review the current diff", "argumentHint": "", "builtin": True},
    {"name": "compact", "description": "Clear the conversation but keep a summary in context", "argumentHint": "", "builtin": True},
    {"name": "init", "description": "Initialize a CLAUDE.md file with codebase documentation", "argumentHint": "", "builtin": True},
]

if "--help" in ARGS or "-h" in ARGS:
    print("Usage: claude [options] [prompt]\n\nOptions:\n  --model <model>\n  --permission-mode <mode>\n  --allow-dangerously-skip-permissions  Allow bypassing permission checks\n")
    sys.exit(0)
if "--version" in ARGS or "-v" in ARGS:
    print("2.9.0 (Claude Code)")
    sys.exit(0)
if "--input-format" not in ARGS:
    # Anything else coool might run (usage probes and the like): nothing to say.
    sys.exit(1)


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS and ARGS.index(name) + 1 < len(ARGS) else default


# coool removes the MCP config file once the CLI has started: read it now, as the CLI does.
_mcp = next((a.split("=", 1)[1] for a in ARGS if a.startswith("--mcp-config=")), None)
MCP_CONFIG = json.loads(Path(_mcp).read_text()) if _mcp and Path(_mcp).exists() else None
SID = arg("--session-id") or arg("--resume") or str(uuid.uuid4())
ALIAS = arg("--model", "opus")
MODEL = next((m["resolvedModel"] for m in MODELS if m["value"] == ALIAS), ALIAS if ALIAS.startswith("claude-") else "claude-opus-5-5")
MODE = arg("--permission-mode", "default")
LOCK = threading.Lock()
TRANSCRIPT = HOME / ".claude" / "projects" / str(CWD).replace("/", "-").replace(".", "-") / f"{SID}.jsonl"
REGISTRY = HOME / ".claude" / "sessions" / f"{os.getpid()}.json"
STARTED = int(time.time() * 1000)
answers: dict[str, dict] = {}
answered = threading.Condition(LOCK)
parent_uuid = None
title_written = False
# The transcript as `claude -p` writes it (no `turn_duration` record), from a "cut an agent" turn on.
PRINT_LIKE = False


def iso(t=None):
    t = time.time() if t is None else t
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"


def out(o):
    with LOCK:
        sys.stdout.write(json.dumps(o, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def record(o, sidechain=False, agent=None):
    """A transcript line, as the CLI writes it."""
    global parent_uuid
    u = str(uuid.uuid4())
    row = {"parentUuid": parent_uuid, "isSidechain": sidechain, "userType": "external", "cwd": str(CWD), "sessionId": SID, "version": "2.9.0", "gitBranch": "main",
           "entrypoint": "sdk-cli", **({"agentId": agent} if agent else {}), **o, "uuid": u, "timestamp": iso()}
    if not sidechain:
        parent_uuid = u
    TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
    with open(TRANSCRIPT, "a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


def registry(status, waiting=None):
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps({"pid": os.getpid(), "sessionId": SID, "cwd": str(CWD), "startedAt": STARTED, "kind": "interactive", "entrypoint": "sdk-cli",
                                    "status": status, **({"waitingFor": waiting} if waiting else {}), "name": "", "nameSource": "derived", "updatedAt": int(time.time() * 1000)}))


def usage(ctx=21_000, out_t=180):
    return {"input_tokens": 6, "cache_creation_input_tokens": 900, "cache_read_input_tokens": ctx, "output_tokens": out_t}


def assistant(content, parent=None, ctx=21_000, agent=None):
    msg = {"model": MODEL, "id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "content": content, "stop_reason": None, "usage": usage(ctx)}
    out({"type": "assistant", "message": msg, "parent_tool_use_id": parent, "session_id": SID, "uuid": str(uuid.uuid4())})
    record({"type": "assistant", "message": msg}, sidechain=parent is not None, agent=agent)


def tool_result(tid, text, parent=None, agent=None, error=False):
    m = {"role": "user", "content": [{"tool_use_id": tid, "type": "tool_result", "content": text, "is_error": error}]}
    out({"type": "user", "message": m, "parent_tool_use_id": parent, "session_id": SID, "uuid": str(uuid.uuid4()), "timestamp": iso()})
    record({"type": "user", "message": m, "toolUseResult": {"stdout": text, "stderr": "", "interrupted": False}}, sidechain=parent is not None, agent=agent)


def tool(name, inp, result, parent=None, agent=None, pause=0.6, ctx=21_000):
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp}], parent=parent, ctx=ctx, agent=agent)
    time.sleep(pause)
    if result is not None:
        tool_result(tid, result, parent=parent, agent=agent)
    return tid


def text(t, ctx=21_000):
    assistant([{"type": "text", "text": t}], ctx=ctx)


def thinking(t):
    assistant([{"type": "thinking", "thinking": t, "signature": "sig"}])


def status_line():
    out({"type": "system", "subtype": "status", "status": "requesting", "session_id": SID, "uuid": str(uuid.uuid4())})


# Claude Platform (the `platform` self-test): like the real CLI, an `apiKeyHelper` from `--settings` is run through a
# shell and its stdout is the key (coool's own executable in helper mode); without one, an ANTHROPIC_API_KEY in the
# environment is the key source (the real CLI prefers the env variable, which is why coool removes it). Each result
# reports what the process has cost so far. Only the last four characters of the key and counts are ever said back.
def _settings():
    for i, a in enumerate(ARGS):
        raw = a[len("--settings="):] if a.startswith("--settings=") else (ARGS[i + 1] if a == "--settings" and i + 1 < len(ARGS) else None)
        if raw is not None:
            try:
                return json.loads(raw)
            except ValueError:
                return {}
    return {}


def _api_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"], "ANTHROPIC_API_KEY"
    helper = _settings().get("apiKeyHelper")
    if helper:
        import subprocess
        r = subprocess.run(helper, shell=True, capture_output=True, text=True, timeout=60)
        k = r.stdout.strip()
        return (k, "apiKeyHelper") if r.returncode == 0 and k else ("", f"apiKeyHelper failed (exit {r.returncode})")
    return "", "none"


API_KEY, KEY_SOURCE = _api_key()
OTHER_AUTH = [v for v in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX") if os.environ.get(v)]
COST = [0.0]


def command_env():
    """What a command the agent runs sees (the Bash tool inherits the CLI's environment): how many ANTHROPIC_API_KEY
    variables, and how many variables hold the key. COOOL_PLATFORM_TEST_KEY is the debug build's stand-in for the
    Keychain (the helper reads the invented key from it), so it is left out of the count."""
    import subprocess
    lines = subprocess.run("env", shell=True, capture_output=True, text=True).stdout.splitlines()
    named = sum(1 for l in lines if l.startswith("ANTHROPIC_API_KEY="))
    holds = sum(1 for l in lines if API_KEY and API_KEY in l and not l.startswith("COOOL_PLATFORM_TEST_KEY="))
    return f"a command's env: ANTHROPIC_API_KEY×{named}, the key×{holds}"


def auth_words():
    key = f"api key ••{API_KEY[-4:]}" if API_KEY else "no api key"
    return f"{key}, other logins: {', '.join(OTHER_AUTH) if OTHER_AUTH else 'none'}, key source: {KEY_SOURCE}, {command_env()}"


def init_line():
    out({"type": "system", "subtype": "init", "cwd": str(CWD), "session_id": SID, "tools": ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Write", "WebFetch", "TodoWrite"],
         "mcp_servers": [], "model": MODEL, "permissionMode": MODE, "slash_commands": [c["name"] for c in COMMANDS], "apiKeySource": KEY_SOURCE if API_KEY else "none", "claude_code_version": "2.9.0",
         "output_style": "default", "agents": ["general-purpose", "Explore", "Plan"], "skills": [], "plugins": [], "uuid": str(uuid.uuid4())})


def result(start, turns=1):
    if API_KEY:
        COST[0] += 0.0125 * turns
    out({"type": "result", "subtype": "success", "is_error": False, "duration_ms": int((time.time() - start) * 1000), "duration_api_ms": int((time.time() - start) * 800), "num_turns": turns,
         "result": "", "stop_reason": "end_turn", "session_id": SID, "total_cost_usd": round(COST[0], 6), "usage": usage(), "uuid": str(uuid.uuid4())})
    if PRINT_LIKE:
        record({"type": "system", "subtype": "stop_hook_summary", "hookCount": 0, "hookInfos": [], "hookErrors": [], "preventedContinuation": False, "stopReason": "", "hasOutput": False, "level": "suggestion"})
    else:
        record({"type": "system", "subtype": "turn_duration", "durationMs": int((time.time() - start) * 1000), "isMeta": False})
    registry("idle")


def ask(tool_name, inp, tid, description):
    rid = str(uuid.uuid4())
    registry("waiting", f"permission to run `{inp.get('command', tool_name)}`" if tool_name == "Bash" else f"permission to use {tool_name}")
    out({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": tool_name, "display_name": tool_name, "input": inp, "description": description,
                                                                    "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test:*"}], "behavior": "allow", "destination": "localSettings"}],
                                                                    "tool_use_id": tid}})
    with answered:
        while rid not in answers:
            answered.wait()
        return answers.pop(rid)


def title(t):
    global title_written
    if not title_written:
        with open(TRANSCRIPT, "a") as f:
            f.write(json.dumps({"type": "ai-title", "aiTitle": t, "sessionId": SID}) + "\n")
        title_written = True


# ------------------------------------------------------------------------------------------------ the turns

def invoices_turn(prompt, start):
    p = lambda f: str(CWD / f)
    time.sleep(1.5)
    thinking("Invoices issued in March show February. The month formatting is the first suspect: Date#getMonth is zero-based.")
    time.sleep(0.4)
    tool("Grep", {"pattern": "getMonth\\(", "output_mode": "content", "-n": True}, "src/format.ts:2:  const month = d.getMonth();", pause=0.5)
    tool("Read", {"file_path": p("src/format.ts")}, (CWD / "src/format.ts").read_text(), pause=0.5)
    tool("Read", {"file_path": p("src/invoice.ts")}, (CWD / "src/invoice.ts").read_text(), pause=0.5)
    f = CWD / "src/format.ts"
    old, new = "const month = d.getMonth();", "const month = d.getMonth() + 1; // getMonth() is zero-based"
    # (acceptEdits: the CLI applies edits without asking.)
    f.write_text(f.read_text().replace(old, new))
    tool("Edit", {"file_path": p("src/format.ts"), "old_string": old, "new_string": new, "replace_all": False}, f"The file {p('src/format.ts')} has been updated.", pause=0.5)
    text("Found it: `formatPeriod` used `getMonth()` as is, so March (2) came out as `2026-02`. Fixed the off-by-one month; running the tests to confirm and clearing the stale build cache first.")
    title(prompt if prompt.endswith("?") else "Fix the March month in the invoice export")
    cmd = "rm -rf node_modules/.cache dist && npm test"
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant([{"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd, "description": "Clear the build cache and run the unit tests"}}], ctx=24_000)
    a = ask("Bash", {"command": cmd, "description": "Clear the build cache and run the unit tests"}, tid, "Clear the build cache and run the unit tests")
    if a.get("behavior") == "allow":
        registry("busy")
        tool_result(tid, " ✓ tests/format.test.ts (4 tests)\n Test Files  1 passed (1)\n      Tests  4 passed (4)")
        text("All 4 tests pass. March invoices now read `2026-03`.")
    else:
        registry("busy")
        tool_result(tid, "The user denied this tool call.", error=True)
        text("Understood, I won't run that. The fix is in `src/format.ts`; run `npm test` when you're ready.")
    result(start)


def fanout_turn(prompt, start):
    p = lambda f: str(CWD / f)
    thinking("Three route groups: search, billing and admin. They don't share files, so one agent each can work in parallel.")
    time.sleep(0.4)
    text("I'll split the audit by route group and run the three in parallel.")
    title("Audit the /v2 routes for missing auth checks")
    groups = [
        ("Audit the search routes", "Explore", [("Grep", {"pattern": "route\\(\"/v2/search", "output_mode": "content"}, "src/routes/search.rs:4"), ("Read", {"file_path": p("src/routes/search.rs")}, "pub async fn search"), ("Read", {"file_path": p("src/middleware/auth.rs")}, "pub fn check")]),
        ("Audit the billing routes", "general-purpose", [("Glob", {"pattern": "src/routes/billing/**/*.rs"}, "src/routes/billing/invoices.rs\nsrc/routes/billing/refunds.rs"), ("Read", {"file_path": p("src/routes/billing/refunds.rs")}, "pub async fn refund"), ("Bash", {"command": "cargo test -p atlas-api billing", "description": "Run the billing tests"}, "test result: ok. 12 passed")]),
        ("Audit the admin routes", "general-purpose", [("Grep", {"pattern": "require_admin", "output_mode": "files_with_matches"}, "src/routes/admin.rs"), ("Read", {"file_path": p("src/routes/admin.rs")}, "pub async fn purge"), ("Edit", {"file_path": p("src/routes/admin.rs"), "old_string": "pub async fn purge(", "new_string": "#[require_admin]\npub async fn purge("}, "The file has been updated.")]),
    ]
    agents = []
    for desc, kind, steps in groups:
        tid = f"toolu_{uuid.uuid4().hex[:24]}"
        agent = f"a{uuid.uuid4().hex[:16]}"
        assistant([{"type": "tool_use", "id": tid, "name": "Agent", "input": {"description": desc, "prompt": f"{desc} under src/routes for handlers that skip the auth layer. Report each one with its file and line, and fix the obvious ones.", "subagent_type": kind}}], ctx=26_000)
        out({"type": "system", "subtype": "task_started", "task_id": agent, "tool_use_id": tid, "description": desc, "subagent_type": kind, "is_backgrounded": False, "task_type": "local_agent", "uuid": str(uuid.uuid4()), "session_id": SID})
        agents.append((tid, agent, desc, steps))
        time.sleep(0.3)
    # The agents' steps arrive interleaved, then they keep working.
    for k in range(3):
        for tid, agent, desc, steps in agents:
            if k < len(steps):
                name, inp, res = steps[k]
                last = k == len(steps) - 1 and desc != "Audit the search routes"
                tool(name, inp, None if last else res, parent=tid, agent=agent, pause=0.3, ctx=[12_400, 17_900, 9_800][agents.index((tid, agent, desc, steps))] + 2_600 * k)
                time.sleep(0.5)
    # Then they keep working until coool stops the chat (the screenshot is taken meanwhile).
    time.sleep(600)
    result(start)


# ------------------------------------------------------------------------------------------------ device tools
# The film (film.sh): a chat that drives coool's own panels through the `coool-device` MCP server coool hands every
# chat (--mcp-config), as the real CLI would: the tools act for real and their results stream into the chat.

class Mcp:
    def __init__(self):
        if not MCP_CONFIG:
            raise RuntimeError("no --mcp-config")
        srv = MCP_CONFIG["mcpServers"]["coool-device"]
        import subprocess
        self.p = subprocess.Popen([srv["command"], *srv.get("args", [])], env={**os.environ, **srv.get("env", {})}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.n = 0
        self.call_raw("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2.9.0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def call_raw(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("the MCP server closed")
            v = json.loads(line)
            if v.get("id") == self.n:
                return v.get("result") or {"content": [{"type": "text", "text": json.dumps(v.get("error"))}], "isError": True}

    def tool(self, name, args):
        """A step in the chat (mcp__coool-device__<name>) whose result is the tool's real answer."""
        tid = f"toolu_{uuid.uuid4().hex[:24]}"
        assistant([{"type": "tool_use", "id": tid, "name": f"mcp__coool-device__{name}", "input": args}], ctx=30_000)
        r = self.call_raw("tools/call", {"name": name, "arguments": args})
        txt = "\n".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
        tool_result(tid, txt, error=bool(r.get("isError")))
        return txt

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=3)
        except Exception:
            self.p.kill()


def element(page, role, name, exact=False):
    """The id of the first `[id] role "name"` line in an observe result (browser or iPhone)."""
    import re
    for m in re.finditer(r'^\s*\[([^\]]+)\]\s+(\S+)\s+"([^"]*)"', page, re.M):
        if (role is None or m.group(2) == role) and (m.group(3) == name if exact else name.lower() in m.group(3).lower()):
            return m.group(1)
    return None


def browser_turn(prompt, start):
    import re
    url = re.search(r"https?://\S+", prompt).group(0).rstrip(".,)")
    thinking("The console runs locally; I can create the key in the Browser panel and read back what the page says.")
    time.sleep(0.6)
    text("I'll do it in the Browser panel.")
    m = Mcp()
    try:
        look = lambda txt: txt if element(txt, None, "") else m.tool("browser_observe", {})
        page = look(m.tool("browser_navigate", {"url": url}))
        time.sleep(0.8)
        page = look(m.tool("browser_click", {"id": int(element(page, "button", "Create key"))}))
        time.sleep(0.6)
        page = look(m.tool("browser_type", {"id": int(element(page, "textbox", "Key name") or element(page, "textbox", "")), "text": "ci-runner"}))
        time.sleep(0.6)
        page = look(m.tool("browser_select", {"id": int(element(page, "combobox", "Budget") or element(page, "combobox", "")), "value": "60 / min"}))
        time.sleep(0.6)
        page = m.tool("browser_click", {"id": int(element(page, "button", "Create", exact=True))})
        title("Create a CI key in the local console")
        time.sleep(0.6)
        text('Done: the console shows **Key "ci-runner" created with a budget of 60 / min.** It is first in the list.')
    finally:
        m.close()
    result(start)


def iphone_turn(prompt, start):
    thinking("Settings > General > About shows the iOS version; three taps from the home screen.")
    time.sleep(0.6)
    text("Opening Settings on the iPhone.")
    m = Mcp()
    try:
        scr = m.tool("app", {"action": "launch", "bundle_id": "com.apple.Preferences"})
        time.sleep(0.8)
        title("Read the iOS version on the simulator")
        scr = m.tool("wait_for", {"idle": True, "timeout_ms": 4000})
        for label in ["General", "About"]:
            target = element(scr, None, label, exact=True)
            if target is None:
                scr = m.tool("wait_for", {"text": label, "timeout_ms": 5000})
                target = element(scr, None, label, exact=True) or element(scr, None, label)
            scr = m.tool("tap", {"target": target})
            time.sleep(0.8)
            scr = m.tool("wait_for", {"idle": True, "timeout_ms": 4000})
        import re
        v = re.search(r'"iOS Version"\s+value=([^\s(]+)', scr) or re.search(r"iOS Version\D+([\d.]+)", scr)
        text(f"iOS version: {v.group(1) if v else 'shown on the About screen'}")
    finally:
        m.close()
    result(start)


def mac_turn(prompt, start):
    thinking("TextEdit is enough for plain release notes; I'll write them in the sandbox Mac and read them back.")
    time.sleep(0.6)
    text("Writing the notes in TextEdit on the Mac.")
    m = Mcp()
    try:
        scr = m.tool("mac_app", {"action": "launch", "app": "TextEdit"})
        title("Draft the atlas-api 0.5 release notes")
        time.sleep(0.6)
        if "textarea" not in scr and "text area" not in scr.lower():
            scr = m.tool("mac_press", {"key": "n", "modifiers": ["command"]})
            time.sleep(0.6)
        for line in ["atlas-api 0.5", "", "- Rate limits per API key on /v2, budgets from config", "- 429 responses carry Retry-After", "- Every request has an id, in the logs and the X-Request-Id header"]:
            m.tool("mac_type", {"text": line + "\n", "replace": False, "observe": False})
            time.sleep(0.4)
        m.tool("mac_observe", {})
        text("The release notes are in a new TextEdit document on the Mac: three changes under **atlas-api 0.5**.")
    finally:
        m.close()
    result(start)


def edit_file(rel, old=None, new=None, content=None):
    """An Edit (old -> new) or a Write (content), applied for real and recorded with its `toolUseResult` as the CLI
    writes it (originalFile is the file before), for the Changes view's self-test."""
    f = CWD / rel
    before = f.read_text() if f.exists() else None
    if content is None:
        after = before.replace(old, new, 1)
        name, inp = "Edit", {"file_path": str(f), "old_string": old, "new_string": new, "replace_all": False}
        res = {"filePath": str(f), "oldString": old, "newString": new, "originalFile": before, "structuredPatch": [], "userModified": False, "replaceAll": False}
    else:
        after = content
        name, inp = "Write", {"file_path": str(f), "content": content}
        res = {"type": "create" if before is None else "update", "filePath": str(f), "content": content, "structuredPatch": [], "originalFile": before}
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp}])
    time.sleep(0.3)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(after)
    m = {"role": "user", "content": [{"tool_use_id": tid, "type": "tool_result", "content": f"The file {f} has been updated."}]}
    out({"type": "user", "message": m, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4()), "timestamp": iso(), "tool_use_result": res})
    record({"type": "user", "message": m, "toolUseResult": res})


def changes_turn(prompt, start):
    """Edits two files (one in two far-apart places) and creates a third: the Changes view's self-test."""
    time.sleep(0.5)
    edit_file("a.txt", "line 2\n", "line two\n")
    edit_file("a.txt", "line 30\n", "line thirty\n")
    text("Renamed lines 2 and 30 in a.txt.")
    edit_file("b.txt", "beta\n", "BETA\n")
    edit_file("notes/new.txt", content="a brand new file\n")
    text("Done: a.txt and b.txt edited, notes/new.txt created.")
    title("Edit a.txt and b.txt, add notes/new.txt")
    result(start)


def long_reply_turn(prompt, start):
    """Ten tool uses, one file edited, then a long reply: the composer-typing self-test (app/src/selftestTyping.ts)."""
    time.sleep(0.4)
    for i in range(9):
        tool("Read", {"file_path": str(CWD / "a.txt")}, f"line {i}\n", pause=0.15)
    edit_file("a.txt", "line 3\n", "line three\n")
    paras = []
    for i in range(14):
        paras.append(f"**Step {i + 1}.** The environment variable is read once at start, then cached; the loader walks the folders in order and "
                     f"keeps the first match, so a value set in the shell wins over the one in the file. Item {i + 1} of the list checks that.")
        if i % 4 == 2:
            paras.append("```sh\nexport COOOL_EXAMPLE=1\nnpm test -- --watch=false\n```")
    text("\n\n".join(paras))
    title("A long reply")
    result(start, turns=10)


def settings_turn(prompt, start):
    """Changes its own MCP config and asks for a restart, as agents do (the `restart` self-test, selftestRestart.ts)."""
    tool("Read", {"file_path": str(CWD / ".mcp.json")}, "{}\n", pause=0.2)
    text(f"I added the `notes` server to `.mcp.json` (stand-in pid {os.getpid()}, session {SID}). Claude Code reads MCP servers only at start, so restart Claude Code, then come back and type continue.")
    title("Add the notes MCP server")
    result(start, turns=2)


def billing_turn(prompt, start):
    """Says how it is logged in (the `platform` self-test): a boolean and the key's last four, never the key."""
    text(f"Billing check (stand-in pid {os.getpid()}, session {SID}): {auth_words()}.")
    result(start)


def continue_turn(prompt, start):
    """After a restart: says which process and session it is (the `restart` self-test checks both)."""
    text(f"Continuing after the restart (stand-in pid {os.getpid()}, session {SID}): the notes server is connected.")
    result(start)


def slow_demo_turn(prompt, start):
    """A step that takes a while (a running turn for `/restart` to ask about)."""
    tool("Bash", {"command": "sleep 40", "description": "Wait a while"}, "", pause=40)
    text("Waited.")
    result(start, turns=2)


def slow_turn(prompt, start):
    """A turn still running a while later ("slowly <seconds>"): a chat mid-turn across a restart (keepalive-idle-e2e.sh)."""
    words = prompt.split()
    secs = next((float(w) for w in words[words.index("slowly") + 1:][:1] if w.replace(".", "", 1).isdigit()), 60.0) if "slowly" in words else 60.0
    tool("Bash", {"command": f"sleep {secs:g}", "description": "Wait"}, "", pause=secs)
    text("Done, slowly.")
    result(start)


def cut_agent_turn(prompt, start):
    """An Agent call cut off after its subagent began ("cut an agent"): denied, so nothing records its end and its
    meta.json is never `finished`. From then on the transcript is written as `claude -p` writes it, with no
    `turn_duration` record (what every coool chat's real transcript looks like): keepalive-idle-e2e.sh."""
    global PRINT_LIKE
    PRINT_LIKE = True
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    agent = f"a{uuid.uuid4().hex[:16]}"
    assistant([{"type": "tool_use", "id": tid, "name": "Agent", "input": {"description": "Look around", "prompt": "Look around the folder.", "subagent_type": "general-purpose"}}])
    sub = TRANSCRIPT.parent / SID / "subagents"
    sub.mkdir(parents=True, exist_ok=True)
    (sub / f"agent-{agent}.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "Look around", "toolUseId": tid, "requestShape": "foreground", "model": "haiku"}))
    with open(sub / f"agent-{agent}.jsonl", "a") as f:
        for _ in range(2):
            m = {"model": MODEL, "id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "content": [{"type": "text", "text": "Looking."}], "usage": usage()}
            f.write(json.dumps({"type": "assistant", "isSidechain": True, "agentId": agent, "sessionId": SID, "cwd": str(CWD), "message": m, "uuid": str(uuid.uuid4()), "timestamp": iso()}) + "\n")
            time.sleep(0.2)
    time.sleep(0.5)
    tool_result(tid, "User rejected tool use", error=True)
    text("Stopped there.")
    result(start)


def flood_turn(prompt, start):
    """A reply streamed in many pieces ("flood <pieces>"): more events than a chat keeps for replay (keepalive-idle-e2e.sh)."""
    words = prompt.split()
    n = next((int(w) for w in words[words.index("flood") + 1:][:1] if w.isdigit()), 1000) if "flood" in words else 1000
    mid = f"msg_{uuid.uuid4().hex[:24]}"
    ev = lambda e: out({"type": "stream_event", "event": e, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    ev({"type": "message_start", "message": {"id": mid, "model": MODEL}})
    ev({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    for i in range(n):
        ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "x" if i % 80 else "\n"}})
    msg = {"model": MODEL, "id": mid, "type": "message", "role": "assistant", "content": [{"type": "text", "text": "flooded"}], "stop_reason": None, "usage": usage()}
    out({"type": "assistant", "message": msg, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    result(start)


def media_turn(prompt, start):
    """The media e2e (app/scripts/media-e2e.sh): the agent writes a chart, shows it with a recording, a sound and a
    PDF through coool's `show` tool, takes a Browser panel screenshot (kept in coool's capture folder), tries to show
    a file that is no media, and embeds the chart and links the recording in its reply."""
    thinking("The chart is rendered; I'll show it with the recording so the change is visible, not just described.")
    time.sleep(0.4)
    text("I rendered the chart and recorded the flow; here they are.")
    tool("Write", {"file_path": str(CWD / "out" / "chart.png"), "content": "(the chart's PNG bytes)"}, f"File created successfully at: {CWD / 'out' / 'chart.png'}", pause=0.3)
    m = Mcp()
    try:
        m.tool("show", {"paths": ["out/chart.png", "out/flow.mp4"], "caption": "The chart after the fix, and a recording of the flow"})
        time.sleep(0.3)
        m.tool("show", {"paths": ["out/voice.m4a"], "caption": "The new alert sound"})
        m.tool("show", {"paths": [str(CWD / "docs" / "spec.pdf")]})
        m.tool("show", {"paths": ["out/flow.html", "out/loop.svg"], "caption": "How a request flows, and the retry loop"})
        if "screenshot" in prompt.lower():
            m.tool("browser_navigate", {"url": str(CWD / "out" / "page.html")})
            time.sleep(0.5)
            m.tool("browser_screenshot", {})
        m.tool("show", {"paths": ["README.md"]})
    finally:
        m.close()
    text("The chart inline as well:\n\n![chart](out/chart.png)\n\nAnd [the recording](out/flow.mp4). A file outside the folder stays a link: ![secret](../secret/hidden.png)")
    title("Show the chart, the recording and the sound")
    result(start)


def frames_turn(prompt, start):
    """The media e2e: what came with a message that carries a video (its key frames, as images, and the marker)."""
    import re
    n = LAST_IMAGES[0]
    m = re.search(r'name="([^"]+)"[^>]*duration="([^"]+)"[^>]*frames="([^"]+)"', prompt)
    if m:
        text(f"I got {n} images with your message: the key frames of **{m.group(1)}** ({m.group(2)}) at {m.group(3)}.")
    else:
        text(f"I got {n} images with your message and no key frames.")
    result(start)


def generic_turn(prompt, start):
    text("Done.")
    result(start)


# The images (content blocks) the last user line carried, and the line's content as the CLI records it.
LAST_IMAGES = [0]
LAST_CONTENT = [None]


def run_turn(prompt):
    start = time.time()
    registry("busy")
    record({"type": "user", "message": {"role": "user", "content": LAST_CONTENT[0] if isinstance(LAST_CONTENT[0], list) else prompt}})
    init_line()
    status_line()
    low = prompt.lower()
    try:
        if "media demo" in low:
            media_turn(prompt, start)
        elif "what happens in the recording" in low:
            frames_turn(prompt, start)
        elif "changes demo" in low:
            changes_turn(prompt, start)
        elif "settings demo" in low:
            settings_turn(prompt, start)
        elif "billing check" in low:
            billing_turn(prompt, start)
        elif "slow demo" in low:
            slow_demo_turn(prompt, start)
        elif low.strip() == "continue":
            continue_turn(prompt, start)
        elif "long reply" in low:
            long_reply_turn(prompt, start)
        elif "march" in low:
            invoices_turn(prompt, start)
        elif "browser panel" in low:
            browser_turn(prompt, start)
        elif "on the mac" in low:
            mac_turn(prompt, start)
        elif "iphone" in low:
            iphone_turn(prompt, start)
        elif "cut an agent" in low:
            cut_agent_turn(prompt, start)
        elif "agent" in low:
            fanout_turn(prompt, start)
        elif "flood" in low:
            flood_turn(prompt, start)
        elif "slowly" in low:
            slow_turn(prompt, start)
        else:
            generic_turn(prompt, start)
    except BrokenPipeError:
        pass
    except Exception:
        import traceback
        with open(HOME / "standin.err", "a") as f:
            f.write(traceback.format_exc())
        text("(the stand-in's scripted turn failed; see standin.err in the workspace)")
        result(start)


# ------------------------------------------------------------------------------------------------ queue mode
# The steering e2e (app/scripts/steer-e2e.sh) writes <HOME>/.standin-queue. Then user lines are not each run at once:
# they go through a queue the way Claude Code 2.1.330 runs them (observed with Haiku 5.5, `sleep` steps and a
# `run_in_background` command; CHAT_SPEC "Steering"):
#
# - every user line gets `command_lifecycle` frames (`queued`, `started`, then `completed` or `cancelled`);
# - one turn at a time; a line written while a turn runs waits in the queue and is taken into that turn after the
#   next tool result (`started`, no result of its own; the turn's `result.user_message_uuids` lists it); one still
#   queued when the turn ends runs as a turn of its own right after;
# - `priority: "now"` puts a line ahead of everything queued (coool writes `now` notes so, right after the interrupt);
# - a background command (`run_in_background`) that finishes queues a task notification. Taken in mid-turn like a
#   line, or, when no turn runs (or the turn ends first), run as a turn of the CLI's own: `system/init` with no
#   lifecycle frame, a reply, a `result` that lists no uuid;
# - `interrupt` answers `{still_queued}` at once; the running step ends with "[Request interrupted by user for tool
#   use]" and the turn with `error_during_execution`; its lines get `cancelled`. What was queued stays queued;
# - `cancel_async_message {message_uuid}`: `{cancelled: true}` and a `cancelled` frame while the line is queued,
#   `{cancelled: false}` once taken in.
QUEUE_MODE = (HOME / ".standin-queue").exists()
QL = threading.Condition()
queue: list[dict] = []
turn: dict | None = None
_bg_n = [0]


def lifecycle(u, state):
    out({"type": "command_lifecycle", "command_uuid": u, "state": state, "session_id": SID, "uuid": str(uuid.uuid4())})


def enqueue(e):
    with QL:
        if e.get("prio") == "now":
            i = 0
            while i < len(queue) and queue[i].get("prio") == "now":
                i += 1
            queue.insert(i, e)
        else:
            queue.append(e)
        QL.notify_all()


def absorb():
    """After a tool result: everything queued comes into the running turn."""
    with QL:
        taken, queue[:] = queue[:], []
    for e in taken:
        if e["kind"] == "prompt":
            lifecycle(e["uuid"], "started")
            record({"type": "attachment", "attachment": {"type": "queued_command", "prompt": e["prompt"], "commandMode": "prompt", "source_uuid": e["uuid"]}})
            turn["uuids"].append(e["uuid"])
            turn["notes"].append(e["prompt"])
        else:
            turn["tasks"].append(e["name"])


def aborted():
    return turn is not None and turn["abort"].is_set()


def qtool(name, inp, res, secs):
    """A main-thread step that the interrupt cuts. False: cut."""
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp}])
    cut = turn["abort"].wait(secs)
    if cut:
        tool_result(tid, "Interrupted by user", error=True)
        return False
    tool_result(tid, res)
    absorb()
    return True


def qagent(desc, secs):
    """A foreground subagent step (a Ladder helper's shape): its own steps stream in under it."""
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    agent = f"a{uuid.uuid4().hex[:16]}"
    assistant([{"type": "tool_use", "id": tid, "name": "Agent", "input": {"description": desc, "prompt": desc, "subagent_type": "general-purpose", "model": "haiku"}}])
    out({"type": "system", "subtype": "task_started", "task_id": agent, "tool_use_id": tid, "description": desc, "subagent_type": "general-purpose", "is_backgrounded": False, "task_type": "local_agent", "uuid": str(uuid.uuid4()), "session_id": SID})
    t0 = time.time()
    while time.time() - t0 < secs:
        if turn["abort"].wait(1.0):
            tool_result(tid, "Interrupted by user", error=True)
            return False
        tool("Read", {"file_path": str(CWD / "README.md")}, "# notes", parent=tid, agent=agent, pause=0.2)
    tool_result(tid, f"{desc}: done.")
    absorb()
    return True


def qbackground(desc, secs, step=False):
    """A `run_in_background` command: its notification is queued when it finishes."""
    _bg_n[0] += 1
    bid = f"b{_bg_n[0]}"
    tid = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant([{"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": f"sleep {secs:g}", "description": desc, "run_in_background": True}}])
    out({"type": "system", "subtype": "task_started", "task_id": bid, "tool_use_id": tid, "description": desc, "task_type": "local_bash", "is_backgrounded": True, "uuid": str(uuid.uuid4()), "session_id": SID})
    tool_result(tid, f"Command running in background with ID: {bid}.")

    def done():
        time.sleep(secs)
        out({"type": "system", "subtype": "task_notification", "task_id": bid, "tool_use_id": tid, "status": "completed", "summary": f'Background command "{desc}" completed (exit code 0)', "uuid": str(uuid.uuid4()), "session_id": SID})
        enqueue({"kind": "task", "name": desc, "step": step})

    threading.Thread(target=done, daemon=True).start()
    absorb()


def stream_text(t, secs):
    """A reply streamed over `secs` (cut by an interrupt). False: cut."""
    mid = f"msg_{uuid.uuid4().hex[:24]}"
    ev = lambda e: out({"type": "stream_event", "event": e, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    ev({"type": "message_start", "message": {"id": mid, "model": MODEL}})
    ev({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    words = t.split(" ")
    for i, w in enumerate(words):
        if turn["abort"].wait(secs / len(words)):
            return False
        ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": w + (" " if i < len(words) - 1 else "")}})
    msg = {"model": MODEL, "id": mid, "type": "message", "role": "assistant", "content": [{"type": "text", "text": t}], "stop_reason": None, "usage": usage()}
    out({"type": "assistant", "message": msg, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    return True


def qresult(start, ok=True):
    o = {"type": "result", "subtype": "success" if ok else "error_during_execution", "is_error": not ok, "duration_ms": int((time.time() - start) * 1000), "num_turns": 1,
         "result": "", "session_id": SID, "usage": usage(), "uuid": str(uuid.uuid4())}
    if turn["uuids"]:
        o["user_message_uuids"] = list(turn["uuids"])
        o["user_message_uuid"] = turn["uuids"][0]
    out(o)
    for u in turn["uuids"]:
        lifecycle(u, "completed" if ok else "cancelled")
    registry("idle")


def noted():
    """What the agent saw mid-turn, said back (the e2e checks the agent had each note)."""
    parts = [f"Noted: {n}" for n in turn["notes"]] + [f"(The background task \"{t}\" finished.)" for t in turn["tasks"]]
    return ("\n\n" + "\n".join(parts)) if parts else ""


def q_steps_turn(prompt, start):
    """"steer demo": a background command (2 s) and then three foreground `sleep 4` steps."""
    qbackground("Build in the background", 2)
    for i in range(3):
        if not qtool("Bash", {"command": "sleep 4", "description": f"Step {i + 1}"}, "", 4):
            return False
    text("Done with the steps." + noted())
    return True


def q_helper_turn(prompt, start):
    """"helper demo": a background helper whose notification turn has a step of its own; this turn ends first."""
    qbackground("Helper: audit the notes", 1.5, step=True)
    text("Started a helper in the background; I'll pick up its results when it reports." + noted())
    return True


def q_agent_turn(prompt, start):
    """"agent step demo": a foreground subagent step, then another step (a Ladder lead waiting on a helper)."""
    if not qagent("Helper: read the notes", 5):
        return False
    if not qtool("Bash", {"command": "sleep 3", "description": "Check the helper's work"}, "", 3):
        return False
    text("The helper is done." + noted())
    return True


def q_story_turn(prompt, start):
    """"story demo": no tool, a reply streamed over a few seconds."""
    return stream_text("Once upon a time a lighthouse keeper counted the ships that passed, one by one, until the fog came in and there was nothing left to count but the waves.", 6)


def q_prompt_turn(e):
    global turn
    start = time.time()
    registry("busy")
    lifecycle(e["uuid"], "started")
    record({"type": "user", "message": {"role": "user", "content": e["prompt"]}})
    init_line()
    out({"type": "system", "subtype": "status", "status": "requesting", "session_id": SID, "user_message_uuids": [e["uuid"]], "uuid": str(uuid.uuid4())})
    low = e["prompt"].lower()
    try:
        if "steer demo" in low:
            ok = q_steps_turn(e["prompt"], start)
        elif "helper demo" in low:
            ok = q_helper_turn(e["prompt"], start)
        elif "agent step demo" in low:
            ok = q_agent_turn(e["prompt"], start)
        elif "story demo" in low:
            ok = q_story_turn(e["prompt"], start)
        else:
            text(f"Re: {e['prompt']}")
            ok = True
    except BrokenPipeError:
        return
    if not ok:
        m = {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}
        out({"type": "user", "message": m, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    qresult(start, ok=ok)


def q_task_turn(e):
    """A turn the CLI runs on its own for a background task's notification (no lifecycle frame, no uuid)."""
    start = time.time()
    registry("busy")
    init_line()
    status_line()
    ok = True
    if e.get("step"):
        ok = qtool("Bash", {"command": "sleep 6", "description": "Read the helper's report"}, "", 6)
    if ok:
        text(f"The background task \"{e['name']}\" finished." + noted())
    else:
        m = {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}
        out({"type": "user", "message": m, "parent_tool_use_id": None, "session_id": SID, "uuid": str(uuid.uuid4())})
    qresult(start, ok=ok)


def q_runner():
    global turn
    while True:
        with QL:
            while not queue:
                QL.wait()
            e = queue.pop(0)
            turn = {"uuids": [e["uuid"]] if e["kind"] == "prompt" else [], "notes": [], "tasks": [], "abort": threading.Event()}
        try:
            if e["kind"] == "prompt":
                q_prompt_turn(e)
            else:
                q_task_turn(e)
        except BrokenPipeError:
            return
        except Exception:
            import traceback
            with open(HOME / "standin.err", "a") as f:
                f.write(traceback.format_exc())
        with QL:
            turn = None


def q_control(sub, req, rid):
    """Queue mode's `interrupt` and `cancel_async_message`; None: not one of them."""
    if sub == "interrupt":
        with QL:
            if turn is not None:
                turn["abort"].set()
            still = [e["uuid"] for e in queue if e["kind"] == "prompt"]
        return {"still_queued": still}
    if sub == "cancel_async_message":
        u = req.get("message_uuid")
        with QL:
            hit = [e for e in queue if e.get("uuid") == u]
            for e in hit:
                queue.remove(e)
        if hit:
            out({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": {"cancelled": True}}})
            lifecycle(u, "cancelled")
            return False
        return {"cancelled": False}
    return None


def main():
    global MODE
    registry("idle")
    if QUEUE_MODE:
        threading.Thread(target=q_runner, daemon=True).start()
    for line in sys.stdin:
        try:
            v = json.loads(line)
        except ValueError:
            continue
        t = v.get("type")
        if t == "control_request":
            req, rid = v.get("request", {}), v.get("request_id")
            sub = req.get("subtype")
            if sub == "initialize":
                resp = {"commands": COMMANDS, "agents": [{"name": "general-purpose"}, {"name": "Explore"}, {"name": "Plan"}], "models": MODELS, "pid": os.getpid(),
                        "claude_code_version": "2.9.0", "current_permission_mode": MODE, "output_style": "default"}
            elif sub == "get_context_usage":
                resp = {"model": MODEL, "maxTokens": 1_000_000, "rawMaxTokens": 1_000_000, "totalTokens": 18_400, "percentage": 1.8, "categories": []}
            elif sub == "set_permission_mode":
                MODE = req.get("mode", MODE)
                resp = {}
            elif QUEUE_MODE and (r := q_control(sub, req, rid)) is not None:
                if r is False:
                    continue
                resp = r
            else:
                resp = {}
            out({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": resp}})
        elif t == "control_response":
            r = v.get("response", {})
            with answered:
                answers[r.get("request_id")] = r.get("response", {})
                answered.notify_all()
        elif t == "user":
            c = v.get("message", {}).get("content")
            prompt = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict))
            LAST_IMAGES[0] = sum(1 for b in c if isinstance(b, dict) and b.get("type") == "image") if isinstance(c, list) else 0
            LAST_CONTENT[0] = c
            if QUEUE_MODE:
                u = v.get("uuid") or str(uuid.uuid4())
                lifecycle(u, "queued")
                enqueue({"kind": "prompt", "uuid": u, "prompt": prompt, "prio": v.get("priority")})
                continue
            threading.Thread(target=run_turn, args=(prompt,), daemon=True).start()
    REGISTRY.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        REGISTRY.unlink(missing_ok=True)
