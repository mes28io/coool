// Self-test `changes` / `changes-codex`: the Changes view on a scratch git repository (COOOL_SELFTEST_DIR), against
// the stand-in CLIs of app/scripts/readme-shots (no model calls; app/scripts/changes-e2e.sh sets it all up).
//
// `changes`: a Claude chat ("changes demo") edits a.txt in two places and b.txt, and creates notes/new.txt. Then,
// through the panel's own buttons: the turn's "3 files changed" opens it; one hunk of a.txt undone; b.txt kept; the new
// file undone (to the Trash); a.txt edited by hand (the driver script does it when the log says `HAND-EDIT a.txt`)
// and its undo refused with the question; a.txt kept and staged; a commit with a typed message. The driver checks the
// repository with git afterwards.
// `changes-codex`: a Codex chat's apply_patch (c.txt edited, d.txt added); the edit undone, the new file kept.

import { newChat } from "./lib/actions";
import { useChats } from "./lib/chat";
import { useStore } from "./store";

export interface ChangesKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

const $ = (s: string, root: ParentNode = document) => root.querySelector<HTMLElement>(s);
const $all = (s: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(s)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const file = (rel: string) => $(`[data-changes-panel] [data-change-file="${rel}"]`);

export const COMMIT_MESSAGE = "Rename line 2 in a.txt (coool self-test)";

export function changesScenarios(k: ChangesKit): Record<string, () => Promise<void>> {
  const { dir, shot, sleep, waitFor, step, log } = k;
  const chats = () => useChats.getState().chats;

  async function start(provider: "claude" | "codex", prompt: string): Promise<number> {
    const before = new Set(Object.keys(chats()).map(Number));
    await newChat({ provider, cwd: dir, model: provider === "claude" ? "opus" : "gpt-5.6", permissionMode: provider === "claude" ? "acceptEdits" : null, prompt });
    const found = await waitFor("the new chat", () => {
      const id = Object.keys(chats()).map(Number).find((i) => !before.has(i));
      return id === undefined ? null : { id };
    }, 20_000);
    useStore.getState().open({ kind: "chat", id: found.id });
    await waitFor("the turn to end", () => chats()[found.id]?.items.some((i) => i.kind === "turn"), 60_000);
    return found.id;
  }

  /** Clicks and waits for the panel's note; returns its text. */
  async function press(el: HTMLElement | null, what: string): Promise<string> {
    if (!el) throw new Error(`no button: ${what}`);
    const before = text($("[data-changes-note]"));
    el.click();
    const note = await waitFor(`the outcome of ${what}`, () => {
      const n = $("[data-changes-note]");
      return n && text(n) !== before ? n : null;
    }, 20_000);
    await sleep(400);
    return `${note.dataset.changesNote}: ${text(note)}`;
  }

  async function unreviewed() {
    const b = $all("[data-changes-panel] button").find((x) => text(x).startsWith("Unreviewed"));
    b?.click();
    await waitFor("the Unreviewed view", () => $('[data-changes-panel="pending"]'), 10_000);
    await sleep(600);
  }

  return {
    async changes() {
      let id = -1;
      await step("changes: a stand-in Claude turn edits two files and creates one", async () => {
        id = await start("claude", "Run the changes demo");
        return `chat ${id}`;
      });
      await step('changes: the turn\'s "3 files changed" opens the panel at that turn', async () => {
        const line = await waitFor("the files-changed line", () => $("[data-turn-files]"), 30_000);
        if (line.dataset.turnFiles !== "3") throw new Error(`line says ${text(line)}`);
        line.click();
        await waitFor("the panel at turn 1", () => $('[data-changes-panel="turn:1"]'), 20_000);
        await waitFor("three files", () => $all("[data-changes-panel] [data-change-file]").length === 3, 20_000);
        await unreviewed();
        const rels = $all("[data-changes-panel] [data-change-file]").map((x) => x.dataset.changeFile);
        const hunks = $all("[data-hunk]", file("a.txt")!).length;
        if (hunks !== 2) throw new Error(`a.txt has ${hunks} hunks`);
        await shot("changes-claude", 900);
        return `${text(line)}; files ${rels.join(", ")}; a.txt ${hunks} hunks; button "${text($("[data-changes-button]"))}"`;
      });
      await step("changes: undo one hunk of a.txt", async () => {
        const btns = $all("[data-undo-hunk]", file("a.txt")!);
        const r = await press(btns[1], "undo hunk 2");
        await waitFor("a.txt with one hunk", () => $all("[data-hunk]", file("a.txt")!).length === 1, 15_000);
        return r;
      });
      await step("changes: keep b.txt", async () => {
        const r = await press($("[data-keep-file]", file("b.txt")!), "keep b.txt");
        await waitFor("b.txt out of the Unreviewed view", () => !file("b.txt"), 15_000);
        return r;
      });
      await step("changes: undo the new file (to the Trash)", async () => {
        const r = await press($("[data-undo-file]", file("notes/new.txt")!), "undo notes/new.txt");
        await waitFor("notes/new.txt out of the Unreviewed view (undone)", () => !file("notes/new.txt"), 15_000);
        return r;
      });
      await step("changes: a.txt edited by hand; its undo is refused with a question", async () => {
        await log("HAND-EDIT a.txt");
        await waitFor("a.txt marked edited since, in the agent's lines", () => file("a.txt")?.dataset.fileDiverged && $("[data-hunk-since]", file("a.txt")!), 60_000);
        // The question shows in the file's card (no note): nothing is written.
        $("[data-undo-file]", file("a.txt")!)!.click();
        const ask = await waitFor("the question", () => $("[data-undo-ask]", file("a.txt")!), 15_000);
        const r = text($("[data-changes-note]")) ? "a note showed too" : "no note";
        if (!/after the agent did/.test(text(ask))) throw new Error(`asked: ${text(ask)}`);
        await shot("changes-refused", 900);
        // Keep my edits.
        $all("button", ask).find((b) => text(b) === "Keep my edits")?.click();
        return `${r} | asked: ${text(ask).slice(0, 160)}`;
      });
      await step("changes: keep and stage a.txt, then commit with a message", async () => {
        $("[data-keep-more]", file("a.txt")!)?.click();
        await sleep(400);
        const r = await press($("[data-keep-stage]"), "keep and stage a.txt");
        await waitFor("1 staged", () => $('[data-commit-box="1"]'), 15_000);
        const ta = $("[data-commit-message]") as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, COMMIT_MESSAGE);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(300);
        const c = await press($("[data-commit]"), "commit");
        if (!/Committed/.test(c)) throw new Error(c);
        await shot("changes-committed", 900);
        return `${r} | ${c}`;
      });
      await log("CHANGES-DONE");
    },

    async "changes-codex"() {
      let id = -1;
      await step("changes-codex: a stand-in Codex turn applies a patch (c.txt edited, d.txt added)", async () => {
        id = await start("codex", "Run the changes demo");
        const line = await waitFor("the files-changed line", () => $("[data-turn-files]"), 30_000);
        line.click();
        await waitFor("the panel at turn 1", () => $('[data-changes-panel="turn:1"]'), 20_000);
        await unreviewed();
        await waitFor("two files", () => $all("[data-changes-panel] [data-change-file]").length === 2, 30_000);
        const c = file("c.txt")!;
        const st = $("[data-file-status]", c)?.dataset.fileStatus;
        if (st !== "modified" || $all("[data-diff-line=del]", c).length !== 1) throw new Error(`c.txt ${st}`);
        await shot("changes-codex", 900);
        return `chat ${id}; ${text(line)}; c.txt ${st}, d.txt ${$("[data-file-status]", file("d.txt")!)?.dataset.fileStatus}`;
      });
      await step("changes-codex: undo c.txt (reconstructed from the patch), keep d.txt", async () => {
        const r = await press($("[data-undo-file]", file("c.txt")!), "undo c.txt");
        await waitFor("c.txt out of the Unreviewed view (undone)", () => !file("c.txt"), 15_000);
        const k2 = await press($("[data-keep-file]", file("d.txt")!), "keep d.txt");
        return `${r} | ${k2}`;
      });
      await log("CHANGES-CODEX-DONE");
    },
  };
}
