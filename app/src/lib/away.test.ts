// Unit tests for lib/away.ts: `node --test app/src/lib/away.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFor, chatAway, missionAway, shippedLabel, type AwayItem, type AwaySession } from "./away.ts";
import type { Change } from "./mission.ts";

const T = new Date(2026, 10, 18, 9, 0, 0).getTime();
const min = (m: number) => T + m * 60_000;
const prompt = (key: string, m: number, text: string): AwayItem => ({ kind: "prompt", key, ts: min(m), text });
const turn = (key: string, m: number, o: { failed?: boolean; ok?: boolean; dur?: number } = {}): AwayItem => ({ kind: "turn", key, ts: min(m), ok: o.ok ?? !o.failed, failed: !!o.failed, durationMs: (o.dur ?? 3) * 60_000 });
const change = (kind: Change["kind"], m: number, object = "src/a.ts", session = "claude:a"): Change => ({ id: `${session}|${kind}|${object}|${m}`, session, kind, action: kind, object, times: 1, ts: min(m), step: "c:x" });

// Left at 10, back at 130: two hours away.
const AWAY = { left: min(10), back: min(130) };

test("chatAway: counts failed and done turns after the mark, newest first, with files and what shipped", () => {
  const items: AwayItem[] = [
    prompt("p0", 0, "Before you left"),
    turn("t0", 5),
    prompt("p1", 20, "Add the PDF route\nwith details"),
    { kind: "tool", key: "x1", ts: min(21), ok: true },
    turn("t1", 24),
    prompt("p2", 40, "Run the migrations"),
    { kind: "tool", key: "x2", ts: min(41), ok: false, output: "error: relation \"users\" does not exist\nstack…" },
    turn("t2", 42, { failed: true }),
    prompt("p3", 60, "Push it"),
    turn("t3", 63),
  ];
  const changes = [change("edit", 22, "src/pdf.ts"), change("create", 23, "src/pdf.test.ts"), change("commit", 62), change("push", 62.5), change("edit", 3, "src/old.ts")];
  const a = chatAway(items, changes, AWAY);
  assert.equal(a.awayMs, 120 * 60_000);
  assert.equal(a.firstKey, "p1", "the card goes before the first item after the person left");
  assert.deepEqual(a.done.map((t) => t.key), ["t3", "t1"]);
  assert.deepEqual(a.failed.map((t) => [t.key, t.error, t.text]), [["t2", 'error: relation "users" does not exist', "Run the migrations"]]);
  assert.equal(a.done[1].text, "Add the PDF route", "the prompt's first line");
  assert.equal(a.done[1].files, 2);
  assert.deepEqual(a.done[0].shipped, ["committed", "pushed"]);
  assert.equal(a.files, 2, "files before the mark don't count");
  assert.deepEqual(a.shipped.map((c) => c.kind), ["push", "commit"]);
  assert.equal(a.worth, true);
});

test("chatAway: quiet for a short absence, for routine progress, and with nothing after the mark", () => {
  const items: AwayItem[] = [prompt("p1", 20, "Tidy the README"), turn("t1", 24)];
  // One finished turn with edits only: routine.
  assert.equal(chatAway(items, [change("edit", 22)], AWAY).worth, false);
  // Two finished turns: worth a card.
  const two = [...items, prompt("p2", 30, "And the changelog"), turn("t2", 33)];
  assert.equal(chatAway(two, [], AWAY).worth, true);
  // ...but not after four minutes away.
  assert.equal(chatAway(two, [], { left: min(29), back: min(33) }).worth, false);
  // A commit alone is worth a word.
  assert.equal(chatAway(items, [change("commit", 23)], AWAY).worth, true);
  // Nothing after the mark at all.
  const none = chatAway(two, [change("commit", 23)], { left: min(200), back: min(300) });
  assert.equal(none.worth, false);
  assert.equal(none.firstKey, null);
});

test("chatAway: a pending approval or question is never a reason to show (the chat's own card shows it)", () => {
  const items: AwayItem[] = [prompt("p1", 20, "Run the tests"), { kind: "permission", key: "perm", ts: min(21), answer: null }, { kind: "question", key: "q", ts: min(22), answer: null }];
  const a = chatAway(items, [], AWAY);
  assert.equal(a.worth, false);
  assert.equal(a.done.length + a.failed.length, 0);
});

test("chatAway: a stopped turn is not reported; a non-zero exit is", () => {
  const items: AwayItem[] = [prompt("p1", 20, "Long job"), turn("t1", 25, { ok: false }), { kind: "exited", key: "ex", ts: min(26), code: 1 }];
  const a = chatAway(items, [], AWAY);
  assert.equal(a.done.length + a.failed.length, 0);
  assert.deepEqual(a.exited, { key: "ex", code: 1 });
  assert.equal(a.worth, true);
  assert.equal(chatAway([prompt("p1", 20, "x"), { kind: "exited", key: "ex", ts: min(26), code: 0 }], [], AWAY).exited, null);
});

test("chatAway: subagent items don't start the card or count as turns", () => {
  const items: AwayItem[] = [prompt("p1", 5, "Fan out"), { kind: "tool", key: "sub", ts: min(15), parent: "task1", ok: true }, turn("t1", 40), prompt("p2", 50, "Again"), turn("t2", 55)];
  const a = chatAway(items, [], AWAY);
  assert.equal(a.firstKey, "t1");
  assert.equal(a.done.length, 2);
});

const sess = (key: string, o: Partial<AwaySession> = {}): AwaySession => ({ key, project: "/code/app", needs: false, busy: false, seenAt: null, lastEvent: 0, items: null, changes: [], ...o });

test("missionAway: totals across sessions, leaves out what Needs you shows, and sessions read since", () => {
  const chatA = sess("claude:a", { items: [prompt("p1", 20, "One"), turn("t1", 25), prompt("p2", 30, "Two"), turn("t2", 40, { failed: true })], changes: [change("commit", 24), change("push", 24.5)] });
  // Needs the person now: its finished turn and commit are not repeated in the strip.
  const needy = sess("claude:n", { needs: true, items: [prompt("p1", 20, "x"), turn("t1", 22)], changes: [change("commit", 21, "a", "claude:n")] });
  // A transcript session that finished while away.
  const term = sess("codex:t", { project: "/code/api", lastEvent: min(90) });
  // A transcript session still working: not "done".
  const busy = sess("codex:b", { busy: true, lastEvent: min(120) });
  // Opened after the person came back: read already.
  const read = sess("claude:r", { seenAt: min(131), items: [prompt("p1", 20, "x"), turn("t1", 22, { failed: true })] });
  // Looked at during the absence (on a phone, another window): only what came after counts.
  const peeked = sess("claude:p", { seenAt: min(100), items: [prompt("p1", 20, "x"), turn("t1", 50), prompt("p2", 105, "y"), turn("t2", 110)] });
  const m = missionAway([chatA, needy, term, busy, read, peeked], AWAY);
  assert.equal(m.failed, 1);
  assert.equal(m.done, 3, "chatA's t1, the transcript session, peeked's t2");
  assert.deepEqual(m.shipped, [{ kind: "commit", n: 1 }, { kind: "push", n: 1 }]);
  assert.equal(m.first.failed, "claude:a");
  assert.equal(m.first.done, "claude:p", "the most recent");
  assert.deepEqual(m.projects, ["/code/app", "/code/api"]);
  assert.equal(m.worth, true);
});

test("missionAway: quiet under ten minutes, for one finished session, and when only Needs you has news", () => {
  const one = sess("codex:t", { lastEvent: min(90) });
  assert.equal(missionAway([one], AWAY).worth, false, "one session finishing is routine");
  const two = [one, sess("codex:u", { lastEvent: min(100) })];
  assert.equal(missionAway(two, AWAY).worth, true);
  assert.equal(missionAway(two, { left: min(92), back: min(101) }).worth, false, "nine minutes away");
  const needy = sess("claude:n", { needs: true, items: [prompt("p1", 20, "x"), turn("t1", 22, { failed: true })] });
  assert.equal(missionAway([needy], AWAY).worth, false);
});

test("awayFor and shippedLabel", () => {
  assert.equal(awayFor(30_000), "1m");
  assert.equal(awayFor(45 * 60_000), "45m");
  assert.equal(awayFor(134 * 60_000), "2h 14m");
  assert.equal(awayFor(120 * 60_000), "2h");
  assert.equal(awayFor(50 * 3600_000), "2d 2h");
  assert.equal(shippedLabel("commit", 3), "3 commits");
  assert.equal(shippedLabel("pr", 1), "1 PR");
});
