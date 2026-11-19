// Unit tests for lib/explain.ts: `node --test app/src/lib/explain.test.ts`. The redaction and wording cases mirror
// crates/core/src/explain.rs's tests (the same rules run on both sides).

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentClaim, checkItems, cleanRead, cleanReply, lastWords, noReassurance, REASSURE, redactSecrets, redactedCount } from "./explain.ts";

test("redaction: token shapes and named secrets", () => {
  const cases: [string, string][] = [
    ["curl -H 'Authorization: Bearer abcdefghijklmnop' https://x", "abcdefghijklmnop"],
    ["export ANTHROPIC_API_KEY=sk-ant-api03-AAAABBBBCCCC", "AAAABBBBCCCC"],
    ["GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ gh pr list", "ghp_0123456789"],
    ["git clone https://bob:hunter22@github.com/x/y", "hunter22"],
    ["mysql --password=s3cr3t -u root", "s3cr3t"],
    ["psql postgres://u:pw1234@db.local:5432/app", "pw1234"],
    ["curl 'https://api.x.com/v1?api_key=QWERTY123&q=1'", "QWERTY123"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls", "wJalrXUtnFEMI"],
    ["echo AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ['{"password": "letmein!"}', "letmein!"],
    ["tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "eyJhbGci"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", "AAAA"],
    ["stripe sk_live_abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ['curl -X POST https://api.example.com -H "Authorization: Bearer sk_live_51Hx9aZ2eXampleTok3nQ"', "51Hx9aZ2eXampleTok3nQ"],
    ["npm config set //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm_abcdefghij"],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes("[redacted"), `${input} -> ${out}`);
    assert.ok(redactedCount(input) >= 1, input);
  }
  for (const c of ["cargo test --workspace", "git push origin main", "npm run build -- --mode production", "rm -rf dist", "curl https://example.com/health", "pnpm -C web build && rsync -av --delete web/dist/ deploy@static.example.com:/srv/www/"]) {
    assert.equal(redactSecrets(c), c);
    assert.equal(redactedCount(c), 0);
  }
  // Idempotent.
  const once = redactSecrets("TOKEN=abc123456 x");
  assert.equal(redactSecrets(once), once);
});

test("wording: never safe", () => {
  for (const t of ["This is safe", "harmless cleanup", "Looks fine to me", "low-risk change", "Nothing to worry about", "routine maintenance", "It should be fine"]) assert.ok(REASSURE.test(t), t);
  for (const t of ["Deletes ./dist", "unsafe if the path is wrong", "Uploads to example.com", "Runs the tests"]) assert.ok(!REASSURE.test(t), t);
  assert.equal(noReassurance("Lists the files in ./src. This is safe and harmless."), "Lists the files in ./src.");
  assert.equal(noReassurance("Looks fine; to find the parser."), "to find the parser.");
  assert.equal(noReassurance("Runs npm test"), "Runs npm test");
});

test("cleanRead: validates, caps, filters", () => {
  assert.deepEqual(cleanRead({ what: "Runs the tests.", why: "To check the fix.", check: [], mismatch: false }), { what: "Runs the tests.", why: "To check the fix.", check: [], mismatch: false });
  assert.equal(cleanRead(null), null);
  assert.equal(cleanRead([]), null);
  assert.equal(cleanRead({ what: "  " }), null);
  assert.equal(cleanRead({ what: "This is safe." }), null, "a reading that only reassures is no reading");
  const r = cleanRead({ what: "z".repeat(900), why: 7, check: ["a", 3, "A", "Nothing to worry about", "b", "c", "d", "e"], mismatch: "yes" })!;
  assert.ok(r.what.length <= 260);
  assert.equal(r.why, "");
  assert.deepEqual(r.check, ["a", "b", "c", "d"]);
  assert.equal(r.mismatch, false);
  assert.deepEqual(cleanRead({ what: "w", why: "", check: ["Deletes a.txt for good", "The description says list, but it also deletes a.txt"], mismatch: true })!.check[0], "The description says list, but it also deletes a.txt");
  assert.equal(cleanRead({ what: "Sends TOKEN=abc123456 to x", why: "", check: [], mismatch: false })!.what, "Sends TOKEN=[redacted] to x");
});

test("cleanReply: off, limited, done, and anything else is an error", () => {
  assert.deepEqual(cleanReply({ status: "off", has_key: true }), { status: "off", has_key: true });
  assert.deepEqual(cleanReply({ status: "limited" }), { status: "limited" });
  assert.equal(cleanReply({ status: "done", read: { what: "Deletes x." }, model: "m", usd: 0.0002, ms: 900 }).status, "done");
  assert.equal(cleanReply({ status: "done", read: { what: "" } }).status, "error");
  assert.equal(cleanReply("nope").status, "error");
  const e = cleanReply({ status: "error", message: "bad key sk-ant-api03-AAAABBBBCCCC" });
  assert.ok(e.status === "error" && !e.message.includes("AAAABBBB"));
});

test("the agent's claim: description, last words, reasoning, plan", () => {
  const c = agentClaim("Bash", { command: "npm test", description: "Run the unit tests" }, { said: "Fixed the bug.\n\nRunning the tests to confirm.", thought: "x" });
  assert.equal(c.description, "Run the unit tests");
  assert.equal(c.said, "Running the tests to confirm.");
  assert.equal(c.thought, null, "reasoning only when it said nothing");
  assert.equal(agentClaim("Bash", { command: "x" }, { said: null, thought: "I should check the cache first." }).thought, "I should check the cache first.");
  assert.equal(agentClaim("ExitPlanMode", { plan: "# Retry with backoff\n\n1. …" }, null).plan, "Retry with backoff");
  assert.equal(agentClaim("Bash", { command: "x", description: "Use TOKEN=abc123456" }, null).description, "Use TOKEN=[redacted]");
  assert.equal(lastWords("a".repeat(400))!.length, 280);
  assert.equal(lastWords(null), null);
});

test("what to check: the rule first, then the AI read, kept apart", () => {
  assert.deepEqual(checkItems(null, null), []);
  const items = checkItems("Deletes files recursively, without asking", { what: "w", why: "", check: ["The description says run the tests, but it also deletes ~/Library/Caches"], mismatch: true });
  assert.deepEqual(
    items.map((i) => [i.from, !!i.mismatch]),
    [
      ["rule", false],
      ["ai", true],
    ],
  );
  assert.equal(checkItems(null, { what: "w", why: "", check: [], mismatch: true })[0].mismatch, true);
});
