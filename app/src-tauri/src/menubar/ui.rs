//! The AppKit side of the menu bar item: an `NSStatusItem` with a template glyph and an attributed title in tabular
//! digits, and a native `NSMenu` (built from model.rs's rows) whose delegate tells the sampler when it is open.
//! Everything here runs on the main thread ([`on_main`] gets there even while the menu is open and tracking).

use super::model::{Bar, Open, Row, SegKind};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSAttributedStringNSStringDrawing, NSBezierPath, NSColor, NSFont, NSImage, NSMenu, NSMenuDelegate, NSMenuItem, NSMutableParagraphStyle, NSStatusBar, NSStatusItem, NSTextAlignment, NSTextTab,
};
use objc2_foundation::{NSArray, NSAttributedString, NSDictionary, NSMutableAttributedString, NSNumber, NSPoint, NSRect, NSSize, NSString};
use std::cell::RefCell;
use std::ffi::c_void;

/// A click in the menu, handed to mod.rs.
#[derive(Clone, Debug)]
pub enum Act {
    Action(String),
    Open(Open),
}

struct Ui {
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    _target: Retained<Target>,
    /// The menu's rows as built: (row id, item), and what each clickable tag does.
    rows: Vec<(String, Retained<NSMenuItem>)>,
    acts: Vec<Act>,
    bar: Option<Bar>,
    /// A self-test's item (its glyph differs).
    test: bool,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

define_class!(
    /// The menu's delegate (open / closed) and the target of its items.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CooolMenuBarTarget"]
    struct Target;

    unsafe impl NSObjectProtocol for Target {}

    unsafe impl NSMenuDelegate for Target {
        #[unsafe(method(menuWillOpen:))]
        fn menu_will_open(&self, _m: &NSMenu) {
            super::on_menu(true);
        }

        #[unsafe(method(menuDidClose:))]
        fn menu_did_close(&self, _m: &NSMenu) {
            super::on_menu(false);
        }
    }

    impl Target {
        #[unsafe(method(act:))]
        fn act(&self, sender: &NSMenuItem) {
            let tag = sender.tag();
            let a = UI.with(|u| u.borrow().as_ref().and_then(|u| u.acts.get(tag as usize).cloned()));
            if let Some(a) = a {
                super::on_act(a);
            }
        }
    }
);

impl Target {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// The needs-you colour (styles.css `--status-needs`), the only accent the item uses.
fn needs_color() -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(254.0 / 255.0, 188.0 / 255.0, 46.0 / 255.0, 1.0)
}

/// coool's glyph: the three o's of its name, as a template image (macOS tints it for light and dark bars). A
/// self-test's item is a test tube instead, so it can never pass for the real one.
fn glyph(test: bool) -> Retained<NSImage> {
    if test && let Some(i) = NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str("testtube.2"), Some(&NSString::from_str("coool self-test"))) {
        i.setTemplate(true);
        return i;
    }
    let size = NSSize::new(20.0, 16.0);
    let draw = RcBlock::new(|_r: NSRect| -> Bool {
        NSColor::blackColor().setStroke();
        let d = 5.4;
        for cx in [3.5, 10.0, 16.5] {
            let p = NSBezierPath::bezierPathWithOvalInRect(NSRect::new(NSPoint::new(cx - d / 2.0, 8.0 - d / 2.0), NSSize::new(d, d)));
            p.setLineWidth(1.6);
            p.stroke();
        }
        Bool::YES
    });
    let i = NSImage::imageWithSize_flipped_drawingHandler(size, false, &draw);
    i.setTemplate(true);
    i
}

type Attrs = Retained<NSDictionary<NSString, AnyObject>>;

fn attrs(font: &NSFont, color: &NSColor, para: Option<&NSMutableParagraphStyle>, baseline: Option<f64>) -> Attrs {
    // SAFETY: AppKit's attribute-name statics are valid NSStrings for the life of the process.
    let (kf, kc, kp, kb) = unsafe { (objc2_app_kit::NSFontAttributeName, objc2_app_kit::NSForegroundColorAttributeName, objc2_app_kit::NSParagraphStyleAttributeName, objc2_app_kit::NSBaselineOffsetAttributeName) };
    let mut keys: Vec<&NSString> = vec![kf, kc];
    let mut vals: Vec<&AnyObject> = vec![font.as_ref(), color.as_ref()];
    if let Some(p) = para {
        keys.push(kp);
        vals.push(p.as_ref());
    }
    let b = baseline.map(NSNumber::new_f64);
    if let Some(b) = &b {
        keys.push(kb);
        vals.push(b.as_ref());
    }
    NSDictionary::from_slices(&keys, &vals)
}

fn push(out: &NSMutableAttributedString, text: &str, a: &Attrs) {
    // SAFETY: a plain string and an attribute dictionary of AppKit keys.
    let s = unsafe { NSAttributedString::initWithString_attributes(NSAttributedString::alloc(), &NSString::from_str(text), Some(a)) };
    out.appendAttributedString(&s);
}

/// The bar's title: small labels, figures in tabular digits (every digit the same width), the needs-you mark in its
/// colour. A leading space parts it from the glyph.
pub fn bar_title(b: &Bar) -> Retained<NSMutableAttributedString> {
    let out = NSMutableAttributedString::new();
    if b.segs.is_empty() {
        return out;
    }
    let size = NSFont::menuBarFontOfSize(0.0).pointSize();
    let value = attrs(&NSFont::monospacedDigitSystemFontOfSize_weight(size, 0.0), &NSColor::labelColor(), None, None);
    // The same colour as the figures: a dimmer one resolved against the app's appearance, not the menu bar's, and came
    // out muddy on a coloured or dark bar.
    let label = attrs(&NSFont::systemFontOfSize_weight(size * 0.62, 0.3), &NSColor::labelColor(), None, Some(1.0));
    let mark = attrs(&NSFont::systemFontOfSize_weight(size * 0.7, 0.0), &needs_color(), None, Some(1.0));
    let space = attrs(&NSFont::monospacedDigitSystemFontOfSize_weight(size, 0.0), &NSColor::labelColor(), None, None);
    push(&out, " ", &space);
    for (i, s) in b.segs.iter().enumerate() {
        if i > 0 {
            push(&out, if s.kind == SegKind::Label { "  " } else { " " }, &space);
        }
        let a = match s.kind {
            SegKind::Value => &value,
            SegKind::Label => &label,
            SegKind::Needs => &mark,
        };
        push(&out, &s.text, a);
    }
    out
}

/// Width in points the bar's title takes (for the self-test's width check).
pub fn title_width(b: &Bar) -> f64 {
    bar_title(b).size().width
}

const MENU_WIDTH: f64 = 330.0;

/// A second line: dim text, with runs of sparkline blocks (▁..█) in Menlo, which has them at an even width (the
/// system font falls back to some other font for them).
fn push_detail(out: &NSMutableAttributedString, text: &str, dim: &Attrs, spark: &Attrs) {
    let is_bar = |c: char| ('\u{2581}'..='\u{2588}').contains(&c);
    let mut run = String::new();
    let mut bars = false;
    for c in text.chars() {
        if is_bar(c) != bars && !run.is_empty() {
            push(out, &run, if bars { spark } else { dim });
            run.clear();
        }
        bars = is_bar(c);
        run.push(c);
    }
    if !run.is_empty() {
        push(out, &run, if bars { spark } else { dim });
    }
}

fn row_title(r: &Row) -> Retained<NSMutableAttributedString> {
    let out = NSMutableAttributedString::new();
    let body = NSFont::menuFontOfSize(0.0).pointSize();
    let small = (body - 2.0).max(10.0);
    let para = NSMutableParagraphStyle::new();
    // SAFETY: an empty options dictionary.
    let tab = unsafe { NSTextTab::initWithTextAlignment_location_options(NSTextTab::alloc(), NSTextAlignment::Right, MENU_WIDTH - 24.0, &NSDictionary::new()) };
    para.setTabStops(Some(&NSArray::from_retained_slice(&[tab])));
    let main = attrs(&NSFont::menuFontOfSize(body), &NSColor::labelColor(), Some(&para), None);
    let figure = attrs(&NSFont::monospacedDigitSystemFontOfSize_weight(body, 0.0), &NSColor::labelColor(), Some(&para), None);
    let dim = attrs(&NSFont::systemFontOfSize(small), &NSColor::secondaryLabelColor(), Some(&para), None);
    let spark_font = NSFont::fontWithName_size(&NSString::from_str("Menlo"), small).unwrap_or_else(|| NSFont::systemFontOfSize(small));
    let spark = attrs(&spark_font, &NSColor::secondaryLabelColor(), Some(&para), None);
    let head = attrs(&NSFont::systemFontOfSize_weight(small, 0.3), &NSColor::secondaryLabelColor(), Some(&para), None);
    let mark = attrs(&NSFont::systemFontOfSize(small), &needs_color(), Some(&para), Some(1.0));
    match r {
        Row::Header { text } => push(&out, text, &head),
        Row::Stat { label, value, detail, .. } => {
            push(&out, label, &main);
            push(&out, "\t", &main);
            push(&out, value, &figure);
            if let Some(d) = detail {
                push_detail(&out, &format!("\n{d}"), &dim, &spark);
            }
        }
        Row::Proc { name, what, cpu, .. } => {
            push(&out, name, &main);
            push(&out, "\t", &main);
            push(&out, cpu, &figure);
            if let Some(w) = what {
                push(&out, &format!("\n{w}"), &dim);
            }
        }
        Row::Need { title, detail, .. } => {
            push(&out, "● ", &mark);
            push(&out, title, &main);
            push(&out, &format!("\n{detail}"), &dim);
        }
        Row::Note { text } => push(&out, text, &dim),
        Row::Action { title, .. } => push(&out, title, &main),
        Row::Sep => {}
    }
    out
}

/// The menu item for a row, and the click it makes (if any).
fn row_item(r: &Row, mtm: MainThreadMarker, target: &Target, tag: usize) -> (Retained<NSMenuItem>, Option<Act>) {
    if let Row::Sep = r {
        return (NSMenuItem::separatorItem(mtm), None);
    }
    let act = match r {
        Row::Action { id, .. } => Some(Act::Action(id.clone())),
        Row::Need { open, .. } => Some(Act::Open(open.clone())),
        Row::Proc { open: Some(o), .. } => Some(Act::Open(o.clone())),
        _ => None,
    };
    let sel: Option<Sel> = act.as_ref().map(|_| sel!(act:));
    // SAFETY: a fresh item; the target outlives the menu (both live in UI).
    let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(""), sel, &NSString::from_str("")) };
    item.setAttributedTitle(Some(&row_title(r)));
    if act.is_some() {
        unsafe { item.setTarget(Some(target.as_ref())) };
        item.setTag(tag as isize);
    }
    // Figures and notes are read, not clicked: disabled, but drawn in the colours their title gives.
    item.setEnabled(act.is_some());
    if let Row::Stat { tip, .. } = r {
        item.setToolTip(Some(&NSString::from_str(tip)));
    }
    (item, act)
}

/// Creates the item (if it isn't there). `hidden`: created with its visibility off, so nothing is drawn in the bar
/// (self-tests and smoke launches); everything else about it is real.
pub fn create(hidden: bool, test: bool) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if UI.with(|u| u.borrow().is_some()) {
        return;
    }
    // A hidden item is made zero wide and hidden in the same main-thread turn, before anything is drawn: it never takes
    // room in the bar, not even for a frame. Then it gets the variable length a real one has (still hidden).
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(if hidden { 0.0 } else { -1.0 /* NSVariableStatusItemLength */ });
    if hidden {
        // Its own autosave name first: macOS stores an item's visibility in the app's defaults under that name, and
        // a hidden test item with the default name ("Item-0") once left the real item invisible on the next launch.
        item.setAutosaveName(Some(&NSString::from_str("coool-hidden-test")));
        item.setVisible(false);
        item.setLength(-1.0);
    } else {
        // Remembers where the person dragged it (⌘-drag) between launches.
        item.setAutosaveName(Some(&NSString::from_str("coool")));
        // Shown whatever a stored flag says: whether it shows is Settings > General > Menu bar, nothing else.
        item.setVisible(true);
    }
    if let Some(b) = item.button(mtm) {
        b.setImage(Some(&glyph(test)));
        // NSImageLeading: the glyph, then the reading.
        let _: () = unsafe { msg_send![&*b, setImagePosition: 7isize] };
    }
    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);
    menu.setMinimumWidth(MENU_WIDTH);
    let target = Target::new(mtm);
    menu.setDelegate(Some(ProtocolObject::from_ref(&*target)));
    item.setMenu(Some(&menu));
    eprintln!("coool menubar: item created{}", if hidden { " (hidden)" } else { "" });
    UI.with(|u| *u.borrow_mut() = Some(Ui { item, menu, _target: target, rows: Vec::new(), acts: Vec::new(), bar: None, test }));
}

/// Takes the item out of the bar for good.
pub fn remove() {
    if let Some(u) = UI.with(|u| u.borrow_mut().take()) {
        u.menu.cancelTracking();
        NSStatusBar::systemStatusBar().removeStatusItem(&u.item);
        eprintln!("coool menubar: item removed");
    }
}

/// (exists, visible, tooltip, the title's text).
pub fn state() -> (bool, bool, String, String) {
    let Some(mtm) = MainThreadMarker::new() else { return (false, false, String::new(), String::new()) };
    UI.with(|u| match u.borrow().as_ref() {
        None => (false, false, String::new(), String::new()),
        Some(u) => {
            let b = u.item.button(mtm);
            let tip = b.as_ref().and_then(|b| b.toolTip()).map(|s| s.to_string()).unwrap_or_default();
            let title = b.as_ref().map(|b| b.attributedTitle().string().to_string()).unwrap_or_default();
            (true, u.item.isVisible(), tip, title)
        }
    })
}

/// Shows a new bar reading (only when it changed: no redraw for the same text).
pub fn set_bar(b: &Bar) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    UI.with(|u| {
        let mut g = u.borrow_mut();
        let Some(u) = g.as_mut() else { return };
        if u.bar.as_ref() == Some(b) {
            return;
        }
        if let Some(btn) = u.item.button(mtm) {
            // The glyph only when there is no figure to show: with one, the reading is the item.
            let figures = b.segs.iter().any(|s| matches!(s.kind, SegKind::Value));
            let img = (!figures).then(|| glyph(u.test));
            btn.setImage(img.as_deref());
            btn.setAttributedTitle(&bar_title(b));
            btn.setToolTip(Some(&NSString::from_str(&b.tooltip)));
        }
        u.bar = Some(b.clone());
    });
}

/// Puts `rows` in the menu: in place when the rows are the same ones (the open menu keeps its place and highlight),
/// rebuilt otherwise.
pub fn set_rows(rows: &[Row]) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    UI.with(|u| {
        let mut g = u.borrow_mut();
        let Some(u) = g.as_mut() else { return };
        let ids: Vec<String> = rows.iter().map(Row::id).collect();
        let same = ids.len() == u.rows.len() && ids.iter().zip(&u.rows).all(|(a, (b, _))| a == b);
        let mut acts = Vec::new();
        if same {
            for (r, (_, item)) in rows.iter().zip(&u.rows) {
                if !matches!(r, Row::Sep) {
                    item.setAttributedTitle(Some(&row_title(r)));
                }
                if let Row::Stat { tip, .. } = r {
                    item.setToolTip(Some(&NSString::from_str(tip)));
                }
                let act = match r {
                    Row::Action { id, .. } => Some(Act::Action(id.clone())),
                    Row::Need { open, .. } => Some(Act::Open(open.clone())),
                    Row::Proc { open: Some(o), .. } => Some(Act::Open(o.clone())),
                    _ => None,
                };
                if let Some(a) = act {
                    item.setTag(acts.len() as isize);
                    acts.push(a);
                }
            }
        } else {
            u.menu.removeAllItems();
            u.rows.clear();
            for (r, id) in rows.iter().zip(ids) {
                let (item, act) = row_item(r, mtm, &u._target, acts.len());
                if let Some(a) = act {
                    acts.push(a);
                }
                u.menu.addItem(&item);
                u.rows.push((id, item));
            }
        }
        u.acts = acts;
    });
}

/// The menu's items as built: (title text, enabled, tooltip).
pub fn menu_items() -> Vec<(String, bool, Option<String>)> {
    UI.with(|u| {
        u.borrow()
            .as_ref()
            .map(|u| {
                u.menu
                    .itemArray()
                    .iter()
                    .map(|i| {
                        let t = if i.isSeparatorItem() { "---".to_string() } else { i.attributedTitle().map(|a| a.string().to_string()).unwrap_or_else(|| i.title().to_string()) };
                        (t, i.isEnabled(), i.toolTip().map(|s| s.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// The click the first enabled menu row whose text starts with `text` makes (for the self-test, which never opens the
/// menu on screen).
pub fn act_of(text: &str) -> Option<Act> {
    UI.with(|u| {
        let g = u.borrow();
        let u = g.as_ref()?;
        let item = u.menu.itemArray().iter().find(|i| i.isEnabled() && i.attributedTitle().is_some_and(|a| a.string().to_string().starts_with(text)))?;
        u.acts.get(item.tag() as usize).cloned()
    })
}

// ---- getting to the main thread, also while the menu tracks ----

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRunLoopGetMain() -> *mut c_void;
    fn CFRunLoopPerformBlock(rl: *mut c_void, mode: *const c_void, block: &block2::DynBlock<dyn Fn()>);
    fn CFRunLoopWakeUp(rl: *mut c_void);
    static kCFRunLoopCommonModes: *const c_void;
}

/// Runs `f` on the main thread soon, in the run loop's common modes: unlike a plain dispatch, it also runs while the
/// menu is open (AppKit then runs the loop in its event-tracking mode), so an open menu keeps updating.
pub fn on_main(f: impl FnOnce() + Send + 'static) {
    let cell = std::sync::Mutex::new(Some(f));
    let block = RcBlock::new(move || {
        if let Some(f) = cell.lock().ok().and_then(|mut c| c.take()) {
            f();
        }
    });
    // SAFETY: the main run loop lives as long as the process; the block is copied by CoreFoundation.
    unsafe {
        let rl = CFRunLoopGetMain();
        CFRunLoopPerformBlock(rl, kCFRunLoopCommonModes, &block);
        CFRunLoopWakeUp(rl);
    }
}

/// Status-bar windows (layer 25) this process has on screen, as the window server lists them (no Screen Recording
/// needed: only numbers are read). A hidden item has none.
pub fn bar_windows() -> usize {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    let me = std::process::id() as i64;
    // SAFETY: the copied array is toll-free bridged to NSArray, read, then released.
    unsafe {
        let arr = CGWindowListCopyWindowInfo(1 /* kCGWindowListOptionOnScreenOnly */, 0);
        if arr.is_null() {
            return 0;
        }
        let a = &*(arr as *const NSArray<NSDictionary<NSString, AnyObject>>);
        let num = |d: &NSDictionary<NSString, AnyObject>, k: &str| d.objectForKey(&NSString::from_str(k)).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.as_i64());
        let n = a.iter().filter(|d| num(d, "kCGWindowOwnerPID") == Some(me) && num(d, "kCGWindowLayer") == Some(25)).count();
        CFRelease(arr);
        n
    }
}
