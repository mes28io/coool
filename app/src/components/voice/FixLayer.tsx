// The fixer in a composer, Grammarly-style, without touching the textarea itself: a mirror layer behind the (clear)
// textarea draws the same text in transparent ink, with a quiet underline under each suggestion and a fading tint on
// words memory just changed. The mirror copies the textarea's box, font and scroll, so the marks sit under the right
// letters; typing, IME, undo, selection, paste and the slash menu are the textarea's own, untouched.
//
// A suggestion's card opens when the caret is in it, the pointer rests on it, or the counter chip is clicked: the
// replacement, why, and Accept · Dismiss · Always. Tab accepts the suggestion at (or after) the caret. A word memory
// changed can be undone from its card ("Undo, and don't do this again").

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { acceptSuggestion, answerOffer, checkTyped, dismissSuggestion, fixAll, getTarget, openSuggestion, shiftField, undoApplied, useVoice, type Insertion } from "../../lib/voice/controller";
import { diffEdit, mapSpan } from "../../lib/voice/ranges";
import type { Suggestion } from "../../lib/voice/suggest";
import { getVoicePrefs } from "../../lib/voice/prefs";
import { cx, ease, Kbd } from "../primitives";
import "./voice.css";

const COPY = [
  "boxSizing",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
  "fontFeatureSettings",
  "fontVariationSettings",
  "fontKerning",
  "fontStretch",
  "textRendering",
] as const;

/** How long a memory change stays tinted, and stays undoable from its card. */
const TINT_MS = 2600;
const UNDO_MS = 60_000;

const KIND_LABEL: Record<Suggestion["kind"], string> = { memory: "Memory", term: "Your words", spelling: "Spelling", grammar: "Grammar", cleanup: "Clean-up", ai: "AI" };

type Mark = { from: number; to: number; kind: "sug"; s: Suggestion } | { from: number; to: number; kind: "applied"; a: Insertion["applied"][number] };

export function FixLayer({ target, ta, text }: { target: string; ta: RefObject<HTMLTextAreaElement | null>; text: string }) {
  const sugs = useVoice((s) => s.suggestions[target]);
  const ins = useVoice((s) => s.inserted[target]);
  const open = useVoice((s) => s.open[target] ?? null);
  const mirror = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState<string | null>(null);
  const [caretIn, setCaretIn] = useState<string | null>(null);

  // Copy the textarea's box and font; again when it resizes (it grows with its text). Re-attached if the textarea
  // element changes (checked after every render; cheap).
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (ta.current !== el) setEl(ta.current);
  });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const st: Record<string, string> = {};
      for (const k of COPY) st[k] = cs[k];
      setStyle(st as React.CSSProperties);
      if (mirror.current) mirror.current.scrollTop = el.scrollTop;
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const onScroll = () => mirror.current && (mirror.current.scrollTop = el.scrollTop);
    el.addEventListener("scroll", onScroll);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [el]);

  // Keep ranges right while the person edits; re-check typed text (debounced) when that is on.
  const prev = useRef(text);
  const typedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const e = diffEdit(prev.current, text);
    prev.current = text;
    if (!e) return;
    shiftField(target, (r) => mapSpan(r, e), text);
    if (getVoicePrefs().fixTyped) {
      if (typedTimer.current) clearTimeout(typedTimer.current);
      typedTimer.current = setTimeout(() => {
        const t = getTarget(target);
        if (t) void checkTyped(t);
      }, 700);
    }
  }, [text, target]);
  useEffect(() => () => void (typedTimer.current && clearTimeout(typedTimer.current)), []);

  // The tint fades on its own; this re-render drops it from the mirror afterwards.
  const lastApplied = ins?.applied.reduce((m, a) => Math.max(m, a.at), 0) ?? 0;
  useEffect(() => {
    if (!lastApplied) return;
    const t = setTimeout(() => setNow(Date.now()), TINT_MS + 50);
    return () => clearTimeout(t);
  }, [lastApplied]);

  const marks = useMemo<Mark[]>(() => {
    const m: Mark[] = [];
    for (const s of sugs ?? []) if (text.slice(s.from, s.to) === s.original) m.push({ from: s.from, to: s.to, kind: "sug", s });
    for (const a of ins?.applied ?? []) if (Date.now() - a.at < UNDO_MS && text.slice(a.from, a.to) === a.written && !m.some((x) => x.from < a.to && a.from < x.to)) m.push({ from: a.from, to: a.to, kind: "applied", a });
    return m.sort((a, b) => a.from - b.from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugs, ins, text, now]);

  // The caret inside a mark opens its card.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const read = () => {
      if (document.activeElement !== el || el.selectionStart !== el.selectionEnd) return setCaretIn(null);
      const c = el.selectionStart ?? 0;
      const hit = marks.find((m) => c > m.from && c < m.to) ?? marks.find((m) => c === m.to && m.kind === "sug");
      setCaretIn(hit ? keyOf(hit) : null);
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [ta, marks]);

  // Pointer resting on a mark (the textarea is on top, so hit-test the mirror's spans by position).
  useEffect(() => {
    // (the textarea element is `el`, kept in step above)
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const move = (e: MouseEvent) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const spans = mirror.current?.querySelectorAll<HTMLElement>("[data-mark]") ?? [];
        let hit: string | null = null;
        for (const s of spans) for (const r of s.getClientRects()) if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) hit = s.dataset.mark!;
        setHover(hit);
      }, 120);
    };
    const leave = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setHover(null), 400);
    };
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", leave);
    return () => {
      if (t) clearTimeout(t);
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseleave", leave);
    };
  }, [el]);

  const active = open ?? caretIn ?? hover;
  const activeMark = marks.find((m) => keyOf(m) === active) ?? null;
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!activeMark || !mirror.current) return setCardPos(null);
    const span = mirror.current.querySelector<HTMLElement>(`[data-mark="${CSS.escape(keyOf(activeMark))}"]`);
    const host = mirror.current.parentElement;
    if (!span || !host) return setCardPos(null);
    const r = span.getClientRects()[0] ?? span.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    setCardPos({ left: Math.max(4, Math.min(r.left - h.left, h.width - 300)), top: r.top - h.top });
  }, [activeMark, text, style]);

  return (
    <>
      <div ref={mirror} aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent" style={style} data-fix-mirror>
        {render(text, marks, now)}
      </div>
      <AnimatePresence>
        {activeMark && cardPos && (
          <motion.div
            key={keyOf(activeMark)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease }}
            className="absolute z-30 w-[296px] -translate-y-full rounded-[12px] border border-line bg-raised p-2.5 shadow-pop"
            style={{ left: cardPos.left, top: cardPos.top - 6 }}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setHover(keyOf(activeMark))}
            data-fix-card={activeMark.kind === "sug" ? activeMark.s.kind : "applied"}
          >
            {activeMark.kind === "sug" ? <SugCard target={target} s={activeMark.s} count={(sugs ?? []).length} /> : <AppliedCard target={target} a={activeMark.a} />}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const keyOf = (m: Mark) => (m.kind === "sug" ? m.s.id : `a${m.a.from}-${m.a.at}`);

function render(text: string, marks: Mark[], now: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.from < at) continue;
    out.push(text.slice(at, m.from));
    const k = keyOf(m);
    if (m.kind === "sug")
      out.push(
        <span key={k} data-mark={k} className={cx("fix-mark", m.s.kind === "spelling" || m.s.kind === "grammar" ? "fix-mark-spell" : "fix-mark-voice")} data-fix-kind={m.s.kind}>
          {text.slice(m.from, m.to)}
        </span>,
      );
    else
      out.push(
        <span key={k} data-mark={k} className={cx("fix-applied", now - m.a.at < TINT_MS && "fix-applied-on")} data-fix-applied={m.a.written}>
          {text.slice(m.from, m.to)}
        </span>,
      );
    at = m.to;
  }
  out.push(text.slice(at), "​");
  return out;
}

function SugCard({ target, s, count }: { target: string; s: Suggestion; count: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{KIND_LABEL[s.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-small text-dim">{s.reason.toLowerCase() === KIND_LABEL[s.kind].toLowerCase() ? "" : s.reason}</span>
      </div>
      <div className="flex items-baseline gap-2 text-base">
        <span className="text-faint line-through decoration-1">{s.original || "·"}</span>
        <span className="text-faint">→</span>
        <span className="font-medium text-fg" data-fix-replacement>
          {s.replacement || "(remove)"}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" data-fix-accept onClick={() => acceptSuggestion(target, s)} className="h-[26px] rounded-[7px] bg-fg px-2.5 text-small font-medium text-bg hover:opacity-85">
          Accept
        </button>
        <button type="button" data-fix-dismiss onClick={() => dismissSuggestion(target, s)} className="h-[26px] rounded-[7px] px-2 text-small text-dim hover:bg-hover hover:text-fg">
          Dismiss
        </button>
        <button type="button" data-fix-always onClick={() => acceptSuggestion(target, s, true)} className="h-[26px] rounded-[7px] px-2 text-small text-dim hover:bg-hover hover:text-fg" title="Accept and always make this fix">
          Always
        </button>
        <span className="flex-1" />
        {count > 1 ? (
          <button type="button" onClick={() => fixAll(target)} className="h-[26px] rounded-[7px] px-2 text-small text-dim hover:bg-hover hover:text-fg" data-fix-all>
            Fix all {count}
          </button>
        ) : (
          <Kbd className="h-[20px] px-1">tab</Kbd>
        )}
      </div>
    </div>
  );
}

function AppliedCard({ target, a }: { target: string; a: Insertion["applied"][number] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-small text-dim">
        From memory: you wrote <span className="font-medium text-fg">{a.written}</span> for “{a.original}” before.
      </div>
      <div className="flex items-center gap-1">
        <button type="button" data-fix-undo onClick={() => undoApplied(target, a)} className="h-[26px] rounded-[7px] px-2 text-small text-fg hover:bg-hover">
          Undo, and don’t do this again
        </button>
      </div>
    </div>
  );
}

/** Tab in the composer: accept the suggestion at the caret, or the next one after it. True when it did. */
export function fixKey(e: React.KeyboardEvent<HTMLTextAreaElement>, target: string): boolean {
  if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  const list = useVoice.getState().suggestions[target] ?? [];
  if (!list.length) return false;
  const c = e.currentTarget.selectionStart ?? 0;
  const s = list.find((x) => c >= x.from && c <= x.to) ?? list.find((x) => x.from >= c) ?? list[0];
  e.preventDefault();
  acceptSuggestion(target, s);
  return true;
}

/** "3 suggestions" in the chip row: opens them in order. */
export function FixCount({ target, ta }: { target: string; ta: RefObject<HTMLTextAreaElement | null> }) {
  const list = useVoice((s) => s.suggestions[target]);
  const n = list?.length ?? 0;
  const go = useCallback(() => {
    const l = useVoice.getState().suggestions[target] ?? [];
    const cur = useVoice.getState().open[target];
    const i = l.findIndex((x) => x.id === cur);
    const s = l[(i + 1) % l.length];
    if (!s) return;
    openSuggestion(target, s.id);
    ta.current?.focus({ preventScroll: true });
    ta.current?.setSelectionRange(s.to, s.to);
  }, [target, ta]);
  return (
    <AnimatePresence initial={false}>
      {n > 0 && (
        <motion.button
          key="count"
          type="button"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.14, ease }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={go}
          data-fix-count={n}
          className="inline-flex h-[28px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2 text-small font-medium text-dim hover:bg-hover hover:text-fg"
          title="Review suggestions (Tab accepts)"
        >
          <span className="size-[6px] rounded-full bg-[var(--accent)]" />
          {n} {n === 1 ? "suggestion" : "suggestions"}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** After a clear one-word fix of dictated text: "Always write Tauri for “tory”?  Add · Not now". */
export function FixOffer({ target }: { target: string }) {
  const offer = useVoice((s) => (s.offer?.target === target ? s.offer : null));
  useEffect(() => {
    if (!offer) return;
    const t = setTimeout(() => answerOffer(false), 12_000);
    return () => clearTimeout(t);
  }, [offer]);
  return (
    <AnimatePresence initial={false}>
      {offer && (
        <motion.div
          key="offer"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.16, ease }}
          className="overflow-hidden"
          data-fix-offer
        >
          <div className="flex items-center gap-2 px-2 pt-1.5 text-small text-dim">
            <span className="min-w-0 truncate">
              Always write <span className="font-medium text-fg">{offer.pair.written}</span> for “{offer.pair.heard}”?
            </span>
            <button type="button" onClick={() => answerOffer(true)} className="font-medium text-fg hover:underline" data-fix-offer-add>
              Add
            </button>
            <span className="text-faint">·</span>
            <button type="button" onClick={() => answerOffer(false)} className="hover:text-fg">
              Not now
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
