//! A file drag from Finder through the native path, without the pointer or the system's drag pasteboard
//! (`selftest_native_drag`, the `attach-native-drop` scenario).
//!
//! The view a real drag goes to is found as AppKit finds it: the frontmost visible view under the point that
//! registered for file URLs (`registeredDraggedTypes`), walking the main window's real view tree. If that isn't the
//! app's WKWebView (a native view laid over it, a child webview in front), the step fails. Then the self-test's own
//! `NSDraggingInfo` (a private, uniquely named pasteboard holding the files as `NSURL`s, a location in window
//! coordinates) is handed to that view's dragging-destination methods (`draggingEntered:` / `draggingUpdated:` /
//! `prepareForDragOperation:` + `performDragOperation:` / `draggingExited:`), so wry reads the pasteboard and the
//! location exactly as for Finder's drag, and Tauri's `tauri://drag-*` events reach the page's listener.
//!
//! Not covered: the window server's side (its choice of window, and `-[NSWindow draggingEntered:]`, which needs the
//! window server's drag session: given this info object it answers without asking any view).

use crate::Core;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Default)]
pub struct NativeDrag {
    /// What the view answered (an `NSDragOperation`; for `drop`, `performDragOperation:`'s BOOL as 0 / 1).
    pub op: Option<u64>,
    /// The view that takes a file drag at the point and its superviews up to the content view (class names).
    pub dest: Vec<String>,
    /// `views` only: every view in the window, `Class hidden? [x y w h] files?`, indented by depth.
    pub views: Vec<String>,
    /// Selectors sent to the info object that it doesn't implement (answered with zero or nothing).
    pub unknown: Vec<String>,
}

/// `kind`: `views`, `enter` (with the `paths`), `over`, `drop` or `exit`; `x` / `y` in CSS pixels of the main window
/// (its points), from the top left.
#[tauri::command(async)]
pub fn selftest_native_drag(app: AppHandle, core: State<'_, Arc<Core>>, kind: String, paths: Vec<String>, x: f64, y: f64) -> Result<NativeDrag, String> {
    super::active(&core)?;
    let win = app.get_window("main").ok_or("no window")?;
    let ns = win.ns_window().map_err(|e| e.to_string())? as usize;
    let main = app.get_webview("main").ok_or("no main webview")?;
    let (tx, rx) = std::sync::mpsc::channel();
    // On the main thread, with the app's own WKWebView (the view the drag must reach).
    main.with_webview(move |pw| {
        let wk = pw.inner() as usize;
        // An Objective-C exception (something sent to the info object that it doesn't answer) comes back as an
        // error instead of aborting the app.
        #[cfg(target_os = "macos")]
        let r = objc2::exception::catch(std::panic::AssertUnwindSafe(|| imp::run(ns as *mut std::ffi::c_void, wk, &kind, &paths, x, y)))
            .unwrap_or_else(|e| Err(format!("Objective-C exception: {}", e.map(|e| format!("{e:?}")).unwrap_or_default())));
        #[cfg(not(target_os = "macos"))]
        let r = imp::run(ns as *mut std::ffi::c_void, wk, &kind, &paths, x, y);
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod imp {
    use super::NativeDrag;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, Bool, ClassBuilder, NSObject, Sel};
    use objc2::{msg_send, sel, ClassType};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSString, NSURL};
    use std::cell::{Cell, RefCell};

    thread_local! {
        // The drag in progress (main thread only): its pasteboard, window, location (window coordinates) and number.
        static PB: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static WIN: Cell<usize> = const { Cell::new(0) };
        static LOC: Cell<(f64, f64)> = const { Cell::new((0.0, 0.0)) };
        static SEQ: Cell<isize> = const { Cell::new(0) };
        static VALID: Cell<isize> = const { Cell::new(0) };
        // Selectors sent that the info object doesn't implement (answered with zero / nothing), for the report.
        static UNKNOWN: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// Any other selector (AppKit's or WebKit's private questions): a signature that returns an integer (zero) or,
    /// for a setter, nothing, so it gets "none" instead of an exception; each is recorded.
    extern "C-unwind" fn signature(this: &AnyObject, _: Sel, s: Sel) -> *mut AnyObject {
        // SAFETY: NSObject's own answer first (implemented selectors), then a plain NSMethodSignature.
        unsafe {
            let own: *mut AnyObject = msg_send![super(this, NSObject::class()), methodSignatureForSelector: s];
            if !own.is_null() {
                return own;
            }
            let name = s.name().to_string_lossy().into_owned();
            let args = name.matches(':').count();
            let types = format!("{}@:{}\0", if args > 0 { "v" } else { "Q" }, "Q".repeat(args));
            let cls = AnyClass::get(c"NSMethodSignature").unwrap();
            msg_send![cls, signatureWithObjCTypes: types.as_ptr() as *const std::ffi::c_char]
        }
    }
    extern "C-unwind" fn forward(_: &AnyObject, _: Sel, inv: *mut AnyObject) {
        // SAFETY: the invocation AppKit built from `signature`; its return value stays zero.
        let s: Sel = unsafe { msg_send![&*inv, selector] };
        UNKNOWN.with(|u| u.borrow_mut().push(s.name().to_string_lossy().into_owned()));
    }

    extern "C-unwind" fn location(_: &AnyObject, _: Sel) -> NSPoint {
        let (x, y) = LOC.with(Cell::get);
        NSPoint::new(x, y)
    }
    extern "C-unwind" fn pasteboard(_: &AnyObject, _: Sel) -> *mut AnyObject {
        PB.with(|p| p.borrow().as_ref().map_or(std::ptr::null_mut(), |p| Retained::as_ptr(p) as *mut AnyObject))
    }
    extern "C-unwind" fn window(_: &AnyObject, _: Sel) -> *mut AnyObject {
        WIN.with(Cell::get) as *mut AnyObject
    }
    extern "C-unwind" fn nil(_: &AnyObject, _: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    extern "C-unwind" fn nil1(_: &AnyObject, _: Sel, _: *mut AnyObject) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    // Finder offers copy, link and generic (NSDragOperationCopy | Link | Generic).
    extern "C-unwind" fn mask(_: &AnyObject, _: Sel) -> usize {
        1 | 2 | 4
    }
    extern "C-unwind" fn seq(_: &AnyObject, _: Sel) -> isize {
        SEQ.with(Cell::get)
    }
    extern "C-unwind" fn zero(_: &AnyObject, _: Sel) -> isize {
        0
    }
    extern "C-unwind" fn no(_: &AnyObject, _: Sel) -> Bool {
        Bool::NO
    }
    extern "C-unwind" fn set_int(_: &AnyObject, _: Sel, _: isize) {}
    extern "C-unwind" fn set_bool(_: &AnyObject, _: Sel, _: Bool) {}
    extern "C-unwind" fn slide(_: &AnyObject, _: Sel, _: NSPoint) {}
    extern "C-unwind" fn none(_: &AnyObject, _: Sel) {}
    extern "C-unwind" fn valid(_: &AnyObject, _: Sel) -> isize {
        VALID.with(Cell::get)
    }
    extern "C-unwind" fn set_valid(_: &AnyObject, _: Sel, n: isize) {
        VALID.with(|v| v.set(n));
    }
    extern "C-unwind" fn enumerate(_: &AnyObject, _: Sel, _: usize, _: *mut AnyObject, _: *mut AnyObject, _: *mut AnyObject, _: *mut AnyObject) {}

    /// The self-test's `NSDraggingInfo` class, made once.
    fn info_class() -> Result<&'static AnyClass, String> {
        if let Some(c) = AnyClass::get(c"CooolSelfTestDraggingInfo") {
            return Ok(c);
        }
        let mut b = ClassBuilder::new(c"CooolSelfTestDraggingInfo", NSObject::class()).ok_or("class")?;
        // SAFETY: each function has the selector's documented signature (NSDraggingInfo, macOS 10.0–10.11 API).
        unsafe {
            if let Some(p) = AnyProtocol::get(c"NSDraggingInfo") {
                b.add_protocol(p);
            }
            b.add_method(sel!(draggingLocation), location as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggedImageLocation), location as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggingPasteboard), pasteboard as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggingDestinationWindow), window as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggingSource), nil as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggedImage), nil as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(namesOfPromisedFilesDroppedAtDestination:), nil1 as extern "C-unwind" fn(_, _, _) -> _);
            b.add_method(sel!(draggingSourceOperationMask), mask as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggingSequenceNumber), seq as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(draggingFormation), zero as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(setDraggingFormation:), set_int as extern "C-unwind" fn(_, _, _));
            b.add_method(sel!(animatesToDestination), no as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(setAnimatesToDestination:), set_bool as extern "C-unwind" fn(_, _, _));
            b.add_method(sel!(numberOfValidItemsForDrop), valid as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(setNumberOfValidItemsForDrop:), set_valid as extern "C-unwind" fn(_, _, _));
            b.add_method(sel!(springLoadingHighlight), zero as extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(resetSpringLoading), none as extern "C-unwind" fn(_, _));
            b.add_method(sel!(slideDraggedImageTo:), slide as extern "C-unwind" fn(_, _, _));
            b.add_method(
                sel!(enumerateDraggingItemsWithOptions:forView:classes:searchOptions:usingBlock:),
                enumerate as extern "C-unwind" fn(_, _, _, _, _, _, _),
            );
            b.add_method(sel!(methodSignatureForSelector:), signature as extern "C-unwind" fn(_, _, _) -> _);
            b.add_method(sel!(forwardInvocation:), forward as extern "C-unwind" fn(_, _, _));
        }
        Ok(b.register())
    }

    fn class_name(v: &AnyObject) -> String {
        v.class().name().to_string_lossy().into_owned()
    }

    /// Whether `v` registered for file drags (`public.file-url` or the legacy filenames type).
    unsafe fn takes_files(v: &AnyObject) -> bool {
        unsafe {
            let types: *mut NSArray<NSString> = msg_send![v, registeredDraggedTypes];
            let Some(types) = types.as_ref() else { return false };
            types.iter().any(|t| {
                let t = t.to_string();
                t == "public.file-url" || t == "NSFilenamesPboardType" || t == "Apple URL pasteboard type"
            })
        }
    }

    unsafe fn walk(v: &AnyObject, depth: usize, out: &mut Vec<String>) {
        unsafe {
            let hidden: bool = msg_send![v, isHidden];
            let f: NSRect = msg_send![v, frame];
            out.push(format!(
                "{}{}{} [{:.0} {:.0} {:.0} {:.0}]{}",
                "  ".repeat(depth),
                class_name(v),
                if hidden { " hidden" } else { "" },
                f.origin.x,
                f.origin.y,
                f.size.width,
                f.size.height,
                if takes_files(v) { " files" } else { "" }
            ));
            let subs: Retained<NSArray<AnyObject>> = msg_send![v, subviews];
            for s in subs.iter() {
                walk(&s, depth + 1, out);
            }
        }
    }

    /// The frontmost, deepest visible view under `p` (window coordinates) registered for file drags: the path to it.
    unsafe fn dest(v: &AnyObject, p: NSPoint) -> Option<Vec<*const AnyObject>> {
        unsafe {
            let hidden: bool = msg_send![v, isHidden];
            if hidden {
                return None;
            }
            let none: *const AnyObject = std::ptr::null();
            let local: NSPoint = msg_send![v, convertPoint: p, fromView: none];
            let b: NSRect = msg_send![v, bounds];
            let inside = local.x >= b.origin.x && local.y >= b.origin.y && local.x < b.origin.x + b.size.width && local.y < b.origin.y + b.size.height;
            if !inside {
                return None;
            }
            let subs: Retained<NSArray<AnyObject>> = msg_send![v, subviews];
            for s in subs.iter().collect::<Vec<_>>().iter().rev() {
                if let Some(mut path) = dest(s, p) {
                    path.push(v as *const AnyObject);
                    return Some(path);
                }
            }
            takes_files(v).then(|| vec![v as *const AnyObject])
        }
    }

    pub fn run(ns: *mut std::ffi::c_void, wk: usize, kind: &str, paths: &[String], x: f64, y: f64) -> Result<NativeDrag, String> {
        if ns.is_null() {
            return Err("no window".into());
        }
        // SAFETY: main thread (run_on_main_thread); `ns` is the live NSWindow; public AppKit API with its documented
        // argument types. The info object answers every NSDraggingInfo getter AppKit and wry read.
        unsafe {
            let win = &*(ns as *mut AnyObject);
            let content: *mut AnyObject = msg_send![win, contentView];
            let content = content.as_ref().ok_or("no content view")?;
            let h: NSRect = msg_send![content, frame];
            let p = NSPoint::new(x, h.size.height - y);
            let path = dest(content, p).unwrap_or_default();
            let mut out = NativeDrag { dest: path.iter().map(|v| class_name(&**v)).collect(), ..Default::default() };
            if kind == "views" {
                walk(content, 0, &mut out.views);
                return Ok(out);
            }
            // The view the drag goes to, as AppKit picks it; it must be the app's own webview (wry's WryWebView).
            let target: &AnyObject = &**path.first().ok_or("no view takes file drags at that point")?;
            if target as *const AnyObject as usize != wk {
                return Err(format!("a file drag there goes to {} (not the app's webview)", out.dest.join(" < ")));
            }
            WIN.with(|w| w.set(ns as usize));
            LOC.with(|l| l.set((p.x, p.y)));
            if kind == "enter" {
                SEQ.with(|s| s.set(s.get() + 1));
                // A pasteboard of its own (never the system's drag pasteboard), holding the files as Finder puts them.
                let pbc = AnyClass::get(c"NSPasteboard").ok_or("no NSPasteboard")?;
                let pb: *mut AnyObject = msg_send![pbc, pasteboardWithUniqueName];
                let pb = Retained::retain(pb).ok_or("no pasteboard")?;
                let _: isize = msg_send![&*pb, clearContents];
                let urls: Vec<Retained<NSURL>> = paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(p))).collect();
                let arr = NSArray::from_retained_slice(&urls);
                let ok: Bool = msg_send![&*pb, writeObjects: &*arr];
                if !ok.as_bool() {
                    return Err("the pasteboard took no files".into());
                }
                VALID.with(|v| v.set(paths.len() as isize));
                PB.with(|slot| {
                    if let Some(old) = slot.borrow_mut().replace(pb) {
                        let _: () = msg_send![&*old, releaseGlobally];
                    }
                });
            }
            if PB.with(|p| p.borrow().is_none()) {
                return Err("no drag in progress (enter first)".into());
            }
            let cls = info_class()?;
            let info: Retained<AnyObject> = msg_send![cls, new];
            let responds = |s: Sel| -> bool { msg_send![target, respondsToSelector: s] };
            out.op = Some(match kind {
                "enter" if responds(sel!(draggingEntered:)) => {
                    let op: usize = msg_send![target, draggingEntered: &*info];
                    op as u64
                }
                "over" if responds(sel!(draggingUpdated:)) => {
                    let op: usize = msg_send![target, draggingUpdated: &*info];
                    op as u64
                }
                "drop" if responds(sel!(performDragOperation:)) => {
                    let ok: Bool = msg_send![target, prepareForDragOperation: &*info];
                    let done: Bool = if ok.as_bool() { msg_send![target, performDragOperation: &*info] } else { Bool::NO };
                    if done.as_bool() && responds(sel!(concludeDragOperation:)) {
                        let _: () = msg_send![target, concludeDragOperation: &*info];
                    }
                    end();
                    done.as_bool() as u64
                }
                "exit" if responds(sel!(draggingExited:)) => {
                    let _: () = msg_send![target, draggingExited: &*info];
                    end();
                    0
                }
                "enter" | "over" | "drop" | "exit" => return Err(format!("the view doesn't answer {kind}")),
                _ => return Err("kind: views, enter, over, drop or exit".into()),
            });
            out.unknown = UNKNOWN.with(|u| std::mem::take(&mut *u.borrow_mut()));
            Ok(out)
        }
    }

    fn end() {
        PB.with(|slot| {
            if let Some(pb) = slot.borrow_mut().take() {
                // SAFETY: our own uniquely named pasteboard, released from the pasteboard server.
                unsafe {
                    let _: () = msg_send![&*pb, releaseGlobally];
                }
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn run(_ns: *mut std::ffi::c_void, _wk: usize, _kind: &str, _paths: &[String], _x: f64, _y: f64) -> Result<super::NativeDrag, String> {
        Err("macOS only".into())
    }
}
