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


def generic_turn(prompt, start):
    text("Done.")
    result(start)


def run_turn(prompt):
    start = time.time()
    registry("busy")
    record({"type": "user", "message": {"role": "user", "content": prompt}})
    init_line()
    status_line()
    low = prompt.lower()
    try:
        if "changes demo" in low:
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


def main():
    global MODE
    registry("idle")
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
            threading.Thread(target=run_turn, args=(prompt,), daemon=True).start()
    REGISTRY.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        REGISTRY.unlink(missing_ok=True)
