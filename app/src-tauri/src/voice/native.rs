//! The macOS pieces of voice: the microphone permission (AVCaptureDevice), the system spell and grammar checker
//! (NSSpellChecker, on device), and voice's keys (a local NSEvent monitor, see `keys`: only while coool is the active
//! app, so it needs no Accessibility or Input Monitoring permission).

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
    use super::super::keys;
    use std::sync::{Arc, Mutex};

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

    // ---------- voice's keys ----------

    const KEY_DOWN_MASK: u64 = 1 << 10;
    const FLAGS_CHANGED_MASK: u64 = 1 << 12;

    /// Installs the local key monitor (once, on the main thread): every key event coool receives, in any of its
    /// views, goes through `keys::decide` with the page's current `cfg`; `on` gets what to tell the page, and the
    /// events voice uses (its chord, Esc and Return while busy) stop there.
    pub fn watch_keys(cfg: Arc<Mutex<keys::Config>>, on: Box<dyn Fn(keys::KeyEvent) + Send + Sync>) {
        let Some(cls) = AnyClass::get(c"NSEvent") else { return };
        let st = Mutex::new(keys::State::default());
        let block = RcBlock::new(move |e: NonNull<AnyObject>| -> *mut AnyObject {
            let ev = unsafe { e.as_ref() };
            let kind: usize = unsafe { msg_send![ev, type] };
            let code: u16 = unsafe { msg_send![ev, keyCode] };
            let flags: usize = unsafe { msg_send![ev, modifierFlags] };
            let raw = if kind == 12 {
                keys::Raw::Flags { code, flags }
            } else {
                let repeat: Bool = unsafe { msg_send![ev, isARepeat] };
                keys::Raw::Down { code, flags, repeat: repeat.as_bool() }
            };
            let c = cfg.lock().unwrap().clone();
            let (tell, pass) = keys::decide(&c, &mut st.lock().unwrap(), raw);
            if let Some(k) = tell {
                on(k);
            }
            if pass { e.as_ptr() } else { std::ptr::null_mut() }
        });
        let monitor: *mut AnyObject = unsafe { msg_send![cls, addLocalMonitorForEventsMatchingMask: KEY_DOWN_MASK | FLAGS_CHANGED_MASK, handler: &*block] };
        // Kept for the life of the app.
        std::mem::forget(block);
        let _ = monitor;
    }

    /// Self-test only: one key event as the keyboard would give it, sent through `-[NSApplication sendEvent:]` (so the
    /// local monitor sees it, then the key window and its focused view): in-process, posted to nothing system-wide,
    /// so it needs no permission and no other app sees it. `kind`: 10 key down, 11 key up, 12 flags changed. Call on
    /// the main thread with the live NSWindow.
    pub fn post_key(ns: *mut std::ffi::c_void, kind: usize, code: u16, flags: usize, chars: &str) -> Result<(), String> {
        use objc2_foundation::NSPoint;
        if ns.is_null() {
            return Err("no window".into());
        }
        unsafe {
            let win = &*(ns as *mut AnyObject);
            let number: isize = msg_send![win, windowNumber];
            let cls = AnyClass::get(c"NSEvent").ok_or("no NSEvent")?;
            let app_cls = AnyClass::get(c"NSApplication").ok_or("no NSApplication")?;
            let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
            let info: *mut AnyObject = msg_send![AnyClass::get(c"NSProcessInfo").ok_or("no NSProcessInfo")?, processInfo];
            let now: f64 = msg_send![&*info, systemUptime];
            let s = NSString::from_str(chars);
            let e: *mut AnyObject = msg_send![cls, keyEventWithType: kind, location: NSPoint::new(0.0, 0.0), modifierFlags: flags, timestamp: now, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), characters: &*s, charactersIgnoringModifiers: &*s, isARepeat: false, keyCode: code];
            if e.is_null() {
                return Err("no event".into());
            }
            let _: () = msg_send![&*app, sendEvent: &*e];
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{check as spell_check, permission, post_key, request as request_permission, watch_keys};

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
pub fn watch_keys(_: std::sync::Arc<std::sync::Mutex<super::keys::Config>>, _: Box<dyn Fn(super::keys::KeyEvent) + Send + Sync>) {}
#[cfg(not(target_os = "macos"))]
pub fn post_key(_: *mut std::ffi::c_void, _: usize, _: u16, _: usize, _: &str) -> Result<(), String> {
    Err("macOS only".into())
}
