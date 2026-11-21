// Run: node --test app/src/lib/chatContext.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNameFor, grouped, lineCount, loadWord, onDiskChange, splitFrontmatter, tildePath, validSkillName, type CtxItem } from "./chatContext.ts";

const item = (o: Partial<CtxItem>): CtxItem => ({
  id: "x",
  group: "instructions",
  kind: "project",
  label: "x",
  source: "Project",
  path: null,
  description: null,
  tokens: 0,
  full_tokens: 0,
  load: "start",
  used: false,
  editable: false,
  depth: 0,
  note: null,
  text: null,
  ...o,
});

test("groups keep the panel's order and sum their tokens", () => {
  const g = grouped([item({ group: "skills", tokens: 3 }), item({ tokens: 10 }), item({ group: "skills", tokens: 4 }), item({ group: "coool", tokens: 1 })]);
  assert.deepEqual(
    g.map((x) => [x.group, x.items.length, x.tokens]),
    [
      ["instructions", 1, 10],
      ["skills", 2, 7],
      ["coool", 1, 1],
    ],
  );
});

test("load words", () => {
  assert.equal(loadWord(item({})), "loaded at start");
  assert.equal(loadWord(item({ group: "skills", load: "listed" })), "listed at start");
  assert.equal(loadWord(item({ group: "skills", load: "listed", used: true })), "used in this session");
  assert.equal(loadWord(item({ group: "memory", kind: "memory", load: "on_demand" })), "read when needed");
  assert.equal(loadWord(item({ load: "conditional" })), "once the folder is trusted");
});

test("names", () => {
  assert.equal(fileNameFor("  Release, checklist! "), "release-checklist");
  assert.equal(fileNameFor("!!"), "memory");
  assert.ok(validSkillName("deploy-2") && !validSkillName("Deploy") && !validSkillName("-x") && !validSkillName("a/b"));
  assert.equal(tildePath("/Users/a/x/CLAUDE.md", "/Users/a"), "~/x/CLAUDE.md");
  assert.equal(tildePath("/Users/ab/x", "/Users/a"), "/Users/ab/x");
});

test("frontmatter is split off for the rendered view", () => {
  const s = splitFrontmatter('---\nname: thing\ndescription: "A: b"\nmetadata:\n  type: project\n---\n\nBody\n');
  assert.deepEqual(s.meta, [
    ["name", "thing"],
    ["description", "A: b"],
  ]);
  assert.equal(s.body, "\nBody\n");
  assert.deepEqual(splitFrontmatter("# Plain\n"), { meta: [], body: "# Plain\n" });
});

test("line count and changes on disk", () => {
  assert.equal(lineCount(""), 1);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
  const a = { len: 3, hash: "aa", modified_ms: 1 };
  const b = { len: 4, hash: "bb", modified_ms: 2 };
  assert.equal(onDiskChange(false, a, { ...a, modified_ms: 9 }), "none");
  assert.equal(onDiskChange(false, a, b), "reload");
  assert.equal(onDiskChange(true, a, b), "conflict");
  assert.equal(onDiskChange(true, a, null), "gone");
});
