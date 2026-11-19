// `?why=demo` (browser mock only): permission requests that show every state of "What this does and why"
// (components/Explain.tsx), with invented data:
//
//   - site:     the AI read arrives a few seconds after the request (an upload with --delete to check)
//   - tests:    the AI read finds a mismatch: "run the unit tests" also deletes two cache folders in home (also Risky)
//   - branch:   AI insights is off: the agent's own words only, and the quiet "turn on" hint
//   - reindex:  the AI read never comes back (the quiet timeout); the command's bearer token is hidden
//   - a terminal session outside coool whose wait doesn't name its command: the transcript's words only, no read
//
// The chats' scripts run in lib/mockChat.ts (`whyScript`); the replies to `explainRequest` come from `mockExplain`.

import type { AiRead, ExplainReply, ExplainRequest } from "./explain";
import type { MockChat } from "./mockChat";

export interface WhyScript {
  prompt: string;
  earlier: string[];
  steps: { name: string; summary: string; input: unknown; output: string }[];
  said: string;
  command: string;
  description: string;
  output: string;
  after: string;
  /** The mock backend's answer: a read after `ms`, "off", or never ("timeout"). */
  reply: { read: AiRead; ms: number } | "off" | "timeout";
}

export const WHY_SCRIPTS: WhyScript[] = [
  {
    prompt: "Ship the landing page fixes to the static host",
    earlier: ["Fix the hero layout on small screens", "Tighten the pricing table copy"],
    steps: [
      { name: "Edit", summary: "web/src/Hero.tsx", input: { file_path: "web/src/Hero.tsx", old_string: "gap-12", new_string: "gap-6 sm:gap-12" }, output: "ok" },
      { name: "Bash", summary: "pnpm -C web test", input: { command: "pnpm -C web test", description: "Run the web tests" }, output: "24 passed" },
    ],
    said: "The tests pass. I'll build the site and publish it to the static host, as you asked.",
    command: "pnpm -C web build && rsync -av --delete web/dist/ deploy@static.example.com:/srv/www/",
    description: "Build the site and upload it to the static host",
    output: "sent 1,204,551 bytes  received 3,118 bytes",
    after: "Published. The landing page on the static host now has the hero and pricing fixes.",
    reply: {
      ms: 3500,
      read: {
        what: "Builds the site in ./web, then copies web/dist to /srv/www on static.example.com over SSH, deleting files there that aren't in the new build.",
        why: "To publish the landing page fixes you asked for; it fixed the hero and ran the web tests just before.",
        check: ["Uploads to static.example.com and removes remote files missing from this build (--delete)"],
        mismatch: false,
      },
    },
  },
  {
    prompt: "Fix the date parsing bug in the invoice export",
    earlier: ["Why do invoices from March show the wrong month?"],
    steps: [
      { name: "Read", summary: "src/export/dates.ts", input: { file_path: "src/export/dates.ts" }, output: "…" },
      { name: "Edit", summary: "src/export/dates.ts", input: { file_path: "src/export/dates.ts", old_string: "getMonth()", new_string: "getMonth() + 1" }, output: "ok" },
    ],
    said: "Fixed the off-by-one month. Running the tests to confirm.",
    command: "npm test && rm -rf ~/Library/Caches/com.example.invoices ~/.npm/_cacache",
    description: "Run the unit tests",
    output: "Tests: 41 passed",
    after: "All 41 tests pass with the month fix.",
    reply: {
      ms: 2600,
      read: {
        what: "Runs npm test, then deletes ~/Library/Caches/com.example.invoices and npm's download cache in ~/.npm/_cacache.",
        why: "To confirm the month fix for the invoice export you asked for.",
        check: [
          "The description says run the unit tests, but the command also deletes two cache folders in your home folder",
          "Deletes outside the project; npm would download every package again",
        ],
        mismatch: true,
      },
    },
  },
  {
    prompt: "Make the sync retries back off, then commit it on a branch",
    earlier: [],
    steps: [{ name: "Edit", summary: "src/sync/retry.ts", input: { file_path: "src/sync/retry.ts", old_string: "delay = 1000", new_string: "delay = Math.min(60_000, 1000 * 2 ** attempt)" }, output: "ok" }],
    said: "Backoff is in. Committing it on a new branch as you asked.",
    command: 'git checkout -b fix/retry-backoff && git commit -am "Back off sync retries"',
    description: "Commit the retry change on a new branch",
    output: "[fix/retry-backoff 3f2a9c1] Back off sync retries",
    after: "Committed on fix/retry-backoff.",
    reply: "off",
  },
  {
    prompt: "Reindex search after the schema change",
    earlier: ["Add the `tags` field to the search schema"],
    steps: [{ name: "Bash", summary: "pnpm db:migrate", input: { command: "pnpm db:migrate", description: "Apply the schema migration" }, output: "1 migration applied" }],
    said: "The migration is applied; the search index needs a rebuild to pick up `tags`.",
    command: 'curl -s -X POST https://api.example.com/v1/search/reindex -H "Authorization: Bearer sk_live_51Hx9aZ2eXampleTok3nQ"',
    description: "Trigger the search reindex",
    output: '{"queued":true}',
    after: "The reindex is queued.",
    reply: "timeout",
  },
];

/** The script a mock chat runs for `prompt`, if it's one of these. */
export const whyScript = (prompt: string) => WHY_SCRIPTS.find((s) => s.prompt.toLowerCase() === prompt.trim().toLowerCase()) ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The mock backend's `explainRequest`: a demo script's own reply, else as AI insights is set (`on`). */
export async function mockExplain(req: ExplainRequest, on: boolean): Promise<ExplainReply> {
  const cmd = (req.input as { command?: unknown } | null)?.command;
  const s = typeof cmd === "string" ? WHY_SCRIPTS.find((x) => x.command === cmd) : undefined;
  const reply = s?.reply ?? (on ? { ms: 1400, read: generic(req) } : "off");
  if (reply === "off") {
    await sleep(60);
    return { status: "off", has_key: false };
  }
  if (reply === "timeout") return new Promise<ExplainReply>(() => {});
  await sleep(reply.ms);
  return { status: "done", read: reply.read, model: "claude-haiku-5-5", usd: 0.00021, ms: reply.ms };
}

function generic(req: ExplainRequest): AiRead {
  const i = (req.input ?? {}) as Record<string, unknown>;
  const what = typeof i.command === "string" ? `Runs \`${i.command}\` in the chat's folder.` : typeof i.file_path === "string" ? `Changes ${i.file_path}.` : `Uses ${req.tool}.`;
  return { what, why: req.prompt ? `For what you asked: ${req.prompt.slice(0, 120)}` : "The context doesn't say.", check: [], mismatch: false };
}

/** Starts the demo chats (each asks once, after its earlier turns). */
export function runWhyDemo(newChat: (cwd: string) => MockChat, home: string) {
  const now = Date.now();
  const where = [`${home}/code/landing`, `${home}/code/invoices`, `${home}/code/notes-sync`, `${home}/code/search-api`];
  WHY_SCRIPTS.forEach((s, i) => {
    const c = newChat(where[i]);
    const go = () => setTimeout(() => c.send(s.prompt), 900 + i * 500);
    if (s.earlier.length) void c.seed(s.earlier, now - (20 - i * 3) * 60_000).then(go);
    else go();
  });
}
