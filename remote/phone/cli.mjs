#!/usr/bin/env node
// coool-phone: a command-line stand-in for the coool Remote iPhone app (docs/REMOTE.md). Only the shell lives
// here; the protocol is src/protocol.mjs, src/relay.mjs and src/phone.mjs.
//
//   coool-phone pair '<coool://pair?...>' [--name "Test iPhone"]   claim, print the code, wait for the Mac's click
//   coool-phone listen                                             print every message from the Mac (JSON lines)
//   coool-phone snapshot                                           hello, print the snapshot and projects
//   coool-phone answer <need-id> allow_once|deny|option <label>
//   coool-phone send <session-id> <text>
//   coool-phone stop <session-id>
//   coool-phone start <project-id> claude|codex <text>
//
// --state <file> (default ./coool-phone.json) keeps the pairing: keys, ids and counters. Keep it private.

import { Phone } from "./src/phone.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const statePath = opt("--state", "coool-phone.json");
const name = opt("--name", "coool-phone");
const timeoutMs = Number(opt("--timeout", "30000"));
const [cmd, ...rest] = args;
const out = (o) => console.log(JSON.stringify(o));

async function withPhone(f) {
  const phone = Phone.load(statePath);
  if (!phone.paired) throw new Error(`not paired (no ${statePath}); run: coool-phone pair '<coool://pair?...>'`);
  try {
    return await f(phone);
  } finally {
    phone.save(statePath);
    await phone.close();
  }
}

/** Connects, sends one command, prints what comes back until its `result` (or the timeout). */
function command(send) {
  return withPhone(async (phone) => {
    let sent = null;
    let done;
    const finished = new Promise((r) => (done = r));
    await phone.connect(
      (m) => {
        out(m);
        if (sent && m.t === "result" && m.b?.of === sent.env.id) done(m.b.ok);
      },
      (e) => e.kind !== "presence" && out({ event: e }),
    );
    sent = await send(phone);
    const timer = setTimeout(() => done(null), timeoutMs);
    const ok = await finished;
    clearTimeout(timer);
    if (ok === null) throw new Error("no result from the Mac (offline, or the command was dropped)");
    if (!ok) process.exitCode = 2;
  });
}

const commands = {
  async pair() {
    const phone = new Phone();
    const code = await phone.claim(rest[0], name);
    out({ code });
    console.error(`Code ${code.slice(0, 3)} ${code.slice(3)}: check that the Mac shows the same, then click Pair there.`);
    if (!(await phone.waitPaired({ timeoutMs: Math.max(timeoutMs, 180_000) }))) throw new Error("not paired: cancelled on the Mac, or expired");
    phone.save(statePath);
    out({ paired: true, deviceId: phone.s.deviceId });
    await phone.close();
  },
  async listen() {
    await withPhone(async (phone) => {
      await phone.connect(out, (e) => out({ event: e }));
      await phone.hello();
      await new Promise((r) => process.on("SIGINT", r));
    });
  },
  async snapshot() {
    await withPhone(async (phone) => {
      let got = 0;
      let done;
      const finished = new Promise((r) => (done = r));
      await phone.connect((m) => {
        out(m);
        if (m.t === "snapshot" || m.t === "projects") if (++got === 2) done();
      });
      await phone.hello();
      const t = setTimeout(done, timeoutMs);
      await finished;
      clearTimeout(t);
    });
  },
  answer: () => command((p) => p.answer(rest[0], rest[1], rest[1] === "option" ? { option: rest[2] } : {})),
  send: () => command((p) => p.sendText(rest[0], rest.slice(1).join(" "))),
  stop: () => command((p) => p.stop(rest[0])),
  start: () => command((p) => p.start(rest[0], rest[1], rest.slice(2).join(" "))),
};

if (!commands[cmd]) {
  console.error("usage: coool-phone pair|listen|snapshot|answer|send|stop|start ... (see the top of cli.mjs)");
  process.exit(64);
}
commands[cmd]().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
