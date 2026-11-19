//! Local speech-to-text for coool: whisper.cpp (vendored, see `whisper.cpp/VENDOR.md`) behind a small safe API.
//!
//! A [`Model`] is one loaded ggml model file (`ggml-base.bin`, `ggml-medium.bin` …). [`Model::run`] takes 16 kHz mono
//! f32 samples and returns the text, transcribed as spoken or translated to English. Nothing here touches the network:
//! the model file is read from disk and inference runs on this Mac (Metal on Apple silicon).

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};

pub mod audio;

/// Whisper's input rate.
pub const SAMPLE_RATE: u32 = 16_000;

#[cfg(not(whisper_stub))]
mod ffi {
    use super::*;
    #[repr(C)]
    pub struct Ctx {
        _p: [u8; 0],
    }
    pub type SegmentCb = extern "C" fn(*const c_char, *mut c_void);
    unsafe extern "C" {
        pub fn coool_whisper_set_verbose(on: c_int);
        pub fn coool_whisper_load(path: *const c_char, use_gpu: c_int, flash_attn: c_int) -> *mut Ctx;
        pub fn coool_whisper_free(ctx: *mut Ctx);
        pub fn coool_whisper_is_multilingual(ctx: *mut Ctx) -> c_int;
        #[allow(clippy::too_many_arguments)]
        pub fn coool_whisper_run(
            ctx: *mut Ctx,
            samples: *const f32,
            n: c_int,
            language: *const c_char,
            translate: c_int,
            threads: c_int,
            initial_prompt: *const c_char,
            audio_ctx: c_int,
            cb: Option<SegmentCb>,
            user: *mut c_void,
            abort: *const AtomicI32,
        ) -> c_int;
        pub fn coool_whisper_n_segments(ctx: *mut Ctx) -> c_int;
        pub fn coool_whisper_segment(ctx: *mut Ctx, i: c_int) -> *const c_char;
        pub fn coool_whisper_detected_language(ctx: *mut Ctx) -> *const c_char;
        pub fn coool_whisper_system_info() -> *const c_char;
    }
}

/// Whether this build has the engine (Apple silicon); elsewhere every load fails with a plain message.
pub const fn available() -> bool {
    !cfg!(whisper_stub)
}

/// What whisper.cpp was built with ("AVX = 0 | NEON = 1 | METAL = 1 …").
pub fn system_info() -> String {
    #[cfg(not(whisper_stub))]
    unsafe {
        return CStr::from_ptr(ffi::coool_whisper_system_info()).to_string_lossy().into_owned();
    }
    #[allow(unreachable_code)]
    String::new()
}

/// Let whisper.cpp / ggml print their logs to stderr (off by default).
pub fn set_verbose(on: bool) {
    #[cfg(not(whisper_stub))]
    unsafe {
        ffi::coool_whisper_set_verbose(on as c_int)
    }
    let _ = on;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    /// Keep the spoken language.
    Transcribe,
    /// Any language in, English out (whisper's translate task).
    Translate,
}

#[derive(Debug, Clone)]
pub struct Options<'a> {
    pub task: Task,
    /// A whisper language code ("tr", "de", "en" …), or `None` to detect it.
    pub language: Option<&'a str>,
    /// Words to bias the decoder towards (whisper's initial prompt); kept short by the caller.
    pub prompt: Option<&'a str>,
    pub threads: usize,
    /// Encoder frames to use (0 = whisper's full 30 s window). A short clip can use fewer, which is much faster.
    pub audio_ctx: usize,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Options { task: Task::Transcribe, language: None, prompt: None, threads: default_threads(), audio_ctx: 0 }
    }
}

/// Performance cores minus one, between 2 and 8 (whisper.cpp scales poorly past 8).
pub fn default_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get().saturating_sub(2)).unwrap_or(4).clamp(2, 8)
}

#[derive(Debug, Clone, Default)]
pub struct Output {
    pub text: String,
    /// The language whisper detected (or was told), e.g. "tr".
    pub language: String,
}

#[derive(Debug)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}

/// A loaded model. Not `Sync`: one utterance at a time (the app runs it on its own worker thread).
pub struct Model {
    #[cfg(not(whisper_stub))]
    ctx: *mut ffi::Ctx,
    multilingual: bool,
}

// The context is only used from one thread at a time (`&mut self` for runs).
unsafe impl Send for Model {}

impl Model {
    /// Loads a ggml model file (seconds for the larger ones). `gpu`: use Metal when there is one.
    pub fn load(path: &Path, gpu: bool) -> Result<Model, Error> {
        if !path.is_file() {
            return Err(Error(format!("No model file at {}", path.display())));
        }
        #[cfg(whisper_stub)]
        {
            let _ = gpu;
            return Err(Error("Voice needs a Mac with Apple silicon.".into()));
        }
        #[cfg(not(whisper_stub))]
        {
            let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| Error("bad path".into()))?;
            let ctx = unsafe { ffi::coool_whisper_load(c.as_ptr(), gpu as c_int, 1) };
            if ctx.is_null() {
                return Err(Error(format!("{} is not a whisper model whisper.cpp can read", path.display())));
            }
            let multilingual = unsafe { ffi::coool_whisper_is_multilingual(ctx) } != 0;
            Ok(Model { ctx, multilingual })
        }
    }

    /// Whether the model knows languages other than English (`*.en` models don't, and can't translate).
    pub fn multilingual(&self) -> bool {
        self.multilingual
    }

    /// Transcribes or translates one utterance. `on_segment` gets each piece of text as it is decoded; `abort`, when
    /// set to non-zero from another thread, stops the run early (it then returns an error).
    pub fn run(&mut self, samples: &[f32], o: &Options, mut on_segment: impl FnMut(&str), abort: Option<&AtomicI32>) -> Result<Output, Error> {
        if samples.is_empty() {
            return Ok(Output::default());
        }
        #[cfg(whisper_stub)]
        {
            let _ = (o, &mut on_segment, abort);
            return Err(Error("Voice needs a Mac with Apple silicon.".into()));
        }
        #[cfg(not(whisper_stub))]
        {
            extern "C" fn tramp(text: *const c_char, user: *mut c_void) {
                let f = unsafe { &mut *(user as *mut &mut dyn FnMut(&str)) };
                let s = unsafe { CStr::from_ptr(text) }.to_string_lossy();
                f(&s);
            }
            let lang = o.language.filter(|l| !l.is_empty() && *l != "auto").map(|l| CString::new(l).unwrap_or_default());
            let prompt = o.prompt.filter(|p| !p.trim().is_empty()).and_then(|p| CString::new(p).ok());
            let mut cb: &mut dyn FnMut(&str) = &mut on_segment;
            let rc = unsafe {
                ffi::coool_whisper_run(
                    self.ctx,
                    samples.as_ptr(),
                    samples.len() as c_int,
                    lang.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    (o.task == Task::Translate) as c_int,
                    o.threads.max(1) as c_int,
                    prompt.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    o.audio_ctx as c_int,
                    Some(tramp),
                    &mut cb as *mut &mut dyn FnMut(&str) as *mut c_void,
                    abort.map_or(std::ptr::null(), |a| a as *const AtomicI32),
                )
            };
            if abort.is_some_and(|a| a.load(Ordering::Relaxed) != 0) {
                return Err(Error("cancelled".into()));
            }
            if rc != 0 {
                return Err(Error(format!("whisper.cpp failed ({rc})")));
            }
            let n = unsafe { ffi::coool_whisper_n_segments(self.ctx) };
            let mut text = String::new();
            for i in 0..n {
                let p = unsafe { ffi::coool_whisper_segment(self.ctx, i) };
                if !p.is_null() {
                    text.push_str(&unsafe { CStr::from_ptr(p) }.to_string_lossy());
                }
            }
            let language = unsafe { CStr::from_ptr(ffi::coool_whisper_detected_language(self.ctx)) }.to_string_lossy().into_owned();
            Ok(Output { text: text.trim().to_string(), language })
        }
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        #[cfg(not(whisper_stub))]
        unsafe {
            ffi::coool_whisper_free(self.ctx)
        }
    }
}

/// The encoder frames a clip of `samples` needs (whisper uses 1500 for 30 s), with headroom, or 0 (the full window)
/// for clips over ~20 s where the saving is small. Shorter windows make short utterances much faster.
pub fn audio_ctx_for(samples: usize) -> usize {
    let secs = samples as f64 / SAMPLE_RATE as f64;
    if secs > 20.0 {
        return 0;
    }
    // 50 frames a second, plus 1.5 s of margin, rounded up to a multiple of 64; never under 384 (quality drops).
    let frames = ((secs + 1.5) * 50.0).ceil() as usize;
    (frames.div_ceil(64) * 64).clamp(384, 1500)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_ctx_scales_with_length() {
        assert_eq!(audio_ctx_for(16_000), 384);
        assert_eq!(audio_ctx_for(16_000 * 10), 576);
        assert_eq!(audio_ctx_for(16_000 * 25), 0);
    }

    #[test]
    fn threads_in_range() {
        let t = default_threads();
        assert!((2..=8).contains(&t));
    }

    #[test]
    fn missing_model_is_a_plain_error() {
        let e = Model::load(Path::new("/nonexistent/ggml-x.bin"), false).err().unwrap();
        assert!(e.0.contains("No model file"));
    }
}
