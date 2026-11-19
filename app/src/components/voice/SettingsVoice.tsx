// Settings > Voice (APP_SPEC "Voice"): on/off, the microphone and its permission, the model (download, pause, resume,
// cancel, use a file already on this Mac), how it writes (translate or transcribe, language, clean-up, send on
// release), the keys, the fixer, and Memory: the words library and every learned correction, searchable and editable,
// with import/export and "Clear everything". Each row filters itself under the Settings search (settings/ui.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store";
import { projectOf, homeShort, folderName } from "../../lib/format";
import { voiceApi, type MicPermission, type ProjectWord } from "../../lib/voice/api";
import { addWord, exportMemory, importMemory, offeredPairs, recordAlways, recordNever, removeEntry, type Entry } from "../../lib/voice/memory";
import { clearMemory, DEFAULT_TOGGLE, loadMemory, setVoicePrefs, updateMemory, useMemory, useVoicePrefs, type Chord, type HoldKey } from "../../lib/voice/prefs";
import { useVoice } from "../../lib/voice/controller";
import { SHORTCUTS } from "../../lib/shortcuts";
import { Button, cx, Kbd } from "../primitives";
import { ErrorLine, Group, Mono, Note, Row, Select, Switch, Tag, useSearching, type Option } from "../settings/ui";
import { chordKeys, HOLD_LABEL, Meter } from "./parts";
import { ModelPicker } from "./ModelPicker";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const LANGUAGES: Option<string>[] = [
  { value: "auto", label: "Detect automatically" },
  ...(
    [
      ["en", "English"],
      ["tr", "Turkish"],
      ["de", "German"],
      ["es", "Spanish"],
      ["fr", "French"],
      ["it", "Italian"],
      ["pt", "Portuguese"],
      ["nl", "Dutch"],
      ["pl", "Polish"],
      ["ru", "Russian"],
      ["uk", "Ukrainian"],
      ["ar", "Arabic"],
      ["fa", "Persian"],
      ["hi", "Hindi"],
      ["zh", "Chinese"],
      ["ja", "Japanese"],
      ["ko", "Korean"],
      ["sv", "Swedish"],
      ["el", "Greek"],
      ["he", "Hebrew"],
    ] as const
  ).map(([value, label]) => ({ value, label })),
];

const PERM_TEXT: Record<MicPermission, string> = {
  not_determined: "macOS asks the first time you dictate.",
  authorized: "Allowed. The microphone is open only while you dictate.",
  denied: "Turned off for coool in System Settings.",
  restricted: "Blocked on this Mac (a profile or parental control).",
  unavailable: "Not available in this build.",
};

export function VoiceSettings() {
  const p = useVoicePrefs();
  const [perm, setPerm] = useState<MicPermission | null>(null);
  useEffect(() => {
    const v = voiceApi();
    const read = () => void v.permission().then(setPerm).catch(() => setPerm("unavailable"));
    read();
    window.addEventListener("focus", read);
    void loadMemory();
    return () => window.removeEventListener("focus", read);
  }, []);
  return (
    <>
      <Group>
        <Row
          attr="voice-on"
          label="Voice to prompt"
          desc="Speak into any composer; a model on this Mac writes it down. Audio never leaves your computer."
          k="dictation speech microphone whisper talk"
          control={<Switch label="Voice to prompt" on={p.enabled} onChange={(v) => setVoicePrefs({ enabled: v })} />}
        />
        <Row
          attr="voice-permission"
          label="Microphone permission"
          k="allow privacy system settings mic"
          desc={<span data-voice-permission={perm ?? ""}>{perm ? PERM_TEXT[perm] : "…"}</span>}
          control={
            perm === "denied" || perm === "restricted" ? (
              <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void voiceApi().openPrivacy()}>
                Open System Settings
              </Button>
            ) : perm === "authorized" ? (
              <Tag tone="ok">allowed</Tag>
            ) : perm === "not_determined" ? (
              <Tag>not asked yet</Tag>
            ) : null
          }
        />
      </Group>

      <Group label="Model" attr="voice-model">
        <Row label="Speech model" desc="Runs on this Mac. Downloaded from the official whisper.cpp host only when you press Download, and checked against its published checksum." k="whisper model download size medium small large turbo ggml">
          <ModelPicker />
        </Row>
      </Group>

      <Group label="How it writes">
        <Row
          attr="voice-task"
          label="Mode"
          desc={p.task === "translate" ? "Speak any language, get an English prompt." : "Writes what you said, in the language you said it."}
          k="translate transcribe english language"
          control={
            <Select
              label="Mode"
              value={p.task}
              width={250}
              onChange={(v) => setVoicePrefs({ task: v })}
              options={[
                { value: "translate", label: "Translate to English", hint: "Any language in, English out" },
                { value: "transcribe", label: "Transcribe as spoken", hint: "Keeps your language" },
              ]}
            />
          }
        />
        <Row attr="voice-language" label="Language you speak" desc="Detecting works for most; a fixed language is a little faster and surer." k="language detect auto" control={<Select label="Language" value={p.language} width={220} onChange={(v) => setVoicePrefs({ language: v })} options={LANGUAGES} />} />
        <Row attr="voice-cleanup" label="Clean up" desc="Removes fillers (um, uh, you know), stutters and repeated words." k="filler stutter repeat tidy" control={<Switch label="Clean up" on={p.cleanup} onChange={(v) => setVoicePrefs({ cleanup: v })} />} />
        <Row attr="voice-send" label="Send when I release" desc="Sends the prompt right away instead of leaving it in the composer to check." k="auto send release" control={<Switch label="Send when I release" on={p.sendOnRelease} onChange={(v) => setVoicePrefs({ sendOnRelease: v })} />} />
      </Group>

      <Group label="Microphone">
        <MicRow perm={perm} />
      </Group>

      <Group label="Keys" footer="Voice keys work while a composer or answer field has focus, never while a device panel has the keyboard.">
        <VoiceKeyRows />
      </Group>

      <Group label="Fixing">
        <Row attr="voice-learn" label="Learn from my corrections" desc="What you fix in dictated text is remembered, and applied for you once you’ve made the same fix twice." k="memory learn corrections" control={<Switch label="Learn from my corrections" on={p.learn} onChange={(v) => setVoicePrefs({ learn: v })} />} />
        <Row attr="voice-spell" label="Spelling and grammar" desc="macOS’s own checker, on this Mac, underlines what looks wrong. Your words are never flagged." k="spell check grammar underline" control={<Switch label="Spelling and grammar" on={p.spell} onChange={(v) => setVoicePrefs({ spell: v })} />} />
        <Row attr="voice-typed" label="Check what I type too" desc="Suggestions on typed text in the composer, not only dictated text." k="typed grammarly" control={<Switch label="Check what I type too" on={p.fixTyped} onChange={(v) => setVoicePrefs({ fixTyped: v })} />} />
        <Row
          attr="voice-ai"
          label="Proofread dictation"
          desc="With Assist on, a small model suggests fixes for dictated text it thinks was misheard. Only that text and your words list are sent; fixes from memory never ask it."
          k="ai haiku polish insights"
          control={<Switch label="Proofread dictation" on={p.aiPolish} onChange={(v) => setVoicePrefs({ aiPolish: v })} />}
        />
      </Group>

      <MemorySection />
    </>
  );
}


function MicRow({ perm }: { perm: MicPermission | null }) {
  const p = useVoicePrefs();
  const [devices, setDevices] = useState<{ name: string; default: boolean }[]>([]);
  const [testing, setTesting] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const busy = useVoice((s) => s.phase !== "idle" && s.phase !== "error");
  useEffect(() => {
    void voiceApi().devices().then(setDevices).catch(() => {});
  }, []);
  useEffect(() => {
    if (!testing) return;
    const v = voiceApi();
    const off = v.onLevel(({ level }) => setLevels((l) => (l.length >= 40 ? [...l.slice(1), level] : [...l, level])));
    return () => {
      off();
      void v.cancel();
    };
  }, [testing]);
  const test = async () => {
    setErr(null);
    if (testing) return setTesting(false);
    try {
      const v = voiceApi();
      // A test is a first use too: macOS asks here if it hasn't yet.
      if ((await v.permission()) === "not_determined") await v.requestPermission();
      setLevels([]);
      setTesting(true);
      await v.start(p.device, null);
      setTimeout(() => setTesting(false), 15_000);
    } catch (e) {
      setTesting(false);
      setErr(/^permission:/.test(errText(e)) ? "coool isn't allowed to use the microphone." : errText(e));
    }
  };
  const opts: Option<string>[] = [{ value: "", label: "System default" }, ...devices.map((d) => ({ value: d.name, label: d.name, hint: d.default ? "current system default" : undefined }))];
  return (
    <Row
      attr="voice-device"
      label="Input"
      desc={testing ? "Speak: the bars should move. Stops by itself after 15 seconds." : "The microphone voice listens to."}
      k="input device microphone level test airpods"
      control={
        <>
          <Select label="Input device" value={p.device ?? ""} width={260} onChange={(v) => setVoicePrefs({ device: v || null })} options={opts} />
          <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={busy || perm === "denied" || perm === "restricted"} onClick={() => void test()} data-voice-test>
            {testing ? "Stop" : "Test"}
          </Button>
        </>
      }
    >
      {testing && <Meter levels={levels} bars={40} className="h-[22px]" tone="var(--accent)" />}
      <ErrorLine>{err}</ErrorLine>
    </Row>
  );
}

// ---------------------------------------------------------------- keys

const HOLD_OPTS: Option<HoldKey>[] = [
  { value: "AltRight", label: "Right ⌥ Option", hint: "Hold alone; ⌥ shortcuts still type" },
  { value: "Fn", label: "Fn (🌐)", hint: "Set System Settings > Keyboard “Press 🌐 key to” to Do Nothing" },
  { value: "MetaRight", label: "Right ⌘ Command", hint: "Hold alone" },
  { value: "off", label: "Off" },
];

/** The two voice keys, also listed (and changeable) in Settings > Keyboard shortcuts. */
export function VoiceKeyRows() {
  const p = useVoicePrefs();
  return (
    <>
      <Row attr="voice-hold" dense label="Hold to talk" desc="Hold, speak, release to insert." k="push to talk shortcut key option fn hold" control={<Select label="Hold to talk" value={p.hold} width={280} onChange={(v) => setVoicePrefs({ hold: v })} options={HOLD_OPTS} />} />
      <Row attr="voice-toggle" dense label="Hands-free" desc="Press once to start, again to insert." k="toggle shortcut key hands free" control={<ChordRecorder value={p.toggle} onChange={(c) => setVoicePrefs({ toggle: c })} />} />
    </>
  );
}

/** Is `c` one of coool's own shortcuts (or a plain typing key)? */
function clash(c: Chord): string | null {
  if (!c.meta && !c.ctrl && !c.alt) return "Use at least one of ⌘ ⌃ ⌥, so it doesn't type.";
  const e = { key: c.code.replace(/^Key/, "").toLowerCase(), code: c.code, metaKey: c.meta, ctrlKey: c.ctrl, shiftKey: c.shift, altKey: c.alt };
  const hit = SHORTCUTS.find((s) => s.match?.(e));
  return hit ? `That's “${hit.label}” already.` : null;
}

function ChordRecorder({ value, onChange }: { value: Chord | null; onChange: (c: Chord | null) => void }) {
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      const c: Chord = { code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
      const why = clash(c);
      if (why) return setErr(why);
      setErr(null);
      onChange(c);
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, onChange]);
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        <button
          ref={btn}
          type="button"
          onClick={() => (setErr(null), setRec((r) => !r))}
          className={cx("flex h-[30px] min-w-[96px] items-center justify-center gap-1 rounded-[8px] border px-2 text-small", rec ? "border-[color-mix(in_oklab,var(--accent)_60%,var(--border))] text-fg" : "border-line bg-bg text-fg")}
          data-voice-chord
        >
          {rec ? "Press keys…" : value ? chordKeys(value).map((k) => <Kbd key={k} className="h-[20px] min-w-[20px] px-1">{k}</Kbd>) : "Off"}
        </button>
        {value && !rec && (
          <button type="button" className="text-small text-faint hover:text-fg" onClick={() => onChange(null)}>
            Off
          </button>
        )}
        {!rec && JSON.stringify(value) !== JSON.stringify(DEFAULT_TOGGLE) && (
          <button type="button" className="text-small text-faint hover:text-fg" onClick={() => onChange(DEFAULT_TOGGLE)}>
            Reset
          </button>
        )}
      </span>
      <ErrorLine>{err}</ErrorLine>
    </span>
  );
}

// ---------------------------------------------------------------- memory

const SOURCE_LABEL: Record<Entry["source"], string> = { seed: "coool", you: "you", edit: "your edits", spelling: "spelling", ai: "AI", project: "project", import: "import" };

function status(e: Entry): { label: string; tone?: "ok" | "warn" | "off" } {
  if (e.never) return { label: "never", tone: "off" };
  if (e.dismissals >= 2) return { label: "muted", tone: "off" };
  if (!e.heard.length) return { label: "word" };
  if (e.confirmed) return { label: "auto", tone: "ok" };
  return { label: `seen ${e.accepts}×`, tone: "warn" };
}

const ago = (t: number) => {
  if (!t) return "never";
  const d = (Date.now() - t) / 1000;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
};

function MemorySection() {
  const m = useMemory();
  const searching = useSearching();
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    void voiceApi().status().then((s) => setPath(s.memory_path)).catch(() => {});
  }, []);
  const entries = m?.entries ?? [];
  const learned = m ? offeredPairs(m) : [];
  const list = useMemo(() => {
    const w = q.toLowerCase().trim();
    return (m?.entries ?? [])
      .filter((e) => !w || e.written.toLowerCase().includes(w) || e.heard.some((h) => h.toLowerCase().includes(w)))
      .sort((a, b) => Number(a.source === "seed") - Number(b.source === "seed") || b.lastUsed - a.lastUsed || a.written.localeCompare(b.written));
  }, [m, q]);
  const doExport = () => {
    if (!m) return;
    const blob = new Blob([exportMemory(m)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coool-voice-memory.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const doImport = (f: File) =>
    void f.text().then((t) => {
      let out: ReturnType<typeof importMemory> | null = null;
      updateMemory((cur) => {
        out = importMemory(cur, t, Date.now());
        return out.memory;
      });
      const r = out as ReturnType<typeof importMemory> | null;
      setMsg(r ? (r.errors.length && !r.added && !r.merged ? `Couldn't import: ${r.errors[0]}` : `Imported ${r.added} new, merged ${r.merged}.`) : null);
    });
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      {learned.length > 0 && (
        <Group label="Learned from your edits" attr="voice-learned" footer="Accept to have coool make these fixes for you from now on.">
          {learned.map((e) => (
            <Row
              key={`${e.entryId}-${e.heard}`}
              dense
              attr={`voice-learned-${e.written}`}
              label={
                <span>
                  “{e.heard}” → <span className="font-medium">{e.written}</span>
                </span>
              }
              k={`${e.written} ${e.heard} learned`}
              desc="You made this fix once. Accept, and coool makes it for you from now on."
              control={
                <>
                  <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={() => updateMemory((x) => recordAlways(x, e.heard, e.written, "you", Date.now()))} data-voice-learned-accept>
                    Accept
                  </Button>
                  <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => updateMemory((x) => recordNever(x, e.heard, e.written, Date.now()))}>
                    Dismiss
                  </Button>
                </>
              }
            />
          ))}
        </Group>
      )}
      <Group label="Memory" attr="voice-memory" footer={path ? <>Everything is in one file on this Mac: <Mono>{homeShort(path)}</Mono>. Never synced or sent.</> : undefined}>
        <Row label="Your words and fixes" desc="Names, project words and corrections. Words bias the model; a fix with “heard as” is applied once confirmed." k="words library vocabulary memory corrections dictionary heard">
          {!searching && (
            <div className="flex items-center gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${entries.length} entries`} aria-label="Search memory" spellCheck={false} className="h-[30px] min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2.5 text-small outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]" data-voice-memory-search />
              <AddEntry />
            </div>
          )}
          <div className="scroll max-h-[340px] divide-y divide-hairline rounded-[8px] border border-line" data-voice-memory-list={list.length}>
            {list.slice(0, 300).map((e) => (
              <EntryRow key={e.id} e={e} />
            ))}
            {!list.length && <div className="px-3 py-3 text-small text-dim">{q ? `Nothing matches “${q}”.` : "No entries yet."}</div>}
          </div>
        </Row>
        <ProjectWords />
        <Row
          label="Import, export, clear"
          k="import export json clear reveal finder"
          control={
            <>
              <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
              <Button variant="ghost" className="h-[30px] px-2 text-small" onClick={() => file.current?.click()}>
                Import…
              </Button>
              <Button variant="ghost" className="h-[30px] px-2 text-small" onClick={doExport}>
                Export
              </Button>
              <Button variant="ghost" className="h-[30px] px-2 text-small" onClick={() => void voiceApi().reveal("memory")}>
                Reveal in Finder
              </Button>
              {confirmClear ? (
                <Button
                  variant="danger"
                  className="h-[30px] px-2.5 text-small"
                  onClick={() => {
                    setConfirmClear(false);
                    void clearMemory().then(() => setMsg("Cleared. coool’s own developer words are back."));
                  }}
                >
                  Clear everything
                </Button>
              ) : (
                <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => setConfirmClear(true)}>
                  Clear everything…
                </Button>
              )}
            </>
          }
        >
          {msg && <div className="text-small text-dim">{msg}</div>}
        </Row>
      </Group>
    </>
  );
}

function EntryRow({ e }: { e: Entry }) {
  const [edit, setEdit] = useState(false);
  const [w, setW] = useState(e.written);
  const [h, setH] = useState(e.heard.join(", "));
  const st = status(e);
  const save = () => {
    const written = w.trim();
    if (!written) return;
    updateMemory((m) => ({ ...m, entries: m.entries.map((x) => (x.id === e.id ? { ...x, written, heard: splitHeard(h), source: x.source === "seed" ? "you" : x.source, confirmed: x.confirmed || x.source === "seed" || !!splitHeard(h).length } : x)) }));
    setEdit(false);
  };
  if (edit)
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <input value={w} onChange={(x) => setW(x.target.value)} className="h-[28px] w-[150px] rounded-[7px] border border-line bg-bg px-2 text-small outline-none" aria-label="Written as" />
        <span className="text-faint">←</span>
        <input value={h} onChange={(x) => setH(x.target.value)} placeholder="heard as (comma separated)" className="h-[28px] min-w-0 flex-1 rounded-[7px] border border-line bg-bg px-2 text-small outline-none placeholder:text-faint" aria-label="Heard as" onKeyDown={(x) => x.key === "Enter" && save()} />
        <Button variant="outline" className="h-[28px] px-2 text-small" onClick={save}>
          Save
        </Button>
      </div>
    );
  return (
    <div className="group flex items-center gap-2 px-2.5 py-1.5" data-voice-entry={e.written}>
      <span className="min-w-0 flex-1 truncate text-small">
        <span className="font-medium text-fg">{e.written}</span>
        {e.heard.length > 0 && <span className="text-dim"> ← {e.heard.join(", ")}</span>}
      </span>
      <span className="hidden shrink-0 text-micro text-faint group-hover:inline">
        {SOURCE_LABEL[e.source]} · used {e.uses}× · {ago(e.lastUsed)}
      </span>
      <Tag tone={st.tone}>{st.label}</Tag>
      <button type="button" className="text-micro text-faint opacity-0 hover:text-fg group-hover:opacity-100" onClick={() => setEdit(true)}>
        Edit
      </button>
      <button type="button" className="text-micro text-faint opacity-0 hover:text-err-text group-hover:opacity-100" onClick={() => updateMemory((m) => removeEntry(m, e.id))} aria-label={`Remove ${e.written}`}>
        Remove
      </button>
    </div>
  );
}

const splitHeard = (s: string) =>
  s
    .split(/[,/]/)
    .map((x) => x.trim())
    .filter(Boolean);

function AddEntry() {
  const [open, setOpen] = useState(false);
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const add = () => {
    const written = w.trim();
    if (!written) return;
    const heard = splitHeard(h);
    updateMemory((m) => addWord(m, written, heard, "you", Date.now()));
    setW("");
    setH("");
    setOpen(false);
  };
  if (!open)
    return (
      <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => setOpen(true)} data-voice-add>
        Add word
      </Button>
    );
  return (
    <span className="flex items-center gap-1.5">
      <input autoFocus value={w} onChange={(e) => setW(e.target.value)} placeholder="Tauri" aria-label="Word" className="h-[30px] w-[110px] rounded-[8px] border border-line bg-bg px-2 text-small outline-none" />
      <input value={h} onChange={(e) => setH(e.target.value)} placeholder="heard as: tory, towery" aria-label="Heard as" className="h-[30px] w-[170px] rounded-[8px] border border-line bg-bg px-2 text-small outline-none placeholder:text-faint" onKeyDown={(e) => e.key === "Enter" && add()} />
      <Button variant="primary" className="h-[30px] px-2.5 text-small" onClick={add}>
        Add
      </Button>
    </span>
  );
}

function ProjectWords() {
  const sessions = useStore((s) => s.sessions);
  const projects = useMemo(() => {
    const seen: string[] = [];
    for (const s of [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))) {
      const p = projectOf(s);
      if (p && !seen.includes(p)) seen.push(p);
    }
    return seen.slice(0, 12);
  }, [sessions]);
  const [proj, setProj] = useState("");
  const [words, setWords] = useState<(ProjectWord & { on: boolean })[] | null>(null);
  const m = useMemory();
  const known = new Set((m?.entries ?? []).map((e) => e.written.toLowerCase()));
  const cur = proj || projects[0] || "";
  const find = async () => {
    const w = await voiceApi().projectWords(cur);
    setWords(w.filter((x) => !known.has(x.word.toLowerCase())).map((x) => ({ ...x, on: true })));
  };
  const add = () => {
    const now = Date.now();
    updateMemory((mm) => (words ?? []).filter((x) => x.on).reduce((acc, x) => addWord(acc, x.word, [], "project", now), mm));
    setWords(null);
  };
  if (!projects.length) return null;
  return (
    <Row
      label="Words from a project"
      desc="Package names, top-level files and folders, branch names. Read on this Mac, shown here first; nothing is added until you say so."
      k="project words package mine"
      control={
        <>
          <Select label="Project" value={cur} width={240} onChange={(v) => (setProj(v), setWords(null))} options={projects.map((p) => ({ value: p, label: folderName(p), hint: homeShort(p) }))} />
          <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void find()} data-voice-project-find>
            Find words
          </Button>
        </>
      }
    >
      {words && (
        <div className="flex flex-col gap-2">
          {words.length ? (
            <div className="flex flex-wrap gap-1.5" data-voice-project-words={words.length}>
              {words.map((x, i) => (
                <button
                  key={x.word}
                  type="button"
                  title={x.from}
                  onClick={() => setWords((ws) => ws!.map((y, j) => (j === i ? { ...y, on: !y.on } : y)))}
                  className={cx("h-[26px] rounded-[7px] border px-2 text-small", x.on ? "border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-accent-soft text-fg" : "border-line text-faint line-through")}
                >
                  {x.word}
                </button>
              ))}
            </div>
          ) : (
            <Note>No new words found there.</Note>
          )}
          {words.some((x) => x.on) && (
            <span className="flex gap-1.5">
              <Button variant="primary" className="h-[30px] px-2.5 text-small" onClick={add}>
                Add {words.filter((x) => x.on).length} words
              </Button>
              <Button variant="ghost" className="h-[30px] px-2 text-small" onClick={() => setWords(null)}>
                Cancel
              </Button>
            </span>
          )}
        </div>
      )}
    </Row>
  );
}

export { HOLD_LABEL };
