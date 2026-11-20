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
  /** An install that ends in a restart (at launch, or the Restart button), while it runs: the update screen. */
  launch?: LaunchUpdate | null;
}

/** Where the update screen's install stands (update/mod.rs `LaunchStage`). */
export type LaunchStage = "download" | "verify" | "install" | "restarting" | "failed" | "background";

export interface LaunchUpdate {
  from: string;
  to: string;
  stage: LaunchStage;
  progress: UpdateProgress | null;
  /** Failed because it ran past the launch gate's limit. */
  timed_out: boolean;
  detail: string | null;
}

/** "Updated to": the version the restart into this one came from (update/marker.rs). */
export interface UpdateWelcome {
  from: string;
  to: string;
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
  if (failed) return failed.id === "coool" && /couldn't be verified/.test(failed.detail ?? "") ? "coool update couldn't be verified" : `${failed.name} update failed`;
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

// ---------- the update screen (components/UpdateScreen.tsx) ----------

/** "Start coool now" is offered once the screen has been up this long while it still downloads or checks. */
export const SKIP_AFTER_MS = 4000;
/** How long the failure line stays before the screen steps aside. */
export const FAILED_HOLD_MS = 2600;
/** At launch, the window holds the normal UI back (plain background) while coool's own check is out, at most this
 *  long, so a found update's screen is the first thing shown rather than the app flashing up and away. */
export const VEIL_MAX_MS = 900;
/** With no word from the backend at all, the hold ends after this. */
export const VEIL_SILENT_MS = 1200;
export const FAILED_LINE = "Couldn't update right now. coool will try again later.";

export interface LaunchView {
  /** "Updating coool to 0.3.2". */
  title: string;
  /** "Downloading", "Checking the download", "Installing", "Restarting", or the failure line. */
  stage: string;
  /** "12 MB of 48 MB" while the download's size is known. */
  bytes: string | null;
  /** 0-100 when known. */
  pct: number | null;
  bar: "progress" | "indeterminate" | "full" | "none";
  /** A second, quieter line. */
  note: string | null;
  /** Offer "Start coool now". */
  skip: boolean;
  failed: boolean;
}

const mb = (n: number) => `${n >= 10 * 1048576 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)} MB`;

/** What the screen shows for the backend's `launch`, given how long it has been up; null: no screen. */
export function launchView(l: LaunchUpdate | null | undefined, shownMs: number): LaunchView | null {
  if (!l || l.stage === "background") return null;
  const title = `Updating coool to ${l.to}`;
  const v: LaunchView = { title, stage: "", bytes: null, pct: null, bar: "indeterminate", note: null, skip: false, failed: false };
  switch (l.stage) {
    case "download": {
      const pct = percent(l.progress);
      const total = l.progress?.total;
      return { ...v, stage: "Downloading", pct, bar: pct === null ? "indeterminate" : "progress", bytes: l.progress && total ? `${mb(l.progress.done)} of ${mb(total)}` : null, skip: shownMs >= SKIP_AFTER_MS };
    }
    case "verify":
      return { ...v, stage: "Checking the download", skip: shownMs >= SKIP_AFTER_MS };
    case "install":
      return { ...v, stage: "Installing" };
    case "restarting":
      return { ...v, stage: "Restarting", bar: "full", note: "coool will open again in a moment." };
    case "failed":
      // One plain line, nothing else: the screen steps aside a moment later.
      return { ...v, title: "", stage: FAILED_LINE, bar: "none", failed: true };
  }
}

/** Whether the launch hold (a plain background over the normal UI) still stands, `ms` after the page started. */
export function veilHolds(s: UpdateStatus | null, ms: number): boolean {
  if (!s) return ms < VEIL_SILENT_MS;
  if (s.launch && s.launch.stage !== "background") return false; // the screen itself takes over
  const app = s.items.find((i) => i.id === "coool");
  const pending = !s.gate_open && app?.state === "checking" && s.auto_app && !s.blocked;
  return pending && ms < VEIL_MAX_MS;
}

/** The confirmation after a restart into a new version. */
export function welcomeLine(w: UpdateWelcome): string {
  return `Updated to ${w.to} · from ${w.from}`;
}
