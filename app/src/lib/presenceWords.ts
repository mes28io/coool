// The words on an agent's cursor label (APP_SPEC "Agent presence"): a short verb phrase for what it is doing now
// ("Tapping General", "Typing the email", "Scrolling down") and who is doing it ("Claude", "Pilot · memory").
// Pure, so node can test it (presenceWords.test.ts). The Browser panel's page draws its own label with the same rules
// (app/src-tauri/src/device/web_agent.js `typingPhrase`).

export type PresenceDevice = "iphone" | "mac" | "browser";

const MAX = 28;

/** An element's name for a label: the quoted part of the browser's `role "name"`, trimmed to fit. */
export function targetName(label: string | null | undefined): string {
  if (!label) return "";
  const quoted = /^[a-z]+ "(.*)"$/.exec(label.trim());
  const n = (quoted ? quoted[1] : label).replace(/\s+/g, " ").trim();
  return n.length > MAX ? `${n.slice(0, MAX - 1).trimEnd()}…` : n;
}

/** Field names that read as "the <name>" ("Typing the email"). */
const FIELD_NOUNS = /^(full |first |last |user ?|display |company |street |e-?mail |phone |zip |postal |search |verification )?(name|email|e-mail|password|passcode|pin|search|address|phone|number|message|username|url|code|title|subject|comment|note|city|country|zip|postcode|query|amount|description|reply|answer|website|company)$/i;

/** "Typing the email" for a field named like one; "Typing in Untitled" for another short name; else "Typing". */
export function typingPhrase(field: string): string {
  if (!field || field.length > 24 || field.split(" ").length > 3) return "Typing";
  if (FIELD_NOUNS.test(field)) return `Typing the ${field === field.toUpperCase() ? field : field.toLowerCase()}`;
  return `Typing in ${field}`;
}

const KEY_NAMES: Record<string, string> = {
  return: "Return",
  enter: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Delete",
  delete: "Delete",
  space: "Space",
  " ": "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};
const BUTTONS: Record<string, string> = { home: "Going home", lock: "Locking the screen", siri: "Asking Siri", volumeup: "Turning it up", volumedown: "Turning it down" };

/** What the actor is doing, as the label's second line. */
export function phrase(a: { kind: string; label?: string | null; decider?: string | null; by?: string | null }, device: PresenceDevice): string {
  const name = targetName(a.label);
  const lower = (a.label ?? "").trim().toLowerCase();
  switch (a.kind) {
    case "tap":
      return `${device === "iphone" ? "Tapping" : "Clicking"}${name ? ` ${name}` : ""}`;
    case "click":
      return `Clicking${name ? ` ${name}` : ""}`;
    case "swipe":
      return "Swiping";
    case "scroll":
      return /^(up|down|left|right|top|bottom)$/.test(lower) ? `Scrolling ${lower}` : "Scrolling";
    case "back":
      return "Going back";
    case "forward":
      return "Going forward";
    case "reload":
      return "Reloading";
    case "type":
      return typingPhrase(name);
    case "select":
      return name ? `Choosing ${name}` : "Choosing";
    case "press":
      if (BUTTONS[lower]) return BUTTONS[lower];
      return `Pressing ${KEY_NAMES[lower] ?? (name.length === 1 ? name.toUpperCase() : name || "a key")}`;
    case "app":
      return lower === "launch" || lower === "pilot" ? "Opening the app" : lower === "terminate" || lower === "quit" ? "Closing the app" : lower === "open_url" || lower === "open" ? "Opening a link" : lower === "shell" ? "Running a command" : "Working";
    case "navigate":
      return `Opening ${host(a.label ?? "") || "a page"}`;
    case "tab":
      return "Switching tabs";
    case "observe":
      return device === "browser" ? "Reading the page" : "Reading the screen";
    case "screenshot":
      return "Looking closely";
    case "wait":
      return "Waiting";
    case "think":
      return a.decider === "haiku" ? "Haiku is choosing" : "Thinking";
    case "device":
      return "Setting up";
    default:
      return "Working";
  }
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Who acts, as the label's first line: the provider (or "Pilot") and, for a pilot step, who decided. */
export function whoLine(a: { by?: string | null; provider?: string | null; decider?: string | null }): string {
  const name = a.by === "pilot" ? "Pilot" : a.provider === "codex" ? "Codex" : a.provider === "claude" ? "Claude" : "Agent";
  const d = a.by === "pilot" ? (a.decider === "haiku" ? "Haiku" : a.decider === "memory" ? "memory" : "") : "";
  return d ? `${name} · ${d}` : name;
}

/** How long the cursor glides `dist` px: quick for short hops, calm for long ones, never slow. */
export function glideMs(dist: number): number {
  if (dist < 2) return 0;
  return Math.round(Math.min(340, Math.max(160, 130 + dist * 0.32)));
}
