//! Runs WAV fixtures through coool's dictation pipeline (`coool_whisper::dictate`, the same code the app's whisper
//! worker runs), both tasks, and prints one JSON line per run with the text, what the guard decided, the detected
//! language and the time taken. For checking the engine without a microphone:
//!
//! ```sh
//! cargo run --release -p coool-whisper --example voice_bench -- <model.bin> <a.wav> [b.wav …]
//! ```
//!
//! `COOOL_BENCH_LANG=tr` passes a fixed language instead of detection; `COOOL_BENCH_TASK=translate|transcribe` runs
//! one task only; `COOOL_BENCH_VOCAB="Tauri, Zustand"` is the words list the guard checks echoes against;
//! `COOOL_BENCH_CPU=1` runs without Metal.
//!
//! `COOOL_BENCH_RAW=1` runs the way coool 0.3.1 did instead (for comparisons): whisper straight on the trimmed clip,
//! no guard, `COOOL_BENCH_PROMPT` as the initial prompt, the short encoder window unless `COOOL_BENCH_FULLCTX=1`, and
//! timestamps off unless `COOOL_BENCH_TS=1`.

use coool_whisper::{Model, Options, Task, audio, audio_ctx_for, dictate};
use std::time::Instant;

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, files) = args.split_first().expect("usage: voice_bench <model.bin> <a.wav> …");
    let lang = std::env::var("COOOL_BENCH_LANG").ok();
    let raw = std::env::var_os("COOOL_BENCH_RAW").is_some();
    let prompt = std::env::var("COOOL_BENCH_PROMPT").ok();
    let full = std::env::var_os("COOOL_BENCH_FULLCTX").is_some();
    let ts = std::env::var_os("COOOL_BENCH_TS").is_some();
    let vocab: Vec<String> = std::env::var("COOOL_BENCH_VOCAB").unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let tasks: Vec<Task> = match std::env::var("COOOL_BENCH_TASK").as_deref() {
        Ok("translate") => vec![Task::Translate],
        Ok("transcribe") => vec![Task::Transcribe],
        _ => vec![Task::Transcribe, Task::Translate],
    };
    let gpu = std::env::var_os("COOOL_BENCH_CPU").is_none();
    let t0 = Instant::now();
    let mut m = Model::load(std::path::Path::new(model), gpu).unwrap_or_else(|e| panic!("{e}"));
    println!("{{\"load_ms\":{},\"multilingual\":{},\"gpu\":{gpu},\"raw\":{raw}}}", t0.elapsed().as_millis(), m.multilingual());
    for f in files {
        let samples = audio::read_wav(std::path::Path::new(f)).unwrap_or_else(|e| panic!("{e}"));
        for &task in &tasks {
            if raw {
                let Some(speech) = audio::trim_silence(&samples) else {
                    println!("{{\"file\":\"{}\",\"silent\":true}}", esc(f));
                    break;
                };
                let s = audio::pad_min(speech.to_vec());
                let o = Options { task, language: lang.as_deref(), prompt: prompt.as_deref(), audio_ctx: if full { 0 } else { audio_ctx_for(s.len()) }, timestamps: ts, ..Default::default() };
                let t = Instant::now();
                let out = m.run(&s, &o, |_| {}, None).unwrap_or_else(|e| panic!("{e}"));
                println!("{{\"file\":\"{}\",\"task\":\"{task:?}\",\"secs\":{:.2},\"ms\":{},\"lang\":\"{}\",\"text\":\"{}\"}}", esc(f), s.len() as f32 / 16_000.0, t.elapsed().as_millis(), out.language, esc(&out.text));
                continue;
            }
            let r = dictate::Request { task, language: lang.as_deref(), vocabulary: &vocab };
            let d = dictate::run(&mut m, &samples, &r, |_| {}, None).unwrap_or_else(|e| panic!("{e}"));
            let segs: Vec<String> = d.segments.iter().map(|s| format!("[{:.2} {:.2}]", s.no_speech, s.avg_logprob)).collect();
            println!(
                "{{\"file\":\"{}\",\"task\":\"{task:?}\",\"secs\":{:.2},\"speech\":{:.2},\"gain_db\":{:.1},\"ms\":{},\"lang\":\"{}\",\"heard\":\"{}\",\"segs\":\"{}\",\"text\":\"{}\",\"raw\":\"{}\"}}",
                esc(f),
                d.secs,
                d.speech_secs,
                d.gain_db,
                d.ms,
                d.language,
                d.heard,
                segs.join(" "),
                esc(&d.text),
                if d.raw == d.text { String::new() } else { esc(&d.raw) }
            );
        }
    }
}
