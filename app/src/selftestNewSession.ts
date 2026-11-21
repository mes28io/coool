// The `newsession` self-test scenario (COOOL_SELFTEST=newsession): the New session sheet in the real app, on a
// throwaway HOME (app/scripts/newsession-e2e.sh builds it from the readme-shots workspace: invented projects as real
// git repositories with Claude Code and Codex sessions, plus a Desktop with folders, ignored folders and a deep repo).
// No model calls: chats start without a prompt, talking to the stand-in CLI.
//
// 1. The sheet opens at once (its disk reads come after); the index finds the repositories, skips ignored folders.
// 2. Search by keyboard to a folder and go in (Enter), up (⌘↑), type-to-select and arrows in the list.
// 3. The chosen folder's summary: git branch, last commit, knowledge, its sessions.
// 4. The path field: Tab completes and goes there.
// 5. A new folder inline: a taken name is refused; with git init and ⌘↵ it is made and a chat starts in it.
// 6. The rules at the command level: nothing outside home, never over an existing path, guarded places not read.
// 7. Continue a recent session from the sheet (resumes it as a chat).
// 8. Start in a new worktree of a repository.
// 9. Desktop asks first (the gate), then lists; light, dark and portrait shots.

import { useChats } from "./lib/chat";
import type { FolderIndex, FolderListing, FolderSummary } from "./lib/folders";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const attr = (name: string) => $(`[data-ns-sheet]`)?.getAttribute(name) ?? "";

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A key press on `el` as the keyboard would send it (React listens at the root). */
function key(el: Element, k: string, mods: { meta?: boolean; shift?: boolean } = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: !!mods.meta, shiftKey: !!mods.shift, bubbles: true, cancelable: true }));
}

export function newSessionScenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  return {
    async newsession() {
      await h.waitFor("ready", () => useStore.getState().ready, 60_000);
      const home = await h.waitFor("the home folder", () => useStore.getState().env?.home, 20_000);
      const code = `${home}/code`;
      const open = async (cwd?: string) => {
        useStore.getState().setSheet(null);
        await h.waitFor("the sheet gone", () => !$("[data-ns-sheet]"), 3_000);
        const t0 = performance.now();
        useStore.getState().setSheet(cwd ? { kind: "new", cwd } : { kind: "new" });
        await h.waitFor("the sheet", () => $("[data-ns-sheet]"), 3_000);
        return Math.round(performance.now() - t0);
      };
      const loc = () => attr("data-ns-loc");
      const target = () => attr("data-ns-target");
      const search = () => $<HTMLInputElement>("[data-ns-search]")!;
      const list = () => $("[data-ns-list]")!;

      await h.step("newsession: opens at once; the index finds the repositories and skips ignored folders", async () => {
        const ms = await open();
        if (ms > 400) throw h.fail(`the sheet took ${ms} ms to appear`);
        let idx = (await h.invoke("folders_index", { extra: [], refresh: false })) as FolderIndex;
        for (let i = 0; idx.scanning && i < 60; i++) {
          await h.sleep(500);
          idx = (await h.invoke("folders_index", { extra: [], refresh: false })) as FolderIndex;
        }
        if (idx.scanning) throw h.fail("the index still scans after 30 s");
        const repos = idx.hits.filter((x) => x.repo).map((x) => x.path);
        for (const want of [`${code}/atlas-api`, `${code}/pixelforge`, `${code}/deep/a/b/deep-repo`]) if (!repos.includes(want)) throw h.fail(`index misses ${want}: ${repos.join(", ")}`);
        const bad = idx.hits.filter((x) => /node_modules|\/Library\/|\/Desktop|too-deep/.test(x.path));
        if (bad.length) throw h.fail(`index has ${bad.map((x) => x.path).join(", ")}`);
        await h.waitFor("the repositories in the sidebar", () => $("[data-ns-sidebar]")?.textContent?.includes("deep-repo"), 10_000);
        await h.sleep(300);
        await h.shot("newsession-open");
        return `appeared in ${ms} ms; ${repos.length} repositories, ${idx.hits.length} folders indexed; places ${idx.places.map((p) => p.label).join(", ")}`;
      });

      await h.step("newsession: search by keyboard, Enter goes in, ⌘↑ goes up, type to select, arrows", async () => {
        search().focus();
        typeInto(search(), "pixelf");
        await h.waitFor("the result", () => $(`[data-ns-result-path="${CSS.escape(`${code}/pixelforge`)}"]`), 5_000);
        await h.shot("newsession-search");
        key(search(), "Enter");
        await h.waitFor("in pixelforge", () => loc() === `${code}/pixelforge`, 3_000);
        key(search(), "ArrowUp", { meta: true });
        await h.waitFor("back in code", () => loc() === code && target() === `${code}/pixelforge`, 3_000);
        list().focus();
        key(list(), "a");
        key(list(), "t");
        await h.waitFor("atlas-api selected by typing", () => target() === `${code}/atlas-api`, 3_000);
        key(list(), "ArrowDown");
        const next = await h.waitFor("the next folder", () => target() !== `${code}/atlas-api` && target(), 3_000);
        key(list(), "ArrowUp");
        await h.waitFor("back on atlas-api", () => target() === `${code}/atlas-api`, 3_000);
        key(list(), "Enter");
        await h.waitFor("in atlas-api", () => loc() === `${code}/atlas-api`, 3_000);
        key(list(), "ArrowLeft");
        await h.waitFor("up again", () => loc() === code && target() === `${code}/atlas-api`, 3_000);
        return `down went to ${next.slice(code.length + 1)}`;
      });

      await h.step("newsession: the chosen folder's git state, knowledge and sessions", async () => {
        await h.waitFor("the summary", () => $("[data-ns-details=ready]"), 10_000);
        const s = (await h.invoke("folders_summary", { path: `${code}/atlas-api`, provider: "claude", allow: false })) as FolderSummary;
        if (!s.git?.branch || !s.git.last) throw h.fail(`git ${JSON.stringify(s.git)}`);
        const gitLine = $("[data-ns-line=git]")?.textContent ?? "";
        if (!gitLine.includes(s.git.branch)) throw h.fail(`git line "${gitLine}"`);
        const commit = $("[data-ns-line=commit]")?.textContent ?? "";
        if (!commit.includes(s.git.last.subject)) throw h.fail(`commit line "${commit}"`);
        if (!$("[data-ns-line=knowledge]")) throw h.fail("no knowledge line");
        const sessions = await h.waitFor("its sessions", () => document.querySelectorAll("[data-ns-session]").length || null, 5_000);
        await h.shot("newsession-details");
        return `${gitLine.trim()} | ${commit.trim()} | ${$("[data-ns-line=knowledge]")?.textContent?.trim()} | ${sessions} sessions shown; stack ${s.stack.join(",")}`;
      });

      await h.step("newsession: the path field completes with Tab and goes there", async () => {
        key(list(), "l", { meta: true });
        const p = await h.waitFor("the path field", () => (document.activeElement === $("[data-ns-path]") ? $<HTMLInputElement>("[data-ns-path]") : null), 3_000);
        typeInto(p, "~/code/pixe");
        key(p, "Tab");
        await h.waitFor("completed", () => p.value === "~/code/pixelforge/" && loc() === `${code}/pixelforge`, 3_000);
        typeInto(p, "~/code/nope-nothing");
        key(p, "Enter");
        const err = await h.waitFor("the error", () => $("[data-ns-path-hint]")?.textContent, 3_000);
        key(p, "Escape");
        return `Tab -> ${p.value}; a missing path says "${err}"`;
      });

      await h.step("newsession: New folder inline (a taken name refused), git init, ⌘↵ makes it and starts a chat there", async () => {
        key(search(), "ArrowUp", { meta: true });
        await h.waitFor("in code", () => loc() === code, 3_000);
        list().focus();
        key(list(), "N", { meta: true, shift: true });
        const name = await h.waitFor("the name field", () => $<HTMLInputElement>("[data-ns-new-name]"), 3_000);
        typeInto(name, "atlas-api");
        key(name, "Enter");
        const err = await h.waitFor("refused", () => $("[data-ns-new-error]")?.textContent, 3_000);
        typeInto(name, "made-by-sheet");
        const git = $<HTMLInputElement>("[data-ns-new-git]")!;
        if (!git.checked) git.click();
        await h.shot("newsession-newfolder");
        const before = new Set(Object.keys(useChats.getState().chats));
        key(name, "Enter", { meta: true });
        const made = `${code}/made-by-sheet`;
        const chat = await h.waitFor("the chat", () => Object.values(useChats.getState().chats).find((c) => !before.has(String(c.id)) && c.cwd === made), 15_000);
        await h.waitFor("the sheet closed", () => !$("[data-ns-sheet]"), 5_000);
        const s = (await h.invoke("folders_summary", { path: made, provider: "claude", allow: false })) as FolderSummary;
        if (!s.is_dir || !s.git?.at_root) throw h.fail(`made ${JSON.stringify(s)}`);
        await h.waitFor("it runs", () => useChats.getState().chats[chat.id]?.ready, 30_000).catch(() => null);
        await h.shot("newsession-newfolder-chat");
        return `"${err}"; made ${made} (git ${s.git.branch ?? "unborn"}); chat ${chat.id} there`;
      });

      await h.step("newsession: creation only inside home, never over anything; guarded places not read", async () => {
        const refused = async (args: Record<string, unknown>) => {
          try {
            await h.invoke("folders_create", args);
            return null;
          } catch (e) {
            return String(e);
          }
        };
        const outside = await refused({ parent: "/private/tmp", name: "coool-should-not-exist", git: false });
        if (!outside?.includes("home folder")) throw h.fail(`outside home: ${outside}`);
        const over = await refused({ parent: code, name: "atlas-api", git: false });
        if (!over?.includes("already exists")) throw h.fail(`over: ${over}`);
        const lib = await refused({ parent: `${home}/Library`, name: "x", git: false });
        if (!lib) throw h.fail("made a folder in Library");
        const l = (await h.invoke("folders_list", { path: `${home}/Desktop`, hidden: false, allow: false })) as FolderListing;
        if (!l.gated || l.entries.length) throw h.fail(`Desktop listed without asking: ${JSON.stringify(l)}`);
        return `outside: "${outside}"; over: "${over}"; Library: "${lib}"; Desktop gated`;
      });

      await h.step("newsession: continue a recent session from the sheet", async () => {
        await open(`${code}/atlas-api`);
        await h.waitFor("the summary", () => $("[data-ns-details=ready]"), 10_000);
        const btn = await h.waitFor("an ended Claude session", () => [...document.querySelectorAll<HTMLElement>("[data-ns-session^='claude:']")].find((b) => b.title.startsWith("Continue")), 10_000);
        const key = btn.dataset.nsSession!;
        const s = useStore.getState().allSessions.find((x) => sessionKey(x) === key)!;
        btn.click();
        const chat = await h.waitFor("the resumed chat", () => Object.values(useChats.getState().chats).find((c) => c.sessionId === s.id), 15_000);
        await h.waitFor("the sheet closed", () => !$("[data-ns-sheet]"), 5_000);
        return `continued "${btn.textContent?.trim().slice(0, 60)}" as chat ${chat.id} (session ${s.id.slice(0, 8)})`;
      });

      await h.step("newsession: start in a new worktree of a repository", async () => {
        await open(`${code}/pixelforge`);
        const chip = await h.waitFor("the worktree chip", () => $("[data-ns-worktree]")?.closest("button"), 10_000);
        chip.click();
        await h.waitFor("on", () => $("[data-ns-worktree=on]"), 3_000);
        const before = new Set(Object.keys(useChats.getState().chats));
        $<HTMLButtonElement>("[data-ns-start]")!.click();
        const chat = await h.waitFor("the chat", () => Object.values(useChats.getState().chats).find((c) => !before.has(String(c.id)) && c.cwd.includes("/.coool/worktrees/")), 15_000);
        const wts = (await h.invoke("worktrees_list", { project: `${code}/pixelforge` })) as { list: { path: string; agent: boolean; branch: string | null }[] };
        const w = wts.list.find((x) => x.path === chat.cwd);
        if (!w?.agent) throw h.fail(`worktrees ${JSON.stringify(wts.list)}`);
        return `chat ${chat.id} in ${chat.cwd.slice(home.length)} on ${w.branch}`;
      });

      await h.step("newsession: Desktop asks first, then lists; light, dark and portrait", async () => {
        await open();
        $<HTMLElement>(`[data-ns-side="${CSS.escape(`${home}/Desktop`)}"]`)!.click();
        await h.waitFor("the gate", () => $("[data-ns-gate]"), 5_000);
        await h.shot("newsession-gate");
        $<HTMLElement>("[data-ns-gate-open]")!.click();
        await h.waitFor("Desktop listed", () => $(`[data-ns-row="${CSS.escape(`${home}/Desktop/old-notes`)}"]`), 5_000);
        useStore.getState().setThemePref("light");
        await open(`${code}/atlas-api`);
        await h.waitFor("the summary", () => $("[data-ns-details=ready]"), 10_000);
        await h.sleep(400);
        await h.shot("newsession-light");
        useStore.getState().setThemePref("dark");
        await h.invoke("selftest_resize", { width: 1000, height: 1500 });
        await h.sleep(900);
        await h.shot("newsession-portrait");
        await h.invoke("selftest_resize", { width: 760, height: 560 });
        await h.sleep(900);
        const layout = attr("data-ns-layout");
        await h.shot("newsession-small");
        await h.invoke("selftest_resize", { width: 1440, height: 900 });
        useStore.getState().setSheet(null);
        return `small window layout: ${layout}`;
      });
    },
  };
}
