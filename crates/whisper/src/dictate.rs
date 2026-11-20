//! One dictated utterance, from captured 16 kHz samples to the text coool inserts. Shared by the app's whisper worker
//! and the `voice_bench` example, so what is measured is what ships:
//!
//! 1. find the speech (`audio::speech_bounds`: an adaptive noise floor; silence or steady noise never reaches whisper),
//! 2. bring quiet speech up to level (`audio::normalize`),
//! 3. run whisper over the full 30 s encoder window with timestamp tokens on (both needed for long dictation: without
//!    timestamps whisper ends each window after its first sentence and drops the rest), and **no initial prompt**,
//! 4. keep only what `guard::judge` believes was spoken.
//!
//! Why no prompt: coool used to prime whisper with "Glossary: API, Claude, …" built from the words library. Measured on
//! coool's fixtures, that made a clear 35 s Turkish request come back as a list of nouns ("Higgs-Field, Seydan, Gevere,
//! Plijate, Xcode,"), and noise or quiet speech come back as the vocabulary itself ("Codex, Codex, Codex, Codex.").
//! The words library now acts only after the fact (the page's memory corrections and suggestions), where it can't
//! invent words the person didn't say. The vocabulary is still passed here, so an echo of it is recognised and dropped.

use crate::{Error, Model, Options, Segment, Task, audio, guard};
use std::sync::atomic::AtomicI32;
use std::time::Instant;

pub struct Request<'a> {
    pub task: Task,
    /// A whisper language code, or `None` to detect it.
    pub language: Option<&'a str>,
    /// The person's words (to recognise an echo of them; never given to whisper).
    pub vocabulary: &'a [String],
}

#[derive(Debug, Clone, Default)]
pub struct Dictation {
    /// The text to insert; empty when nothing was heard.
    pub text: String,
    pub language: String,
    /// "words", "silence" (whisper wasn't run), or why the decoded text was dropped: "unclear", "echo",
    /// "repetition", "boilerplate".
    pub heard: &'static str,
    /// Seconds of speech energy found, and the gain applied to it.
    pub speech_secs: f32,
    pub gain_db: f32,
    /// Length of what whisper was given, and how long it took.
    pub secs: f32,
    pub ms: u64,
    /// Whisper's own pieces, kept or not (for the self-test log and troubleshooting).
    pub segments: Vec<Segment>,
    /// The text before the guard (empty for silence).
    pub raw: String,
}

/// Steps 1 and 2: the samples whisper should get, the seconds of speech in them and the gain applied (dB), or `None`
/// when there's no speech in the recording.
pub fn prepare(samples: &[f32]) -> Option<(Vec<f32>, f32, f32)> {
    let (a, b) = audio::speech_bounds(samples, 200)?;
    let mut s = samples[a..b].to_vec();
    let speech = audio::speech_secs(&s);
    let gain = audio::normalize(&mut s);
    Some((audio::pad_min(s), speech, gain))
}

/// The whole utterance. `on_segment` gets whisper's pieces as they decode (before the guard: the page shows them only
/// while it works).
pub fn run(m: &mut Model, samples: &[f32], r: &Request, on_segment: impl FnMut(&str), abort: Option<&AtomicI32>) -> Result<Dictation, Error> {
    let Some((s, speech_secs, gain_db)) = prepare(samples) else {
        return Ok(Dictation { heard: "silence", secs: samples.len() as f32 / 16_000.0, ..Default::default() });
    };
    if r.task == Task::Translate && !m.multilingual() {
        return Err(Error("This model only knows English, so it can't translate. Choose a multilingual model in Settings > Voice.".into()));
    }
    let o = Options { task: r.task, language: r.language, prompt: None, audio_ctx: 0, timestamps: true, ..Default::default() };
    let t = Instant::now();
    let out = m.run(&s, &o, on_segment, abort)?;
    let ms = t.elapsed().as_millis() as u64;
    let (text, heard) = match guard::judge(&out.segments, r.vocabulary, speech_secs) {
        Ok(t) => (t, "words"),
        Err(why) => (String::new(), why.as_str()),
    };
    Ok(Dictation { text, language: out.language, heard, speech_secs, gain_db, secs: s.len() as f32 / 16_000.0, ms, segments: out.segments, raw: out.text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_and_noise_never_reach_whisper() {
        assert!(prepare(&vec![0.0; 48_000]).is_none());
        let mut s = 1u32;
        let hiss: Vec<f32> = (0..64_000)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((s >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.04
            })
            .collect();
        assert!(prepare(&hiss).is_none());
    }
}
