//! The macOS pieces of voice: the microphone permission (AVCaptureDevice), the system spell and grammar checker
//! (NSSpellChecker, on device), and the Fn key (a local NSEvent monitor: only while coool is the active app, so it
//! needs no Accessibility or Input Monitoring permission).

use serde::Serialize;

/// Where the microphone permission stands, as macOS reports it for this process (an unbundled dev build is attributed
/// to the app that launched it, e.g. the terminal).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MicPermission {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    Unavailable,
}

#[derive(Serialize, Clone, Debug)]
pub struct SpellHit {
    /// UTF-16 offsets into the checked text (the same as JavaScript string indices).
    pub from: usize,
    pub to: usize,
    pub word: String,
    pub guesses: Vec<String>,
    /// Set for a grammar issue: macOS's description of it.
    pub grammar: Option<String>,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSArray, NSRange, NSString};
    use std::ptr::NonNull;
    use std::sync::Mutex;

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    fn capture_device() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    pub fn permission() -> MicPermission {
        let Some(cls) = capture_device() else { return MicPermission::Unavailable };
        let s: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio] };
        match s {
            0 => MicPermission::NotDetermined,
            1 => MicPermission::Restricted,
            2 => MicPermission::Denied,
            3 => MicPermission::Authorized,
            _ => MicPermission::Unavailable,
        }
    }

    /// Shows the system's one-time prompt (only while not determined) and waits for the answer (up to 2 minutes).
    pub fn request() -> MicPermission {
        let Some(cls) = capture_device() else { return MicPermission::Unavailable };
        if permission() != MicPermission::NotDetermined {
            return permission();
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let tx = Mutex::new(Some(tx));
        let block = RcBlock::new(move |ok: Bool| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(ok.as_bool());
            }
        });
        let _: () = unsafe { msg_send![cls, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*block] };
        let _ = rx.recv_timeout(std::time::Duration::from_secs(120));
        permission()
    }

    // ---------- NSSpellChecker ----------

    fn checker() -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"NSSpellChecker")?;
        let c: *mut AnyObject = unsafe { msg_send![cls, sharedSpellChecker] };
        unsafe { Retained::retain(c) }
    }

    static DOC_TAG: Mutex<Option<isize>> = Mutex::new(None);

    /// One spell-document tag for this run: the person's words go in its ignore list (this session only, never the
    /// system-wide learned dictionary).
    fn doc_tag(c: &AnyObject) -> isize {
        let mut t = DOC_TAG.lock().unwrap();
        *t.get_or_insert_with(|| {
            let cls = AnyClass::get(c"NSSpellChecker").unwrap();
            let _ = c;
            unsafe { msg_send![cls, uniqueSpellDocumentTag] }
        })
    }

    fn ns_strings(words: &[String]) -> Retained<NSArray<NSString>> {
        let v: Vec<Retained<NSString>> = words.iter().map(|w| NSString::from_str(w)).collect();
        NSArray::from_retained_slice(&v)
    }

    pub fn check(text: &str, language: Option<&str>, ignore: &[String], grammar: bool) -> Vec<SpellHit> {
        let Some(c) = checker() else { return vec![] };
        let tag = doc_tag(&c);
        let s = NSString::from_str(text);
        let lang = language.filter(|l| !l.is_empty()).map(NSString::from_str);
        let lang_ptr: *const NSString = lang.as_deref().map_or(std::ptr::null(), |l| l as *const NSString);
        let mut out = Vec::new();
        unsafe {
            let words = ns_strings(ignore);
            let _: () = msg_send![&*c, setIgnoredWords: &*words, inSpellDocumentWithTag: tag];
            let len: usize = msg_send![&*s, length];
            let mut at = 0usize;
            let mut guard = 0;
            while at < len && guard < 200 {
                guard += 1;
                let mut count: isize = 0;
                let r: NSRange = msg_send![&*c, checkSpellingOfString: &*s, startingAt: at as isize, language: lang_ptr, wrap: false, inSpellDocumentWithTag: tag, wordCount: &mut count];
                if r.location == usize::MAX || r.length == 0 || r.location < at {
                    break;
                }
                let word: Retained<NSString> = msg_send![&*s, substringWithRange: r];
                let g: *mut NSArray<NSString> = msg_send![&*c, guessesForWordRange: r, inString: &*s, language: lang_ptr, inSpellDocumentWithTag: tag];
                let guesses = if g.is_null() { vec![] } else { (*g).iter().take(3).map(|x| x.to_string()).collect() };
                out.push(SpellHit { from: r.location, to: r.location + r.length, word: word.to_string(), guesses, grammar: None });
                at = r.location + r.length;
            }
            if grammar {
                let mut details: *mut NSArray<AnyObject> = std::ptr::null_mut();
                let r: NSRange = msg_send![&*c, checkGrammarOfString: &*s, startingAt: 0isize, language: lang_ptr, wrap: false, inSpellDocumentWithTag: tag, details: &mut details];
                if r.location != usize::MAX && r.length > 0 && !details.is_null() {
                    for d in (*details).iter() {
                        let key_range = NSString::from_str("NSGrammarRange");
                        let key_desc = NSString::from_str("NSGrammarUserDescription");
                        let key_fix = NSString::from_str("NSGrammarCorrections");
                        let rv: *mut AnyObject = msg_send![&*d, objectForKey: &*key_range];
                        if rv.is_null() {
                            continue;
                        }
                        let sub: NSRange = msg_send![&*rv, rangeValue];
                        let abs = NSRange { location: r.location + sub.location, length: sub.length };
                        if abs.location + abs.length > len || abs.length == 0 {
                            continue;
                        }
                        let desc: *mut NSString = msg_send![&*d, objectForKey: &*key_desc];
                        let fixes: *mut NSArray<NSString> = msg_send![&*d, objectForKey: &*key_fix];
                        let word: Retained<NSString> = msg_send![&*s, substringWithRange: abs];
                        out.push(SpellHit {
                            from: abs.location,
                            to: abs.location + abs.length,
                            word: word.to_string(),
                            guesses: if fixes.is_null() { vec![] } else { (*fixes).iter().take(3).map(|x| x.to_string()).collect() },
                            grammar: Some(if desc.is_null() { "Grammar".into() } else { (*desc).to_string() }),
                        });
                    }
                }
            }
        }
        out
    }

    // ---------- Fn key ----------

    const FLAGS_CHANGED_MASK: u64 = 1 << 12;
    const FN_FLAG: usize = 1 << 23;
    const KVK_FUNCTION: u16 = 63;

    /// Calls `on(down)` when the Fn (🌐) key goes down or up while coool is the active app. Installed once, on the
    /// main thread; the event passes through unchanged.
    pub fn watch_fn(on: Box<dyn Fn(bool) + Send + Sync>) {
        let Some(cls) = AnyClass::get(c"NSEvent") else { return };
        let held = std::sync::atomic::AtomicBool::new(false);
        let block = RcBlock::new(move |e: NonNull<AnyObject>| -> *mut AnyObject {
            let ev = unsafe { e.as_ref() };
            let code: u16 = unsafe { msg_send![ev, keyCode] };
            if code == KVK_FUNCTION {
                let flags: usize = unsafe { msg_send![ev, modifierFlags] };
                let down = flags & FN_FLAG != 0;
                if held.swap(down, std::sync::atomic::Ordering::Relaxed) != down {
                    on(down);
                }
            }
            e.as_ptr()
        });
        let monitor: *mut AnyObject = unsafe { msg_send![cls, addLocalMonitorForEventsMatchingMask: FLAGS_CHANGED_MASK, handler: &*block] };
        // Kept for the life of the app.
        std::mem::forget(block);
        let _ = monitor;
    }
}

#[cfg(target_os = "macos")]
pub use mac::{check as spell_check, permission, request as request_permission, watch_fn};

#[cfg(not(target_os = "macos"))]
pub fn permission() -> MicPermission {
    MicPermission::Unavailable
}
#[cfg(not(target_os = "macos"))]
pub fn request_permission() -> MicPermission {
    MicPermission::Unavailable
}
#[cfg(not(target_os = "macos"))]
pub fn spell_check(_: &str, _: Option<&str>, _: &[String], _: bool) -> Vec<SpellHit> {
    vec![]
}
#[cfg(not(target_os = "macos"))]
pub fn watch_fn(_: Box<dyn Fn(bool) + Send + Sync>) {}
