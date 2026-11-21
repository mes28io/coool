// Unit tests for lib/folderRules.ts: `node --test app/src/lib/folderRules.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { crumbs, freshName, guardedPlace, nameProblem, parentOf, recentProjects, searchFolders, sessionsIn, tilde, typeSelect, untilde, workingHere, type Candidate, type SessionLike } from "./folderRules.ts";

const H = "/Users/p";
const s = (cwd: string, updated: number, extra: Partial<SessionLike> = {}): SessionLike => ({ provider: "claude", id: `${cwd}-${updated}`, cwd, status: "ended", pid: null, updated, ...extra });

test("recent projects: newest first, counted, both CLIs", () => {
  const r = recentProjects([
    s(`${H}/code/a`, 10),
    s(`${H}/code/b`, 30, { provider: "codex" }),
    s(`${H}/code/a`, 50, { provider: "codex" }),
    s(`${H}/code/a/.claude/worktrees/x`, 5, { project: `${H}/code/a` }),
    s("", 99),
  ]);
  assert.deepEqual(r.map((x) => [x.path, x.count, x.last]), [[`${H}/code/a`, 3, 50], [`${H}/code/b`, 1, 30]]);
  assert.deepEqual(r[0].providers, ["claude", "codex"]);
});

test("sessions in a folder and who works in this copy now", () => {
  const all = [
    s(`${H}/code/a`, 1, { status: "busy" }),
    s(`${H}/code/a/sub`, 2, { status: "idle", pid: 4 }),
    s(`${H}/code/a/.coool/worktrees/w`, 3, { status: "busy", project: `${H}/code/a` }),
    s(`${H}/code/a`, 4),
    s(`${H}/code/ab`, 5, { status: "busy" }),
    s(`${H}/code/a`, 6, { status: "idle" }),
  ];
  assert.deepEqual(sessionsIn(all, `${H}/code/a/`).map((x) => x.updated), [6, 4, 3, 2, 1]);
  assert.deepEqual(workingHere(all, `${H}/code/a`).map((x) => x.updated), [1, 2]);
  assert.deepEqual(sessionsIn(all, `${H}/code`, false).length, 0, "a folder of projects isn't their session list");
  assert.deepEqual(sessionsIn(all, `${H}/code/a`, false).map((x) => x.updated), [6, 4, 3, 1]);
  assert.deepEqual(workingHere(all, `${H}/code`, false).length, 0);
  assert.deepEqual(workingHere([s(`${H}/x`, 1, { status: "idle", chat: 3 })], `${H}/x`).length, 1);
});

test("paths: parent, crumbs, tilde", () => {
  assert.equal(parentOf(`${H}/code/a/`), `${H}/code`);
  assert.equal(parentOf("/Users"), "/");
  assert.equal(parentOf("/"), null);
  assert.equal(parentOf("~/x"), null);
  assert.deepEqual(crumbs(`${H}/code/a`, H).map((c) => c.label), ["p", "code", "a"]);
  assert.deepEqual(crumbs(`${H}/code/a`, H).at(-1)!.path, `${H}/code/a`);
  assert.deepEqual(crumbs("/Volumes/USB/x", H).map((c) => [c.label, c.path]), [["/", "/"], ["Volumes", "/Volumes"], ["USB", "/Volumes/USB"], ["x", "/Volumes/USB/x"]]);
  assert.deepEqual(crumbs("/", H).map((c) => c.label), ["/"]);
  assert.equal(tilde(`${H}/code`, H), "~/code");
  assert.equal(tilde(`${H}x/code`, H), `${H}x/code`);
  assert.equal(untilde("~/code", H), `${H}/code`);
  assert.equal(untilde("~", H), H);
});

test("guarded places match the backend's", () => {
  assert.equal(guardedPlace(`${H}/Desktop`, H), "Desktop");
  assert.equal(guardedPlace(`${H}/Documents/x/y`, H), "Documents");
  assert.equal(guardedPlace(`${H}/Library/Mobile Documents/x`, H), "iCloud Drive");
  assert.equal(guardedPlace("/Volumes/USB", H), "Volumes");
  assert.equal(guardedPlace("/Volumes", H), null);
  assert.equal(guardedPlace(`${H}/DesktopX`, H), null);
  assert.equal(guardedPlace(`${H}/code/Desktop`, H), null);
});

test("search: name starts beat scattered matches; recent beats repo beats folder; one row per path", () => {
  const c: Candidate[] = [
    { path: `${H}/code/atlas-api`, name: "atlas-api", source: "repo", repo: true },
    { path: `${H}/code/atlas-api`, name: "atlas-api", source: "recent" },
    { path: `${H}/old/atlas`, name: "atlas", source: "folder" },
    { path: `${H}/code/a-t-l-a-s`, name: "a-t-l-a-s", source: "repo", repo: true },
    { path: `${H}/code/pixelforge`, name: "pixelforge", source: "repo", repo: true },
  ];
  const r = searchFolders("atlas", c);
  assert.deepEqual(r.map((x) => x.path), [`${H}/old/atlas`, `${H}/code/atlas-api`, `${H}/code/a-t-l-a-s`]);
  assert.equal(r[1].source, "recent");
  assert.deepEqual(searchFolders("atl code", c).map((x) => x.path), [`${H}/code/atlas-api`, `${H}/code/a-t-l-a-s`]);
  assert.deepEqual(searchFolders("  ", c), []);
  assert.deepEqual(searchFolders("zzz", c), []);
  assert.equal(searchFolders("a", c, 2).length, 2);
});

test("type to select, Finder's way", () => {
  const names = ["api", "Assets", "build", "bundle", "docs"];
  assert.equal(typeSelect(names, "b", 0), 2);
  assert.equal(typeSelect(names, "bu", 0), 2);
  assert.equal(typeSelect(names, "bun", 0), 3);
  assert.equal(typeSelect(names, "AS", 0), 1);
  assert.equal(typeSelect(names, "bb", 2), 3, "the same letter again steps on");
  assert.equal(typeSelect(names, "bb", 3), 2, "and wraps");
  assert.equal(typeSelect(names, "oc", 0), 4, "contains, when nothing starts with it");
  assert.equal(typeSelect(names, "zz", 0), -1);
  assert.equal(typeSelect(names, "", 0), -1);
});

test("new folder names", () => {
  assert.equal(nameProblem("", []), "Give the folder a name");
  assert.equal(nameProblem("a/b", []), "A folder name can't contain “/” or “:”");
  assert.equal(nameProblem("a:b", []), "A folder name can't contain “/” or “:”");
  assert.equal(nameProblem("..", []), "That name is taken by the system");
  assert.equal(nameProblem("API", ["api"]), "“API” already exists here");
  assert.equal(nameProblem("x".repeat(256), []), "That name is too long");
  assert.equal(nameProblem(" new-app ", ["api"]), null);
  assert.equal(freshName([]), "untitled folder");
  assert.equal(freshName(["untitled folder", "Untitled Folder 2"]), "untitled folder 3");
});
