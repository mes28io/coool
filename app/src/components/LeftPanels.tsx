// The views the left sidebar panel can show besides Projects: Usage, Needs you and Settings.
// Each fills the panel (header 44px, scrolling body); Sidebar cross-fades between them.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, isNotAvailable } from "../lib/backend";
import { answerPermission, answerQuestion } from "../lib/actions";
import { pendingPermission, pendingQuestion, useChats } from "../lib/chat";
import { useNow } from "../lib/clock";
import { ago, displayTitle } from "../lib/format";
import { attention } from "../lib/live";
import { setMotionPref, useMotion, type MotionPref } from "../lib/motion";
import { sessionKey } from "../lib/types";
import type { InsightsStatus } from "../lib/types";
import { useStore, type ThemePref } from "../store";
import { IAlert, ICheck } from "./icons";
import { Button, cx, ease, ProviderMark, Segmented } from "./primitives";
import { useProjects } from "./Sidebar";
import { UsageBlock, useUsageProviders } from "./Usage";

function Header({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div data-tauri-drag-region className="flex h-[44px] shrink-0 items-center gap-2 pl-4 pr-3">
      <span className="text-base font-semibold text-fg">{title}</span>
      {aside && <span className="min-w-0 flex-1 truncate text-small text-dim tnum">{aside}</span>}
    </div>
  );
}

// ---------- Usage ----------

export function UsageView() {
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  return (
    <div className="flex h-full flex-col" data-sidebar-view="usage" role="region" aria-label="Plan usage">
      <Header title="Usage" />
      <div className="scroll flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        {providers.map((p) => (
          <div key={p} className="rounded-[12px] border border-line bg-raised">
            <UsageBlock provider={p} usage={usage[p]} />
          </div>
        ))}
        {providers.length === 0 && <div className="px-1 py-2 text-small text-dim">No supported CLI found.</div>}
      </div>
    </div>
  );
}

// ---------- Needs you ----------

/** Sessions that are blocked on the person: what the rail badge counts. */
export function useNeedsYou() {
  const { projects, digest } = useProjects();
  return projects.flatMap((p) => p.live.map((s) => ({ s, a: attention(s, digest) })).filter((x) => x.a.needs));
}

type Needed = ReturnType<typeof useNeedsYou>[number];

/** "Bash · pnpm build" -> "pnpm build". */
const brief = (tool: string, summary: string) => (summary.startsWith(tool + " · ") ? summary.slice(tool.length + 3) : summary);

function NeedsRow({ s, a }: Needed) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const chat = useChats((c) => (s.chat != null ? c.chats[s.chat] : undefined));
  const perm = chat?.running ? pendingPermission(chat) : null;
  const ask = chat?.running && !perm ? pendingQuestion(chat) : null;
  const [more, setMore] = useState(false);
  const go = () => open({ kind: "session", key: sessionKey(s) });
  const q = ask && ask.questions.length === 1 && !ask.questions[0].multi_select && !ask.questions[0].secret && ask.questions[0].options.length > 0 ? ask.questions[0] : null;
  const since = perm?.ts ?? ask?.ts ?? null;
  const outside = !perm && !ask;

  const small = "h-[26px] rounded-[7px] px-2.5 text-small";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.2, ease }}
      className="overflow-hidden"
      data-needs-row={sessionKey(s)}
      data-needs-kind={perm ? "permission" : ask ? "question" : "outside"}
    >
      <div className="rounded-[10px] px-2.5 py-2 transition-colors duration-150 hover:bg-hover">
        <button type="button" onClick={go} className="flex w-full items-start gap-2.5 text-left" title="Open this session">
          <ProviderMark provider={s.provider} size={15} className="mt-[3px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base text-fg">
              {perm ? (
                <>
                  <span className="font-medium">{perm.tool}</span>
                  <span className="text-dim"> · {brief(perm.tool, perm.summary)}</span>
                </>
              ) : ask ? (
                (ask.questions[0]?.question ?? "A question")
              ) : (
                displayTitle(s)
              )}
            </span>
            <span className="block truncate text-small text-dim">
              {perm || ask ? displayTitle(s) : a.needs}
              {since && <span className="text-faint"> · waiting {ago(since, now).replace(" ago", "")}</span>}
            </span>
          </span>
        </button>
        {perm && chat && (
          <div className="mt-2 pl-[25px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="primary" className={small} data-allow-once onClick={() => answerPermission(chat.id, perm.requestId, "allow")} title="Allow this once">
                Allow
              </Button>
              <Button variant="ghost" className={cx(small, "hover:text-err-text")} data-deny onClick={() => answerPermission(chat.id, perm.requestId, "deny")} title="Deny">
                Deny
              </Button>
              {perm.remember.length > 0 && (
                <Button variant="ghost" className={cx(small, "ml-auto text-dim")} onClick={() => setMore((v) => !v)} aria-expanded={more} title="Allow and remember">
                  Allow always…
                </Button>
              )}
            </div>
            {more && (
              <div className="mt-1.5 flex flex-col gap-1" data-remember-options>
                {perm.remember.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    data-remember={o.id}
                    data-remember-scope={o.scope}
                    title={o.detail}
                    onClick={() => answerPermission(chat.id, perm.requestId, "always", o)}
                    className="rounded-[7px] border border-line px-2 py-1 text-left text-small text-fg transition-colors duration-150 hover:bg-hover"
                  >
                    <span className="block">{o.label}</span>
                    {o.scope !== "chat" && <span className="block text-micro text-faint">{o.scope === "user" ? "Saved, all projects" : "Saved to file"}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {ask && chat && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[25px]">
            {q ? (
              q.options.map((o) => (
                <Button key={o.label} variant="outline" className={small} data-option={o.label} title={o.description || undefined} onClick={() => answerQuestion(chat.id, ask.requestId, [[o.label]])}>
                  {o.label}
                </Button>
              ))
            ) : (
              <Button variant="outline" className={small} onClick={go}>
                Answer
              </Button>
            )}
          </div>
        )}
        {outside && (
          <div className="mt-2 flex items-center gap-2 pl-[25px]">
            <Button variant="outline" className={small} onClick={go}>
              Open
            </Button>
            <span className="text-small text-faint">{a.source === "job" ? "a job is waiting" : s.chat === null ? "in your terminal" : "answer it in the session"}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function NeedsView() {
  const list = useNeedsYou();
  return (
    <div className="flex h-full flex-col" data-sidebar-view="needs">
      <Header title="Needs you" aside={list.length ? `${list.length} waiting` : undefined} />
      <div className="scroll min-h-0 flex-1 px-2 pb-3">
        {list.length === 0 && (
          <div className="mx-1 mt-1 rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-base text-dim" data-needs-empty>
            Nothing needs you
          </div>
        )}
        <AnimatePresence initial={false}>
          {list.map((n) => (
            <NeedsRow key={sessionKey(n.s)} {...n} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- Settings ----------

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40", on ? "bg-accent" : "bg-[color-mix(in_oklab,var(--dim)_35%,transparent)]")}
    >
      <motion.span
        className="absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]"
        initial={false}
        animate={{ left: on ? 18 : 2 }}
        transition={{ type: "spring", stiffness: 700, damping: 38 }}
      />
    </button>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="pt-4 first:pt-1">
      <div className="px-1 pb-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{label}</div>
      <div className="flex flex-col divide-y divide-hairline rounded-[12px] border border-line bg-raised px-3">{children}</div>
    </section>
  );
}

/** Label, optional dim description, control on the right (or stacked below with `stack`). */
function Row({ label, desc, control, stack, children, attr }: { label: string; desc?: ReactNode; control?: ReactNode; stack?: boolean; children?: ReactNode; attr?: string }) {
  return (
    <div className="flex flex-col gap-2 py-2.5" data-setting={attr}>
      <div className={cx("flex gap-3", stack ? "flex-col" : "items-start")}>
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">{label}</div>
          {desc && <div className="mt-0.5 text-small text-dim">{desc}</div>}
        </div>
        {control && <div className={cx("shrink-0", !stack && "mt-[1px]")}>{control}</div>}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  "h-[32px] w-full min-w-0 rounded-[8px] border border-line bg-bg px-2.5 font-mono text-mono-small outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent)]";

/** Reduce motion: Auto / On / Off (lib/motion.ts), with what it amounts to right now. */
function ReduceMotionRow() {
  const m = useMotion();
  const now =
    m.pref === "on" ? "Reduced: activity shows still" : m.pref === "off" ? "Full motion, always" : m.reduce ? `Auto · reduced now (${m.reason ?? "device"})` : "Auto · full motion";
  return (
    <Row
      attr="reduce-motion"
      label="Reduce motion"
      desc="Auto follows macOS Reduce motion, Low Power Mode, heat and a low battery."
      stack
      control={
        <div className="flex flex-col gap-1.5">
          <Segmented<MotionPref> size="sm" value={m.pref} onChange={setMotionPref} options={[{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />
          <div className="text-small text-dim" data-motion-state={m.reduce ? "reduced" : "full"}>
            {now}
          </div>
        </div>
      }
    />
  );
}

export function SettingsView() {
  const themePref = useStore((s) => s.themePref);
  const setThemePref = useStore((s) => s.setThemePref);
  const showAutomation = useStore((s) => s.showAutomation);
  const setShowAutomation = useStore((s) => s.setShowAutomation);
  const hiddenAutomation = useStore((s) => s.hiddenAutomation);
  const [st, setSt] = useState<InsightsStatus | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    api()
      .insightsStatus()
      .then(setSt)
      .catch(() => setSt({ enabled: false, has_key: false, available: false }));
  }, []);
  const avail = st?.available !== false;
  const run = async (f: () => Promise<void>, next: Partial<InsightsStatus>) => {
    setErr(null);
    try {
      await f();
      setSt((s) => (s ? { ...s, ...next } : s));
      return true;
    } catch (e) {
      setErr(isNotAvailable(e) ? "Insights aren't available in this build of coool yet." : e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const save = async () => {
    const k = key.trim();
    if (!k || saving) return;
    setSaving(true);
    // The key goes straight to the backend (Keychain) and is dropped from UI state right away.
    setKey("");
    const ok = await run(() => api().insightsSetKey(k), { has_key: true });
    setSaving(false);
    if (ok) setReplacing(false);
  };

  return (
    <div className="flex h-full flex-col" data-sidebar-view="settings">
      <Header title="Settings" />
      <div className="scroll min-h-0 flex-1 px-3 pb-4">
        <Section label="Appearance">
          <Row label="Theme" stack control={<Segmented<ThemePref> size="sm" value={themePref} onChange={setThemePref} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />} />
          <ReduceMotionRow />
        </Section>

        <Section label="Sessions">
          <Row
            attr="show-automation"
            label="Show runs started by other tools"
            desc={
              <>
                Sessions that apps and agents launched programmatically (<span className="font-mono text-mono-small">claude -p</span>, the Agent SDK, <span className="font-mono text-mono-small">codex exec</span>). Off, only sessions you started are listed.
                {!showAutomation && hiddenAutomation > 0 && <span className="text-faint"> {hiddenAutomation} hidden right now.</span>}
              </>
            }
            control={<Switch label="Show runs started by other tools" on={showAutomation} onChange={setShowAutomation} />}
          />
        </Section>

        <Section label="AI insights">
          <Row
            label="AI insights"
            desc="A one-line headline for each live session, and a “Needs you” flag with the reason when an agent is blocked on you."
            control={<Switch label="AI insights" on={!!st?.enabled} disabled={!st || !avail} onChange={(v) => void run(() => api().insightsSetEnabled(v), { enabled: v })} />}
          >
            <div className="rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-2.5 py-2 text-small text-dim">
              Uses <span className="font-medium text-fg/85">your own Anthropic API key</span>, billed to you, never your Claude Code or Codex login. A small model (Claude Haiku 5.5) runs only for live sessions whose activity changed, at most once per
              session every 45s, with an hourly cap: roughly $0.03 per hour of nonstop agent work per session, usually far less.
            </div>
          </Row>
          <Row label="API key" desc={avail && st && !st.has_key ? "Stored in the macOS Keychain. coool can't show it again; you can only replace or remove it." : undefined}>
            {!avail ? (
              <div className="flex items-center gap-2 text-small text-dim">
                <IAlert size={14} className="shrink-0 text-busy-text" />
                Insights aren't available in this build of coool yet.
              </div>
            ) : st?.has_key && !replacing ? (
              <div className="flex flex-col gap-2">
                <span className="flex h-[32px] items-center gap-2 rounded-[8px] border border-line bg-bg px-2.5 text-small">
                  <ICheck size={14} className="shrink-0 text-accent-text" />
                  <span className="min-w-0 truncate text-fg/90">Key saved in your Keychain</span>
                  <span className="ml-auto font-mono text-mono-small tracking-[0.2em] text-faint">••••</span>
                </span>
                <div className="flex gap-1.5">
                  <Button variant="outline" className="h-[30px] flex-1" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                  <Button variant="ghost" className="h-[30px] flex-1 hover:text-err-text" onClick={() => void run(() => api().insightsClearKey(), { has_key: false })}>
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <input type="password" autoComplete="off" spellCheck={false} className={inputCls} placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
                <div className="flex gap-1.5">
                  <Button variant="primary" type="submit" className="h-[30px] flex-1" disabled={!key.trim() || saving}>
                    {saving ? "Saving…" : "Save key"}
                  </Button>
                  {replacing && (
                    <Button variant="ghost" className="h-[30px] flex-1" onClick={() => setReplacing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
            {err && <div className="text-small text-err-text">{err}</div>}
          </Row>
        </Section>
      </div>
    </div>
  );
}
