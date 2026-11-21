// The `context` self-test scenario (COOOL_SELFTEST=context): the Context panel in the real app (APP_SPEC "Context
// panel"), on a throwaway HOME the runner fills with invented ~/.claude and ~/.codex content and a scratch repository
// at <dir>/repo with nested CLAUDE.md files, a project skill, a user skill, an auto-memory folder and an earlier
// session whose transcript used the user skill (see the runner's notes in the report). No model calls: the chat talks
// to the stand-in CLI (app/scripts/readme-shots/standin-claude.py), or no turn happens at all.
//
// 1. A Claude chat in <dir>/repo/sub/deep (Ladder on) opens the panel from its header: every item shows, with the
//    sources the core lookup gives (user, import, rules, parent above the repository, project, local, nested), the
//    memory index and file, both skills, Ladder's text and the coool-device tools.
// 2. The earlier session (by its transcript): the user skill is marked used.
// 3. Edit a memory file and a skill through the panel's own editor (typed into, Save), read back.
// 4. A save over a stale stamp is refused ("changed"); create a memory file (the form) and a skill, delete one to
//    the (throwaway) Trash with the confirm.
// 5. Forbidden paths are refused at the command level: settings, credentials, a session key, Codex's auth, a
//    transcript, `..`, a symlink out of the project.

import { newChat } from "./lib/actions";
import { useChats } from "./lib/chat";
import type { CtxFile, CtxOverview, CtxSaveReply, CtxTarget } from "./lib/chatContext";
import { chatPanelKey } from "./lib/browserAgent";
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

/** Types into a React-controlled field the way a keystroke would. */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function contextScenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  return {
    async context(ctx) {
      const dir = ctx.cfg.dir;
      const home = dir.replace(/\/work$/, "");
      const repo = `${dir}/repo`;
      const deep = `${repo}/sub/deep`;
      const mem = `${home}/.claude/projects/${repo.replace(/[^A-Za-z0-9_-]/g, "-")}/memory`;
      let target: CtxTarget = { provider: "claude", cwd: deep, chat: null, sessionId: null };
      const ov = () => h.invoke("chat_context", { target }) as Promise<CtxOverview>;
      const read = (path: string) => h.invoke("chat_context_read", { target, path }) as Promise<CtxFile>;
      const item = (path: string) => $(`[data-context-item="${CSS.escape(path)}"]`);
      let id = -1;

      await h.step("context: the panel opens from the chat's header, left of the browser", async () => {
        await h.waitFor("ready", () => useStore.getState().ready, 60_000);
        const before = new Set(Object.keys(useChats.getState().chats).map(Number));
        await newChat({ provider: "claude", cwd: deep, model: "haiku", ladder: { on: true } });
        ({ id } = await h.waitFor("the chat", () => { const n = Object.keys(useChats.getState().chats).map(Number).find((i) => !before.has(i)); return n === undefined ? null : { id: n }; }, 15_000));
        await h.waitFor("ready", () => useChats.getState().chats[id]?.ready, 60_000);
        useStore.getState().open({ kind: "chat", id });
        await h.sleep(800);
        await h.shot("context-chat");
        const btn = await h.waitFor("the Context button", () => $("button[title^=\"This chat's context\"]"), 10_000);
        const globe = btn.nextElementSibling as HTMLElement | null;
        if (!globe || !/browser/i.test(globe.title)) throw h.fail(`the button after Context is "${globe?.title}"`);
        btn.click();
        await h.waitFor("the panel", () => $("[data-context-list]"), 10_000);
        target = { ...target, chat: id, sessionId: useChats.getState().chats[id]?.sessionId ?? null };
        return `chat ${id}; right panel ${useStore.getState().rightPanel[chatPanelKey(id)]}`;
      });

      await h.step("context: every item, with its source", async () => {
        const o = await ov();
        const want: [string, string][] = [
          [`${home}/.claude/CLAUDE.md`, "User"],
          [`${home}/.claude/extra/imported.md`, "Imported by"],
          [`${home}/.claude/rules/mine.md`, "User rules"],
          [`${dir}/CLAUDE.md`, "Parent folder"],
          [`${repo}/CLAUDE.md`, "Project (parent folder)"],
          [`${repo}/.claude/CLAUDE.md`, "Project (parent folder)"],
          [`${repo}/.claude/rules/style.md`, "Project rules"],
          [`${repo}/CLAUDE.local.md`, "Local"],
          [`${repo}/sub/CLAUDE.md`, "Project (parent folder)"],
          [`${deep}/CLAUDE.md`, "Project"],
          [`${mem}/MEMORY.md`, "Auto memory · index"],
          [`${mem}/thing.md`, "Auto memory"],
          [`${repo}/.claude/skills/proj-skill/SKILL.md`, "Project (parent folder)"],
          [`${home}/.claude/skills/user-skill/SKILL.md`, "User"],
        ];
        const norm = (p: string) => p.replace(/^\/private(?=\/)/, "");
        const miss: string[] = [];
        for (const [p, src] of want) {
          const it = o.items.find((i) => i.path && norm(i.path) === norm(p));
          if (!it || !it.source.startsWith(src)) miss.push(`${p} (${it?.source ?? "absent"})`);
          else await h.waitFor(`row ${p}`, () => item(it.path!), 8000);
        }
        if (miss.length) throw h.fail(`missing or wrong: ${miss.join("; ")}`);
        const order = o.items.filter((i) => i.group === "instructions").map((i) => norm(i.path ?? "").slice(norm(home).length));
        const coool = o.items.filter((i) => i.group === "coool").map((i) => `${i.label} ~${i.tokens}`);
        if (!coool.some((c) => c.startsWith("Ladder"))) throw h.fail(`no Ladder text: ${coool.join(", ")}`);
        const launched = (await h.invoke("selftest_chat_launch", { chat: id })) as { args: string[] };
        const plugin = launched.args.some((a) => a.startsWith("--plugin-dir="));
        if (plugin && !o.items.some((i) => i.label === "coool-ladder:briefs")) throw h.fail("no Ladder plugin skill");
        coool.push(plugin ? "plugin skill coool-ladder:briefs" : "no --plugin-dir (no cheaper tier known to the stand-in)");
        const sum = o.items.reduce((n, i) => n + i.tokens, 0);
        if (sum !== o.total || !$("[data-context-total]")?.textContent?.includes("tokens")) throw h.fail(`total ${o.total} vs ${sum}`);
        await h.shot("context-overview");
        return `order ${order.join(" > ")}; coool: ${coool.join(", ")}; total ~${o.total}`;
      });

      await h.step("context: the earlier session's transcript marks the skill it used", async () => {
        const o = (await h.invoke("chat_context", { target: { provider: "claude", cwd: deep, chat: null, sessionId: "11111111-2222-4333-8444-555555555555" } })) as CtxOverview;
        const used = o.items.filter((i) => i.used).map((i) => i.label);
        if (!used.includes("user-skill") || used.includes("proj-skill")) throw h.fail(`used: ${used.join(", ")}`);
        if (o.started_model !== "claude-haiku-5-5") throw h.fail(`started with ${o.started_model}`);
        if (o.items.some((i) => i.group === "coool")) throw h.fail("a watched session shows coool's additions");
        return `used: ${used.join(", ")}; started with ${o.started_model}`;
      });

      const editThrough = async (path: string, append: string) => {
        item(path)!.click();
        const edit = await h.waitFor("Edit", () => $(`[data-context-view="${CSS.escape(path)}"] [data-context-edit]`), 8000);
        edit.click();
        const ed = `[data-context-editor="${CSS.escape(path)}"]`;
        const area = await h.waitFor("the editor", () => $<HTMLTextAreaElement>(`${ed} [data-context-textarea]:not(:disabled)`), 8000);
        await h.waitFor("the text", () => area.value.length > 0, 5000);
        typeInto(area, area.value + append);
        await h.sleep(150);
        await h.shot(`context-edit-${path.split("/").slice(-2).join("-")}`);
        $(`${ed} [data-context-save]`)!.click();
        await h.waitFor("back on the file", () => $("[data-context-view]"), 8000);
        const f = await read(path);
        if (!f.text.endsWith(append)) throw h.fail(`not saved: ${JSON.stringify(f.text.slice(-60))}`);
        $<HTMLButtonElement>('button[title="Back to the chat\'s context"]')!.click();
        await h.waitFor("the list", () => $("[data-context-list]"), 5000);
        return f;
      };

      await h.step("context: edit a memory file and a skill in the panel", async () => {
        item(`${mem}/thing.md`)!.click();
        await h.waitFor("the preview", () => $("[data-context-rendered]"), 8000);
        await h.shot("context-preview");
        $<HTMLButtonElement>('button[title="Back to the chat\'s context"]')!.click();
        await h.waitFor("the list", () => $("[data-context-list]"), 5000);
        const a = await editThrough(`${mem}/thing.md`, "Edited from the Context panel.\n");
        const b = await editThrough(`${home}/.claude/skills/user-skill/SKILL.md`, "\nStep added from the panel.\n");
        return `memory ${a.stamp.len} bytes, skill ${b.stamp.len} bytes (${b.eol})`;
      });

      await h.step("context: a stale save is refused; create a memory and a skill; delete one", async () => {
        const p = `${repo}/CLAUDE.md`;
        const f = await read(p);
        const ok = (await h.invoke("chat_context_save", { target, path: p, text: f.text + "one\n", stamp: f.stamp })) as CtxSaveReply;
        if (ok.result !== "saved") throw h.fail("first save refused");
        const stale = (await h.invoke("chat_context_save", { target, path: p, text: "clobber\n", stamp: f.stamp })) as CtxSaveReply;
        if (stale.result !== "changed") throw h.fail("the stale save went through");
        if ((await read(p)).text !== f.text + "one\n") throw h.fail("the file changed after the refused save");
        // A memory file through the form.
        await h.waitFor("the list", () => $("[data-context-list]"), 5000);
        $<HTMLButtonElement>('button[title="New memory file"]')!.click();
        typeInto(await h.waitFor("title", () => $<HTMLInputElement>("[data-context-memory-title]"), 5000), "Self-test note");
        typeInto($<HTMLInputElement>("[data-context-memory-desc]")!, "Made by the context self-test");
        await h.sleep(100);
        $<HTMLButtonElement>("[data-context-create-submit]")!.click();
        await h.waitFor("its editor", () => $("[data-context-editor]"), 8000);
        $<HTMLButtonElement>("[data-context-cancel]")!.click();
        const index = await read(`${mem}/MEMORY.md`);
        if (!index.text.includes("- [Self-test note](self-test-note.md) — Made by the context self-test")) throw h.fail(`index: ${index.text}`);
        // A skill through the form.
        $<HTMLButtonElement>('button[title="Back to the chat\'s context"]')?.click();
        await h.waitFor("the list", () => $("[data-context-list]"), 5000);
        $<HTMLButtonElement>('button[title="New skill"]')!.click();
        typeInto(await h.waitFor("name", () => $<HTMLInputElement>("[data-context-skill-name]"), 5000), "selftest-skill");
        typeInto($<HTMLTextAreaElement>("[data-context-skill-desc]")!, "Made by the context self-test.");
        await h.sleep(100);
        await h.shot("context-create-skill");
        $<HTMLButtonElement>("[data-context-create-submit]")!.click();
        const ed = await h.waitFor("its editor", () => $("[data-context-editor]"), 8000);
        const skill = ed.dataset.contextEditor!;
        $<HTMLButtonElement>("[data-context-cancel]")!.click();
        // Delete it with the confirm.
        await h.waitFor("its view", () => $("[data-context-view]"), 8000);
        $<HTMLButtonElement>('button[title="Move this skill\'s folder to the Trash"]')!.click();
        (await h.waitFor("the confirm", () => $<HTMLButtonElement>("[data-context-trash]"), 5000)).click();
        await h.waitFor("the list", () => $("[data-context-list]"), 8000);
        const o = await ov();
        if (o.items.some((i) => i.label === "selftest-skill")) throw h.fail("the skill is still listed");
        if (!o.items.some((i) => i.label === "self-test-note")) throw h.fail("the new memory isn't listed");
        return `stale save refused; created ${skill.split("/").slice(-2).join("/")} and self-test-note.md; skill moved to the Trash`;
      });

      await h.step("context: forbidden paths are refused by the commands", async () => {
        const refused: string[] = [];
        const tryIt = async (what: string, f: () => Promise<unknown>) => {
          try {
            await f();
            throw h.fail(`${what} was allowed`);
          } catch (e) {
            if (e instanceof Error && e.message.endsWith("was allowed")) throw e;
            refused.push(what);
          }
        };
        await tryIt("read settings.json", () => read(`${home}/.claude/settings.json`));
        await tryIt("read .credentials.json", () => read(`${home}/.claude/.credentials.json`));
        await tryIt("read a session key", () => read(`${home}/.claude/sessions/1.key`));
        await tryIt("read Codex auth", () => read(`${home}/.codex/auth.json`));
        await tryIt("read a transcript", () => read(`${home}/.claude/projects/${deep.replace(/[^A-Za-z0-9_-]/g, "-")}/11111111-2222-4333-8444-555555555555.jsonl`));
        await tryIt("read through ..", () => read(`${deep}/../../CLAUDE.md`));
        await tryIt("read a symlink out", () => read(`${deep}/CLAUDE.local.md`));
        await tryIt("save settings.json", () => h.invoke("chat_context_save", { target, path: `${home}/.claude/settings.json`, text: "{}", stamp: null }));
        await tryIt("save Codex auth", () => h.invoke("chat_context_save", { target, path: `${home}/.codex/auth.json`, text: "{}", stamp: null }));
        await tryIt("save a source file", () => h.invoke("chat_context_save", { target, path: `${repo}/main.rs`, text: "x", stamp: null }));
        await tryIt("trash settings.json", () => h.invoke("chat_context_trash", { target, path: `${home}/.claude/settings.json` }));
        await tryIt("create an instruction file outside the project", () => h.invoke("chat_context_create", { target, create: { what: "instructions", path: `${home}/elsewhere/CLAUDE.md` } }));
        return `${refused.length} refused: ${refused.join(", ")}`;
      });
    },
  };
}
