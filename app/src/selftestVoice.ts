// The `voice` self-test scenario (COOOL_SELFTEST=voice): voice end to end in the real app, no microphone and no
// model calls. The backend plays a WAV fixture as if it were captured (`voice_selftest_inject`), the real whisper.cpp
// engine transcribes it, and the page's own pipeline cleans, applies memory, inserts and checks. A composer of a chat
// that exists only in the page (no CLI is started; "sending" is the composer's learning hook, never a model call).
//
// Needs: COOOL_VOICE_MODEL (a multilingual ggml model; small or larger translates) and COOOL_VOICE_FIXTURES (a folder
// with en.wav, en-fillers.wav, en-terms.wav, tr.wav, de.wav, es.wav, made with `say -o … --data-format=LEI16@16000`,
// plus the capture-path fixtures in the formats Mac microphones deliver: tr-short-48k-f32.wav,
// tr-short-44k-s16-stereo.wav, en-44k-s16-stereo.wav, tr-long40-48k-f32-stereo.wav (a 35 s Turkish request),
// real-tr-1-48k-f32.wav (real speech: FLEURS, CC BY 4.0), noise-48k-f32.wav, silence-44k-s16-stereo.wav, hum.wav,
// silence.wav, noise.wav; `afconvert -f WAVE -d LEF32@48000 -c 1 …` and the like).
// The keys are driven with real AppKit key events (`voice_selftest_keys`: in-process, no permission).

import { useChats } from "./lib/chat";
import { useStore } from "./store";
import { voiceApi } from "./lib/voice/api";
import { getTarget, startListening, stopListening, targetOf, useVoice, noteSent, replaceRange, acceptSuggestion, answerOffer } from "./lib/voice/controller";
import { clearMemory, getMemory, setVoicePrefs, updateMemory } from "./lib/voice/prefs";
import { addWord, removeEntry } from "./lib/voice/memory";

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
  heard: string;
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
          const r = (await invoke("voice_selftest_transcribe", { path: fx(file), req: { model: env.model, task, language: null } })) as Transcript;
          out.push(`${file}/${task}: [${r.language}] ${r.heard} ${r.ms} ms${r.load_ms ? ` (+${r.load_ms} ms load)` : ""} for ${r.secs.toFixed(1)} s: "${r.text}"`);
          return r;
        };
        for (const f of ["silence.wav", "noise.wav"]) {
          const r = await run(f, "translate");
          if (r.text) throw fail(`${f} gave text: ${r.text}`);
        }
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

      // ---- Through the capture boundary: each fixture as a microphone delivers it (its own rate, channels, format),
      // in Core Audio-sized callbacks, through the app's converter, ended by the key's release (with the tail).
      const said = async (file: string, task: "translate" | "transcribe", language: string) => {
        setVoicePrefs({ task, language });
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "");
        const r = await dictate(file, el);
        const s = useVoice.getState();
        return { ...r, value: el.value, notice: s.notice?.kind ?? null, why: s.notice?.why ?? null, last: s.last };
      };
      const row = (file: string, mode: string, r: Awaited<ReturnType<typeof said>>) =>
        `${file} [${mode}] → ${r.notice === "nothing" ? `nothing (${r.why})` : JSON.stringify(r.value)} · ${r.last?.language ?? "?"}, ${r.last?.speech_secs.toFixed(1)} s speech, ${r.last?.ms} ms`;
      const hasEnglish = (v: string) => /\b(the|button|page|blue|error|messages?)\b/i.test(v) && !/[çğışöü]/i.test(v);

      await step("voice: Turkish → English through the capture path (48 kHz f32 mono, 44.1 kHz int16 stereo)", async () => {
        const out: string[] = [];
        for (const f of ["tr-short-48k-f32.wav", "tr-short-44k-s16-stereo.wav"]) {
          const r = await said(f, "translate", "tr");
          out.push(row(f, "tr→en", r));
          if (!hasEnglish(r.value) || !/blue/i.test(r.value)) throw fail(`not a sensible English prompt: ${out.at(-1)}`);
        }
        return out.join(" | ");
      });

      await step("voice: Turkish as spoken, and English, through the capture path", async () => {
        const out: string[] = [];
        const tr = await said("tr-short-44k-s16-stereo.wav", "transcribe", "tr");
        out.push(row("tr-short-44k-s16-stereo.wav", "tr", tr));
        if (!/sayfas/i.test(tr.value) || !/mavi/i.test(tr.value)) throw fail(`not Turkish: ${out.at(-1)}`);
        const real = await said("real-tr-1-48k-f32.wav", "transcribe", "tr");
        out.push(row("real-tr-1-48k-f32.wav (FLEURS, real speech)", "tr", real));
        if (!/patlama/i.test(real.value)) throw fail(`real Turkish: ${out.at(-1)}`);
        const en = await said("en-44k-s16-stereo.wav", "transcribe", "auto");
        out.push(row("en-44k-s16-stereo.wav", "auto", en));
        if (!/exponential backoff/i.test(en.value)) throw fail(`English: ${out.at(-1)}`);
        return out.join(" | ");
      });

      await step("voice: a 35 s Turkish request comes back whole (the owner's failure: a list of nouns, the middle lost)", async () => {
        const r = await said("tr-long40-48k-f32-stereo.wav", "translate", "tr");
        const t = await said("tr-long40-48k-f32-stereo.wav", "transcribe", "tr");
        const out = [row("tr-long40 (35 s)", "tr→en", r), row("tr-long40 (35 s)", "tr", t)];
        for (const want of [/test/i, /key ?chain|keychain/i, /button/i]) if (!want.test(r.value)) throw fail(`translation lost ${want}: ${out[0]}`);
        for (const want of [/anahtar/i, /testleri/i, /butonun/i]) if (!want.test(t.value)) throw fail(`transcript lost ${want}: ${out[1]}`);
        return out.join(" | ");
      });

      await step("voice: silence and noise insert nothing, say so, and never the vocabulary", async () => {
        // The owner's kind of memory: their words in the library (what whisper used to read back on weak audio).
        updateMemory((m) => ["Xfield", "Cdance", "Replicate", "Genjitsu"].reduce((acc, w) => addWord(acc, w, [], "you", Date.now()), m));
        const out: string[] = [];
        for (const f of ["silence-44k-s16-stereo.wav", "noise-48k-f32.wav", "hum.wav"]) {
          for (const task of ["translate", "transcribe"] as const) {
            const r = await said(f, task, task === "translate" ? "tr" : "auto");
            out.push(row(f, task, r));
            if (r.value !== "") throw fail(`inserted something: ${out.at(-1)}`);
            if (r.notice !== "nothing") throw fail(`no "nothing heard" notice: ${out.at(-1)}`);
          }
        }
        await shot("voice-nothing", undefined, 100);
        return out.join(" | ");
      });

      // ---- The keys, as the keyboard delivers them: AppKit events into coool's window (no permission; nothing posted
      // system-wide). Right Option is key code 61 with the right-Option device bit (0x40); Option is 1<<19.
      const ALT = 1 << 19;
      const keys = (steps: { kind: "down" | "up" | "flags"; code: number; flags?: number; chars?: string; wait_ms?: number }[]) => invoke("voice_selftest_keys", { steps });
      const seen: string[] = [];
      const spy = (e: KeyboardEvent) => seen.push(`${e.type}:${e.code}:${e.key === " " ? "nbsp" : e.key}`);
      window.addEventListener("keydown", spy, true);

      await step("voice: hold Right Option (native key events) dictates; release finishes", async () => {
        setVoicePrefs({ task: "translate", language: "tr" });
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "");
        el.focus();
        const secs = (await invoke("voice_selftest_inject", { path: fx("tr-short-48k-f32.wav") })) as number;
        await keys([{ kind: "flags", code: 61, flags: ALT | 0x40, wait_ms: 50 }]);
        await waitFor("listening", () => useVoice.getState().phase === "listening", 5_000);
        await sleep(secs * 500);
        await shot("voice-listening-hold", undefined, 0);
        await sleep(secs * 500 + 300);
        await keys([{ kind: "flags", code: 61, flags: 0 }]);
        await waitFor("the insertion", () => useVoice.getState().phase === "idle" && !!el.value, 60_000);
        await shot("voice-done", undefined, 200);
        if (!/blue/i.test(el.value)) throw fail(`value: ${el.value}`);
        return JSON.stringify(el.value);
      });

      await step("voice: Option+Space with focus outside the composer starts, Return finishes, and no space is typed", async () => {
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "");
        el.blur();
        (document.activeElement as HTMLElement | null)?.blur?.();
        seen.length = 0;
        const secs = (await invoke("voice_selftest_inject", { path: fx("en-44k-s16-stereo.wav") })) as number;
        setVoicePrefs({ task: "transcribe", language: "auto" });
        await keys([{ kind: "down", code: 49, flags: ALT | 0x20, chars: " " }, { kind: "up", code: 49, flags: ALT | 0x20, chars: " " }]);
        await waitFor("listening (toggle)", () => useVoice.getState().phase === "listening" && useVoice.getState().mode === "toggle", 5_000);
        await sleep(secs * 500);
        await shot("voice-listening-toggle", undefined, 0);
        await sleep(secs * 500 + 300);
        await keys([{ kind: "down", code: 36, chars: "\r" }, { kind: "up", code: 36, chars: "\r" }]);
        await waitFor("the insertion", () => useVoice.getState().phase === "idle" && !!el.value, 60_000);
        if (el.value.includes(" ")) throw fail("a non-breaking space was typed");
        if (seen.some((s) => s.startsWith("keydown:Space") || s.startsWith("keydown:Enter"))) throw fail(`the page saw voice's keys: ${seen.join(" ")}`);
        if (!/backoff/i.test(el.value)) throw fail(`value: ${el.value}`);
        return `${JSON.stringify(el.value)}; page saw: ${seen.join(" ") || "nothing"}`;
      });

      await step("voice: Esc (native) cancels listening; Undo takes the dictation back out", async () => {
        const el = ta()!;
        replaceRange(el, 0, el.value.length, "keep me");
        el.focus();
        const before = await counters();
        await invoke("voice_selftest_inject", { path: fx("en.wav") });
        await keys([{ kind: "down", code: 49, flags: ALT, chars: " " }]);
        await waitFor("listening", () => useVoice.getState().phase === "listening", 5_000);
        await sleep(600);
        await keys([{ kind: "down", code: 53, chars: "\u001b" }]);
        await waitFor("idle", () => useVoice.getState().phase === "idle", 3_000);
        const after = await counters();
        if (el.value !== "keep me") throw fail(`value ${el.value}`);
        if (after.runs !== before.runs) throw fail("whisper ran after a cancel");
        // Undo: dictate, then undo from the surface.
        el.setSelectionRange(el.value.length, el.value.length);
        await dictate("en.wav", el);
        const added = el.value;
        const undo = await waitFor("the Undo button", () => document.querySelector<HTMLButtonElement>("[data-voice-action=undo]"), 3_000);
        undo.click();
        await sleep(200);
        if (el.value !== "keep me") throw fail(`after undo: ${el.value}`);
        return `cancelled; "${added}" undone`;
      });
      window.removeEventListener("keydown", spy, true);

      await step("voice: Settings > Voice > Test your microphone shows what coool heard", async () => {
        setVoicePrefs({ task: "translate", language: "tr" });
        useStore.getState().openSettings("voice");
        const btn = await waitFor("the Test button", () => document.querySelector<HTMLButtonElement>("[data-voice-test]"), 5_000);
        await invoke("voice_selftest_inject", { path: fx("tr-short-44k-s16-stereo.wav") });
        btn.scrollIntoView({ block: "center" });
        btn.click();
        await waitFor("listening", () => document.querySelector("[data-voice-test-state=listening]"), 5_000);
        await sleep(2500);
        await shot("voice-test-listening", undefined, 0);
        const res = await waitFor("the result", () => document.querySelector<HTMLElement>("[data-voice-test-result]"), 60_000);
        await shot("voice-test-result", undefined, 200);
        const text = res.textContent ?? "";
        useStore.getState().closeSettings();
        if (res.dataset.voiceTestResult !== "words" || !/blue/i.test(text)) throw fail(`test row: ${text}`);
        return text;
      });
      setVoicePrefs({ task: "transcribe", language: "auto" });
      await clearMemory();

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
        const tauri = /\b(Torii|Tori|Tory|Towery|Tauri)\b/.exec(heard1)?.[1];
        const zus = /\b(Zust\w*|susten|Zustand)\b/i.exec(heard1)?.[1];
        notes.push(`round 1 heard "${heard1}"`);
        if (!tauri || !zus) throw fail(`unexpected transcript: ${heard1}`);
        let fixed = heard1.replace(tauri, "Tauri").replace(zus, "Zustand");
        replaceRange(el, 0, el.value.length, fixed);
        noteSent(id, fixed);
        answerOffer(false);
        replaceRange(el, 0, el.value.length, "");
        // Round 2: the same words come back underlined ("you fixed this before"); accept them.
        const checks = useVoice.getState().stats.checks;
        await dictate("en-terms.wav", el);
        await waitFor("the checker", () => useVoice.getState().stats.checks > checks, 10_000);
        const offered = suggestions().filter((s) => s.kind === "memory");
        notes.push(`round 2 "${el.value}", memory suggestions: ${offered.map((s) => `${s.original}→${s.replacement}`).join(", ") || "none"}`);
        if (tauri !== "Tauri" && !offered.some((s) => s.replacement === "Tauri") && !/Tauri/.test(el.value)) throw fail("no Tauri suggestion in round 2");
        await shot("voice-suggestions", undefined, 300);
        for (const s of [...offered].sort((a, b) => b.from - a.from)) acceptSuggestion(id, s);
        // Whatever is still misheard, the person fixes by hand (whisper may hear a word differently each time).
        fixed = el.value.replace(/\b(Torii|Tori|Tory|Towery)\b/, "Tauri").replace(/\b(Zust(?!and\b)\w*|susten)\b/i, "Zustand");
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
