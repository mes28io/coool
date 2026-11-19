//! Runs WAV fixtures through the real engine, both tasks, and prints one JSON line per run with the text, the detected
//! language and the time taken (load once, then per utterance). For checking the engine without a microphone:
//!
//! ```sh
//! cargo run --release -p coool-whisper --example voice_bench -- <model.bin> <a.wav> [b.wav …]
//! ```
//!
//! `COOOL_BENCH_PROMPT="Tauri, Zustand"` biases the decoder (the words library). `COOOL_BENCH_LANG=en` passes a fixed language instead of detection; `COOOL_BENCH_FULLCTX=1` turns off the short
//! encoder window; `COOOL_BENCH_CPU=1` runs without Metal.

use coool_whisper::{Model, Options, Task, audio, audio_ctx_for};
use std::time::Instant;

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, files) = args.split_first().expect("usage: voice_bench <model.bin> <a.wav> …");
    let lang = std::env::var("COOOL_BENCH_LANG").ok();
    let prompt = std::env::var("COOOL_BENCH_PROMPT").ok();
    let full = std::env::var_os("COOOL_BENCH_FULLCTX").is_some();
    let gpu = std::env::var_os("COOOL_BENCH_CPU").is_none();
    let t0 = Instant::now();
    let mut m = Model::load(std::path::Path::new(model), gpu).unwrap_or_else(|e| panic!("{e}"));
    println!("{{\"load_ms\":{},\"multilingual\":{},\"gpu\":{gpu},\"info\":\"{}\"}}", t0.elapsed().as_millis(), m.multilingual(), esc(coool_whisper::system_info().trim()));
    for f in files {
        let raw = audio::read_wav(std::path::Path::new(f)).unwrap_or_else(|e| panic!("{e}"));
        let Some(speech) = audio::trim_silence(&raw) else {
            println!("{{\"file\":\"{}\",\"silent\":true}}", esc(f));
            continue;
        };
        let samples = audio::pad_min(speech.to_vec());
        for task in [Task::Transcribe, Task::Translate] {
            let o = Options { task, language: lang.as_deref(), prompt: prompt.as_deref(), audio_ctx: if full { 0 } else { audio_ctx_for(samples.len()) }, ..Default::default() };
            let t = Instant::now();
            let mut first: Option<u128> = None;
            let out = m.run(&samples, &o, |_| { first.get_or_insert(t.elapsed().as_millis()); }, None).unwrap_or_else(|e| panic!("{e}"));
            println!(
                "{{\"file\":\"{}\",\"task\":\"{:?}\",\"secs\":{:.2},\"ms\":{},\"first_segment_ms\":{},\"lang\":\"{}\",\"text\":\"{}\"}}",
                esc(f),
                task,
                samples.len() as f32 / 16_000.0,
                t.elapsed().as_millis(),
                first.unwrap_or(0),
                out.language,
                esc(&out.text)
            );
        }
    }
}
