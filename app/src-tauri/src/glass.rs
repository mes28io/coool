//! Frosted glass ("Translucent window", Settings > Appearance): an `NSVisualEffectView` behind the main window's
//! webviews, blending with the desktop and the windows behind coool. The page then leaves two regions translucent
//! (the title bar and icon rail, and the device panels' background); everything else stays opaque. See APP_SPEC.
//!
//! Public AppKit only: `NSVisualEffectView`, `-[NSWindow setOpaque:]` / `setBackgroundColor:`, and
//! `NSWorkspace.accessibilityDisplayShouldReduceTransparency`. The webview is already transparent (wry disables
//! its `drawsBackground` because the window has a background colour), so no `macOSPrivateApi` is needed.
//!
//! Off (the setting, or macOS "Reduce transparency"): the view is hidden, the window is opaque again and the page
//! paints today's solid colours. `glass_set` is a sync command, so it runs on the main thread, as AppKit needs.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// What the page needs back: whether the glass is showing, and why not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct GlassState {
    /// The effect view is showing (the page may go translucent).
    pub active: bool,
    /// macOS "Reduce transparency" is on (or forced for a test build, see [`reduce_transparency`]).
    pub reduce_transparency: bool,
    /// This build can show it at all (macOS).
    pub supported: bool,
}

/// The glass shows when the person wants it and the system doesn't ask for less transparency.
pub fn decide(wanted: bool, reduce_transparency: bool, supported: bool) -> GlassState {
    GlassState { active: supported && wanted && !reduce_transparency, reduce_transparency, supported }
}

/// The `NSVisualEffectMaterial`, in both themes (the appearance picks its light or dark variant). Titlebar: the
/// clearest of the frosts that keep text crisp. Measured on macOS 27 over a striped colour field, the rail's colour
/// came through clearly more than with Sidebar (dark: rgb 81,60,62 against 64,38,41 behind a red band), so
/// more of what is behind shows; full-screen UI went grey and flat, under-window background
/// and HUD read muddier. `COOOL_GLASS_MATERIAL` overrides it in a debug build, to compare.
const MATERIAL: isize = 3;

/// macOS "Reduce transparency" (System Settings > Accessibility > Display). A debug build can force it with
/// `COOOL_REDUCE_TRANSPARENCY=1`, to test the fallback without changing the system setting.
pub fn reduce_transparency() -> bool {
    if cfg!(debug_assertions) && std::env::var("COOOL_REDUCE_TRANSPARENCY").is_ok_and(|v| v == "1") {
        return true;
    }
    imp::reduce_transparency()
}

/// Turns the glass on or off for the main window (`dark`: the theme, which picks the material's appearance).
/// Returns what is in effect; the page goes translucent only when `active`.
#[tauri::command]
pub fn glass_set(app: AppHandle, on: bool, dark: bool) -> Result<GlassState, String> {
    let st = decide(on, reduce_transparency(), cfg!(target_os = "macos"));
    let w = app.get_window("main").ok_or("no main window")?;
    imp::apply(&w, st.active, dark)?;
    Ok(st)
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::{NSRect, NSString};
    use std::cell::RefCell;

    // `NSVisualEffectBlendingMode.behindWindow`, `NSVisualEffectState.followsWindowActivity`: a window in the
    // background loses its vibrancy and goes flat, as Finder's sidebar does, so the window in front reads as active.
    const BEHIND_WINDOW: isize = 0;
    const FOLLOWS_WINDOW: isize = 0;
    const ACTIVE: isize = 1;
    // NSViewWidthSizable | NSViewHeightSizable
    const FILL: usize = 2 | 16;
    // NSWindowBelow
    const BELOW: isize = -1;

    thread_local! {
        // The main window's effect view, made once (main thread only).
        static VIEW: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    pub fn reduce_transparency() -> bool {
        let Some(cls) = AnyClass::get(c"NSWorkspace") else { return false };
        // SAFETY: class method returning the shared workspace; a plain BOOL getter (macOS 10.10+).
        unsafe {
            let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
            if ws.is_null() {
                return false;
            }
            msg_send![&*ws, accessibilityDisplayShouldReduceTransparency]
        }
    }

    pub fn apply(w: &tauri::Window, on: bool, dark: bool) -> Result<(), String> {
        let ns = w.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
        if ns.is_null() {
            return Err("no NSWindow".into());
        }
        // SAFETY: a sync Tauri command runs on the main thread; `ns` is Tauri's live NSWindow. Every message is
        // public AppKit with the documented argument types (NSInteger / NSUInteger / BOOL / objects).
        unsafe {
            let win = &*ns;
            let content: *mut AnyObject = msg_send![win, contentView];
            if content.is_null() {
                return Err("no content view".into());
            }
            let content = &*content;
            let view = VIEW.with(|v| v.borrow().clone());
            if !on {
                if let Some(v) = &view {
                    let _: () = msg_send![&**v, setHidden: true];
                }
                // Opaque again; the page sets the solid colour right after (lib/boot.ts).
                let _: () = msg_send![win, setOpaque: true];
                return Ok(());
            }
            let view = match view {
                Some(v) => v,
                None => {
                    let cls = AnyClass::get(c"NSVisualEffectView").ok_or("no NSVisualEffectView")?;
                    let bounds: NSRect = msg_send![content, bounds];
                    let raw: *mut AnyObject = msg_send![cls, alloc];
                    let raw: *mut AnyObject = msg_send![raw, initWithFrame: bounds];
                    let v = Retained::from_raw(raw).ok_or("NSVisualEffectView init failed")?;
                    let _: () = msg_send![&*v, setAutoresizingMask: FILL];
                    let _: () = msg_send![&*v, setBlendingMode: BEHIND_WINDOW];
                    // A self-test window never takes focus, so it would always show the inactive (flat) material: a
                    // debug build can ask for the active one with `COOOL_GLASS_ACTIVE=1`, as the person sees it.
                    let state = if cfg!(debug_assertions) && std::env::var("COOOL_GLASS_ACTIVE").is_ok_and(|v| v == "1") { ACTIVE } else { FOLLOWS_WINDOW };
                    let _: () = msg_send![&*v, setState: state];
                    // Under every webview (the app's and the in-app browser's), whatever is added later.
                    let none: *const AnyObject = std::ptr::null();
                    let _: () = msg_send![content, addSubview: &*v, positioned: BELOW, relativeTo: none];
                    VIEW.with(|slot| *slot.borrow_mut() = Some(v.clone()));
                    v
                }
            };
            // A debug build can try another material (`COOOL_GLASS_MATERIAL=<NSVisualEffectMaterial>`), to compare them.
            let material = std::env::var("COOOL_GLASS_MATERIAL").ok().filter(|_| cfg!(debug_assertions)).and_then(|m| m.parse::<isize>().ok()).unwrap_or(super::MATERIAL);
            let _: () = msg_send![&*view, setMaterial: material];
            // The material follows the app's theme, not the system's (coool can be light on a dark Mac). It has to be a
            // vibrant appearance: with plain Aqua / DarkAqua the view draws a flat fill and blends with nothing.
            if let Some(ap) = AnyClass::get(c"NSAppearance") {
                let name = NSString::from_str(if dark { "NSAppearanceNameVibrantDark" } else { "NSAppearanceNameVibrantLight" });
                let a: *mut AnyObject = msg_send![ap, appearanceNamed: &*name];
                if !a.is_null() {
                    let _: () = msg_send![&*view, setAppearance: a];
                }
            }
            let _: () = msg_send![&*view, setHidden: false];
            let _: () = msg_send![win, setOpaque: false];
            if let Some(color) = AnyClass::get(c"NSColor") {
                let clear: *mut AnyObject = msg_send![color, clearColor];
                let _: () = msg_send![win, setBackgroundColor: clear];
            }
            // The shadow follows the window's alpha; recompute it now the window is see-through.
            let _: () = msg_send![win, invalidateShadow];
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn reduce_transparency() -> bool {
        false
    }
    pub fn apply(_w: &tauri::Window, _on: bool, _dark: bool) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glass_needs_the_setting_and_no_reduce_transparency() {
        assert!(decide(true, false, true).active);
        assert!(!decide(false, false, true).active);
        let rt = decide(true, true, true);
        assert!(!rt.active && rt.reduce_transparency);
        assert!(!decide(true, false, false).active);
    }
}
