import { test } from "node:test";
import assert from "node:assert/strict";
import { asksRestart, parseRestart, restartAsk, restartOffer } from "./restartRules.ts";
import type { ChatItem } from "./chat.ts";

test("/restart, with or without a message", () => {
  assert.deepEqual(parseRestart("/restart"), { message: "" });
  assert.deepEqual(parseRestart("  /restart  "), { message: "" });
  assert.deepEqual(parseRestart("/restart continue"), { message: "continue" });
  assert.deepEqual(parseRestart("/Restart  go on with step 2 "), { message: "go on with step 2" });
  assert.deepEqual(parseRestart("/restart continue\nand then run the tests"), { message: "continue\nand then run the tests" });
  for (const no of ["/restarts", "/restartnow", "restart", "please /restart", "/resume", "", "/"]) assert.equal(parseRestart(no), null, no);
});

test("a reply that asks for a restart", () => {
  for (const yes of [
    "I added the server to .mcp.json. Restart Claude Code, then come back and type continue.",
    "Please restart claude so it picks up the new settings.",
    "You'll need to restart your Claude Code session for the hook to load.",
    "Restart the session and I'll carry on.",
    "Done. Restart Codex, then say continue.",
    "The config changed: relaunch, then type continue.",
    "After restarting Claude Code, run /mcp to check it's connected.",
  ])
    assert.ok(asksRestart(yes), yes);
});

test("no button otherwise (conservative)", () => {
  for (const no of [
    "Done. The tests pass.",
    "Restart the dev server to see the change.",
    "I restarted the server; it's listening on 3000.",
    "No need to restart Claude Code: the setting applies right away.",
    "This works without restarting the session.",
    "Don't relaunch, it reloads on its own.",
    "Relaunch the app and open Settings.",
    "Run `claude --resume` or `restart claude` in a script:\n```sh\nrestart claude code\n```",
    "Restarting the simulator fixed it.",
  ])
    assert.ok(!asksRestart(no), no);
});

const text = (key: string, t: string, extra: Partial<Extract<ChatItem, { kind: "text" }>> = {}): ChatItem => ({ kind: "text", key, id: key, text: t, ts: 1, streaming: false, parent: null, model: null, ...extra });
const ASKING = "Restart Claude Code, then type continue.";

test("the offer sits under the last reply only, until something follows it", () => {
  const turn: ChatItem = { kind: "turn", key: "t", ts: 2, durationMs: 1, ok: true, failed: false, tools: 0, tokens: null };
  assert.equal(restartOffer([text("a", ASKING), turn]), "a");
  assert.equal(restartOffer([text("a", ASKING)]), "a");
  // A subagent's text after it doesn't count; a newer reply, prompt or the restart's notice ends it.
  assert.equal(restartOffer([text("a", ASKING), text("s", "Restart the server", { parent: "tool1" }), turn]), "a");
  assert.equal(restartOffer([text("a", ASKING), text("b", "All set.")]), null);
  assert.equal(restartOffer([text("a", ASKING), turn, { kind: "prompt", key: "p", id: "p", text: "continue", ts: 3 }]), null);
  assert.equal(restartOffer([text("a", ASKING), turn, { kind: "notice", key: "n", level: "info", text: "Restarted Claude Code", needsTerminal: false, ts: 3 }]), null);
  assert.equal(restartOffer([text("a", ASKING, { streaming: true })]), null, "not while it is still being written");
  assert.equal(restartOffer([text("a", "All set.")]), null);
  assert.equal(restartOffer([]), null);
});

test("the confirmation names the CLI", () => {
  assert.equal(restartAsk("claude").title, "Claude is working. Restart anyway?");
  assert.equal(restartAsk("codex").title, "Codex is working. Restart anyway?");
  assert.match(restartAsk("claude").body, /^The current step is stopped\./);
});
