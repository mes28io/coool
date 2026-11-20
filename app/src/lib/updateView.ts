// The updater (app/src-tauri/src/update/): what the backend reports, and what the rail's icon and panel make of it.
// Pure, so it is tested on its own (updateView.test.ts).

export type UpdateItemState =
  | "unknown"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "staged"
  | "waiting"
  | "manual"
  | "failed"
  | "missing";

export interface UpdateProgress {
  phase: "download" | "verify" | "install";
  done: number;
  total: number | null;
}

/** coool itself, Claude Code or Codex. */
export interface UpdateItem {
  id: "coool" | "claude" | "codex";
  name: string;
  current: string | null;
  latest: string | null;
  state: UpdateItemState;
  /** A plain line: why it waits, what failed. */
  detail: string | null;
  /** A command to run in Terminal. */
  command: string | null;
  /** How a CLI is installed ("npm", "standalone installer"...). */
  method: string | null;
  progress: UpdateProgress | null;
}

export interface UpdateStatus {
  items: UpdateItem[];
  auto_app: boolean;
  auto_cli: boolean;
  gate_open: boolean;
  checked_at: number | null;
  /** Why this copy of coool can't update itself (a development build, a read-only folder), if so. */
  blocked: string | null;
}

/** What the rail's icon shows: nothing, activity, the done check, or something waiting on the person. */
export type RailUpdate = "hidden" | "busy" | "done" | "attention";

const BUSY: UpdateItemState[] = ["downloading", "installing"];
const ATTENTION: UpdateItemState[] = ["available", "waiting", "manual", "failed"];

export function railUpdate(s: UpdateStatus | null): RailUpdate {
  if (!s) return "hidden";
  const items = s.items;
  if (items.some((i) => BUSY.includes(i.state))) return "busy";
  // The launch checks show as activity too (they are short); a later background check stays quiet.
  if (!s.gate_open && items.some((i) => i.state === "checking")) return "busy";
  if (items.some((i) => ATTENTION.includes(i.state) && !(i.id === "coool" && i.state === "available" && s.auto_app))) return "attention";
  if (items.some((i) => i.state === "staged")) return "done";
  // A coool update found with automatic updates on downloads by itself (a failed try is retried quietly).
  return "hidden";
}

/** The icon's tooltip. */
export function railLabel(s: UpdateStatus | null): string {
  if (!s) return "Updates";
  const by = (st: UpdateItemState) => s.items.find((i) => i.state === st);
  const app = s.items.find((i) => i.id === "coool");
  if (by("downloading") || by("installing")) {
    const i = by("downloading") ?? by("installing")!;
    const pct = percent(i.progress);
    return i.id === "coool" ? `Updating coool${pct !== null ? ` · ${pct}%` : ""}` : `Updating ${i.name}`;
  }
  const failed = by("failed");
  if (failed) return `${failed.name} update failed`;
  const waiting = by("waiting");
  if (waiting) return `${waiting.name} update waiting`;
  const manual = by("manual");
  if (manual) return `${manual.name} ${manual.latest ?? ""} available`.replace(/\s+/g, " ").trim();
  if (app?.state === "staged") return "Update installed · restart to apply";
  const avail = by("available");
  if (avail) return `${avail.name} ${avail.latest ?? ""} available`.replace(/\s+/g, " ").trim();
  return "Updates";
}

export function percent(p: UpdateProgress | null): number | null {
  if (!p || p.phase !== "download" || !p.total) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** One line for an item's state in the panel. */
export function itemLine(i: UpdateItem): string {
  const to = i.latest ? `${i.current ?? "?"} → ${i.latest}` : (i.current ?? "");
  switch (i.state) {
    case "current":
      return i.current ? `${i.current} · up to date` : "Up to date";
    case "checking":
      return "Checking…";
    case "unknown":
      return i.current ? `${i.current}` : "Not checked";
    case "available":
      return `${to} · available`;
    case "downloading": {
      const pct = percent(i.progress);
      return `${to} · downloading${pct !== null ? ` ${pct}%` : ""}`;
    }
    case "installing":
      return `${to} · ${i.id === "coool" ? "verifying" : "updating"}`;
    case "staged":
      return `${to} · installed, restart to apply`;
    case "waiting":
      return `${to} · waiting`;
    case "manual":
      return `${to} · needs a command`;
    case "failed":
      return i.latest ? `${to} · failed` : "Doesn't start";
    case "missing":
      return "Not installed";
  }
}

/** "2 working chats will stop." for the restart confirmation, or null when nothing runs. */
export function stopLine(running: number): string | null {
  if (running <= 0) return null;
  return running === 1 ? "1 working chat will stop. Its transcript stays, so you can resume it." : `${running} working chats will stop. Their transcripts stay, so you can resume them.`;
}
