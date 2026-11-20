//! What whisper says when it heard nothing worth writing down, and how coool recognises it. Given silence, noise,
//! very quiet or garbled audio, whisper doesn't return nothing: it returns the words it was primed with ("Codex,
//! Codex, Codex."), a loop of one word, or its training data's boilerplate ("Thank you for watching!"). Every check
//! here is a pure function of the decoded segments, so the owner's failure modes are unit-tested exactly.

use crate::Segment;

/// Why a decoded text was thrown away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Every segment was one whisper itself thought held no speech, or was guessing at.
    Unclear,
    /// The text is the vocabulary (or a prompt) read back, not speech.
    Echo,
    /// One word or phrase over and over: whisper's decoding loop.
    Repetition,
    /// A stock line from subtitles whisper learnt from, with nothing to say it was really spoken.
    Boilerplate,
}
impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Unclear => "unclear",
            Reason::Echo => "echo",
            Reason::Repetition => "repetition",
            Reason::Boilerplate => "boilerplate",
        }
    }
}

/// A segment whisper itself doubts: likely no speech and not confident, or hardly any confidence at all.
pub fn doubtful(s: &Segment) -> bool {
    (s.no_speech > 0.5 && s.avg_logprob < -0.7) || s.avg_logprob < -1.4
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '.' && c != '-')
        .map(|w| w.trim_matches(|c: char| c == '.' || c == '\'' || c == '-').to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// One word (or a short phrase) making up most of a longer text.
pub fn is_repetition(text: &str) -> bool {
    let w = words(text);
    if w.len() < 3 {
        return false;
    }
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for x in &w {
        *counts.entry(x.as_str()).or_default() += 1;
    }
    let top = counts.values().copied().max().unwrap_or(0);
    if top >= 3 && top * 2 >= w.len() {
        return true;
    }
    // A phrase loop: few distinct three-word runs in a long text.
    if w.len() >= 12 {
        let grams: std::collections::HashSet<_> = w.windows(3).collect();
        if (grams.len() as f32) < 0.4 * (w.len() - 2) as f32 {
            return true;
        }
    }
    false
}

/// The vocabulary (or the prompt) read back: nearly every word of the text is one of the vocabulary's words, it reads
/// as a list (commas between single words, no sentence), or it starts with the prompt's own label.
pub fn is_echo(text: &str, vocabulary: &[String]) -> bool {
    let w = words(text);
    if w.is_empty() || vocabulary.is_empty() {
        return false;
    }
    if w[0] == "glossary" {
        return true;
    }
    let vocab: std::collections::HashSet<String> = vocabulary.iter().flat_map(|v| words(v)).collect();
    let hits = w.iter().filter(|x| vocab.contains(*x)).count();
    hits >= 2 && hits * 4 >= w.len() * 3
}

const BOILERPLATE: &[&str] = &[
    "thank you",
    "thank you.",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching!",
    "thank you so much for watching",
    "please subscribe",
    "subtitles by the amara.org community",
    "you",
    "bye",
    "bye.",
    "altyazı m.k.",
    "izlediğiniz için teşekkür ederim",
    "izlediğiniz için teşekkürler",
    "abone olmayı unutmayın",
    "teşekkür ederim",
    "teşekkürler",
    "see you in the next video",
    "see you next time",
    "bir sonraki videoda görüşmek üzere",
    "abone olmayı unutmayın",
];

/// A stock subtitle line. Only thrown away when the evidence for speech is weak (see `judge`).
pub fn is_boilerplate(text: &str) -> bool {
    let t = text.trim().trim_end_matches(['.', '!']).to_lowercase();
    BOILERPLATE.iter().any(|b| b.trim_end_matches(['.', '!']) == t) || t.contains("amara.org") || t.contains("altyazı")
}

/// Decides what to keep of one run: the text of the segments worth keeping, or why nothing is. `speech_secs` is how
/// much speech energy the recording held.
pub fn judge(segments: &[Segment], vocabulary: &[String], speech_secs: f32) -> Result<String, Reason> {
    let kept: Vec<&Segment> = segments.iter().filter(|s| !s.text.trim().is_empty() && !doubtful(s)).collect();
    if kept.is_empty() {
        return Err(Reason::Unclear);
    }
    let text = kept.iter().map(|s| s.text.trim()).collect::<Vec<_>>().join(" ");
    if is_repetition(&text) {
        return Err(Reason::Repetition);
    }
    if is_echo(&text, vocabulary) {
        return Err(Reason::Echo);
    }
    let weak = speech_secs < 1.5 || kept.iter().any(|s| s.no_speech > 0.2 || s.avg_logprob < -0.6);
    if weak && is_boilerplate(&text) {
        return Err(Reason::Boilerplate);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text: &str, no_speech: f32, avg_logprob: f32) -> Segment {
        Segment { text: text.into(), no_speech, avg_logprob, tokens: text.split_whitespace().count() }
    }

    /// The owner's memory file's kind of vocabulary: coool's own words plus two they added.
    fn owner_vocab() -> Vec<String> {
        ["API", "Claude", "Claude Code", "CLI", "Codex", "coool", "Xfield", "Cdance", "Field", "Dance", "GitHub", "JavaScript", "JSON", "TypeScript", "Tauri", "Zustand", "Replicate"].map(String::from).to_vec()
    }

    #[test]
    fn what_whisper_said_to_coools_noise_fixtures_is_dropped() {
        // Measured with the compact medium model and the old glossary prompt (see APP_SPEC "Voice"): white noise →
        // "Codex, Codex, Codex, Codex."; whisper-quiet Turkish → "TypeScript, TypeScript, TypeScript, TypeScript."
        let v = owner_vocab();
        assert_eq!(judge(&[seg("Codex, Codex, Codex, Codex.", 0.3, -0.4)], &v, 0.4), Err(Reason::Repetition));
        assert_eq!(judge(&[seg("TypeScript, TypeScript, TypeScript, TypeScript.", 0.1, -0.3)], &v, 2.0), Err(Reason::Repetition));
    }

    #[test]
    fn the_vocabulary_read_back_is_dropped() {
        let v = owner_vocab();
        assert_eq!(judge(&[seg("Xfield, Cdance, API, Replicate.", 0.2, -0.5)], &v, 3.0), Err(Reason::Echo));
        assert_eq!(judge(&[seg("Glossary: Claude, Codex.", 0.1, -0.2)], &v, 3.0), Err(Reason::Echo));
        // A real sentence that uses some of the words stays.
        assert_eq!(judge(&[seg("Add the Replicate API key to the settings page.", 0.01, -0.2)], &v, 3.0).as_deref(), Ok("Add the Replicate API key to the settings page."));
    }

    #[test]
    fn segments_whisper_doubts_are_dropped() {
        let v = owner_vocab();
        assert_eq!(judge(&[seg("Xfield Genjitsu", 0.8, -1.1)], &v, 1.0), Err(Reason::Unclear));
        assert_eq!(judge(&[seg("something", 0.0, -1.8)], &v, 1.0), Err(Reason::Unclear));
        assert_eq!(judge(&[], &v, 0.0), Err(Reason::Unclear));
        // A doubtful tail is cut, the confident speech kept.
        assert_eq!(judge(&[seg("Run the tests.", 0.01, -0.15), seg("Codex", 0.7, -1.0)], &v, 2.0).as_deref(), Ok("Run the tests."));
    }

    #[test]
    fn boilerplate_only_goes_when_the_evidence_is_weak() {
        assert_eq!(judge(&[seg("Thank you for watching!", 0.3, -0.5)], &[], 0.8), Err(Reason::Boilerplate));
        assert_eq!(judge(&[seg("Altyazı M.K.", 0.1, -0.4)], &[], 1.0), Err(Reason::Boilerplate));
        // What the compact model said to 4 s of white noise when it slipped past the speech check (self-test).
        assert_eq!(judge(&[seg("See you in the next video.", 0.1, -0.3)], &[], 0.0), Err(Reason::Boilerplate));
        // Said clearly, at length: kept.
        assert_eq!(judge(&[seg("Thank you.", 0.01, -0.1)], &[], 2.5).as_deref(), Ok("Thank you."));
    }

    #[test]
    fn ordinary_speech_is_kept() {
        let v = owner_vocab();
        for t in ["Change the color of the button on the login page to blue.", "Bu fonksiyonu yeniden yaz ve testleri çalıştır.", "Use Claude Code for this, not Codex.", "ok ok, go"] {
            assert_eq!(judge(&[seg(t, 0.02, -0.25)], &v, 2.0).as_deref(), Ok(t), "{t}");
        }
        assert!(!is_repetition("the cat and the dog and the bird"));
    }
}
