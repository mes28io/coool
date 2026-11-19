// Unit tests for lib/notifyRoute.ts: `node --test app/src/lib/notifyRoute.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { canDecide, destination, type NotifyClick, type RouteContext } from "./notifyRoute.ts";

const click = (o: Partial<NotifyClick>): NotifyClick => ({ kind: "needs", chat: 3, session: "claude:abc", request: "r1", action: "default", ...o });
const ctx = (o: Partial<RouteContext> = {}): RouteContext => ({ sessions: [{ key: "claude:abc", chat: 3 }, { key: "codex:x", chat: null }], needs: ["claude:abc"], chats: [3], ...o });

test("needs you: the Needs you page with that session picked while it still waits", () => {
  assert.deepEqual(destination(click({}), ctx()), { to: "needs", key: "claude:abc" });
  // The session key alone (a click that launched coool: no chat id) finds it too.
  assert.deepEqual(destination(click({ chat: null }), ctx()), { to: "needs", key: "claude:abc" });
  // Before discovery linked a session key: found through its chat.
  assert.deepEqual(destination(click({ session: null }), ctx()), { to: "needs", key: "claude:abc" });
});

test("needs you, already answered: its chat, never an empty page", () => {
  assert.deepEqual(destination(click({}), ctx({ needs: [] })), { to: "session", key: "claude:abc" });
  assert.deepEqual(destination(click({}), ctx({ needs: ["codex:x"] })), { to: "session", key: "claude:abc" });
  // No session listed yet but the chat is this run's: the chat itself.
  assert.deepEqual(destination(click({ session: null }), ctx({ sessions: [], needs: [] })), { to: "chat", id: 3 });
  // Nothing of it left (an old run's chat, its transcript gone): just bring coool forward.
  assert.deepEqual(destination(click({ chat: null, session: "claude:gone" }), ctx()), { to: "app" });
});

test("finished and failed open the chat; the test and unknown kinds only bring coool forward", () => {
  assert.deepEqual(destination(click({ kind: "finished" }), ctx()), { to: "session", key: "claude:abc" });
  assert.deepEqual(destination(click({ kind: "failed", session: "codex:x", chat: null }), ctx()), { to: "session", key: "codex:x" });
  assert.deepEqual(destination(click({ kind: "test", chat: null, session: null }), ctx()), { to: "app" });
  assert.deepEqual(destination(click({ kind: "app" }), ctx()), { to: "app" });
});

test("canDecide waits for the sessions, and for the named one while the first load runs", () => {
  assert.equal(canDecide(click({}), false, true, ctx()), false);
  assert.equal(canDecide(click({}), true, false, ctx()), true);
  assert.equal(canDecide(click({ session: "claude:later" }), true, true, ctx()), false);
  assert.equal(canDecide(click({ session: "claude:later" }), true, false, ctx()), true);
  assert.equal(canDecide(click({ session: null }), true, true, ctx()), true);
});
