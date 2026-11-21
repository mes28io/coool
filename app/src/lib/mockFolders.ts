// The browser mock's file system for the New session sheet's folder finder (crates/core/src/folders is the real one):
// an invented home with code folders, git repositories, the guarded Desktop / Documents / Downloads, and the summary of
// each folder. `?newsession=1` opens the sheet at start; `?newsession=search` types a search; `?newsession=new` starts
// a new folder; `?newsession=gate` opens the Desktop's "ask first" pane; `&slowfolders=1` makes the index take 2 s.

import type { FolderCompletion, FolderHit, FolderIndex, FolderListing, FolderSummary } from "./folders";
import type { Provider } from "./types";

const HOME = "/Users/you";
const H = (p: string) => `${HOME}/${p}`;
const now = Date.now();
const MIN = 60_000;

interface Node {
  repo?: { branch: string; changes: number; subject: string; ago: number; short: string };
  stack?: string[];
  files?: number;
  ctx?: { project: string[]; skills: number; projectSkills: number; memory?: boolean };
}

const repo = (branch: string, changes: number, subject: string, ago: number, stack: string[], ctx?: Node["ctx"]): Node => ({
  repo: { branch, changes, subject, ago, short: Math.abs(hash(subject)).toString(16).slice(0, 7).padEnd(7, "0") },
  stack,
  files: 6 + (subject.length % 9),
  ctx,
});
function hash(s: string) {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

/** Path (relative to home) -> what it is. Folders in between exist implicitly. */
const TREE: Record<string, Node> = {
  code: { files: 1 },
  "code/atlas-api": repo("rate-limit", 2, "Fix rounding in the search budget", 47 * MIN, ["Rust"], { project: ["CLAUDE.md"], skills: 4, projectSkills: 1, memory: true }),
  "code/atlas-api/src": { files: 3 },
  "code/atlas-api/src/routes": { files: 2 },
  "code/atlas-api/src/middleware": { files: 2 },
  "code/atlas-api/tests": { files: 1 },
  "code/pixelforge": repo("main", 0, "Bloom pass on Metal", 3 * 60 * MIN, ["Rust"], { project: ["CLAUDE.md", "AGENTS.md"], skills: 3, projectSkills: 0 }),
  "code/pixelforge/shaders": { files: 2 },
  "code/pixelforge/src": { files: 3 },
  "code/notes-ios": repo("cloudkit-sync", 5, "Keep the keyboard from covering the editor", 26 * 60 * MIN, ["Swift", "Xcode"], { project: ["AGENTS.md"], skills: 2, projectSkills: 0 }),
  "code/invoices": repo("main", 1, "Export invoices as CSV", 12 * MIN, ["Node"], { project: ["CLAUDE.md"], skills: 3, projectSkills: 2, memory: true }),
  "code/relay": repo("retry-webhooks", 4, "Back off webhook retries", 9 * MIN, ["Go"], { project: ["AGENTS.md"], skills: 2, projectSkills: 0 }),
  "code/relay-docs":repo("main", 0, "Document the retry headers", 2 * 24 * 60 * MIN, ["Node"], { project: [], skills: 2, projectSkills: 0 }),
  "code/project-3d": repo("blender-4", 3, "Bake the lighting rig", 5 * 60 * MIN, ["Python"], { project: ["CLAUDE.md"], skills: 2, projectSkills: 0 }),
  "code/blender-addon": repo("main", 0, "Ship the add-on milestone", 9 * 24 * 60 * MIN, ["Python"], { project: ["CLAUDE.md"], skills: 2, projectSkills: 0 }),
  "code/coool": repo("master", 7, "coool 0.4.0", 40 * MIN, ["Rust", "Node"], { project: ["CLAUDE.md", "AGENTS.md"], skills: 6, projectSkills: 3, memory: true }),
  "code/harbor": repo("main", 0, "Initial commit", 30 * 24 * 60 * MIN, ["Go"], { project: [], skills: 2, projectSkills: 0 }),
  "code/site": repo("main", 0, "New landing copy", 4 * 24 * 60 * MIN, ["Node"], { project: [], skills: 2, projectSkills: 0 }),
  "code/playground": { files: 4 },
  "code/playground/scratch-1": { files: 2 },
  "code/playground/wgpu-test": repo("main", 0, "triangle", 60 * 24 * 60 * MIN, ["Rust"]),
  "code/experiments": { files: 0 },
  "code/experiments/atlas-prototype": repo("main", 0, "first sketch", 90 * 24 * 60 * MIN, ["Node"]),
  Developer: { files: 0 },
  "Developer/fieldnotes-web": repo("main", 2, "Map view", 6 * 24 * 60 * MIN, ["Node"], { project: ["CLAUDE.md"], skills: 2, projectSkills: 0 }),
  "Developer/pocket-ledger": repo("main", 0, "Budgets per month", 11 * 24 * 60 * MIN, ["Swift", "Xcode"], { project: [], skills: 2, projectSkills: 0 }),
  infra: repo("main", 0, "Bump the runners", 8 * 24 * 60 * MIN, ["Docker"], { project: [], skills: 2, projectSkills: 0 }),
  Desktop: { files: 14 },
  "Desktop/coool-notes": { files: 3 },
  "Desktop/screenshots": { files: 40 },
  "Desktop/affect-study": repo("main", 1, "Analysis notebook", 3 * 24 * 60 * MIN, ["Python"], { project: [], skills: 2, projectSkills: 0 }),
  Documents: { files: 22 },
  "Documents/Invoices 2026": { files: 12 },
  "Documents/Writing": { files: 8 },
  Downloads: { files: 61 },
  "Downloads/archive": { files: 3 },
  Music: { files: 0 },
  Pictures: { files: 0 },
  Library: { files: 0 },
  Movies: { files: 0 },
  ".config": { files: 4 },
  ".ssh": { files: 3 },
};

const made = new Set<string>();
const all = () => new Set([...Object.keys(TREE), ...made]);
const exists = (rel: string) => rel === "" || [...all()].some((k) => k === rel || k.startsWith(rel + "/"));
const rel = (p: string) => (p === HOME ? "" : p.startsWith(HOME + "/") ? p.slice(HOME.length + 1) : null);
const guarded = (p: string) => (["Desktop", "Documents", "Downloads"].find((g) => p === H(g) || p.startsWith(H(g) + "/")) ?? null);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slow = typeof location !== "undefined" && /[?&]slowfolders=1/.test(location.search);
let indexed = 0;

function children(r: string): string[] {
  const pre = r ? r + "/" : "";
  const out = new Set<string>();
  for (const k of all()) if (k.startsWith(pre) && k !== r) out.add(k.slice(pre.length).split("/")[0]);
  return [...out].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), undefined, { numeric: true }));
}

export const mockFolders = {
  async index(_extra: string[], refresh: boolean): Promise<FolderIndex> {
    await delay(20);
    if (!indexed || refresh) indexed = indexed || Date.now() + (slow ? 2000 : 250);
    const ready = Date.now() >= indexed;
    const hits: FolderHit[] = ready
      ? Object.entries(TREE)
          .filter(([k]) => !guarded(H(k)) && !k.startsWith(".") && !["Library", "Music", "Pictures", "Movies"].includes(k.split("/")[0]) && (k.split("/").length <= 3 || TREE[k].repo))
          .map(([k, n]) => ({ path: H(k), name: k.split("/").pop()!, repo: !!n.repo, modified_ms: now - (n.repo?.ago ?? 50 * 24 * 60 * MIN) }))
      : [];
    return {
      home: HOME,
      places: [
        { kind: "home", label: "you", path: HOME, guarded: false },
        { kind: "desktop", label: "Desktop", path: H("Desktop"), guarded: true },
        { kind: "documents", label: "Documents", path: H("Documents"), guarded: true },
        { kind: "downloads", label: "Downloads", path: H("Downloads"), guarded: true },
        { kind: "code", label: "code", path: H("code"), guarded: false },
        { kind: "code", label: "Developer", path: H("Developer"), guarded: false },
      ],
      hits,
      at_ms: ready ? indexed : 0,
      scanning: !ready,
      roots: [HOME, H("code"), H("Developer")],
    };
  },

  async list(path: string, hidden: boolean, allow: boolean): Promise<FolderListing> {
    await delay(15);
    const p = path.replace(/\/+$/, "") || "/";
    const r = rel(p);
    const base: FolderListing = { path: p, parent: p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/", entries: [], files: 0, hidden: 0, more: false, protected: guarded(p), gated: false, error: null };
    if (base.protected && !allow) return { ...base, gated: true };
    if (r === null) {
      const names = p === "/" ? ["Applications", "Library", "System", "Users", "Volumes"] : p === "/Users" ? ["Shared", "you"] : [];
      return { ...base, entries: names.map((n) => ({ name: n, path: `${p === "/" ? "" : p}/${n}`, repo: false, hidden: false, link: false })), files: p === "/" ? 0 : 0, error: names.length ? null : "This folder doesn't exist" };
    }
    if (!exists(r)) return { ...base, error: "This folder doesn't exist" };
    const names = children(r);
    const vis = names.filter((n) => hidden || !n.startsWith("."));
    return {
      ...base,
      entries: vis.map((n) => {
        const k = r ? `${r}/${n}` : n;
        return { name: n, path: H(k), repo: !!TREE[k]?.repo, hidden: n.startsWith("."), link: false };
      }),
      hidden: names.length - vis.length,
      files: TREE[r]?.files ?? 0,
    };
  },

  async complete(input: string, allow: boolean): Promise<FolderCompletion> {
    await delay(10);
    const i = input.lastIndexOf("/");
    if (i < 0) return input === "~" ? { dir: "", matches: ["~"], completed: "~/", gated: false } : { dir: "", matches: [], completed: null, gated: false };
    const dirTyped = input.slice(0, i + 1);
    const prefix = input.slice(i + 1).toLowerCase();
    const dir = dirTyped.replace(/^~/, HOME).replace(/\/+$/, "") || "/";
    if (guarded(dir) && !allow) return { dir: dirTyped, matches: [], completed: null, gated: true };
    const l = await mockFolders.list(dir, prefix.startsWith("."), true);
    const m = l.entries.map((e) => e.name).filter((n) => n.toLowerCase().startsWith(prefix));
    let completed: string | null = null;
    if (m.length === 1) completed = `${dirTyped}${m[0]}/`;
    else if (m.length > 1) {
      let c = m[0];
      for (const x of m) while (!x.toLowerCase().startsWith(c.toLowerCase())) c = c.slice(0, -1);
      if (c.length > prefix.length) completed = dirTyped + c;
    }
    return { dir: dirTyped, matches: m, completed, gated: false };
  },

  async summary(path: string, provider: Provider, allow: boolean): Promise<FolderSummary> {
    await delay(90 + Math.random() * 120);
    const p = path.replace(/\/+$/, "");
    const r = rel(p);
    const s: FolderSummary = { path: p, exists: false, is_dir: false, inside_home: r !== null, writable: false, protected: guarded(p), gated: false, folders: 0, files: 0, stack: [], git: null, context: null };
    if (s.protected && !allow) return { ...s, gated: true };
    if (r === null || !exists(r)) return { ...s, exists: r === null && (p === "/" || p === "/Users") };
    // The nearest repository at or above.
    let rr: string | null = r;
    while (rr !== null && !TREE[rr]?.repo) rr = rr.includes("/") ? rr.slice(0, rr.lastIndexOf("/")) : rr === "" ? null : "";
    const n = TREE[r] ?? {};
    const root = rr !== null ? TREE[rr] : undefined;
    const rp = rr !== null ? H(rr) : "";
    const ctx = root?.ctx ?? { project: [], skills: 2, projectSkills: 0 };
    const files = ctx.project.filter((f) => (provider === "codex" ? f === "AGENTS.md" : f === "CLAUDE.md" || (f === "AGENTS.md" && !ctx.project.includes("CLAUDE.md"))));
    return {
      ...s,
      exists: true,
      is_dir: true,
      writable: true,
      folders: children(r).filter((x) => !x.startsWith(".")).length,
      files: n.files ?? 0,
      stack: root?.stack ?? n.stack ?? [],
      git: root?.repo
        ? { root: rp, branch: root.repo.branch, changes: made.has(r) ? 0 : root.repo.changes, last: made.has(r) ? null : { short: root.repo.short, subject: root.repo.subject, when_ms: now - root.repo.ago }, worktree_of: null, at_root: rr === r }
        : null,
      context: {
        project: files.map((f) => ({ label: `~/${rr}/${f}`, path: `${rp}/${f}`, source: "Project", tokens: f === "CLAUDE.md" ? 1840 : 960 })),
        user: 1,
        skills: ctx.skills,
        project_skills: ctx.projectSkills,
        memory: !!ctx.memory && provider === "claude",
        tokens: files.length * 1400 + ctx.skills * 90 + 620,
      },
    };
  },

  async create(parent: string, name: string, git: boolean): Promise<string> {
    await delay(120);
    const r = rel(parent.replace(/\/+$/, ""));
    if (r === null) throw new Error("New folders go inside your home folder only");
    const n = name.trim();
    if (!n || /[/:]/.test(n)) throw new Error("A folder name can't contain “/” or “:”");
    const k = r ? `${r}/${n}` : n;
    if (exists(k)) throw new Error(`“${n}” already exists here`);
    made.add(k);
    if (git) TREE[k] = repo("main", 0, "", 0, [], { project: [], skills: 2, projectSkills: 0 });
    return H(k);
  },

  async worktree(project: string, name: string): Promise<{ path: string; branch: string }> {
    await delay(400);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat";
    return { path: `${project}/.coool/worktrees/${slug}`, branch: `coool/${slug}` };
  },
};

/** `?newsession=<state>`: open the sheet once the page is up, then put it in that state (see the header). */
export async function runNewSessionDemo() {
  const state = /[?&]newsession=(\w+)/.exec(location.search)?.[1] ?? "1";
  const { useStore } = await import("../store");
  await delay(900);
  useStore.getState().setSheet({ kind: "new" });
  await delay(500);
  const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s);
  const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const click = (s: string) => $(s)?.click();
  if (state === "search") type($<HTMLInputElement>("[data-ns-search]")!, "atlas");
  if (state === "new") {
    click(`[data-ns-side="${H("code")}"]`);
    await delay(200);
    click("[data-ns-newfolder]");
    await delay(100);
    type($<HTMLInputElement>("[data-ns-new-name]")!, "weather-bot");
  }
  if (state === "gate") click(`[data-ns-side="${H("Desktop")}"]`);
  if (state === "prompt") {
    click(`[data-ns-side="${H("code/invoices")}"]`);
    await delay(200);
    type($<HTMLTextAreaElement>("[data-ns-prompt]")!, "Add a CSV export of paid invoices with a date range filter");
  }
  if (state === "busy") click(`[data-ns-side="${H("code/atlas-api")}"]`);
}
