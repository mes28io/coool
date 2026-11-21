// `?context=demo|preview|edit|create|live`: the Context panel in the browser mock. A Claude chat in a nested folder of
// a repository (~/code/harbor/web) opens with the panel showing; `preview` opens a memory file, `edit` the project's
// CLAUDE.md in the editor, `create` the new-skill form, `live` has "the agent" edit a memory file after a few seconds
// (the panel follows it). The files live in memory here and the overview is worked out from them the way
// crates/core/src/chatctx does it (sizes at 3.8 characters per token), so edits, creates and deletes show.

import type { CtxCreate, CtxFile, CtxItem, CtxOverview, CtxSaveReply, CtxStamp, CtxTarget } from "./chatContext";
import type { MockChat } from "./mockChat";

const HOME = "/Users/you";
const REPO = `${HOME}/code/harbor`;
const CWD = `${REPO}/web`;
const MEM = `${HOME}/.claude/projects/-Users-you-code-harbor/memory`;
const LADDER = "/Users/you/Library/Application Support/coool/ladder-plugin/coool-ladder";

export type CtxDemo = "demo" | "preview" | "edit" | "create" | "live";
export const ctxDemo = (): CtxDemo | null => {
  const m = /[?&]context=(demo|preview|edit|create|live)\b/.exec(typeof location === "undefined" ? "" : location.search)?.[1];
  return (m as CtxDemo | undefined) ?? null;
};
/** What the panel opens on in each demo. */
export const ctxDemoStart = (): { view: "file" | "edit" | "create-skill"; path?: string } | null => {
  switch (ctxDemo()) {
    case "preview":
      return { view: "file", path: `${MEM}/release-process.md` };
    case "edit":
      return { view: "edit", path: `${REPO}/CLAUDE.md` };
    case "create":
      return { view: "create-skill" };
    default:
      return null;
  }
};

const files = new Map<string, { text: string; ms: number }>();
const put = (p: string, text: string) => files.set(p, { text, ms: Date.now() });

put(
  `${HOME}/.claude/CLAUDE.md`,
  "# How I work\n\n- Plain words in commit messages and PR descriptions.\n- Ask before anything destructive: force-push, deleting branches, dropping tables.\n- Prefer small diffs; say what you checked.\n\nWriting style: @~/.claude/writing.md\n",
);
put(`${HOME}/.claude/writing.md`, "# Writing\n\nShort sentences. No filler. Name the file and the line when pointing at code.\n");
put(
  `${REPO}/CLAUDE.md`,
  "# Harbor\n\nA booking app for small marinas: `web/` (Vite + React), `api/` (Rust, axum), `infra/` (Terraform).\n\n## Commands\n\n- `pnpm -C web dev`: the web app on :5173\n- `cargo test -p api`: the API's tests (needs Postgres from `docker compose up db`)\n\n## Rules\n\n- Money is integer cents everywhere; never floats.\n- Every API change updates `api/openapi.yaml` in the same commit.\n- UI strings go through `web/src/i18n/en.json`.\n",
);
put(`${REPO}/CLAUDE.local.md`, "# Local\n\nMy Postgres runs on port 5433, not 5432.\n");
put(`${CWD}/CLAUDE.md`, "# web/\n\n- Components in `src/components`, one per file, named exports.\n- Tailwind only; no CSS modules.\n- Run `pnpm -C web test` after touching `src/lib`.\n");
put(
  `${MEM}/MEMORY.md`,
  "- [Release process](release-process.md) — tag from main, the changelog is written by hand, deploy waits for a green CI run\n- [Owner preferences](owner-preferences.md) — wants screenshots of UI changes before merging\n- [Flaky booking test](flaky-booking-test.md) — booking_overlap is timing-sensitive; rerun once before digging\n",
);
put(
  `${MEM}/release-process.md`,
  "---\nname: release-process\ndescription: Tag from main, the changelog is written by hand, deploy waits for a green CI run\nmetadata:\n  type: project\n  modified: 2026-11-18T09:12:04.000Z\n---\n\n# Release process\n\n1. Merge to `main`, wait for CI.\n2. Write the changelog entry by hand in `CHANGELOG.md` (no generated notes).\n3. `git tag v<x.y.z>` and push the tag; the deploy job picks it up.\n\n**Why:** the generated notes listed internal refactors and confused marina owners.\n",
);
put(
  `${MEM}/owner-preferences.md`,
  "---\nname: owner-preferences\ndescription: Wants screenshots of UI changes before merging\nmetadata:\n  type: feedback\n---\n\nShow a screenshot of every UI change (light and dark) before asking to merge.\n",
);
put(
  `${MEM}/flaky-booking-test.md`,
  "---\nname: flaky-booking-test\ndescription: booking_overlap is timing-sensitive; rerun once before digging\nmetadata:\n  type: project\n---\n\n`api/tests/booking_overlap.rs` races the clock around midnight UTC. Rerun once; if it fails twice, it's real.\n",
);
put(
  `${REPO}/.claude/skills/release-notes/SKILL.md`,
  "---\nname: release-notes\ndescription: Draft the changelog entry for the next Harbor release from the merged PRs since the last tag.\n---\n\n# Release notes\n\n1. `git log --merges $(git describe --tags --abbrev=0)..main`\n2. Group by area (web, api, infra); leave out refactors.\n3. One plain sentence per change, written for marina owners.\n",
);
put(
  `${HOME}/.claude/skills/commit-style/SKILL.md`,
  "---\nname: commit-style\ndescription: Write commit messages the way I like them: what changed and why, in plain words, no prefixes.\n---\n\n# Commit style\n\nFirst line: what changed, under 72 characters. Then why, as prose.\n",
);
put(`${LADDER}/skills/briefs/SKILL.md`, "---\nname: briefs\ndescription: Ladder brief shapes per delegate tier and how to check a delegate's report. Load before writing your first delegate brief.\n---\n\n# Ladder briefs\n\n…\n");

const LADDER_TEXT =
  "# Ladder (set by coool)\nYou lead: your tokens go to the plan, briefs, hard calls, checking and the answer. Hand other work to the cheapest tier that can carry it:\n  mid Sonnet 5.5 (`sonnet`): multi-file work, debugging, research needing judgment, review\n  small+bulk Haiku 5.5 (`haiku`): scoped edits, pattern clones, lookups, summaries; mechanical bulk work from an exact rule set\n- Up to 4 delegates at once. Check every delegate's work before you build on it (read the diff, run `pnpm test` or open the output yourself).\nBefore your first brief, load the `coool-ladder:briefs` skill (brief shape per tier).\n";
const COOOL_TEXT =
  "# You are in coool\nThis chat runs inside coool, a desktop app. The person sees your work as a chat with panels beside it: a browser, an iPhone simulator and a sandbox Mac your coool-device tools drive.\n";

const tok = (s: string) => Math.round(s.length / 3.8);
const stampOf = (p: string): CtxStamp | null => {
  const f = files.get(p);
  if (!f) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < f.text.length; i++) h = Math.imul(h ^ f.text.charCodeAt(i), 0x01000193) >>> 0;
  return { len: f.text.length, hash: h.toString(16), modified_ms: f.ms };
};
const meta = (text: string, k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "")?.[1]?.replace(/^["']|["']$/g, "") ?? null;

function item(o: Partial<CtxItem> & Pick<CtxItem, "id" | "group" | "label" | "source">): CtxItem {
  return { kind: "project", path: null, description: null, tokens: 0, full_tokens: 0, load: "start", used: false, editable: false, depth: 0, note: null, text: null, ...o };
}

const tilde = (p: string) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

function fileItem(p: string, o: Partial<CtxItem> & Pick<CtxItem, "group" | "source">): CtxItem | null {
  const f = files.get(p);
  if (!f) return null;
  const t = tok(f.text);
  return item({ id: p, path: p, label: tilde(p), tokens: o.load && o.load !== "start" ? 0 : t, full_tokens: t, editable: true, ...o });
}

function skills(root: string, source: string, editable: boolean, prefix = ""): CtxItem[] {
  return [...files.keys()]
    .filter((p) => p.startsWith(root + "/") && p.endsWith("/SKILL.md") && p.slice(root.length + 1).split("/").length === 2)
    .sort()
    .map((p) => {
      const t = files.get(p)!.text;
      const name = prefix + (meta(t, "name") ?? p.split("/").slice(-2)[0]);
      const desc = meta(t, "description");
      const used = name === "release-notes";
      return item({ id: p, path: p, group: "skills", kind: "skill", label: name, source, description: desc, load: "listed", tokens: tok(name + (desc ?? "") + "    ") + (used ? tok(t) : 0), full_tokens: tok(t), used, editable });
    });
}

function overview(target: CtxTarget): CtxOverview {
  const items: CtxItem[] = [];
  const add = (i: CtxItem | null) => i && items.push(i);
  add(fileItem(`${HOME}/.claude/CLAUDE.md`, { group: "instructions", kind: "user", source: "User" }));
  add(fileItem(`${HOME}/.claude/writing.md`, { group: "instructions", kind: "import", source: "Imported by ~/.claude/CLAUDE.md", editable: false, depth: 1 }));
  add(fileItem(`${REPO}/CLAUDE.md`, { group: "instructions", source: "Project (parent folder)" }));
  add(fileItem(`${REPO}/CLAUDE.local.md`, { group: "instructions", kind: "local", source: "Local (not checked in)" }));
  add(fileItem(`${CWD}/CLAUDE.md`, { group: "instructions", source: "Project" }));
  const index = files.get(`${MEM}/MEMORY.md`);
  if (index)
    add(fileItem(`${MEM}/MEMORY.md`, { group: "memory", kind: "memory_index", source: "Auto memory · index", label: "MEMORY.md", description: `${index.text.split("\n").filter((l) => l.startsWith("- ")).length} entries` }));
  for (const p of [...files.keys()].filter((p) => p.startsWith(MEM + "/") && !p.endsWith("/MEMORY.md")).sort()) {
    const t = files.get(p)!.text;
    add(fileItem(p, { group: "memory", kind: "memory", source: "Auto memory", load: "on_demand", label: meta(t, "name") ?? p.split("/").pop()!, description: meta(t, "description") }));
  }
  items.push(...skills(`${HOME}/.claude/skills`, "User", true), ...skills(`${REPO}/.claude/skills`, "Project (parent folder)", true), ...skills(`${LADDER}/skills`, "Plugin coool-ladder (coool, --plugin-dir)", false, "coool-ladder:"));
  items.push(
    item({ id: "builtin:dataviz", group: "skills", kind: "skill", label: "dataviz", source: "Built in or managed", description: "Charts, plots and dashboards in any medium.", load: "listed", tokens: 30, note: "Listed by Claude Code for this session; its file isn't in a folder the panel reads." }),
    item({ id: "coool:ladder:0", group: "coool", kind: "coool_text", label: "Ladder", source: "coool · --append-system-prompt", description: "Ladder (set by coool)", tokens: tok(LADDER_TEXT), full_tokens: tok(LADDER_TEXT), text: LADDER_TEXT, note: "Settings > Ladder turns it on or off for new chats." }),
    item({ id: "coool:You are in coool:1", group: "coool", kind: "coool_text", label: "You are in coool", source: "coool · --append-system-prompt", description: "You are in coool", tokens: tok(COOOL_TEXT), full_tokens: tok(COOOL_TEXT), text: COOOL_TEXT }),
    item({ id: "coool-mcp:coool-device", group: "coool", kind: "coool_mcp", label: "coool-device", source: "coool · MCP server", description: "34 tools: the chat's iPhone, Mac and browser panels", load: "on_demand", full_tokens: 9_840, note: "Claude Code lists these tools by name at start and loads a tool's definition when the agent searches for it." }),
    item({ id: "mcp:user:linear", group: "mcp", kind: "mcp", label: "linear", source: "User · ~/.claude.json", load: "on_demand", note: "Its tools are known once the CLI connects to it." }),
  );
  const root = target.cwd || CWD;
  return {
    provider: target.provider,
    folder: { path: root, exists: true, repo_root: REPO, branch: "booking-calendar", worktree_of: null },
    items,
    total: items.reduce((n, i) => n + i.tokens, 0),
    memory_dir: MEM,
    create: {
      project_instructions: null,
      user_instructions: null,
      memory_dir: MEM,
      project_skills: `${REPO}/.claude/skills`,
      user_skills: `${HOME}/.claude/skills`,
    },
    started_model: "claude-opus-5-5",
    launch_model: "claude-opus-5-5",
    effort: null,
    notes: [
      "Changes to instructions, memory and skills reach Claude Code in its next session; a running chat keeps what it started with (a skill it hasn't used yet is read when it uses it, and memory files are read when needed).",
    ],
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN = /\/\.claude\/(settings[^/]*\.json|\.credentials|sessions\/)|\/\.codex\/(auth\.json|config\.toml)|\.\./;

export const mockCtx = {
  async chatContext(target: CtxTarget): Promise<CtxOverview> {
    await wait(40);
    return overview(target);
  },
  async chatContextRead(_t: CtxTarget, path: string): Promise<CtxFile> {
    await wait(30);
    if (FORBIDDEN.test(path)) throw new Error(`coool never opens ${path} (CLI settings, credentials and sessions are off limits)`);
    const f = files.get(path);
    if (!f) throw new Error("the file is gone");
    return { path, text: f.text, stamp: stampOf(path)!, eol: "lf", editable: !path.includes("/ladder-plugin/") && !path.endsWith("writing.md") };
  },
  async chatContextSave(_t: CtxTarget, path: string, text: string, stamp: CtxStamp | null): Promise<CtxSaveReply> {
    await wait(60);
    if (FORBIDDEN.test(path)) throw new Error(`coool only edits this chat's instructions, memory and skills, not ${path}`);
    const now = stampOf(path);
    if (stamp ? !now || now.hash !== stamp.hash : now) return { result: "changed", stamp: now };
    put(path, text);
    return { result: "saved", stamp: stampOf(path)! };
  },
  async chatContextCreate(_t: CtxTarget, c: CtxCreate): Promise<string> {
    await wait(80);
    if (c.what === "skill") {
      const root = c.scope === "user" ? `${HOME}/.claude/skills` : `${REPO}/.claude/skills`;
      const p = `${root}/${c.name}/SKILL.md`;
      if (files.has(p)) throw new Error("it already exists");
      put(p, `---\nname: ${c.name}\ndescription: ${c.description}\n---\n\n# ${c.name}\n\nWhat to do when this skill is used.\n`);
      return p;
    }
    if (c.what === "memory") {
      const base = c.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "memory";
      const p = `${MEM}/${base}.md`;
      put(p, `---\nname: ${base}\ndescription: ${c.description}\nmetadata:\n  type: ${c.kind ?? "project"}\n  modified: ${new Date().toISOString()}\n---\n\n`);
      const idx = files.get(`${MEM}/MEMORY.md`)?.text ?? "";
      put(`${MEM}/MEMORY.md`, `${idx}- [${c.title.trim()}](${base}.md) — ${c.description}\n`);
      return p;
    }
    put(c.path, c.path.endsWith("AGENTS.md") ? "# AGENTS.md\n\nInstructions for coding agents working in this folder.\n" : "# CLAUDE.md\n\nInstructions for Claude Code in this folder.\n");
    return c.path;
  },
  async chatContextTrash(_t: CtxTarget, path: string): Promise<string> {
    await wait(60);
    const dir = path.endsWith("/SKILL.md") ? path.slice(0, -"/SKILL.md".length) : null;
    for (const k of files.keys()) if (k === path || (dir && k.startsWith(dir + "/"))) files.delete(k);
    if (path.startsWith(MEM + "/")) {
      const name = path.split("/").pop();
      const idx = files.get(`${MEM}/MEMORY.md`);
      if (idx) put(`${MEM}/MEMORY.md`, idx.text.split("\n").filter((l) => !l.includes(`](${name})`)).join("\n"));
    }
    return dir ?? path;
  },
  async chatContextReveal() {},
};

/** Opens a Claude chat in ~/code/harbor/web with the Context panel showing. */
export async function runContextDemo(make: (cwd: string) => MockChat) {
  const [{ useStore }, { chatPanelKey }] = await Promise.all([import("../store"), import("./browserAgent")]);
  const c = make(CWD);
  await new Promise<void>((r) => {
    const tick = () => {
      const st = useStore.getState();
      if (st.ready && st.chatInfos[c.id]) return r();
      setTimeout(tick, 50);
    };
    tick();
  });
  void c.seed(["Add a week view to the booking calendar"], Date.now() - 4 * 60_000);
  const st = useStore.getState();
  st.open({ kind: "chat", id: c.id });
  st.setRightPanel(chatPanelKey(c.id), "context");
  if (ctxDemo() === "live")
    setTimeout(() => {
      const p = `${MEM}/flaky-booking-test.md`;
      const f = files.get(p);
      if (f) put(p, f.text + "\nUpdate (by the agent): it also fails when the test runner's TZ isn't UTC.\n");
    }, 6000);
}
