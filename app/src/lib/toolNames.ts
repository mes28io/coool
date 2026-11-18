// One name for every tool call, on every surface (CHAT_SPEC "Tool rows"): the chat timeline's step rows and
// group chips, subagent and Jobs cards, Mission control's fan-out hover, the Needs-you list, the activity line.
//
// Built-in tools keep their own name ("Read", "Bash") and the existing detail. MCP tools (Claude
// `mcp__<server>__<tool>`, Codex `<server>.<tool>`) are read as a person would say them: coool-device's
// browser, iPhone and Mac tools get verb phrases built from the call's input and, once it ended, the first
// line of its result ("Clicked "Decline""); any other server reads "<server> · <Tool in words>" with its most
// telling argument. Typed text is shown only when the result says the field was not a hidden one.
//
// Pure (no React, no store): unit-tested by toolNames.test.ts.

export type ToolFamily = "browser" | "iphone" | "mac" | "pilot" | "mcp" | "tool";

export interface ToolRow {
  family: ToolFamily;
  /** The bold part: "Opened", "Clicked", "Scrolled down", "Bash", "github · Create pull request". */
  label: string;
  /** The mono part (may be empty): "affectui.com/components", "\"Decline\"", "pnpm test". */
  detail: string;
  /** What the step-group chip counts it under: "Browser", "iPhone", "Mac", "Pilot", the server, or the tool name. */
  group: string;
  /** The tool's raw name (tooltip, icon, mood). */
  raw: string;
  /** Failed, but nothing the person must act on (a wait that timed out): shown neutral, not red. */
  soft?: boolean;
}

export interface ToolCallLike {
  name: string;
  input?: unknown;
  /** The result (empty while running). */
  output?: string;
  /** The core's one-line summary ("Name · detail"). */
  summary?: string;
  /** null / undefined while running. */
  ok?: boolean | null;
  running?: boolean;
}

const SERVER_MAX = 16;
const DETAIL_MAX = 80;

/** `mcp__github__create_pull_request` -> github / create_pull_request; `coool-device.browser_click` (Codex) likewise. */
export function parseMcp(name: string): { server: string; tool: string } | null {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i < 0) return rest ? { server: rest, tool: "" } : null;
    return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
  }
  // Codex: "<server>.<tool>" (the tool may hold dots of its own: "codex_apps.higgsfield.jobs_wait").
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(name);
  if (m && !/^\d/.test(m[2])) return { server: m[1], tool: m[2] };
  return null;
}

const isDevice = (server: string) => /^coool[-_]device$/i.test(server);

/** "claude_ai_Claude_Docs" -> "Claude Docs"; a connector's uuid -> "connector"; clipped to 16. */
export function serverLabel(server: string): string {
  let s = server.replace(/^claude_ai_/i, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return "connector";
  s = s.replace(/_/g, " ").trim();
  return s.length > SERVER_MAX ? s.slice(0, SERVER_MAX - 1).trimEnd() + "…" : s;
}

/** "create_pull_request" -> "Create pull request"; "getPageText" -> "Get page text"; "higgsfield.jobs_wait" -> "Higgsfield jobs wait". */
export function words(tool: string): string {
  const w = tool
    .replace(/_mcp$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return w ? w[0].toUpperCase() + w.slice(1) : "";
}

const clip = (s: string, n = DETAIL_MAX) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** "https://www.affectui.com/components/agent-crew?x=1" -> "affectui.com/components/agent-crew", the path cut from the middle when long. */
export function shortUrl(raw: string, max = 48): string {
  const s = raw.trim();
  let host = "";
  let path = "";
  const m = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)([^?#]*)/i.exec(s);
  if (m) {
    host = m[2].replace(/^www\./i, "");
    path = m[3] === "/" ? "" : m[3].replace(/\/$/, "");
  } else {
    const b = /^([^/?#\s]+)([^?#]*)/.exec(s);
    host = (b?.[1] ?? s).replace(/^www\./i, "");
    path = (b?.[2] ?? "").replace(/\/$/, "");
  }
  const out = host + path;
  if (out.length <= max) return out || s;
  const room = max - host.length - 1;
  if (room < 8) return out.slice(0, max - 1) + "…";
  const head = Math.ceil(room / 2);
  return host + path.slice(0, head) + "…" + path.slice(path.length - (room - head));
}

/** A field name that suggests a secret: its typed text is never shown, even when the result does not say "hidden". */
const SECRETISH = /pass(word|code|phrase)?|\bpin\b|secret|token|api[ _-]?key|otp|one[- ]time|security code|cvc|cvv|credential/i;
/** Argument names never shown as the generic detail. */
const SECRET_KEY = /pass|secret|token|key|auth|cookie|credential|session/i;

const firstLine = (s: string | undefined) => (s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
const q = (s: string) => `"${clip(s, 40)}"`;
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** `button "Decline"` -> `"Decline"`; `element` -> `element`. */
function quotedOf(what: string): string {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(what);
  if (m) return q(m[1].replace(/\\"/g, '"'));
  return clip(what, 40);
}

/** The label inside the first quotes of a line (`tapped "Settings" at …` -> Settings), or null. */
function labelIn(line: string): string | null {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(line);
  return m ? m[1] : null;
}

const target = (v: unknown) => {
  if (Array.isArray(v) && v.length === 2) return `(${Math.round(Number(v[0]))}, ${Math.round(Number(v[1]))})`;
  const s = str(v);
  return s ? `#${s.replace(/^\[|\]$/g, "")}` : "";
};

const elapsed = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s`.replace(".0 s", " s") : `${ms} ms`);

/** A wait's target in words: "Saved" (quoted), a selector, a URL, or "the page to settle". */
function waitWhat(i: Record<string, unknown>, surface: "page" | "screen"): { what: string; idle: boolean } {
  if (typeof i.text === "string" && i.text) return { what: q(i.text), idle: false };
  if (typeof i.selector === "string" && i.selector) return { what: clip(i.selector, 40), idle: false };
  if (typeof i.url === "string" && i.url) return { what: shortUrl(i.url), idle: false };
  if (typeof i.id === "string" && i.id) return { what: target(i.id), idle: false };
  return { what: `the ${surface} to settle`, idle: true };
}

function waitRow(t: ToolCallLike, i: Record<string, unknown>, surface: "page" | "screen", base: Omit<ToolRow, "label" | "detail">): ToolRow {
  const { what, idle } = waitWhat(i, surface);
  const gone = i.gone === true;
  const run = isRunning(t);
  if (!run && t.ok === false) {
    const m = /timed out after (\d+) ms/.exec(firstLine(t.output));
    if (m) {
      const took = elapsed(+m[1]);
      return { ...base, soft: true, label: `Waited ${took}`, detail: idle ? `${surface} kept changing` : `${what} never ${gone ? "went away" : "showed"}` };
    }
  }
  if (idle) return { ...base, label: run ? `Waiting for the ${surface} to settle` : `Waited for the ${surface} to settle`, detail: "" };
  return { ...base, label: run ? (gone ? "Waiting for it to go" : "Waiting for") : gone ? "Waited for it to go" : "Waited for", detail: what };
}

const isRunning = (t: ToolCallLike) => t.running ?? (t.ok === null || t.ok === undefined);
const failed = (t: ToolCallLike) => !isRunning(t) && t.ok === false;

/** Steps of a batch in words: "click, type, wait" (each kind once, in order). */
function batchKinds(actions: unknown): string {
  if (!Array.isArray(actions)) return "";
  const seen: string[] = [];
  const word: Record<string, string> = { click: "click", tap: "tap", type: "type", select: "choose", press: "key", button: "button", scroll: "scroll", swipe: "swipe", navigate: "open", open_url: "open", launch: "launch", back: "back", forward: "forward", reload: "reload", wait_for: "wait", wait_ms: "pause" };
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const k = Object.keys(a).find((x) => x in word);
    if (k && !seen.includes(word[k])) seen.push(word[k]);
  }
  return seen.join(", ");
}

function batchRow(t: ToolCallLike, i: Record<string, unknown>, where: string, base: Omit<ToolRow, "label" | "detail">): ToolRow {
  const n = Array.isArray(i.actions) ? i.actions.length : 0;
  const steps = n === 1 ? "1 step" : n ? `${n} steps` : "steps";
  if (failed(t)) {
    const at = /^(\d+)\. FAILED/m.exec(t.output ?? "");
    if (at) return { ...base, label: `Stopped at step ${at[1]} of ${n || "?"}`, detail: where };
  }
  return { ...base, label: `${isRunning(t) ? "Doing" : "Did"} ${steps} ${where}`, detail: batchKinds(i.actions) };
}

/** Typed-into phrasing shared by the three surfaces; `field` is the field's name when known. */
function typedRow(t: ToolCallLike, text: string, field: string | null, masked: boolean, base: Omit<ToolRow, "label" | "detail">, fallbackTarget: string): ToolRow {
  if (isRunning(t)) return { ...base, label: "Typing into", detail: field ? q(field) : fallbackTarget || "a field" };
  if (failed(t)) return { ...base, label: "Couldn't type into", detail: field ? q(field) : fallbackTarget || "a field" };
  const n = [...text].length;
  // Nothing known (a transcript line, whose summary would be the typed text itself, which is dropped).
  if (!n && !field) return { ...base, label: "Typed into", detail: fallbackTarget || "a field" };
  const hidden = masked || !field || SECRETISH.test(field);
  const what = hidden ? `${n} ${n === 1 ? "character" : "characters"}${masked ? ", hidden" : ""}` : q(text);
  return { ...base, label: field ? "Typed into" : "Typed", detail: field ? `${q(field)} · ${what}` : what };
}

function browserRow(t: ToolCallLike, tool: string, i: Record<string, unknown>): ToolRow {
  const base = { family: "browser" as const, group: "Browser", raw: t.name };
  const run = isRunning(t);
  const bad = failed(t);
  const out = firstLine(t.output);
  switch (tool) {
    case "navigate": {
      const url = str(i.url);
      return { ...base, label: run ? "Opening" : bad ? "Couldn't open" : "Opened", detail: url ? shortUrl(url) : "" };
    }
    case "click": {
      const m = /^clicked (.+?) at \(/.exec(out);
      if (!run && !bad && m) return { ...base, label: "Clicked", detail: quotedOf(m[1]) };
      return { ...base, label: run ? "Clicking" : bad ? "Couldn't click" : "Clicked", detail: target(i.id) };
    }
    case "type": {
      const masked = /\(hidden field\)/.test(out);
      const m = /^typed .*? into (.+?) \((?:hidden field|replacing what it held)\)/.exec(out);
      const field = m ? labelIn(m[1]) : null;
      return typedRow(t, str(i.text), field, masked, base, target(i.id));
    }
    case "select": {
      const m = /^selected (.+) in (.+)$/.exec(out);
      if (!run && !bad && m) return { ...base, label: "Chose", detail: `${clip(m[1], 40)} in ${quotedOf(m[2])}` };
      const v = str(i.value) || (Array.isArray(i.values) ? i.values.map(str).join(", ") : "");
      return { ...base, label: run ? "Choosing" : bad ? "Couldn't choose" : "Chose", detail: v ? q(v) : target(i.id) };
    }
    case "scroll": {
      const d = str(i.direction);
      if (!d && i.id !== undefined) return { ...base, label: run ? "Scrolling to" : "Scrolled to", detail: target(i.id) };
      const dir = d === "top" || d === "bottom" ? `to the ${d}` : d || "down";
      return { ...base, label: `${run ? "Scrolling" : "Scrolled"} ${dir}`, detail: "" };
    }
    case "press":
      return { ...base, label: run ? "Pressing" : "Pressed", detail: keyName(str(i.key), i.modifiers) };
    case "back":
      return { ...base, label: run ? "Going back" : "Went back", detail: "" };
    case "forward":
      return { ...base, label: run ? "Going forward" : "Went forward", detail: "" };
    case "reload":
      return { ...base, label: run ? "Reloading the page" : "Reloaded the page", detail: "" };
    case "tabs": {
      const a = str(i.action) || "list";
      if (a === "new") return { ...base, label: "Opened a new tab", detail: str(i.url) ? shortUrl(str(i.url)) : "" };
      if (a === "switch") return { ...base, label: "Switched to tab", detail: str(i.tab) };
      if (a === "close") return { ...base, label: "Closed tab", detail: str(i.tab) };
      return { ...base, label: "Listed the tabs", detail: "" };
    }
    case "wait_for":
      return waitRow(t, i, "page", base);
    case "screenshot":
      return { ...base, label: run ? "Taking a screenshot" : "Took a screenshot", detail: "" };
    case "observe": {
      // The result's first line is "Title — https://url".
      const u = /\s—\s(\S+)$/.exec(out)?.[1];
      return { ...base, label: run ? "Reading the page" : "Read the page", detail: u && !bad ? shortUrl(u) : "" };
    }
    case "batch":
      return batchRow(t, i, "on the page", base);
  }
  return { ...base, label: `Browser · ${words(tool)}`, detail: genericArg(i) };
}

/** "Enter", "⌘ A" (modifiers first). */
function keyName(key: string, mods: unknown): string {
  const sym: Record<string, string> = { command: "⌘", cmd: "⌘", shift: "⇧", option: "⌥", alt: "⌥", control: "⌃", ctrl: "⌃" };
  const m = Array.isArray(mods) ? mods.map((x) => sym[String(x).toLowerCase()] ?? String(x)).join("") : "";
  const k = key.length === 1 ? key.toUpperCase() : key;
  return m ? `${m} ${k}` : k;
}

/** The iPhone and the sandbox Mac share most of their verbs (tap vs click). */
function screenRow(t: ToolCallLike, tool: string, i: Record<string, unknown>, mac: boolean): ToolRow {
  const base = mac ? { family: "mac" as const, group: "Mac", raw: t.name } : { family: "iphone" as const, group: "iPhone", raw: t.name };
  const where = mac ? "on the Mac" : "on the iPhone";
  const run = isRunning(t);
  const bad = failed(t);
  const out = firstLine(t.output);
  switch (tool) {
    case "observe":
      return { ...base, label: run ? "Reading the screen" : "Read the screen", detail: "" };
    case "screenshot":
      return { ...base, label: run ? "Taking a screenshot" : "Took a screenshot", detail: "" };
    case "tap":
    case "click": {
      const verb = /^(long-pressed|tapped|right-clicked|double-clicked|clicked)/.exec(out)?.[1];
      const label = labelIn(out);
      const pt = i.target !== undefined ? target(i.target) : typeof i.x === "number" && typeof i.y === "number" ? target([i.x, i.y]) : "";
      if (!run && !bad && verb) return { ...base, label: verb[0].toUpperCase() + verb.slice(1), detail: label !== null ? q(label) : pt };
      const word = mac ? ["Clicking", "Couldn't click", "Clicked"] : ["Tapping", "Couldn't tap", "Tapped"];
      return { ...base, label: run ? word[0] : bad ? word[1] : word[2], detail: pt };
    }
    case "type": {
      // "tapped "Email" at (x,y), typed "…"": the field is the tapped element, when `into` was given.
      const field = /^(?:tapped|clicked) "/.test(out) ? labelIn(out) : null;
      return typedRow(t, str(i.text), field, false, base, target(i.into));
    }
    case "swipe":
    case "scroll": {
      const d = str(i.scroll) || str(i.direction);
      if (d) return { ...base, label: `${run ? "Scrolling" : "Scrolled"} ${d}`, detail: i.in !== undefined ? `in ${target(i.in)}` : "" };
      return { ...base, label: run ? "Swiping" : "Swiped", detail: "" };
    }
    case "press": {
      const b = str(i.button);
      if (b) return { ...base, label: `${run ? "Pressing" : "Pressed"} ${b === "home" ? "Home" : b === "lock" ? "the lock button" : b}`, detail: "" };
      return { ...base, label: run ? "Pressing" : "Pressed", detail: keyName(str(i.key), i.modifiers) };
    }
    case "batch":
      return batchRow(t, i, where, base);
    case "wait_for":
      return waitRow(t, i, "screen", base);
    case "app": {
      const a = str(i.action);
      const app = str(i.app) || str(i.bundle_id);
      if (a === "launch") return { ...base, label: run ? "Opening" : "Opened", detail: app };
      if (a === "terminate" || a === "quit") return { ...base, label: run ? "Quitting" : "Quit", detail: app };
      if (a === "install") return { ...base, label: run ? "Installing" : "Installed", detail: str(i.path).split("/").pop() ?? "" };
      if (a === "open_url" || a === "open") return { ...base, label: run ? "Opening" : "Opened", detail: str(i.url) ? (/^[a-z]+:\/\//i.test(str(i.url)) && /^https?:/i.test(str(i.url)) ? shortUrl(str(i.url)) : clip(str(i.url), 60)) : "" };
      return { ...base, label: mac ? "Listed the running apps" : "Listed the apps", detail: "" };
    }
    case "device": {
      const a = str(i.action) || "status";
      const what = mac ? "the Mac" : "the simulator";
      if (a === "boot") return { ...base, label: run ? `Starting ${what}` : `Started ${what}`, detail: "" };
      if (a === "shutdown") return { ...base, label: `Shut down ${what}`, detail: "" };
      if (a === "list") return { ...base, label: "Listed the simulators", detail: "" };
      if (a === "select") return { ...base, label: "Switched device", detail: out.replace(/^now driving /, "") || str(i.udid).slice(0, 8) };
      if (a === "appearance") return { ...base, label: `Switched to ${str(i.value) || "dark"} mode`, detail: "" };
      if (a === "location") return { ...base, label: "Set the location", detail: typeof i.lat === "number" && typeof i.lon === "number" ? `${i.lat}, ${i.lon}` : "" };
      if (a === "privacy") return { ...base, label: `${i.grant === false ? "Revoked" : "Granted"} ${str(i.service) || "access"}`, detail: str(i.bundle_id) };
      return { ...base, label: `Checked ${what}`, detail: "" };
    }
    case "shell":
      return { ...base, label: run ? "Running on the Mac" : "Ran on the Mac", detail: clip(str(i.command)) };
    case "share":
      return { ...base, label: "Shared with the Mac", detail: str(i.path).split("/").filter(Boolean).pop() ?? "" };
  }
  return { ...base, label: `${mac ? "Mac" : "iPhone"} · ${words(tool)}`, detail: genericArg(i) };
}

/** The most telling argument of a third-party tool call. */
function genericArg(i: Record<string, unknown>): string {
  // A tool driven by an `action` (a computer-use style "computer" tool): the action says what it did, and its `text`
  // may be what was typed, so it is never shown.
  if (typeof i.action === "string" && i.action.trim()) {
    const a = words(i.action).toLowerCase();
    const target = typeof i.url === "string" ? shortUrl(i.url) : typeof i.query === "string" ? clip(i.query) : "";
    return target ? `${a} ${target}` : a;
  }
  for (const k of ["url", "query", "q", "path", "file_path", "file", "command", "name", "title", "goal", "text", "prompt", "description", "message", "id"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return k === "url" ? shortUrl(v) : clip(v);
  }
  for (const [k, v] of Object.entries(i)) if (!SECRET_KEY.test(k) && typeof v === "string" && v.trim() && v.length < 400) return clip(v);
  return "";
}

/** The input as an object (a JSON string, Codex style, is parsed). */
function inputOf(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string" && input.startsWith("{")) {
    try {
      const v = JSON.parse(input);
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** "Bash · pnpm build" -> "pnpm build". */
const stripName = (name: string, summary: string) => (summary.startsWith(name + " · ") ? summary.slice(name.length + 3) : summary === name ? "" : summary);

/** A tool call -> its row. */
export function toolRow(t: ToolCallLike): ToolRow {
  const mcp = parseMcp(t.name);
  const i = inputOf(t.input);
  if (!mcp) {
    const agent = /^(task|agent)$/i.test(t.name);
    // ToolSearch loads tools by name ("select:mcp__coool-device__browser_click,…"): the names read as they do in rows.
    if (t.name === "ToolSearch") {
      const q = str(i.query) || stripName(t.name, t.summary ?? "");
      return { family: "tool", label: t.name, detail: readableToolNames(q), group: t.name, raw: t.name };
    }
    return { family: "tool", label: t.name, detail: stripName(t.name, t.summary ?? ""), group: agent ? "Agent" : t.name, raw: t.name };
  }
  const { server, tool } = mcp;
  if (isDevice(server)) {
    if (tool === "pilot_run") {
      const target = str(i.target) === "browser" ? "Browser" : str(i.target) === "mac" ? "Mac" : "iPhone";
      return { family: "pilot", label: `Pilot · ${target}`, detail: clip(str(i.goal)), group: "Pilot", raw: t.name };
    }
    if (tool.startsWith("browser_")) return browserRow(t, tool.slice(8), i);
    if (tool.startsWith("mac_")) return screenRow(t, tool.slice(4), i, true);
    return screenRow(t, tool, i, false);
  }
  const srv = serverLabel(server);
  const detail = Object.keys(i).length ? genericArg(i) : stripName(t.name, t.summary ?? "");
  return { family: "mcp", label: tool ? `${srv} · ${words(tool)}` : srv, detail, group: srv, raw: t.name };
}

/**
 * Tool names inside a text (a ToolSearch query) as rows name them: "select:mcp__coool-device__browser_click,
 * mcp__weather__get_forecast" -> "Browser click, weather · Get forecast". Other text is left as it is.
 */
export function readableToolNames(text: string): string {
  const one = (name: string) => {
    const m = parseMcp(name);
    if (!m) return name;
    if (isDevice(m.server)) {
      const g = groupOf(name);
      const rest = m.tool.replace(/^(browser|mac)_/, "");
      return g === "Pilot" ? "Pilot" : `${g} ${words(rest).toLowerCase()}`;
    }
    return m.tool ? `${serverLabel(m.server)} · ${words(m.tool)}` : serverLabel(m.server);
  };
  return text
    .replace(/^select:\s*/i, "")
    .replace(/mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_.-]+)?/g, one)
    .replace(/\s*,\s*/g, ", ");
}

/** For a transcript's "name · detail" line, the input key the core's summary took its detail from (its first string value). */
const FIRST_KEY: Record<string, string> = {
  browser_navigate: "url",
  browser_scroll: "direction",
  browser_press: "key",
  browser_wait_for: "text",
  browser_tabs: "action",
  browser_select: "value",
  browser_click: "id",
  tap: "target",
  swipe: "scroll",
  press: "key",
  wait_for: "text",
  app: "action",
  device: "action",
  mac_click: "target",
  mac_scroll: "direction",
  mac_press: "key",
  mac_wait_for: "text",
  mac_app: "action",
  mac_device: "action",
  mac_shell: "command",
  mac_share: "path",
  pilot_run: "goal",
};

/**
 * A transcript activity line ("mcp__coool-device__browser_navigate · https://…") -> its row. Only the summary's
 * detail is known (the call's first string argument), never the result: typed text is never shown from here.
 */
export function toolRowFromText(text: string): ToolRow {
  const i = text.indexOf(" · ");
  const name = i < 0 ? text : text.slice(0, i);
  const detail = i < 0 ? "" : text.slice(i + 3);
  const mcp = parseMcp(name);
  if (!mcp) return toolRow({ name, summary: text, ok: true });
  const tool = isDevice(mcp.server) ? mcp.tool : "";
  if (isDevice(mcp.server)) {
    // A type call's summary is the typed text itself: drop it.
    if (/^(browser_)?type$|^mac_type$/.test(tool)) return toolRow({ name, input: {}, ok: true, output: "" });
    const key = FIRST_KEY[tool];
    return toolRow({ name, input: key && detail ? { [key]: detail } : {}, ok: true, output: "" });
  }
  return toolRow({ name, summary: text, ok: true });
}

/** A "name · detail" line (a session's `current`) -> what to show as its name and its detail. */
export function stepParts(text: string): { name: string; detail: string } {
  const r = toolRowFromText(text);
  return { name: r.label, detail: r.detail };
}

/** "Opened affectui.com/components": the row as one line of text. */
export const rowText = (r: ToolRow) => (r.detail ? `${r.label} ${r.detail}` : r.label);

/** The step-group chips: "Browser ×13" style counts, first seen first, at most `max`. */
export function toolChips(tools: { name: string; agent?: boolean }[], max = 4): [string, number][] {
  const m = new Map<string, number>();
  for (const t of tools) {
    const g = t.agent ? "Agent" : groupOf(t.name);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return [...m.entries()].slice(0, max);
}

/** The chip a tool counts under, from its name alone. */
export function groupOf(name: string): string {
  const mcp = parseMcp(name);
  if (!mcp) return /^(task|agent)$/i.test(name) ? "Agent" : name;
  if (isDevice(mcp.server)) return mcp.tool === "pilot_run" ? "Pilot" : mcp.tool.startsWith("browser_") ? "Browser" : mcp.tool.startsWith("mac_") ? "Mac" : "iPhone";
  return serverLabel(mcp.server);
}

const BASE: Record<string, string> = { Opening: "open", Clicking: "click", Typing: "type", Taking: "take", Reading: "read", Scrolling: "scroll", Waiting: "wait", Doing: "do", Running: "run", Pressing: "press", Tapping: "tap", Swiping: "swipe", Choosing: "choose", Going: "go", Reloading: "reload", Starting: "start", Installing: "install", Quitting: "quit" };

/**
 * A permission request in words, asked before the call runs: the group, then what it wants to do in the
 * base form ("Browser" + "open affectui.com/components"; "github" + "Create pull request Fix the crash").
 */
export function permissionWhat(tool: string, input: unknown, summary: string): { name: string; detail: string } {
  const mcp = parseMcp(tool);
  if (!mcp) return { name: tool, detail: stripName(tool, summary) };
  const r = toolRow({ name: tool, input, running: true, summary });
  if (r.family === "mcp") {
    const words = r.label.includes(" · ") ? r.label.slice(r.label.indexOf(" · ") + 3) : "";
    return { name: r.group, detail: [words, r.detail].filter(Boolean).join(" ") };
  }
  if (r.family === "pilot") return { name: r.label, detail: r.detail };
  const [first, ...rest] = r.label.split(" ");
  const label = BASE[first] ? [BASE[first], ...rest].join(" ") : r.label;
  return { name: r.group, detail: r.detail ? `${label} ${r.detail}` : label };
}
