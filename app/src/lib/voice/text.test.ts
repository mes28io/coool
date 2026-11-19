// Unit tests for lib/voice/text.ts: `node --test app/src/lib/voice/text.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hash, overlaps, protectedSpans, tokenize } from "./text.ts";

const prot = (t: string) => protectedSpans(t).map((s) => t.slice(s.from, s.to));

test("tokenize: words with offsets, apostrophes and dashes inside, Unicode letters", () => {
  const t = tokenize("Don't re-run café, ok?");
  assert.deepEqual(
    t.map((x) => [x.text, x.lower, x.from, x.to]),
    [
      ["Don't", "don't", 0, 5],
      ["re-run", "re-run", 6, 12],
      ["café", "café", 13, 17],
      ["ok", "ok", 19, 21],
    ],
  );
});

test("protectedSpans: code, fences, URLs, emails, paths, flags", () => {
  assert.deepEqual(prot("run `pnpm dev` now"), ["`pnpm dev`"]);
  assert.deepEqual(prot("see ```ts\nconst a = 1\n``` ok"), ["```ts\nconst a = 1\n```"]);
  assert.deepEqual(prot("open ```\nunterminated tori"), ["```\nunterminated tori"]);
  assert.deepEqual(prot("go to https://coool.sh/docs, then www.example.com."), ["https://coool.sh/docs", "www.example.com"]);
  assert.deepEqual(prot("mail me@example.com"), ["me@example.com"]);
  assert.deepEqual(prot("edit ~/notes and ./a ../b /etc/hosts src/lib/x"), ["~/notes", "./a", "../b", "/etc/hosts", "src/lib/x"]);
  assert.deepEqual(prot("in foo.ts and tori.ts."), ["foo.ts", "tori.ts"]);
  assert.deepEqual(prot("pass -v and --force and --mode=fast"), ["-v", "--force", "--mode=fast"]);
});

test("protectedSpans: identifiers, slash commands, mentions, quotes", () => {
  assert.deepEqual(prot("call useTori in ChatComposer"), ["useTori", "ChatComposer"]);
  assert.deepEqual(prot("set max_retries and MAX_RETRY"), ["max_retries", "MAX_RETRY"]);
  assert.deepEqual(prot("the my-long-name and gpt-4 ids"), ["my-long-name", "gpt-4"]);
  assert.deepEqual(prot("use a::b, f(x) and arr[0] or x=1"), ["a::b", "f(x)", "arr[0]", "x=1"]);
  assert.deepEqual(prot("/compact please"), ["/compact"]);
  assert.deepEqual(prot("look at @file.ts"), ["@file.ts"]);
  assert.deepEqual(prot('say "keep tori" and “curly tori”'), ['"keep tori"', "“curly tori”"]);
});

test("protectedSpans: plain speech is not protected (stutters, contractions, a re-run)", () => {
  assert.deepEqual(prot("b-b-but don't re-run it (please)"), []);
  assert.deepEqual(prot("a well-known word, e-mail"), []);
});

test("protectedSpans: sorted and merged", () => {
  const t = "`a` `b`";
  assert.deepEqual(protectedSpans(t), [
    { from: 0, to: 3 },
    { from: 4, to: 7 },
  ]);
  assert.deepEqual(protectedSpans("`x`--y"), [{ from: 0, to: 6 }]);
});

test("overlaps and hash", () => {
  assert.equal(overlaps({ from: 2, to: 4 }, [{ from: 4, to: 6 }]), false);
  assert.equal(overlaps({ from: 2, to: 5 }, [{ from: 4, to: 6 }]), true);
  assert.equal(hash("abc"), hash("abc"));
  assert.notEqual(hash("abc"), hash("abd"));
  assert.match(hash(""), /^[0-9a-f]{8}$/);
});
