#!/usr/bin/env node
// The phone's half of the `remote` self-test (app/src/selftestRemote.ts): scripted, against the real relay and the
// real app. The two sides meet through files in the test's folder (see that file).
//
//   node e2e.mjs <self-test folder>
//
// Writes remote-phone-*.txt there as it goes, and remote-phone-failed.txt (then exits 1) on the first failure.

import fs from "node:fs";
import path from "node:path";
import * as P from "./src/protocol.mjs";
import { Phone } from "./src/phone.mjs";

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: node e2e.mjs <self-test folder>");
  process.exit(64);
}
const NAME = "coool e2e iPhone";
const file = (n) => path.join(dir, n);
const put = (n, text) => fs.writeFileSync(file(n), text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function waitFile(n, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file(n))) return fs.readFileSync(file(n), "utf8");
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${n}`);
}

const got = [];
const results = new Map();
async function until(what, f, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
/** Sends a command and waits for the Mac's `result` of it. */
async function command(promise) {
  const { env } = await promise;
  return await until(`the result of ${env.t}`, () => results.get(env.id), 60_000);
}

async function main() {
  const base = path.basename(dir);
  const phone = new Phone();
  try {
    // 1. Pair.
    const qr = (await waitFile("remote-pair-url.txt", 180_000)).trim();
    const code = await phone.claim(qr, NAME);
    log("claimed; code", code);
    put("remote-phone-code.txt", code);
    if (!(await phone.waitPaired({ timeoutMs: 120_000 }))) throw new Error("not paired (refused or expired)");
    log("paired as", phone.s.deviceId);

    // 2. Connect; the snapshot.
    await phone.connect(
      (m) => {
        got.push(m);
        if (m.t === "result") results.set(m.b.of, m.b);
        log("<-", m.t, JSON.stringify(m.b).slice(0, 160));
      },
      (e) => e.kind !== "presence" && log("event", JSON.stringify(e)),
    );
    await phone.hello();
    const snap = await until("the snapshot", () => got.find((m) => m.t === "snapshot"));
    const projects = await until("the projects", () => got.find((m) => m.t === "projects"));
    const foreign = snap.b.sessions.filter((s) => s.project !== base && s.project !== "invented-project");
    if (foreign.length) throw new Error(`the snapshot holds sessions not of this test: ${foreign.length}`);
    put("remote-phone-snapshot.txt", JSON.stringify(snap.b));

    // 3. The permission request: "always" refused, then allow once.
    const need = await until("the Bash request", () => got.find((m) => m.t === "need" && m.b.tool === "Bash" && /coool-remote-ok/.test(m.b.command ?? ""))?.b, 180_000);
    log("need", need.id, need.command);
    const always = await command(phone.answer(need.id, "always"));
    if (always.ok) throw new Error("an always answer was accepted");
    const r = await command(phone.answer(need.id, "allow_once"));
    if (!r.ok) throw new Error(`allow once failed: ${r.error}`);
    put("remote-phone-answered.txt", `allowed ${need.tool} once (always refused: ${always.error})`);
    const session = need.session;

    // 4. Send, then stop mid-turn.
    await until("the chat idle again", () => got.some((m) => m.t === "session" && m.b.id === session && m.b.state === "idle" && m.at > Date.now() - 600_000) || got.filter((m) => m.t === "need_gone").length > 0, 120_000);
    await sleep(3_000);
    const sent = await command(phone.sendText(session, "Count from 1 to 400, one number per line, nothing else."));
    if (!sent.ok) throw new Error(`send failed: ${sent.error}`);
    const t0 = Date.now();
    await until("the chat working", () => got.some((m) => m.t === "session" && m.b.id === session && m.b.state === "working" && m.at >= t0 - 2_000), 60_000);
    const stop = await command(phone.stop(session));
    if (!stop.ok) throw new Error(`stop failed: ${stop.error}`);
    put("remote-phone-stopped.txt", `sent, then stopped ${session}`);

    // 5. Refusals, then a start in the test's folder.
    // The folders the Mac knows now (the first snapshot came before any chat ran here).
    const nProjects = got.filter((m) => m.t === "projects").length;
    await phone.getSnapshot();
    const fresh = await until("fresh projects", () => got.filter((m) => m.t === "projects")[nProjects]);
    void projects;
    const proj = fresh.b.projects.find((p) => p.name === base);
    if (!proj) throw new Error(`the test's folder is not among the projects: ${JSON.stringify(projects.b.projects)}`);
    const viaPath = await command(phone.start(dir, "claude", "hi"));
    const unknown = await command(phone.start(P.randomId(), "claude", "hi"));
    const sneaky = await command(phone.send("start", { project: proj.id, cwd: "/", cli: "claude", text: "hi" }));
    const old = await command(phone.sendEnvelope(P.envelope("send", { session, text: "from a minute ago" }, Date.now() - 70_000)));
    const refusals = { path: viaPath, unknownProject: unknown, withPath: sneaky, expired: old };
    for (const [k, v] of Object.entries(refusals)) if (v.ok) throw new Error(`${k} was accepted`);
    if (old.error !== "expired") throw new Error(`an old command came back as ${old.error}`);
    put("remote-phone-refusals.txt", Object.entries(refusals).map(([k, v]) => `${k}: ${v.error}`).join("; "));
    const started = await command(phone.start(proj.id, "claude", "Reply with just the word hi."));
    if (!started.ok) throw new Error(`start failed: ${started.error}`);
    put("remote-phone-started.txt", JSON.stringify({ session: started.session, mode: started.mode }));

    // 6. Removed on the Mac: refused.
    await waitFile("remote-app-removed.txt", 300_000);
    let refused = null;
    try {
      await phone.sendText(session, "after removal");
    } catch (e) {
      refused = e.code ?? String(e);
    }
    if (!refused) throw new Error("a removed phone could still send");
    const reopen = await phone.relay.openSession(phone.s.id.signPriv, "device", phone.s.mac.macId, phone.s.deviceId);
    put("remote-phone-refused.txt", `send: ${refused}; openSession: ${reopen.ok ? "ACCEPTED" : reopen.code}`);
    log("done");
  } catch (e) {
    log("FAILED", e.message);
    put("remote-phone-failed.txt", String(e.message ?? e));
    process.exitCode = 1;
  } finally {
    await phone.close();
  }
}

main();
