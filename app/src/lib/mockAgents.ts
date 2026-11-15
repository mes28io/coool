// `?agents=chat`: a chat that hands work to four subagents at once (Task calls with nested
// tool calls, delivered as chat items): one fails, one finishes after a failed step, one is
// stopped by the person (interrupted mid-step), one keeps going for a good while. See lib/agentsDemo.ts.

import type { MockChat } from "./mockChat";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const rid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

interface Script {
  kind: string;
  desc: string;
  model: string;
  steps: { name: string; summary: string; ms: number; fail?: boolean }[];
  /** How it ends: "stopped" is cut off by the person in its last step. */
  end: "done" | "stopped" | "failed";
  /** The failure ("failed" only). */
  error?: string;
  say: string;
  startAfter: number;
}

const P = "~/code/blender-addon/src";
const SCRIPTS: Script[] = [
  {
    kind: "Explore", desc: "Survey the Blender operator API", model: "claude-haiku-5-5", end: "failed", error: "API error: rate limited (429) while reading docs/api/types.md", startAfter: 600,
    say: "Found 212 operators; the add-on needs 9 of them, all stable since Blender 3.6.",
    steps: [
      { name: "Grep", summary: "bpy.ops", ms: 1800 }, { name: "Read", summary: `${P}/ops/register.py`, ms: 2200 }, { name: "Grep", summary: "register_class", ms: 1900 },
      { name: "Read", summary: "docs/api/types.md", ms: 2300 }, { name: "Grep", summary: "deprecated", ms: 1700 },
    ],
  },
  {
    kind: "general-purpose", desc: "Port the exporter to the new mesh API", model: "claude-sonnet-5-5", end: "done", startAfter: 1400,
    say: "Exporter now uses the foreach_get path; export is 4.1x faster on the benchmark scene.",
    steps: [
      { name: "Read", summary: `${P}/export/mesh.py`, ms: 2000 }, { name: "Grep", summary: "to_mesh", ms: 1700 }, { name: "Edit", summary: `${P}/export/mesh.py`, ms: 2600 },
      { name: "Bash", summary: "pytest tests/export -q", ms: 3400, fail: true }, { name: "Edit", summary: `${P}/export/mesh.py`, ms: 2300 }, { name: "Bash", summary: "pytest tests/export -q", ms: 3000 },
      { name: "Edit", summary: `${P}/export/normals.py`, ms: 2200 }, { name: "Bash", summary: "pytest tests -q", ms: 3200 }, { name: "Read", summary: `${P}/export/bench.py`, ms: 1800 },
      { name: "Bash", summary: "python bench/export.py", ms: 3600 }, { name: "Edit", summary: "CHANGELOG.md", ms: 1800 }, { name: "Bash", summary: "git diff --stat", ms: 1500 },
    ],
  },
  {
    kind: "general-purpose", desc: "Set up the add-on test harness", model: "claude-sonnet-5-5", end: "stopped", startAfter: 2200,
    say: "",
    steps: [
      { name: "Write", summary: "tests/conftest.py", ms: 2300 }, { name: "Bash", summary: "blender -b --python tests/run.py", ms: 3300 }, { name: "Edit", summary: "tests/conftest.py", ms: 2000 },
      { name: "Bash", summary: "blender -b --python tests/run.py", ms: 3000 },
    ],
  },
  {
    kind: "Explore", desc: "Audit the preferences panel", model: "claude-haiku-5-5", end: "done", startAfter: 3000,
    say: "The panel is fine; one label is untranslated and the reset button has no confirm.",
    steps: [
      { name: "Read", summary: `${P}/ui/prefs.py`, ms: 2100 }, { name: "Grep", summary: "AddonPreferences", ms: 1700 }, { name: "Read", summary: `${P}/ui/translations.py`, ms: 2100 },
      { name: "Grep", summary: "draw_reset", ms: 1800 }, { name: "Read", summary: `${P}/ui/layout.py`, ms: 2000 }, { name: "Grep", summary: "bl_label", ms: 1700 }, { name: "Read", summary: `${P}/ui/icons.py`, ms: 1900 },
      { name: "Grep", summary: "previews", ms: 1800 }, { name: "Read", summary: `${P}/ui/panels.py`, ms: 2200 }, { name: "Grep", summary: "poll(", ms: 1700 }, { name: "Read", summary: `${P}/ui/menus.py`, ms: 2300 },
      { name: "Grep", summary: "layout.prop", ms: 1800 }, { name: "Read", summary: `${P}/ui/operators.py`, ms: 2100 }, { name: "Grep", summary: "invoke", ms: 1600 }, { name: "Read", summary: `${P}/ui/utils.py`, ms: 2000 },
    ],
  },
];

export async function runAgentsChat(c: MockChat) {
  c.always.add("Bash");
  c.always.add("Edit");
  c.always.add("Write");
  await wait(1500);
  c.emit({ type: "user_message", id: `u_${rid()}`, text: "Split the add-on milestone across four agents and report back when they finish" });
  c.setState("working");
  c.turnStart = Date.now();
  await wait(500);
  const mid = `msg_${rid()}`;
  c.emit({ type: "assistant_message", id: mid, text: "I'll hand this to four agents working in parallel: API survey, exporter port, test harness and a preferences audit.", model: c.model, parent_tool_id: null });
  let out = 0;
  const usage = (model: string) => {
    out += 180 + Math.floor(Math.random() * 260);
    c.emit({ type: "usage", model, tokens: { input: out * 4, cached: out * 9, output: out, context: 60_000 }, context_window: 1_000_000 });
  };
  await Promise.all(
    SCRIPTS.map(async (sc) => {
      await wait(sc.startAfter);
      const aid = `toolu_${rid()}`;
      c.emit({ type: "tool_start", id: aid, name: "Task", summary: sc.desc, input: { subagent_type: sc.kind, description: sc.desc }, parent_tool_id: null });
      for (const st of sc.steps) {
        const tid = `toolu_${rid()}`;
        c.emit({ type: "tool_start", id: tid, name: st.name, summary: st.summary, input: {}, parent_tool_id: aid });
        await wait(st.ms);
        if (sc.end === "stopped" && st === sc.steps[sc.steps.length - 1]) {
          c.emit({ type: "tool_end", id: tid, ok: false, output: "[Request interrupted by user for tool use]" });
          break;
        }
        c.emit({ type: "tool_end", id: tid, ok: !st.fail, output: st.fail ? "error: 2 tests failed" : "ok" });
        const sid = `msg_${rid()}`;
        c.emit({ type: "assistant_message", id: sid, text: `Checked ${st.summary}.`, model: sc.model, parent_tool_id: aid });
        usage(sc.model);
      }
      if (sc.end === "done") {
        const sid = `msg_${rid()}`;
        c.emit({ type: "assistant_message", id: sid, text: sc.say, model: sc.model, parent_tool_id: aid });
        usage(sc.model);
        c.emit({ type: "tool_end", id: aid, ok: true, output: sc.say });
      } else if (sc.end === "failed") c.emit({ type: "tool_end", id: aid, ok: false, output: sc.error ?? "failed" });
      else c.emit({ type: "tool_end", id: aid, ok: false, output: "[Request interrupted by user for tool use]" });
    }),
  );
  c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: "Two of four agents finished. The exporter is 4.1x faster; the API survey hit a rate limit and the test harness was stopped, so those need another look.", model: c.model, parent_tool_id: null });
  c.emit({ type: "turn_end", duration_ms: Date.now() - c.turnStart, ok: true });
  c.setState("idle");
}
