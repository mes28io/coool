// The one naming function for tool calls (lib/toolNames.ts): a table of real calls -> row text.
// Tool names and inputs are taken from the self-test logs (inspo runs) and the coool-device tool list
// (app/src-tauri/src/device/{mcp,web,vm}.rs); results are the first lines those tools really return.
// Run: node --test app/src/lib/toolNames.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOf, parseMcp, permissionWhat, rowText, serverLabel, shortUrl, stepParts, toolChips, toolRow, toolRowFromText, words, type ToolCallLike } from "./toolNames.ts";

const D = (t: string) => `mcp__coool-device__${t}`;
const done = (name: string, input: unknown, output: string, ok = true): ToolCallLike => ({ name, input, output, ok });
const run = (name: string, input: unknown): ToolCallLike => ({ name, input, output: "", ok: null });

test("parseMcp: Claude and Codex spellings", () => {
  assert.deepEqual(parseMcp("mcp__coool-device__browser_navigate"), { server: "coool-device", tool: "browser_navigate" });
  assert.deepEqual(parseMcp("mcp__claude_ai_Claude_Docs__batch"), { server: "claude_ai_Claude_Docs", tool: "batch" });
  assert.deepEqual(parseMcp("coool-device.browser_batch"), { server: "coool-device", tool: "browser_batch" });
  assert.deepEqual(parseMcp("codex_apps.higgsfield.jobs_wait"), { server: "codex_apps", tool: "higgsfield.jobs_wait" });
  assert.deepEqual(parseMcp("mcp__cua_repl"), { server: "cua_repl", tool: "" });
  for (const n of ["Bash", "Read", "apply_patch", "web_search", "Task", "view_image", "update_plan"]) assert.equal(parseMcp(n), null, n);
});

const TABLE: [string, ToolCallLike, string][] = [
  // Browser, from the inspo self-test runs.
  ["navigate", done(D("browser_navigate"), { url: "https://www.affectui.com/components/" }, "opened https://www.affectui.com/components/\n(load 1100 ms)"), "Opened affectui.com/components"],
  ["navigate, running", run(D("browser_navigate"), { url: "https://www.affectui.com/components/agent-crew" }), "Opening affectui.com/components/agent-crew"],
  ["long URL is trimmed in the middle", done(D("browser_navigate"), { url: "https://docs.example.com/guides/getting-started/installation/macos/apple-silicon/troubleshooting" }, "opened …"), "Opened docs.example.com/guides/getting-…troubleshooting"],
  ["click with the result's label", done(D("browser_click"), { id: 2 }, 'clicked button "Decline" at (412,388)\n\n…'), 'Clicked "Decline"'],
  ["click while running", run(D("browser_click"), { id: 12 }), "Clicking #12"],
  ["click failed", done(D("browser_click"), { id: 99 }, "no element 99 on the page", false), "Couldn't click #99"],
  ["type, plain field", done(D("browser_type"), { id: 4, text: "ahmet@example.com" }, 'typed "ahmet@example.com" into textbox "Email" (replacing what it held)'), 'Typed into "Email" · "ahmet@example.com"'],
  ["type, hidden field stays hidden", done(D("browser_type"), { id: 7, text: "hunter2" }, 'typed 7 characters into textbox "Password" (hidden field)'), 'Typed into "Password" · 7 characters, hidden'],
  ["type while running never shows the text", run(D("browser_type"), { id: 7, text: "hunter2" }), "Typing into #7"],
  ["type into a password-named field without the hidden flag", done(D("browser_type"), { id: 3, text: "s3cret" }, 'typed "s3cret" into textbox "API key" (replacing what it held)'), 'Typed into "API key" · 6 characters'],
  ["scroll", done(D("browser_scroll"), { direction: "down" }, "scrolled down 640 px"), "Scrolled down"],
  ["scroll to the bottom", done(D("browser_scroll"), { direction: "bottom" }, "scrolled to the bottom"), "Scrolled to the bottom"],
  ["screenshot", done(D("browser_screenshot"), {}, "screenshot (120 ms)"), "Took a screenshot"],
  ["observe", done(D("browser_observe"), { all: true, text_max: 20000 }, "affectUI — https://www.affectui.com/components/agent-crew\nready · …"), "Read the page affectui.com/components/agent-crew"],
  ["wait_for text", done(D("browser_wait_for"), { text: "Saved" }, '"Saved" to appear after 420 ms'), 'Waited for "Saved"'],
  ["wait_for idle, timed out", done(D("browser_wait_for"), { idle: true }, "timed out after 5019 ms waiting for the page to settle: it keeps changing (live content or an animation); the page as it is now", false), "Waited 5 s page kept changing"],
  ["wait_for text, timed out", done(D("browser_wait_for"), { text: "Done", timeout_ms: 3000 }, 'timed out after 3002 ms waiting for "Done" to appear', false), 'Waited 3 s "Done" never showed'],
  ["batch", done(D("browser_batch"), { actions: [{ type: "a@b.c", id: 4 }, { click: 7 }, { wait_for: "Saved" }] }, "1. typed …\n2. clicked …\n3. waited …"), "Did 3 steps on the page type, click, wait"],
  ["batch stopped at a step", done(D("browser_batch"), { actions: [{ click: 1 }, { click: 2 }, { click: 3 }] }, "1. clicked …\n2. FAILED: no element 2 (stopped; later steps not run)", false), "Stopped at step 2 of 3 on the page"],
  ["press", done(D("browser_press"), { key: "Enter", id: 4 }, 'pressed Enter on textbox "Search"'), "Pressed Enter"],
  ["back", done(D("browser_back"), {}, "went back\n(load 300 ms)"), "Went back"],
  ["select", done(D("browser_select"), { id: 9, value: "Blue" }, 'selected "Blue" in combobox "Color"'), 'Chose "Blue" in "Color"'],
  ["tabs new", done(D("browser_tabs"), { action: "new", url: "https://example.com" }, "opened tab 2"), "Opened a new tab example.com"],
  // iPhone
  ["tap with its label", done(D("tap"), { target: "k3f" }, 'tapped "Settings" at (201,412)'), 'Tapped "Settings"'],
  ["tap while running", run(D("tap"), { target: "k3f" }), "Tapping #k3f"],
  ["long press", done(D("tap"), { target: "a1", hold_ms: 800 }, 'long-pressed "Photo" at (100,200)'), 'Long-pressed "Photo"'],
  ["iPhone type into a field", done(D("type"), { text: "hello", into: "q1" }, 'tapped "Search" at (200,80), typed "hello"'), 'Typed into "Search" · "hello"'],
  ["iPhone type into a passcode field stays hidden", done(D("type"), { text: "123456", into: "p" }, 'tapped "Passcode" at (200,80), typed "123456"'), 'Typed into "Passcode" · 6 characters'],
  ["iPhone type, field unknown: only the length", done(D("type"), { text: "secret words" }, 'typed "secret words"'), "Typed 12 characters"],
  ["iPhone scroll", done(D("swipe"), { scroll: "down" }, "scrolled down"), "Scrolled down"],
  ["iPhone home button", done(D("press"), { button: "home" }, "pressed the home button"), "Pressed Home"],
  ["iPhone observe", done(D("observe"), {}, "Settings · 14 elements"), "Read the screen"],
  ["iPhone open app", done(D("app"), { action: "launch", bundle_id: "com.apple.Preferences" }, "launched"), "Opened com.apple.Preferences"],
  ["iPhone batch", done(D("batch"), { actions: [{ tap: "a" }, { type: "x" }, { tap: "b" }, { wait_for: "Done" }] }, "1. …"), "Did 4 steps on the iPhone tap, type, wait"],
  // Mac
  ["mac click", done(D("mac_click"), { target: "b7" }, 'clicked "Save" at (640,512)'), 'Clicked "Save"'],
  ["mac double click", done(D("mac_click"), { target: "f2", count: 2 }, 'double-clicked "Notes.txt" at (40,90)'), 'Double-clicked "Notes.txt"'],
  ["mac app", done(D("mac_app"), { action: "launch", app: "TextEdit" }, "launched TextEdit (com.apple.TextEdit)"), "Opened TextEdit"],
  ["mac shell", done(D("mac_shell"), { command: "sw_vers -productVersion" }, "15.2"), "Ran on the Mac sw_vers -productVersion"],
  ["mac screenshot", done(D("mac_screenshot"), {}, ""), "Took a screenshot"],
  // Pilot
  ["pilot_run", run(D("pilot_run"), { goal: "Open Settings and read the iOS version", target: "iphone" }), "Pilot · iPhone Open Settings and read the iOS version"],
  // Other servers: "<server> · <tool in words>" with the telling argument.
  ["github", done("mcp__github__create_pull_request", { title: "Fix the cart crash", head: "fix/cart" }, "#412"), "github · Create pull request Fix the cart crash"],
  ["supabase", done("mcp__supabase__execute_sql", { project_id: "abc", query: "select count(*) from orders" }, "[]"), "supabase · Execute sql select count(*) from orders"],
  ["claude.ai connector name", done("mcp__claude_ai_Claude_Docs__batch", { batch: [] }, "ok"), "Claude Docs · Batch"],
  ["uuid connector", done("mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__guide", {}, "ok"), "connector · Guide"],
  ["camelCase tool", done("mcp__Claude_Browser__get_page_text", { tabId: "3" }, "…"), "Claude Browser · Get page text 3"],
  ["secrets never become the detail", done("mcp__stripe__create_customer", { api_key: "sk_live_x", email_hint: "ok" }, ""), "stripe · Create customer ok"],
  // From real transcripts (the Chrome extension's tools): the action reads, typed text never does.
  ["computer tool: the action, not the coordinates", done("mcp__claude-in-chrome__computer", { action: "left_click", coordinate: [10, 20], tabId: 3 }, ""), "claude-in-chrome · Computer left click"],
  ["computer tool typing: never the text", done("mcp__claude-in-chrome__computer", { action: "type", text: "+90 537 000 00 00", tabId: 3 }, ""), "claude-in-chrome · Computer type"],
  ["the _mcp suffix is dropped", done("mcp__claude-in-chrome__tabs_context_mcp", { createIfEmpty: true }, ""), "claude-in-chrome · Tabs context"],
  ["Codex spelling", done("coool-device.browser_navigate", { url: "https://example.com/a/" }, "opened"), "Opened example.com/a"],
  ["long server names are clipped", done("mcp__my_really_long_company_server__ping", {}, ""), "my really long… · Ping"],
  // Built-ins keep their name and the core's summary.
  ["Bash", done("Bash", { command: "pnpm test" }, "ok"), "Bash pnpm test"],
];

for (const [what, call, want] of TABLE) {
  test(`row: ${what}`, () => {
    const call2 = call.name === "Bash" ? { ...call, summary: "Bash · pnpm test" } : call;
    assert.equal(rowText(toolRow(call2)), want);
  });
}

test("a timed-out wait is neutral, not a failure to act on", () => {
  const r = toolRow(done(D("browser_wait_for"), { idle: true }, "timed out after 5019 ms waiting for the page to settle", false));
  assert.equal(r.soft, true);
  assert.equal(toolRow(done(D("browser_click"), { id: 1 }, "no element", false)).soft, undefined);
});

test("families and chips", () => {
  assert.equal(toolRow(run(D("browser_click"), { id: 1 })).family, "browser");
  assert.equal(toolRow(run(D("tap"), {})).family, "iphone");
  assert.equal(toolRow(run(D("mac_type"), { text: "x" })).family, "mac");
  assert.equal(toolRow(run("mcp__github__list_issues", {})).family, "mcp");
  assert.equal(groupOf(D("browser_screenshot")), "Browser");
  assert.equal(groupOf(D("observe")), "iPhone");
  assert.equal(groupOf(D("mac_observe")), "Mac");
  assert.equal(groupOf(D("pilot_run")), "Pilot");
  assert.equal(groupOf("Task"), "Agent");
  const tools = [...Array(13)].map(() => ({ name: D("browser_click") })).concat([...Array(4)].map(() => ({ name: D("tap") })), [{ name: D("pilot_run") }, { name: "Read" }]);
  assert.deepEqual(toolChips(tools), [["Browser", 13], ["iPhone", 4], ["Pilot", 1], ["Read", 1]]);
});

test("transcript lines: the summary's detail, never the typed text", () => {
  assert.equal(rowText(toolRowFromText(`${D("browser_navigate")} · https://www.affectui.com/components/`)), "Opened affectui.com/components");
  assert.equal(rowText(toolRowFromText(`${D("browser_type")} · hunter2`)), "Typed into a field");
  assert.equal(rowText(toolRowFromText(`${D("type")} · 123456`)), "Typed into a field");
  assert.equal(rowText(toolRowFromText(`${D("mac_type")} · my passphrase`)), "Typed into a field");
  assert.equal(rowText(toolRowFromText(D("browser_screenshot"))), "Took a screenshot");
  assert.equal(rowText(toolRowFromText(`${D("tap")} · k3f`)), "Tapped #k3f");
  assert.equal(rowText(toolRowFromText(`${D("pilot_run")} · Open Settings`)), "Pilot · iPhone Open Settings");
  assert.equal(rowText(toolRowFromText("mcp__supabase__list_tables · public")), "supabase · List tables public");
  assert.equal(rowText(toolRowFromText("Read · ~/code/app/src/a.ts")), "Read ~/code/app/src/a.ts");
  assert.deepEqual(stepParts("Bash · pnpm build"), { name: "Bash", detail: "pnpm build" });
  assert.deepEqual(stepParts(`${D("browser_click")}`), { name: "Clicked", detail: "" });
});

test("permission requests read in the base form", () => {
  assert.deepEqual(permissionWhat(D("browser_navigate"), { url: "https://affectui.com/components" }, ""), { name: "Browser", detail: "open affectui.com/components" });
  assert.deepEqual(permissionWhat(D("browser_type"), { id: 3, text: "hunter2" }, `${D("browser_type")} · hunter2`), { name: "Browser", detail: "type into #3" });
  assert.deepEqual(permissionWhat("mcp__github__create_pull_request", { title: "Fix" }, ""), { name: "github", detail: "Create pull request Fix" });
  assert.deepEqual(permissionWhat("Bash", { command: "rm -rf dist" }, "Bash · rm -rf dist"), { name: "Bash", detail: "rm -rf dist" });
});

test("helpers", () => {
  assert.equal(words("create_pull_request"), "Create pull request");
  assert.equal(words("getPageText"), "Get page text");
  assert.equal(serverLabel("claude_ai_Gmail"), "Gmail");
  assert.equal(shortUrl("https://www.example.com/"), "example.com");
  assert.equal(shortUrl("example.com/a?x=1"), "example.com/a");
});

test("ToolSearch: the names it loads read as rows do; pilot_run on the Mac says Mac", () => {
  const r = toolRow({ name: "ToolSearch", input: { query: "select:mcp__coool-device__browser_navigate,mcp__coool-device__browser_click,mcp__weather__get_forecast" }, ok: true });
  assert.equal(r.detail, "Browser navigate, Browser click, weather · Get forecast");
  assert.ok(!/mcp__/.test(toolRow({ name: "ToolSearch", summary: "ToolSearch · select:mcp__coool-device__tap", ok: true }).detail));
  assert.equal(toolRow({ name: "ToolSearch", input: { query: "slack send" }, ok: true }).detail, "slack send");
  assert.equal(toolRow({ name: "mcp__coool-device__pilot_run", input: { target: "mac", goal: "Open Calculator" }, ok: true }).label, "Pilot · Mac");
});
