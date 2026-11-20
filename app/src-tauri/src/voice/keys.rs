//! Voice's keys, read from AppKit's event stream (a local NSEvent monitor, `native::watch_keys`) instead of the page.
//!
//! Why not the page: a web page only gets keys while its own webview has focus, so the old in-page handler did
//! nothing when focus was in the Browser panel, a device panel, the sidebar, or anywhere outside a composer; and
//! ⌥Space reached the composer as a typed non-breaking space whenever the page didn't catch it first. A local monitor
//! sees every key event coool receives, whichever of its views has focus, and can swallow the ones voice uses. It
//! needs no permission (it never sees another app's keys), so the keys work while coool is the active app, and not
//! when another app is in front (that would need Input Monitoring or Accessibility, which coool doesn't ask for).
//!
//! `decide` is the pure part (unit-tested): one event in, what to tell the page and whether the event goes on.

use serde::{Deserialize, Serialize};

/// The page's current wishes (`voice_keys`): which keys, and what's going on.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Config {
    /// Voice is set up (on, a model chosen) and no panel has the keyboard.
    pub enabled: bool,
    /// "AltRight", "MetaRight", "Fn" or "off".
    pub hold: String,
    /// The hands-free chord: a macOS key code and its modifiers.
    pub toggle: Option<Chord>,
    /// Listening or transcribing: Esc cancels.
    pub active: bool,
    /// Listening hands-free (toggle or mic button): Return finishes.
    pub enter_finishes: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord {
    pub key: u16,
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// What the page is told (`voice-key` events).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyEvent {
    /// The hold key went down or up (alone or not: `Chord` follows if another key is pressed while it's down).
    Hold { down: bool },
    /// Another key while the hold key is down: it was a shortcut (⌥ + letter), not push-to-talk.
    Chord,
    Toggle,
    Escape,
    Enter,
}

/// One AppKit key event, reduced to what matters here.
#[derive(Clone, Copy, Debug)]
pub enum Raw {
    /// NSEventTypeFlagsChanged: `code` is the modifier key that changed, `flags` the modifier flags after it.
    Flags { code: u16, flags: usize },
    /// NSEventTypeKeyDown.
    Down { code: u16, flags: usize, repeat: bool },
}

// NSEventModifierFlags, and the device-dependent bits that tell right from left (IOKit's NX_DEVICER*KEYMASK).
pub const SHIFT: usize = 1 << 17;
pub const CTRL: usize = 1 << 18;
pub const ALT: usize = 1 << 19;
pub const CMD: usize = 1 << 20;
pub const FN: usize = 1 << 23;
const RIGHT_ALT: usize = 0x40;
const RIGHT_CMD: usize = 0x10;

pub const KEY_RIGHT_ALT: u16 = 61;
pub const KEY_RIGHT_CMD: u16 = 54;
pub const KEY_FN: u16 = 63;
pub const KEY_ESCAPE: u16 = 53;
pub const KEY_RETURN: u16 = 36;
pub const KEY_ENTER: u16 = 76;

/// The monitor's own memory between events.
#[derive(Default, Debug)]
pub struct State {
    held: bool,
}

/// What to tell the page, and whether the event continues to coool's views (`false`: voice used it up).
pub fn decide(cfg: &Config, st: &mut State, e: Raw) -> (Option<KeyEvent>, bool) {
    match e {
        Raw::Flags { code, flags } => {
            let down = match (cfg.hold.as_str(), code) {
                ("AltRight", KEY_RIGHT_ALT) => flags & RIGHT_ALT != 0,
                ("MetaRight", KEY_RIGHT_CMD) => flags & RIGHT_CMD != 0,
                ("Fn", KEY_FN) => flags & FN != 0,
                _ => return (None, true),
            };
            // Released even when voice was turned off meanwhile, so a recording never sticks.
            if !cfg.enabled && down {
                st.held = false;
                return (None, true);
            }
            if st.held == down {
                return (None, true);
            }
            st.held = down;
            (Some(KeyEvent::Hold { down }), true)
        }
        Raw::Down { code, flags, repeat } => {
            if cfg.active && code == KEY_ESCAPE {
                return (Some(KeyEvent::Escape), false);
            }
            if cfg.active && cfg.enter_finishes && (code == KEY_RETURN || code == KEY_ENTER) && flags & (CMD | CTRL | ALT | SHIFT) == 0 {
                return (Some(KeyEvent::Enter), false);
            }
            if cfg.enabled
                && let Some(c) = cfg.toggle
                && c.key == code
                && (flags & CMD != 0) == c.meta
                && (flags & CTRL != 0) == c.ctrl
                && (flags & ALT != 0) == c.alt
                && (flags & SHIFT != 0) == c.shift
            {
                // Swallowed, repeats too: ⌥Space would otherwise type a non-breaking space into the composer.
                return (if repeat { None } else { Some(KeyEvent::Toggle) }, false);
            }
            if st.held {
                return (Some(KeyEvent::Chord), true);
            }
            (None, true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config { enabled: true, hold: "AltRight".into(), toggle: Some(Chord { key: 49, meta: false, ctrl: false, alt: true, shift: false }), active: false, enter_finishes: false }
    }

    #[test]
    fn right_option_alone_is_push_to_talk_and_left_option_is_not() {
        let (c, mut s) = (cfg(), State::default());
        assert_eq!(decide(&c, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: ALT | RIGHT_ALT }), (Some(KeyEvent::Hold { down: true }), true));
        assert_eq!(decide(&c, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: 0 }), (Some(KeyEvent::Hold { down: false }), true));
        // Left Option (58, its own device bit 0x20) does nothing.
        assert_eq!(decide(&c, &mut s, Raw::Flags { code: 58, flags: ALT | 0x20 }), (None, true));
        // Right Option released while left is still held: the ALT flag stays, the right bit goes.
        decide(&c, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: ALT | RIGHT_ALT | 0x20 });
        assert_eq!(decide(&c, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: ALT | 0x20 }), (Some(KeyEvent::Hold { down: false }), true));
    }

    #[test]
    fn a_letter_while_holding_is_a_shortcut_and_still_types() {
        let (c, mut s) = (cfg(), State::default());
        decide(&c, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: ALT | RIGHT_ALT });
        assert_eq!(decide(&c, &mut s, Raw::Down { code: 0, flags: ALT | RIGHT_ALT, repeat: false }), (Some(KeyEvent::Chord), true));
    }

    #[test]
    fn option_space_toggles_and_never_types() {
        let (c, mut s) = (cfg(), State::default());
        assert_eq!(decide(&c, &mut s, Raw::Down { code: 49, flags: ALT | 0x20, repeat: false }), (Some(KeyEvent::Toggle), false));
        assert_eq!(decide(&c, &mut s, Raw::Down { code: 49, flags: ALT | 0x20, repeat: true }), (None, false));
        // Plain Space and ⌘⌥Space are left alone.
        assert_eq!(decide(&c, &mut s, Raw::Down { code: 49, flags: 0, repeat: false }), (None, true));
        assert_eq!(decide(&c, &mut s, Raw::Down { code: 49, flags: ALT | CMD, repeat: false }), (None, true));
        // Off: ⌥Space types as usual.
        let off = Config { enabled: false, ..cfg() };
        assert_eq!(decide(&off, &mut s, Raw::Down { code: 49, flags: ALT, repeat: false }), (None, true));
    }

    #[test]
    fn escape_and_return_only_while_voice_is_busy() {
        let (mut c, mut s) = (cfg(), State::default());
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_ESCAPE, flags: 0, repeat: false }), (None, true));
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_RETURN, flags: 0, repeat: false }), (None, true));
        c.active = true;
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_ESCAPE, flags: 0, repeat: false }), (Some(KeyEvent::Escape), false));
        // Holding to talk: Return isn't "finish" (the release is), so it goes on to the composer.
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_RETURN, flags: 0, repeat: false }), (None, true));
        c.enter_finishes = true;
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_RETURN, flags: 0, repeat: false }), (Some(KeyEvent::Enter), false));
        assert_eq!(decide(&c, &mut s, Raw::Down { code: KEY_RETURN, flags: SHIFT, repeat: false }), (None, true));
    }

    #[test]
    fn fn_and_right_command() {
        let mut s = State::default();
        let f = Config { hold: "Fn".into(), ..cfg() };
        assert_eq!(decide(&f, &mut s, Raw::Flags { code: KEY_FN, flags: FN }), (Some(KeyEvent::Hold { down: true }), true));
        assert_eq!(decide(&f, &mut s, Raw::Flags { code: KEY_FN, flags: 0 }), (Some(KeyEvent::Hold { down: false }), true));
        let m = Config { hold: "MetaRight".into(), ..cfg() };
        assert_eq!(decide(&m, &mut s, Raw::Flags { code: KEY_RIGHT_CMD, flags: CMD | RIGHT_CMD }), (Some(KeyEvent::Hold { down: true }), true));
        assert_eq!(decide(&m, &mut s, Raw::Flags { code: KEY_RIGHT_ALT, flags: ALT | RIGHT_ALT }), (None, true));
    }
}
