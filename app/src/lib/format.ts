import type { Session } from "./types";

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 || Number.isInteger(+m.toFixed(2)) ? Math.round(m * 10) / 10 : m.toFixed(2).replace(/0$/, "")}M`;
}

export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function folderName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd || "unknown";
}

let home = "";
export const setHome = (h: string) => (home = h.replace(/\/+$/, ""));
export function homeShort(p: string): string {
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/** The CLI's placeholder name for an unnamed session: "<folder>-<n>" (e.g. "demo-project-43"). */
function generic(title: string, cwd: string): boolean {
  const f = folderName(cwd);
  return !!f && title.length > f.length + 1 && title.startsWith(f + "-") && /^[0-9a-f]{1,8}$/i.test(title.slice(f.length + 1));
}

/** "Write · a.txt" -> "a.txt" when the step already shows the name "Write". */
export function stripToolName(name: string, summary: string): string {
  return summary.startsWith(name + " · ") ? summary.slice(name.length + 3) : summary;
}

export function displayTitle(s: Pick<Session, "title" | "last_prompt" | "cwd">): string {
  if (s.title && !(s.last_prompt && generic(s.title, s.cwd))) return s.title;
  if (s.last_prompt) {
    const one = s.last_prompt.split(/\s+/).join(" ");
    return one.length > 60 ? one.slice(0, 59) + "…" : one;
  }
  return folderName(s.cwd) || "untitled";
}

/** "Bash · cargo test" -> { name: "Bash", detail: "cargo test" } */
export function splitTool(text: string): { name: string; detail: string } {
  const i = text.indexOf(" · ");
  if (i < 0) return { name: text, detail: "" };
  return { name: text.slice(0, i), detail: text.slice(i + 3) };
}

/** Activity `ts` is local HH:MM:SS; map it to epoch ms (today, or yesterday if that'd be in the future). */
export function tsToMs(ts: string, now = Date.now()): number | null {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(ts);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(+m[1], +m[2], +m[3], 0);
  let t = d.getTime();
  if (t > now + 60_000) t -= 86_400_000;
  return t;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** For estimated durations: coarse on purpose, never seconds. */
export function fmtApprox(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h${m % 60 >= 30 ? "+" : ""}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

export function isThinking(current: string | null | undefined): boolean {
  return !!current && /^thinking/i.test(current);
}

/** For tight spots: "~/code/app/src/components/Sidebar.tsx" -> "components/Sidebar.tsx". Non-paths pass through. */
export function shortDetail(detail: string): string {
  if (!/^[~/]/.test(detail) || /\s/.test(detail)) return detail;
  const parts = detail.split("/").filter(Boolean);
  return parts.length <= 2 ? detail : parts.slice(-2).join("/");
}
