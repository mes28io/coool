// Unit tests for lib/mission.ts: `node --test app/src/lib/mission.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cellCounts, cellState, changesFromActivity, changesFromChat, committing, compactSpan, fanout, foldAgentRows, heredocs, hmsToMs, ledgerRows, lineCounts, mergeChanges, projectPath, relPath, sideEffect, wordDiff, type ItemLike } from "./mission.ts";
import type { Activity } from "./types.ts";

const NOW = new Date(2026, 10, 18, 15, 0, 0).getTime();
const at = (h: number, m: number, s = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
const tool = (text: string, ts: string, extra: Partial<Activity> = {}): Activity => ({ ts, kind: "tool", text, ...extra });

test("relPath: inside the project, home-shortened, and outside", () => {
  assert.equal(relPath("/Users/you/code/app/src/a.ts", "/Users/you/code/app"), "src/a.ts");
  assert.equal(relPath("~/code/app/src/a.ts", "/Users/you/code/app"), "src/a.ts");
  assert.equal(relPath("/private/tmp/x/y/z.ts", "/tmp/x"), "y/z.ts");
  assert.equal(relPath("/etc/nginx/sites/default", "/Users/you/code/app"), "sites/default");
});

test("hmsToMs: today, or yesterday when it would be in the future", () => {
  assert.equal(hmsToMs("14:59:00", NOW), NOW - 60_000);
  assert.equal(hmsToMs("23:00:00", NOW), new Date(2026, 10, 17, 23, 0, 0).getTime());
  assert.equal(hmsToMs("garbage", NOW), null);
});

test("sideEffect: git, gh, deploys, and read-only commands", () => {
  assert.deepEqual(sideEffect(`git add -A && git commit -m "Retry failed webhooks in queue.ts"`), { kind: "commit", action: "Committed", object: "Retry failed webhooks in queue.ts", detail: undefined });
  assert.equal(sideEffect(`git commit -am 'Bump version'`)?.object, "Bump version", "combined -am carries the message");
  assert.equal(sideEffect(`git commit -qam "Quiet one"`)?.object, "Quiet one");
  assert.equal(sideEffect(`git commit --message="Fix it"`)?.object, "Fix it");
  const push = sideEffect("git push -u origin HEAD", "invoice-pdf");
  assert.equal(push?.kind, "push");
  assert.equal(push?.before, "invoice-pdf");
  assert.equal(push?.after, "origin/invoice-pdf");
  const merge = sideEffect("git merge --no-ff worktree-agent-ab12", "main");
  assert.deepEqual([merge?.action, merge?.before, merge?.after], ["Merged", "worktree-agent-ab12", "main"]);
  assert.equal(sideEffect("git merge --abort"), null);
  const pr = sideEffect(`gh pr create --title "Pricing page v2" --base main`, "pricing-v2");
  assert.deepEqual([pr?.action, pr?.object, pr?.before, pr?.after], ["Opened PR", "Pricing page v2", "pricing-v2", "main"]);
  assert.equal(sideEffect("npx vercel --prod")?.kind, "deploy");
  assert.equal(sideEffect("fly deploy")?.detail, "Fly");
  assert.equal(sideEffect("rm -rf dist build")?.object, "dist");
  assert.equal(sideEffect("git -C /x/y push")?.kind, "push");
  assert.equal(sideEffect(`curl -X POST https://api.example.com/v1/hooks -d '{}'`)?.object, "api.example.com/v1/hooks");
  for (const ro of ["git status --short", "git log --oneline", "cargo test", "pnpm tsc --noEmit", "curl https://example.com", "git diff HEAD~1"]) assert.equal(sideEffect(ro), null, ro);
});

test("committing: only a git commit in progress", () => {
  assert.equal(committing(`Bash · git commit -m "Add the PDF route"`), "Add the PDF route");
  assert.equal(committing("Bash · git commit"), "");
  assert.equal(committing("Bash · cargo test"), null);
  assert.equal(committing("Edit · ~/a.ts"), null);
  assert.equal(committing(null), null);
});

test("lineCounts and wordDiff", () => {
  assert.deepEqual(lineCounts("a\nb\nc", "a\nB\nc\nd"), { added: 2, removed: 1 });
  assert.deepEqual(lineCounts("", "x\ny"), { added: 2, removed: 0 });
  const d = wordDiff("Retry every 5 seconds until it works.", "Retry with exponential backoff until it works.");
  assert.deepEqual(
    d.filter((p) => p.op !== "same").map((p) => [p.op, p.text.trim()]),
    [
      ["del", "every 5 seconds"],
      ["add", "with exponential backoff"],
    ],
  );
  // Kept + struck parts give the old text back, kept + added the new one.
  assert.equal(d.filter((p) => p.op !== "add").map((p) => p.text).join(""), "Retry every 5 seconds until it works.");
  assert.equal(d.filter((p) => p.op !== "del").map((p) => p.text).join(""), "Retry with exponential backoff until it works.");
  assert.deepEqual(wordDiff("same", "same"), [{ op: "same", text: "same" }]);
});

test("changesFromActivity: edits coalesce per turn, failed steps and reads are skipped, git and artifacts show", () => {
  const root = "/Users/you/code/app";
  const act: Activity[] = [
    { ts: at(14, 0), kind: "prompt", text: "Fix the queue" },
    tool("Read · ~/code/app/src/queue.ts", at(14, 1)),
    tool("Edit · ~/code/app/src/queue.ts", at(14, 2)),
    tool("Edit · ~/code/app/src/queue.ts", at(14, 3)),
    tool("Bash · cargo test", at(14, 4)),
    tool(`Bash · git commit -m "Retry failed webhooks"`, at(14, 5)),
    tool("Bash · git push origin main", at(14, 6)),
    { ts: at(14, 6, 1), kind: "error", text: "rejected: non-fast-forward", step: true },
    { ts: at(14, 7), kind: "prompt", text: "And the docs" },
    tool("Edit · ~/code/app/src/queue.ts", at(14, 8)),
    tool("Write · ~/code/app/docs/queue.md", at(14, 9)),
    tool("Artifact · page.html", at(14, 10), { artifact: { url: "https://claude.ai/artifact/x", version: 3, file_path: "/p.html", title: "Queue guide" } }),
    tool("mcp__coool-device__pilot_run · Open Settings and read the iOS version", at(14, 11)),
  ];
  const rows = changesFromActivity("claude:s1", act, root, "main", NOW);
  assert.deepEqual(
    rows.map((r) => [r.action, r.object, r.times]),
    [
      ["Drove the device", "Open Settings and read the iOS version", 1],
      ["Published", "Queue guide", 1],
      ["Wrote", "docs/queue.md", 1],
      ["Edited", "src/queue.ts", 1],
      ["Committed", "Retry failed webhooks", 1],
      ["Edited", "src/queue.ts", 2],
    ],
  );
  const pub = rows[1];
  assert.deepEqual([pub.before, pub.after], ["v2", "v3"]);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(rows[5].step, "a:3", "a coalesced row points at its latest step");
  // Same rows, same ids on the next payload (ids don't depend on position).
  const again = changesFromActivity("claude:s1", [...act, tool("Read · x", at(14, 12))], root, "main", NOW);
  assert.deepEqual(again.map((r) => r.id), rows.map((r) => r.id));
});

test("changesFromChat: line counts, before/after, patches, and only successful calls", () => {
  const root = "/Users/you/code/app";
  const t = (id: string, name: string, input: unknown, ok: boolean | null = true, output = "ok"): ItemLike => ({ kind: "tool", id, name, summary: "", input, ts: NOW - 10_000, endTs: NOW - 9_000, ok, output, parent: null });
  const items: ItemLike[] = [
    { kind: "prompt", key: "p1" },
    t("t1", "Edit", { file_path: `${root}/src/price.ts`, old_string: "const PRO = 29;", new_string: "const PRO = 34;" }),
    t("t2", "Edit", { file_path: `${root}/src/queue.ts`, old_string: "a\nb", new_string: "a\nc\nd" }),
    t("t3", "Edit", { file_path: `${root}/src/queue.ts`, old_string: "x", new_string: "y\nz" }),
    t("t4", "Write", { file_path: `${root}/src/new.ts`, content: "1\n2\n3\n" }, true, "File created successfully"),
    t("t5", "Edit", { file_path: `${root}/src/denied.ts`, old_string: "a", new_string: "b" }, false),
    t("t6", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n+more\n*** Add File: src/b.rs\n+fn b() {}\n*** End Patch" }),
    t("t7", "Bash", { command: "git commit -m 'Raise the Pro price'" }),
    t("t8", "Bash", { command: "git commit -m 'never ran'" }, null),
  ];
  const rows = changesFromChat("claude:c1", items, root, "main");
  const by = Object.fromEntries(rows.map((r) => [r.object, r]));
  assert.deepEqual([by["src/price.ts"].before, by["src/price.ts"].after, by["src/price.ts"].added, by["src/price.ts"].removed], ["const PRO = 29;", "const PRO = 34;", 1, 1]);
  assert.deepEqual([by["src/queue.ts"].times, by["src/queue.ts"].added, by["src/queue.ts"].removed, by["src/queue.ts"].before], [2, 4, 2, undefined]);
  assert.deepEqual([by["src/new.ts"].action, by["src/new.ts"].added], ["Created", 3]);
  assert.equal(by["src/denied.ts"], undefined);
  assert.deepEqual([by["src/lib.rs"].added, by["src/lib.rs"].removed], [2, 1]);
  assert.equal(by["src/b.rs"].action, "Created");
  assert.equal(by["Raise the Pro price"].kind, "commit");
  assert.equal(rows.filter((r) => r.kind === "commit").length, 1, "a call still running is not a change yet");
});

test("mergeChanges: newest first, capped", () => {
  const mk = (id: string, ts: number) => ({ id, session: "s", kind: "edit" as const, action: "Edited", object: id, times: 1, ts, step: id });
  assert.deepEqual(mergeChanges([[mk("a", 1), mk("c", 3)], [mk("b", 2)]], 2).map((r) => r.id), ["c", "b"]);
});

test("fanout: the latest turn's agents, while any runs or shortly after", () => {
  const c = (id: string, state: "running" | "done" | "failed" | "needs", startedAt: number, lastAt = startedAt, stopped = false) => ({ id, state, startedAt, lastAt, stopped });
  const cards = [c("old", "done", NOW - 600_000), c("a", "running", NOW - 30_000), c("b", "done", NOW - 30_000, NOW - 5_000), c("d", "failed", NOW - 29_000, NOW - 2_000, true)];
  assert.deepEqual(fanout(cards, NOW - 60_000, NOW).map((x) => x.id), ["a", "b", "d"]);
  assert.deepEqual(fanout(cards.slice(0, 2), NOW - 60_000, NOW), [], "one agent is not a fan-out");
  const finished = [c("a", "done", NOW - 300_000, NOW - 200_000), c("b", "done", NOW - 300_000, NOW - 200_000)];
  assert.deepEqual(fanout(finished, null, NOW), [], "gone a while after the last one finished");
  assert.equal(fanout(finished, null, NOW - 150_000).length, 2);
  assert.deepEqual(cellCounts(cards.map(cellState)), { running: 1, needs: 0, failed: 0, stopped: 1, done: 2 });
});

test("foldAgentRows: many subagent file rows become one row that says how many files, agents and where", () => {
  const r = (id: string, object: string, ts: number, agent: string | null, kind: "edit" | "create" | "commit" = "edit") => ({ id, session: "s", kind, action: "Edited", object, times: 1, ts, step: agent ? `g:${agent}` : `a:${id}`, added: 2, removed: 1 });
  const rows = [r("a", "app/src/x.rs", 9, "g1"), r("own", "main.rs", 8, null), r("b", "app/src/y.rs", 7, "g2"), r("c", "crates/core/z.rs", 6, "g3", "create"), r("d", "app/src/x.rs", 5, "g1"), r("f", "docs/w.md", 4.5, "g2"), r("e", "c", 4, "g1", "commit")];
  const agentOf = (c: { step: string }) => (c.step.startsWith("g:") ? c.step.slice(2) : null);
  const out = foldAgentRows(rows, agentOf);
  assert.deepEqual(
    out.map((c) => [c.action, c.object, c.detail ?? ""]),
    [
      ["Agents edited", "4 files", "3 agents · app/src, crates/core and 1 more"],
      ["Edited", "main.rs", ""],
      ["Edited", "c", ""],
    ],
    "writes and edits fold together; the same file twice counts once",
  );
  assert.deepEqual([out[0].added, out[0].removed, out[0].ts], [10, 5, 9]);
  assert.equal(foldAgentRows(rows.slice(0, 4), agentOf).length, 4, "three files or fewer stay as they are");
});

test("heredocs and commit messages: -F - with a heredoc, -m \"$(cat <<EOF)\", one-line timeline form", () => {
  const full = "git add -A && git commit -q -F - <<'EOF'\nMission control: one system\n\nLonger body; with | pipes && ands.\n\nCo-Authored-By: X <x@y>\nEOF";
  assert.equal(sideEffect(full)?.object, "Mission control: one system");
  const subst = `git commit -m "$(cat <<'EOF'\nTrail owns git history\n\nBody\nEOF\n)"`;
  assert.equal(sideEffect(subst)?.object, "Trail owns git history");
  // The timeline collapses newlines; the subject is the start of the body, clipped.
  const oneLine = "git commit -q -F - <<'EOF' Ledger: drop scratch deletes EOF";
  assert.equal(sideEffect(oneLine)?.object, "Ledger: drop scratch deletes");
  assert.equal(committing("Bash · git commit -q -F - <<'EOF' Fold agent rows EOF"), "Fold agent rows");
  assert.equal(heredocs("cat <<EOF\na\nb\nEOF\necho hi").cmd, "cat <<HEREDOC\necho hi");
  assert.equal(sideEffect("git commit -q -F /tmp/msg.txt")?.object, "a commit", "a message file isn't read");
});

test("projectPath: inside the project, worktrees, and what is not the project", () => {
  const root = "/Users/you/code/app";
  assert.equal(projectPath("/Users/you/code/app/src/a.ts", root), "src/a.ts");
  assert.equal(projectPath("~/code/app/src/a.ts", root), "src/a.ts");
  assert.equal(projectPath("/Users/you/code/app/.claude/worktrees/agent-a1/src/a.ts", root), "src/a.ts", "a worktree's file is the project's file");
  assert.equal(projectPath("src/a.ts", root), "src/a.ts");
  for (const out of ["/private/tmp/claude-501/scratch/shot.mjs", "/tmp/x.txt", "/var/folders/ab/T/x", "/Users/you/.claude/projects/m.md", "/Users/you/other/a.ts", "$S/bb-br", "${TMP}/x", "/Users/you/code/app/node_modules/x/i.js", "/Users/you/code/app/target/debug/a", "/Users/you/code/app/app/dist/index.js", "app/build/out.js", "/Users/you/code/app/.claude/settings.json", "../elsewhere/a"])
    assert.equal(projectPath(out, root), null, out);
});

test("sideEffect with the project root: scratch and throwaway deletes are not changes", () => {
  const root = "/Users/you/code/app";
  assert.equal(sideEffect(`rm -rf "$S/bb-br" "$S/br-dark"`, null, root), null, "a $VAR scratch path");
  assert.equal(sideEffect("rm -f /private/tmp/claude-501/x/ip-full.png", null, root), null, "temp folder");
  assert.equal(sideEffect("cd /private/tmp/scratch && rm -rf bb-br br-dark", null, root), null, "after cd to a temp folder");
  assert.equal(sideEffect(`cd "$S" && rm ip-full`, null, root), null, "after cd to a variable");
  assert.equal(sideEffect("rm -f shot.png server.log", null, root), null, "screenshots and logs");
  assert.equal(sideEffect("rm -rf dist target node_modules", null, root), null, "generated folders");
  assert.equal(sideEffect("rm -rf ~/elsewhere/x", null, root), null, "outside the project");
  const real = sideEffect("rm src/old.ts src/older.ts", null, root);
  assert.deepEqual([real?.object, real?.detail], ["src/old.ts", "and 1 more"]);
  assert.equal(sideEffect("cd app && rm src/old.ts", null, "/Users/you/code")?.object, "app/src/old.ts", "cd inside the project");
  assert.equal(sideEffect("cd .claude/worktrees/agent-x && rm src/gone.ts", null, root)?.object, "src/gone.ts", "cd into a worktree");
  assert.equal(sideEffect("git rm -q src/legacy.ts", null, root)?.object, "src/legacy.ts");
  assert.equal(sideEffect("mv /tmp/a.png /tmp/b.png", null, root), null);
  for (const hk of ["git worktree remove .claude/worktrees/agent-x --force", "git branch -d worktree-agent-x", "git branch -D worktree-agent-x", "git worktree prune"]) assert.equal(sideEffect(hk, "main", root), null, hk);
  assert.equal(sideEffect("curl -X POST http://localhost:5173/api/x", null, root), null, "a request to this machine");
});

test("changesFromActivity: scratch writes outside the project are not changes; worktree files map to the project", () => {
  const root = "/Users/you/code/app";
  const act: Activity[] = [
    { ts: at(14, 0), kind: "prompt", text: "Go" },
    tool("Write · /private/tmp/claude-501/x/scratchpad/shot.mjs", at(14, 1)),
    tool("Write · ~/.claude/projects/m/memory/x.md", at(14, 2)),
    tool("Edit · ~/code/app/.claude/worktrees/agent-a1/src/a.ts", at(14, 3)),
    tool(`Bash · rm -rf "$S/bb-br"`, at(14, 4)),
  ];
  assert.deepEqual(changesFromActivity("claude:s", act, root, null, NOW).map((c) => [c.action, c.object]), [["Edited", "src/a.ts"]]);
});

test("ledgerRows: the trail owns git history; committed edits leave; pushes and uncommitted edits stay", () => {
  const mk = (id: string, kind: "edit" | "commit" | "merge" | "push" | "deploy", object: string, ts: number, agent: string | null = null, action = kind === "merge" ? "Merged" : "x") => ({ id, session: "s", kind, action, object, times: 1, ts, step: agent ? `g:${agent}` : `a:${id}` });
  const agentOf = (c: { step: string }) => (c.step.startsWith("g:") ? c.step.slice(2) : null);
  const rows = [
    mk("deploy", "deploy", "to production", 90),
    mk("push", "push", "main", 80),
    mk("merge", "merge", "worktree-agent-a", 70),
    mk("wip", "edit", "src/wip.ts", 65),
    mk("commit", "commit", "Fix it", 60),
    mk("done", "edit", "src/fixed.ts", 50),
    mk("agentEdit", "edit", "src/agent.ts", 40, "g1"),
    mk("agentCommit", "commit", "Agent work", 45, "g1"),
    mk("otherAgent", "edit", "src/other.ts", 30, "g2"),
    mk("onTrail", "edit", "src/trail.ts", 20, "g3"),
    mk("prMerge", "merge", "#12", 10, null, "Merged PR"),
  ];
  const trail = [{ time_ms: 25, files: ["src/trail.ts"], merge: null }];
  assert.deepEqual(
    ledgerRows(rows, { agentOf, trail }).map((c) => c.id),
    ["deploy", "push", "wip", "otherAgent", "prMerge"],
  );
  assert.deepEqual(
    ledgerRows(rows, { agentOf, trail: null }).map((c) => c.id),
    ["deploy", "push", "merge", "wip", "commit", "agentCommit", "otherAgent", "onTrail", "prMerge"],
    "without a trail (not a repository) the git rows stay; only author-committed edits leave",
  );
});

test("fanout: background agents from earlier turns still count while they run", () => {
  const c = (id: string, state: "running" | "done", startedAt: number, lastAt = startedAt) => ({ id, state, startedAt, lastAt, stopped: false });
  const turn = NOW - 60_000;
  const cards = [c("bg1", "running", NOW - 900_000), c("bg2", "running", NOW - 800_000), c("oldDone", "done", NOW - 900_000)];
  assert.deepEqual(fanout(cards, turn, NOW).map((x) => x.id), ["bg1", "bg2"], "the row's \"2 agents working\" has its fan-out");
  assert.deepEqual(fanout([cards[0]], turn, NOW), [], "one worker is not a fan-out");
  assert.deepEqual(fanout([cards[0]], turn, NOW, 90_000, 1).map((x) => x.id), ["bg1"], "one agent and one background shell are");
});

test("compactSpan: one format for ages and elapsed times", () => {
  assert.deepEqual([5_000, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000 * 3].map(compactSpan), ["5s", "59s", "1m", "59m", "1h", "3d"]);
});

test("ledgerRows: the same uncommitted file from several sessions is one row", () => {
  const mk = (id: string, session: string, ts: number) => ({ id, session, kind: "edit" as const, action: "Edited", object: "src/a.ts", times: 1, ts, step: `a:${id}`, added: 1, removed: 0 });
  const out = ledgerRows([mk("x", "s1", 9), mk("y", "s2", 5), mk("z", "s1", 3)], { agentOf: () => null, trail: [] });
  assert.deepEqual(out.map((c) => [c.id, c.times, c.added]), [["x", 3, 3]]);
});
