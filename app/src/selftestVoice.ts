// The `voice` self-test scenario (COOOL_SELFTEST=voice): voice end to end in the real app, no microphone and no
// model calls. The backend plays a WAV fixture as if it were captured (`voice_selftest_inject`), the real whisper.cpp
// engine transcribes it, and the page's own pipeline cleans, applies memory, inserts and checks. A composer of a chat
// that exists only in the page (no CLI is started; "sending" is the composer's learning hook, never a model call).
//
// Needs: COOOL_VOICE_MODEL (a multilingual ggml model; small or larger translates) and COOOL_VOICE_FIXTURES (a folder
// with en.wav, en-fillers.wav, en-terms.wav, tr.wav, de.wav, es.wav, made with `say -o … --data-format=LEI16@16000`).

import { useChats } from "./lib/chat";
import { useStore } from "./store";
import { voiceApi } from "./lib/voice/api";
import { cancelListening, getTarget, startListening, stopListening, targetOf, useVoice, noteSent, replaceRange, acceptSuggestion, answerOffer } from "./lib/voice/controller";
import { clearMemory, getMemory, setVoicePrefs, updateMemory } from "./lib/voice/prefs";
import { removeEntry } from "./lib/voice/memory";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string, window?: string, settle?: number) => Promise<void>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
}

type Inv = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Env {
  model: string | null;
  fixtures: string | null;
}
interface Transcript {
  text: string;
  language: string;
  ms: number;
  secs: number;
  load_ms: number;
}
interface Counters {
  spell: number;
  polish: number;
  runs: number;
}

const CHAT = 990_001;

export function voiceScenarios(h: H, invoke: Inv): Record<string, () => Promise<void>> {
  const { step, shot, log, sleep, waitFor, fail } = h;
  const counters = () => invoke("voice_selftest_counters") as Promise<Counters>;
  let env: Env = { model: null, fixtures: null };
  const fx = (n: string) => `${env.fixtures}/${n}`;
  const ta = () => document.querySelector<HTMLTextAreaElement>("[data-main] textarea[data-voice]") ?? document.querySelector<HTMLTextAreaElement>("textarea[data-voice]");

  /** Plays `file` into the field `el` as a hold-to-talk utterance: start, wait for it all to "arrive", release. */
  async function dictate(file: string, el: HTMLTextAreaElement | HTMLInputElement, opts: { shotName?: string } = {}) {
    const secs = (await invoke("voice_selftest_inject", { path: fx(file) })) as number;
    const t = targetOf(el);
    if (!t) throw fail("the field is not a voice target");
    el.focus();
    void startListening(t, "hold");
    await waitFor("listening", () => useVoice.getState().phase === "listening", 5_000);
    await sleep(secs * 1000 + 250);
    if (opts.shotName) await shot(opts.shotName, undefined, 0);
    const t0 = performance.now();
    await stopListening();
    await waitFor("the insertion", () => useVoice.getState().phase === "idle" || useVoice.getState().phase === "error", 60_000);
    if (useVoice.getState().phase === "error") throw fail(`voice error: ${useVoice.getState().error}`);
    return { ms: Math.round(performance.now() - t0), secs };
  }
  const suggestions = () => useVoice.getState().suggestions[getTarget(ta()?.dataset.voice ?? null)?.id ?? ""] ?? [];

  return {
    async voice() {
      env = (await invoke("voice_selftest_env")) as Env;
      if (!env.model || !env.fixtures) throw fail("set COOOL_VOICE_MODEL and COOOL_VOICE_FIXTURES");
      setVoicePrefs({ enabled: true, model: env.model, modelId: null, task: "transcribe", language: "auto", cleanup: true, learn: true, spell: true, aiPolish: false, sendOnRelease: false, hold: "AltRight" });
      await clearMemory();

      await step("voice: the engine transcribes and translates the fixtures (no microphone)", async () => {
        const out: string[] = [];
        const run = async (file: string, task: "transcribe" | "translate") => {
          const r = (await invoke("voice_selftest_transcribe", { path: fx(file), req: { model: env.model, task, language: null, prompt: null } })) as Transcript;
          out.push(`${file}/${task}: [${r.language}] ${r.ms} ms${r.load_ms ? ` (+${r.load_ms} ms load)` : ""} for ${r.secs.toFixed(1)} s: "${r.text}"`);
          return r;
        };
        const en = await run("en.wav", "transcribe");
        if (!/retry/i.test(en.text) || !/back ?off/i.test(en.text)) throw fail(`English: ${en.text}`);
        for (const [file, lang] of [
          ["tr.wav", "tr"],
          ["de.wav", "de"],
          ["es.wav", "es"],
        ] as const) {
          const a = await run(file, "transcribe");
          if (a.language !== lang) throw fail(`${file} heard as ${a.language}`);
          const b = await run(file, "translate");
          if (/[çğışöüñäß]/i.test(b.text) || !/\b(the|to|a|an|with|add|function)\b/i.test(b.text)) throw fail(`${file} translation isn't English: ${b.text}`);
        }
        for (const l of out) await log(`  ${l}`);
        return `${out.length} runs`;
      });

      // A chat that lives only in the page: its composer is a real one (no CLI behind it).
      useChats.getState().ensure({ id: CHAT, provider: "claude", cwd: "/tmp/voice-selftest", session_id: null, model: null, state: "idle", running: true });
      useStore.getState().open({ kind: "chat", id: CHAT });
      await waitFor("the composer", () => ta(), 10_000);

      await step("voice: hold to talk inserts the cleaned text at the caret, between existing text", async () => {
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "Before this. || After that.");
        el.setSelectionRange(13, 13);
        const r = await dictate("en-fillers.wav", el, { shotName: "voice-listening" });
        const v = el.value;
        await shot("voice-inserted", undefined, 300);
        if (!v.startsWith("Before this. ") || !v.endsWith("|| After that.")) throw fail(`surroundings changed: ${v}`);
        if (/\b(um|uh)\b|with with|the, the/i.test(v)) throw fail(`not cleaned: ${v}`);
        if (!/retry with exponential backoff to the upload function/i.test(v)) throw fail(`text: ${v}`);
        return `${r.secs.toFixed(1)} s of speech → inserted ${r.ms} ms after release: ${JSON.stringify(v)}`;
      });

      await step("voice: Esc while listening cancels (nothing inserted, nothing transcribed)", async () => {
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "keep me");
        const before = await counters();
        await invoke("voice_selftest_inject", { path: fx("en.wav") });
        el.focus();
        void startListening(targetOf(el)!, "hold");
        await waitFor("listening", () => useVoice.getState().phase === "listening", 5_000);
        await sleep(700);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        await sleep(400);
        const after = await counters();
        if (useVoice.getState().phase !== "idle") throw fail(`phase ${useVoice.getState().phase}`);
        if (el.value !== "keep me") throw fail(`value ${el.value}`);
        if (after.runs !== before.runs) throw fail("whisper ran after a cancel");
        // The next start must not reuse the cancelled fixture's capture.
        cancelListening();
        return "cancelled";
      });

      await step("voice: send when I release, off then on", async () => {
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "");
        await dictate("en.wav", el);
        if (!el.value.trim()) throw fail("off: nothing inserted");
        const off = el.value;
        replaceRange(el, 0, el.value.length, "");
        setVoicePrefs({ sendOnRelease: true });
        // The composer's send path runs (and clears the composer); the fake chat has no CLI, so the backend refuses.
        await dictate("en.wav", el);
        await sleep(400);
        setVoicePrefs({ sendOnRelease: false });
        if (el.value.trim()) throw fail(`on: still in the composer: ${el.value}`);
        return `off kept "${off}"; on sent it`;
      });

      await step("voice: memory learns a fix (edit → suggested → accepted → applied, with no checker or model call)", async () => {
        // A genuine mishearing: take coool's own spellings of these two words out of memory first.
        updateMemory((m) => m.entries.filter((e) => e.written === "Tauri" || e.written === "Zustand").reduce((acc, e) => removeEntry(acc, e.id), m));
        const el = ta()!;
        const id = el.dataset.voice!;
        const notes: string[] = [];
        // Round 1: dictate, the person fixes the words by hand, sends.
        replaceRange(el, 0, el.value.length, "");
        await dictate("en-terms.wav", el);
        const heard1 = el.value;
        const tauri = /\b(Tori|Tory|Tauri)\b/.exec(heard1)?.[1];
        const zus = /\b(Zust\w*|susten|Zustand)\b/i.exec(heard1)?.[1];
        notes.push(`round 1 heard "${heard1}"`);
        if (!tauri || !zus) throw fail(`unexpected transcript: ${heard1}`);
        let fixed = heard1.replace(tauri, "Tauri").replace(zus, "Zustand");
        replaceRange(el, 0, el.value.length, fixed);
        noteSent(id, fixed);
        answerOffer(false);
        replaceRange(el, 0, el.value.length, "");
        // Round 2: the same words come back underlined ("you fixed this before"); accept them.
        await dictate("en-terms.wav", el);
        await waitFor("the checker", () => useVoice.getState().stats.checks >= 3, 10_000);
        const offered = suggestions().filter((s) => s.kind === "memory");
        notes.push(`round 2 "${el.value}", memory suggestions: ${offered.map((s) => `${s.original}→${s.replacement}`).join(", ") || "none"}`);
        if (tauri !== "Tauri" && !offered.some((s) => s.replacement === "Tauri") && !/Tauri/.test(el.value)) throw fail("no Tauri suggestion in round 2");
        await shot("voice-suggestions", undefined, 300);
        for (const s of [...offered].sort((a, b) => b.from - a.from)) acceptSuggestion(id, s);
        // Whatever is still misheard, the person fixes by hand (whisper may hear a word differently each time).
        fixed = el.value.replace(/\b(Tori|Tory)\b/, "Tauri").replace(/\b(Zust(?!and\b)\w*|susten)\b/i, "Zustand");
        if (fixed !== el.value) replaceRange(el, 0, el.value.length, fixed);
        noteSent(id, fixed);
        answerOffer(false);
        replaceRange(el, 0, el.value.length, "");
        // Round 3: applied from memory; neither macOS's checker nor the AI is asked.
        const before = await counters();
        await dictate("en-terms.wav", el);
        await sleep(600);
        const after = await counters();
        const v = el.value;
        notes.push(`round 3 "${v}", spell checks +${after.spell - before.spell}, AI calls +${after.polish - before.polish}`);
        await shot("voice-from-memory", undefined, 100);
        if (!/\bTauri\b/.test(v) || !/\bZustand\b/.test(v)) throw fail(`not applied from memory: ${v} [${notes.join(" | ")}] ${JSON.stringify(getMemory().entries.filter((x) => /tauri|zust/i.test(x.written)))}`);
        if (after.polish !== before.polish) throw fail("the AI was asked");
        if (after.spell !== before.spell) throw fail("the spell checker was asked for an utterance memory covers");
        const e = getMemory().entries.find((x) => x.written === "Tauri");
        notes.push(`memory: Tauri ← ${e?.heard.join(", ")} (confirmed ${e?.confirmed}, accepts ${e?.accepts})`);
        return notes.join(" | ");
      });

      await step("voice: the Needs-you page's answer field takes dictation (floating listening pill)", async () => {
        useChats.getState().apply(CHAT, [
          { seq: 1, ts: Date.now(), type: "question", request_id: "voice-q1", questions: [{ id: "q1", header: "Retry", question: "How should the upload retry?", options: [], multi_select: false, allow_other: true, secret: false }] },
        ]);
        useStore.getState().openNeeds();
        const input = await waitFor("the answer field", () => [...document.querySelectorAll<HTMLInputElement>("input[data-voice]")].find((i) => i.offsetParent !== null), 10_000);
        const secs = (await invoke("voice_selftest_inject", { path: fx("en.wav") })) as number;
        input.focus();
        void startListening(targetOf(input)!, "hold");
        await waitFor("the floating pill", () => document.querySelector("[data-voice-floating] [data-voice-strip=listening]"), 5_000);
        await sleep(secs * 500);
        await shot("voice-needs-field", undefined, 0);
        await sleep(secs * 500 + 250);
        await stopListening();
        await waitFor("the insertion", () => useVoice.getState().phase === "idle", 60_000);
        if (!/retry/i.test(input.value)) throw fail(`value: ${input.value}`);
        useStore.getState().closeNeeds();
        return JSON.stringify(input.value);
      });

      await step("voice: Settings > Voice shows the microphone permission as macOS reports it (never asked by the test)", async () => {
        const p = await voiceApi().permission();
        useStore.getState().openSettings("voice");
        const el = await waitFor("the permission row", () => document.querySelector<HTMLElement>("[data-voice-permission]")?.dataset.voicePermission || null, 5_000);
        await shot("voice-settings", undefined, 400);
        useStore.getState().closeSettings();
        if (el !== p) throw fail(`row says ${el}, macOS says ${p}`);
        return `permission: ${p}`;
      });
    },
  };
}
