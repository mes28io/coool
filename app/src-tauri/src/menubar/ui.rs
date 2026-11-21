//! The AppKit side of the menu bar item: an `NSStatusItem` with a template glyph and an attributed title in tabular
//! digits, and a native `NSMenu` (built from model.rs's rows) whose delegate tells the sampler when it is open.
//! Everything here runs on the main thread ([`on_main`] gets there even while the menu is open and tracking).
//!
//! Rows that are only read (figures, heads, notes, processes without a session) are custom views: an `NSTextField`
//! label in an `NSView`, on a disabled item. AppKit draws a disabled item's own title dimmed, whatever colours its
//! attributes give (measured in an open menu: no text pixel above half opacity), but not an item's view: those rows
//! read in the label colours at full contrast, get no hover highlight, are skipped by the keyboard, and a click on
//! one does nothing. Rows that do something stay native items. The views copy the native rows' geometry as macOS lays
//! it out (measured in an open menu on macOS 27: the title field at x 14 in the menu's window; one line in a 24 pt
//! row, several in their height + 6), and the x is read again from a native row each time the menu opens.
//!
//! Where the menu sits: AppKit opens it at a location it keeps while it is open and puts the window back there after
//! every change of its content (measured: a window moved by hand returns there on the next title change; content
//! that grows or shrinks keeps the top). Each time the menu opens, and after each update while it is open, [`place`]
//! checks the window's top against the bottom of the menu bar of its screen and moves it up to the bar when AppKit
//! left a gap (the person saw one of about 36 pt on macOS 27, the item on a 30 pt bar).

use super::model::{Bar, Open, Row, SegKind};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, sel};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSAttributedStringNSStringDrawing, NSAutoresizingMaskOptions, NSBezierPath, NSBitmapImageFileType, NSColor, NSColorSpace, NSFont, NSImage, NSMenu, NSMenuDelegate, NSMenuItem,
    NSMutableParagraphStyle, NSScreen, NSStatusBar, NSStatusItem, NSTextAlignment, NSTextField, NSTextTab, NSView, NSWindow,
};
use objc2_foundation::{NSArray, NSAttributedString, NSDictionary, NSMutableAttributedString, NSNumber, NSPoint, NSRange, NSRect, NSSize, NSString};
use serde::Serialize;
use std::cell::RefCell;
use std::ffi::c_void;

/// A click in the menu, handed to mod.rs.
#[derive(Clone, Debug)]
pub enum Act {
    Action(String),
    Open(Open),
}

/// A row of the menu as built. A row that is only read has its view and label.
struct Slot {
    id: String,
    item: Retained<NSMenuItem>,
    view: Option<Retained<NSView>>,
    label: Option<Retained<NSTextField>>,
}

struct Ui {
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    _target: Retained<Target>,
    /// The menu's rows as built, and what each clickable tag does.
    rows: Vec<Slot>,
    acts: Vec<Act>,
    /// The rows last put in the menu (the self-test's probe updates the open menu with them).
    last: Vec<Row>,
    bar: Option<Bar>,
    /// A self-test's item (its glyph differs).
    test: bool,
    /// The x of a native row's title field in the menu's window (read again when the menu opens).
    text_x: f64,
    /// The open menu's window (from its first turn open until it closes).
    window: Option<Retained<NSWindow>>,
    /// Where the menu sat when it last opened, and what [`place`] did.
    geometry: Option<Geometry>,
    /// The self-test's probe has the menu open: it is never shown (alpha 0).
    probing: bool,
}

/// The open menu against the menu bar of its screen, in screen points (y up).
#[derive(Clone, Debug, Serialize)]
pub struct Geometry {
    /// The screen's frame: x, y, width, height.
    pub screen: [f64; 4],
    pub bar_height: f64,
    pub bar_bottom: f64,
    /// The menu window's top as AppKit placed it, and after [`place`].
    pub top_before: f64,
    pub top_after: f64,
    pub moved: bool,
    /// The status item's own window, and AppKit's private record of the bar's height for it (what it places the
    /// menu from).
    pub item_window: Option<[f64; 4]>,
    pub item_bar_height: Option<f64>,
    pub thickness: f64,
    pub text_x: f64,
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
            // The window doesn't exist yet: it does by the tracking loop's first turn.
            on_main(|| opened(0));
        }

        #[unsafe(method(menuDidClose:))]
        fn menu_did_close(&self, _m: &NSMenu) {
            UI.with(|u| {
                if let Ok(mut g) = u.try_borrow_mut()
                    && let Some(u) = g.as_mut()
                {
                    u.window = None;
                }
            });
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

/// What a click on the row does (none: the row is only read).
fn row_act(r: &Row) -> Option<Act> {
    match r {
        Row::Action { id, .. } => Some(Act::Action(id.clone())),
        Row::Need { open, .. } => Some(Act::Open(open.clone())),
        Row::Proc { open: Some(o), .. } => Some(Act::Open(o.clone())),
        _ => None,
    }
}

/// The x of a native row's title field in the menu's window as macOS 27 lays it out (read again on each open).
const TEXT_X: f64 = 14.0;

/// A read-only row's height, and its label's inset from the row's top and its height, as macOS lays out a native
/// row with the same title: one line in a 24 pt row (a field at least 16 pt high, 4 pt down), several lines in their
/// height + 6 (3 pt down).
fn metrics(t: &NSAttributedString) -> (f64, f64, f64) {
    let h = t.size().height.ceil();
    if t.string().to_string().contains('\n') { (h + 6.0, 3.0, h) } else { (24.0, 4.0, h.max(16.0)) }
}

fn lay_out(view: &NSView, label: &NSTextField, t: &NSAttributedString, x: f64) {
    let (rh, top, fh) = metrics(t);
    let w = view.frame().size.width.max(MENU_WIDTH);
    view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, rh)));
    label.setFrame(NSRect::new(NSPoint::new(x, rh - top - fh), NSSize::new(w - x - 4.0, fh)));
}

/// A read-only row's view: its title in a label, at the native rows' x.
fn info_view(t: &NSAttributedString, mtm: MainThreadMarker, x: f64) -> (Retained<NSView>, Retained<NSTextField>) {
    let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(MENU_WIDTH, 24.0)));
    view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
    let label = NSTextField::labelWithAttributedString(t, mtm);
    label.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
    view.addSubview(&label);
    lay_out(&view, &label, t, x);
    (view, label)
}

/// The menu item for a row, and the click it makes (if any).
fn row_item(r: &Row, mtm: MainThreadMarker, target: &Target, tag: usize, x: f64) -> (Slot, Option<Act>) {
    let id = r.id();
    if let Row::Sep = r {
        return (Slot { id, item: NSMenuItem::separatorItem(mtm), view: None, label: None }, None);
    }
    let act = row_act(r);
    let sel: Option<Sel> = act.as_ref().map(|_| sel!(act:));
    // SAFETY: a fresh item; the target outlives the menu (both live in UI).
    let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(""), sel, &NSString::from_str("")) };
    let title = row_title(r);
    // The title also on a view's item: what the self-test reads.
    item.setAttributedTitle(Some(&title));
    if act.is_some() {
        unsafe { item.setTarget(Some(target.as_ref())) };
        item.setTag(tag as isize);
    }
    item.setEnabled(act.is_some());
    let tip = if let Row::Stat { tip, .. } = r { Some(NSString::from_str(tip)) } else { None };
    item.setToolTip(tip.as_deref());
    let (view, label) = if act.is_none() {
        // Read, not clicked: a view on the disabled item, so that it isn't dimmed (see the module's head).
        let (v, l) = info_view(&title, mtm, x);
        v.setToolTip(tip.as_deref());
        item.setView(Some(&v));
        (Some(v), Some(l))
    } else {
        (None, None)
    };
    (Slot { id, item, view, label }, act)
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
    UI.with(|u| *u.borrow_mut() = Some(Ui { item, menu, _target: target, rows: Vec::new(), acts: Vec::new(), last: Vec::new(), bar: None, test, text_x: TEXT_X, window: None, geometry: None, probing: false }));
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
        // Same ids: same kinds, and a row is a view exactly when it was one (a process row that becomes clickable
        // changes id).
        let same = ids.len() == u.rows.len() && ids.iter().zip(&u.rows).all(|(a, b)| *a == b.id);
        let mut acts = Vec::new();
        if same {
            for (r, slot) in rows.iter().zip(&u.rows) {
                if matches!(r, Row::Sep) {
                    continue;
                }
                let title = row_title(r);
                if let (Some(view), Some(label)) = (&slot.view, &slot.label) {
                    // In place: the label's text; the row's frame only when its number of lines changed.
                    let old = view.frame().size.height;
                    label.setAttributedStringValue(&title);
                    if (metrics(&title).0 - old).abs() > 0.5 {
                        lay_out(view, label, &title, u.text_x);
                        u.menu.itemChanged(&slot.item);
                    }
                }
                slot.item.setAttributedTitle(Some(&title));
                if let Row::Stat { tip, .. } = r {
                    let tip = NSString::from_str(tip);
                    slot.item.setToolTip(Some(&tip));
                    if let Some(v) = &slot.view {
                        v.setToolTip(Some(&tip));
                    }
                }
                if let Some(a) = row_act(r) {
                    slot.item.setTag(acts.len() as isize);
                    acts.push(a);
                }
            }
        } else {
            u.menu.removeAllItems();
            u.rows.clear();
            for r in rows {
                let (slot, act) = row_item(r, mtm, &u._target, acts.len(), u.text_x);
                if let Some(a) = act {
                    acts.push(a);
                }
                u.menu.addItem(&slot.item);
                u.rows.push(slot);
            }
        }
        u.acts = acts;
        u.last = rows.to_vec();
        // An open menu: AppKit has just put its window back where it opened it.
        if u.window.is_some() {
            place(u);
        }
    });
}

// ---- where the open menu sits ----

/// The top edge of a rect (screen coordinates have y up).
fn top(r: NSRect) -> f64 {
    r.origin.y + r.size.height
}

fn rect4(r: NSRect) -> [f64; 4] {
    [r.origin.x, r.origin.y, r.size.width, r.size.height]
}

/// The menu bar's height on `screen`: what it takes off the top of the visible frame, or, while it hides itself,
/// the window server's menu bar window over that screen (only bounds are read: no permission needed).
fn bar_height(screen: &NSScreen) -> f64 {
    let (f, v) = (screen.frame(), screen.visibleFrame());
    let h = top(f) - top(v);
    if h >= 1.0 {
        return h;
    }
    windows(24 /* kCGMainMenuWindowLevel */, None).into_iter().find(|w| (w[0] - f.origin.x).abs() < 1.0 && (w[2] - f.size.width).abs() < 1.0).map(|w| w[3]).unwrap_or(0.0)
}

/// The open menu's window: the one its rows' views are in.
fn menu_window(u: &Ui) -> Option<Retained<NSWindow>> {
    u.window.clone().filter(|w| w.isVisible()).or_else(|| u.rows.iter().filter_map(|s| s.view.as_ref()?.window()).find(|w| w.isVisible()))
}

/// How far below the bar's bottom AppKit may leave the menu's top before [`place`] moves it.
const GAP_TOLERANCE: f64 = 6.0;

/// Where the menu's window should go: its top at the bar's bottom when AppKit left it more than [`GAP_TOLERANCE`]
/// below (never down, never over the bar). `None`: leave it.
pub fn corrected_top(window_top: f64, bar_bottom: f64) -> Option<f64> {
    (window_top < bar_bottom - GAP_TOLERANCE).then_some(bar_bottom)
}

#[cfg(test)]
mod tests {
    use super::corrected_top;

    #[test]
    fn a_menu_left_below_the_bar_goes_up_to_it() {
        // The person's: a 30 pt bar on a 1080 pt screen, the menu's top 36 pt below it.
        assert_eq!(corrected_top(1050.0 - 36.0, 1050.0), Some(1050.0));
        // Where AppKit puts a menu it opens at the bar (its window 5 pt above the location), or a few points lower:
        // left alone.
        assert_eq!(corrected_top(1055.0, 1050.0), None);
        assert_eq!(corrected_top(1050.0, 1050.0), None);
        assert_eq!(corrected_top(1045.0, 1050.0), None);
        // Never down.
        assert_eq!(corrected_top(1100.0, 1050.0), None);
    }
}

/// Moves the open menu's window up to the bottom of its screen's menu bar if AppKit left a gap, and says where it was.
fn place(u: &mut Ui) -> Option<Geometry> {
    let w = menu_window(u)?;
    let screen = w.screen()?;
    let bh = bar_height(&screen);
    if bh < 1.0 {
        return None;
    }
    let bar_bottom = top(screen.frame()) - bh;
    let f = w.frame();
    let before = top(f);
    let fix = corrected_top(before, bar_bottom);
    if let Some(t) = fix {
        w.setFrameTopLeftPoint(NSPoint::new(f.origin.x, t));
    }
    let mtm = MainThreadMarker::new()?;
    let item_window = u.item.button(mtm).and_then(|b| b.window()).map(|w| rect4(w.frame()));
    let s = sel!(_menuBarHeight);
    // SAFETY: asked only when the item answers it; it returns a CGFloat.
    let responds: bool = unsafe { msg_send![&*u.item, respondsToSelector: s] };
    let item_bar_height: Option<f64> = responds.then(|| unsafe { msg_send![&*u.item, _menuBarHeight] });
    Some(Geometry { screen: rect4(screen.frame()), bar_height: bh, bar_bottom, top_before: before, top_after: top(w.frame()), moved: fix.is_some(), item_window, item_bar_height, thickness: NSStatusBar::systemStatusBar().thickness(), text_x: u.text_x })
}

fn class_name(v: &NSView) -> String {
    v.class().name().to_string_lossy().into_owned()
}

/// Every view under `v` (itself included) whose class is `name`.
fn views_of(v: &NSView, name: &str, out: &mut Vec<Retained<NSView>>) {
    if class_name(v) == name {
        out.push(v.retain());
    }
    for s in v.subviews().iter() {
        views_of(&s, name, out);
    }
}

/// The topmost view of a window (its frame view), under which the menu's rows are.
fn root_view(w: &NSWindow) -> Option<Retained<NSView>> {
    let mut v = w.contentView()?;
    // SAFETY: read while the window, which retains its views, is alive.
    while let Some(s) = unsafe { v.superview() } {
        v = s;
    }
    Some(v)
}

/// The native rows' title fields in the open menu (AppKit's `_NSMenuItemTextField`, an NSTextField).
fn native_fields(w: &NSWindow) -> Vec<Retained<NSView>> {
    let mut out = Vec::new();
    if let Some(r) = root_view(w) {
        views_of(&r, "_NSMenuItemTextField", &mut out);
    }
    out
}

fn in_window(v: &NSView) -> NSRect {
    v.convertRect_toView(v.bounds(), None)
}

/// The menu has just opened (`tries`: turns already waited for its window): the views take the native rows' title
/// x, the window goes up to the bar if AppKit left a gap, and where it was goes to stderr and
/// `$TMPDIR/coool-menubar-geometry.json`.
fn opened(tries: u32) {
    let done = UI.with(|u| {
        let Ok(mut g) = u.try_borrow_mut() else { return false };
        let Some(u) = g.as_mut() else { return true };
        let Some(w) = u.rows.iter().filter_map(|s| s.view.as_ref()?.window()).find(|w| w.isVisible()) else { return false };
        if u.probing {
            w.setAlphaValue(0.0);
        }
        u.window = Some(w.clone());
        if let Some(x) = native_fields(&w).first().map(|f| in_window(f).origin.x)
            && (x - u.text_x).abs() > 0.25
        {
            u.text_x = x;
            for s in &u.rows {
                if let (Some(v), Some(l)) = (&s.view, &s.label) {
                    lay_out(v, l, &l.attributedStringValue(), x);
                }
            }
        }
        u.geometry = place(u);
        if let Some(g) = &u.geometry
            && !u.probing
        {
            let line = serde_json::to_string(g).unwrap_or_default();
            eprintln!("coool menubar: menu opened {line}");
            let _ = std::fs::write(std::env::temp_dir().join("coool-menubar-geometry.json"), line);
        }
        true
    });
    // The window comes with the menu's first display: try again every 5 ms for a while.
    if !done && tries < 60 {
        on_main_later(5, move || opened(tries + 1));
    }
}

/// The menu's items as built: (title text, enabled, tooltip, drawn by a view of ours).
pub fn menu_items() -> Vec<(String, bool, Option<String>, bool)> {
    UI.with(|u| {
        u.borrow()
            .as_ref()
            .map(|u| {
                u.menu
                    .itemArray()
                    .iter()
                    .map(|i| {
                        let t = if i.isSeparatorItem() { "---".to_string() } else { i.attributedTitle().map(|a| a.string().to_string()).unwrap_or_else(|| i.title().to_string()) };
                        (t, i.isEnabled(), i.toolTip().map(|s| s.to_string()), i.view().is_some())
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

// ---- the self-test's probe: the real menu opened, never shown ----

/// Luminance of the opaque pixels of `view` drawn offscreen in `appearance`: (darkest, brightest, how many), and the
/// image as PNG.
fn render(view: &NSView, appearance: &NSAppearance) -> Option<(f64, f64, usize, Vec<u8>)> {
    view.setAppearance(Some(appearance));
    let b = view.bounds();
    let rep = view.bitmapImageRepForCachingDisplayInRect(b)?;
    view.cacheDisplayInRect_toBitmapImageRep(b, &rep);
    let srgb = NSColorSpace::sRGBColorSpace();
    let (mut lo, mut hi, mut n) = (1.0f64, 0.0f64, 0usize);
    for y in 0..rep.pixelsHigh() {
        for x in 0..rep.pixelsWide() {
            let Some(c) = rep.colorAtX_y(x, y).and_then(|c| c.colorUsingColorSpace(&srgb)) else { continue };
            if c.alphaComponent() < 0.5 {
                continue;
            }
            let l = 0.2126 * c.redComponent() + 0.7152 * c.greenComponent() + 0.0722 * c.blueComponent();
            lo = lo.min(l);
            hi = hi.max(l);
            n += 1;
        }
    }
    // SAFETY: an empty properties dictionary.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.map(|d| d.to_vec()).unwrap_or_default();
    view.setAppearance(None);
    Some((lo, hi, n, png))
}

/// Which label colour a run of a title has: "label", "secondary" or "other".
fn color_at(t: &NSAttributedString, i: usize) -> &'static str {
    // SAFETY: an AppKit attribute name; the index is inside the string (checked by the caller).
    let c = unsafe { t.attribute_atIndex_effectiveRange(objc2_app_kit::NSForegroundColorAttributeName, i, std::ptr::null_mut()) };
    let Some(c) = c.and_then(|c| c.downcast::<NSColor>().ok()) else { return "none" };
    if c.isEqual(Some(&NSColor::labelColor())) {
        "label"
    } else if c.isEqual(Some(&NSColor::secondaryLabelColor())) {
        "secondary"
    } else {
        "other"
    }
}

/// The first line of a field's text: its text, and its width (with the tab to the figure) from where the field draws.
fn first_line(t: &NSAttributedString) -> (String, f64) {
    let s = t.string().to_string();
    let n = s.find('\n').unwrap_or(s.len());
    let utf16 = s[..n].encode_utf16().count();
    let sub = t.attributedSubstringFromRange(NSRange::new(0, utf16));
    (s[..n].to_string(), sub.size().width)
}

/// Measures the open menu (called in its first turns open): rows, alignment, colours, placement, an update in place.
fn probe_measure(w: &NSWindow, drop: f64, shots: Option<&str>, sample: Option<Retained<NSMenuItem>>) -> serde_json::Value {
    use serde_json::json;
    let Some(mtm) = MainThreadMarker::new() else { return json!(null) };
    let added = UI.with(|u| u.borrow().as_ref().map(|u| u.menu.clone())).zip(sample);
    let natives: Vec<serde_json::Value> = native_fields(w)
        .iter()
        .filter_map(|f| {
            let f = f.downcast_ref::<NSTextField>()?;
            let r = in_window(f);
            let (text, width) = first_line(&f.attributedStringValue());
            Some(json!({ "text": text, "x": r.origin.x, "right": text.contains('\t').then_some(r.origin.x + width), "row_height": f.superview_height() }))
        })
        .collect();
    if let Some((menu, item)) = &added {
        menu.removeItem(item);
    }
    let (views, geometry, last) = UI.with(|u| {
        let g = u.borrow();
        let Some(u) = g.as_ref() else { return (Vec::new(), None, Vec::new()) };
        let views: Vec<serde_json::Value> = u
            .rows
            .iter()
            .filter_map(|s| {
                let (v, l) = (s.view.as_ref()?, s.label.as_ref()?);
                let r = in_window(l);
                let t = l.attributedStringValue();
                let (text, width) = first_line(&t);
                let full = t.string().to_string();
                let detail = full.find('\n').map(|i| full[..=i].encode_utf16().count());
                Some(json!({
                    "text": text,
                    "x": r.origin.x,
                    "right": text.contains('\t').then_some(r.origin.x + width),
                    "row_height": v.frame().size.height,
                    "enabled": s.item.isEnabled(),
                    "in_window": v.window().is_some(),
                    "color": color_at(&t, 0),
                    "detail_color": detail.filter(|&i| i < t.length()).map(|i| color_at(&t, i)),
                }))
            })
            .collect();
        (views, u.geometry.clone(), u.last.clone())
    });
    // AppKit puts the window back where it opened it after any change of content: a native row's title changes (as
    // it would on an update), then the rows are updated in place as the sampler does every 2 s.
    let native_item = UI.with(|u| u.borrow().as_ref().and_then(|u| u.rows.iter().find(|s| s.view.is_none() && !s.item.isSeparatorItem()).map(|s| (u.menu.clone(), s.item.clone()))));
    let mut relayout_top = None;
    if let Some((menu, item)) = native_item {
        let t = item.attributedTitle();
        item.setAttributedTitle(Some(&NSAttributedString::from_nsstring(&NSString::from_str("A much longer title that makes the menu relay out"))));
        relayout_top = Some(top(w.frame()));
        item.setAttributedTitle(t.as_deref());
        menu.itemChanged(&item);
    }
    set_rows(&last);
    let updated_top = top(w.frame());
    // A read-only row drawn offscreen in light and dark.
    let mut renders = serde_json::Map::new();
    if let Some(r) = last.iter().find(|r| matches!(r, Row::Stat { .. })) {
        let (v, _) = info_view(&row_title(r), mtm, TEXT_X);
        for (name, ap) in [("light", unsafe { NSAppearanceNameAqua }), ("dark", unsafe { NSAppearanceNameDarkAqua })] {
            if let Some(a) = NSAppearance::appearanceNamed(ap)
                && let Some((lo, hi, n, png)) = render(&v, &a)
            {
                let path = shots.map(|d| format!("{d}/menubar-row-{name}.png"));
                if let Some(p) = &path {
                    let _ = std::fs::write(p, &png);
                }
                renders.insert(name.into(), json!({ "darkest": lo, "brightest": hi, "pixels": n, "png": path }));
            }
        }
    }
    json!({ "drop": drop, "geometry": geometry, "relayout_top": relayout_top, "updated_top": updated_top, "natives": natives, "views": views, "renders": renders })
}

trait SuperHeight {
    fn superview_height(&self) -> Option<f64>;
}
impl SuperHeight for NSTextField {
    /// The height of the native row the field is in.
    fn superview_height(&self) -> Option<f64> {
        // SAFETY: read while the menu's window retains its views.
        unsafe { self.superview() }.map(|s| s.frame().size.height)
    }
}

type Out = std::sync::Arc<std::sync::Mutex<Option<serde_json::Value>>>;

/// The probe's turns in the open menu: waits for its window and [`opened`]; puts in a native row with a figure, as a
/// process tied to a session has (the menu has one only while such a process is busy; AppKit makes its title field
/// on a later turn); measures; closes the menu.
fn probe_tick(n: u32, drop: f64, shots: Option<String>, out: Out, sample: Option<Retained<NSMenuItem>>) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let w = UI.with(|u| u.borrow().as_ref().and_then(|u| u.window.clone().filter(|_| u.geometry.is_some())));
    let menu = UI.with(|u| u.borrow().as_ref().map(|u| u.menu.clone()));
    let Some(menu) = menu else { return };
    let (shots2, out2) = (shots.clone(), out.clone());
    let again = move |s: Option<Retained<NSMenuItem>>| {
        let (shots, out) = (shots2, out2);
        // Retained<NSMenuItem> isn't Send; the block runs on this same (main) thread.
        let s = std::sync::Mutex::new(s.map(|s| Retained::into_raw(s) as usize));
        on_main_later(10, move || {
            // SAFETY: the pointer was made from a Retained on this thread just before.
            let s = s.lock().unwrap().take().map(|p| unsafe { Retained::from_raw(p as *mut NSMenuItem).unwrap() });
            probe_tick(n + 1, drop, shots, out, s)
        })
    };
    match (w, sample) {
        (Some(w), None) => {
            w.setAlphaValue(0.0);
            let row = Row::Proc { id: "probe".into(), name: "claude".into(), what: Some("Claude Code · a session".into()), cpu: "7.9%".into(), open: Some(Open { key: None, chat: None }) };
            let item = UI.with(|u| {
                let g = u.borrow();
                let u = g.as_ref()?;
                // Its tag points at no click: nothing is sent even if it were clicked.
                let (slot, _) = row_item(&row, mtm, &u._target, usize::MAX >> 1, u.text_x);
                u.menu.insertItem_atIndex(&slot.item, 1);
                Some(slot.item)
            });
            again(item)
        }
        (Some(w), Some(s)) => {
            let ready = native_fields(&w).iter().any(|f| f.downcast_ref::<NSTextField>().is_some_and(|f| f.stringValue().to_string().contains('\t')));
            if !ready && n < 100 {
                return again(Some(s));
            }
            let v = probe_measure(&w, drop, shots.as_deref(), Some(s));
            *out.lock().unwrap() = Some(v);
            menu.cancelTrackingWithoutAnimation();
        }
        (None, s) if n < 100 => again(s),
        (None, _) => menu.cancelTrackingWithoutAnimation(),
    }
}

/// Opens the item's own menu (never shown: its window is at alpha 0 from its first turn, and it closes again within
/// a few turns) at a location `drop` points below the main screen's menu bar, as AppKit did for the person, and
/// measures it: where it sits before and after [`place`], after a relayout and an update in place; the native rows'
/// and the views' text x and figure edges; the views' colours; a row drawn offscreen in light and dark (PNGs into
/// `shots`).
pub fn probe(drop: f64, shots: Option<String>) -> Result<serde_json::Value, String> {
    let mtm = MainThreadMarker::new().ok_or("not the main thread")?;
    let menu = UI.with(|u| u.borrow().as_ref().map(|u| u.menu.clone())).ok_or("no item")?;
    let screen = NSScreen::mainScreen(mtm).ok_or("no screen")?;
    let bar_bottom = top(screen.frame()) - bar_height(&screen);
    UI.with(|u| {
        if let Some(u) = u.borrow_mut().as_mut() {
            u.probing = true;
            u.geometry = None;
        }
    });
    let out = std::sync::Arc::new(std::sync::Mutex::new(None));
    let o = out.clone();
    let s = shots.clone();
    on_main(move || probe_tick(0, drop, s, o, None));
    // The window's top lands 5 pt above the location (measured): this puts it `drop` below the bar.
    let at = NSPoint::new(screen.visibleFrame().origin.x + 40.0, bar_bottom - drop - 5.0);
    menu.popUpMenuPositioningItem_atLocation_inView(None, at, None);
    UI.with(|u| {
        if let Some(u) = u.borrow_mut().as_mut() {
            u.probing = false;
        }
    });
    let v = out.lock().unwrap().take().ok_or("the menu didn't open")?;
    Ok(v)
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

/// [`on_main`] after `ms` milliseconds.
fn on_main_later(ms: u64, f: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        on_main(f);
    });
}

/// Status-bar windows (layer 25) this process has on screen, as the window server lists them (no Screen Recording
/// needed: only numbers are read). A hidden item has none.
pub fn bar_windows() -> usize {
    windows(25, Some(std::process::id() as i64)).len()
}

/// On-screen windows at `layer` (of process `pid`, or anyone's) as x, y, width, height in the window server's
/// coordinates (y down from the top of the main screen). Only numbers are read: no Screen Recording needed.
fn windows(layer: i64, pid: Option<i64>) -> Vec<[f64; 4]> {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    // SAFETY: the copied array is toll-free bridged to NSArray, read, then released.
    unsafe {
        let arr = CGWindowListCopyWindowInfo(1 /* kCGWindowListOptionOnScreenOnly */, 0);
        if arr.is_null() {
            return Vec::new();
        }
        let a = &*(arr as *const NSArray<NSDictionary<NSString, AnyObject>>);
        let num = |d: &NSDictionary<NSString, AnyObject>, k: &str| d.objectForKey(&NSString::from_str(k)).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.as_f64());
        let out = a
            .iter()
            .filter(|d| num(d, "kCGWindowLayer") == Some(layer as f64) && pid.is_none_or(|p| num(d, "kCGWindowOwnerPID") == Some(p as f64)))
            .filter_map(|d| {
                let b = d.objectForKey(&NSString::from_str("kCGWindowBounds"))?;
                let b = &*(Retained::as_ptr(&b) as *const NSDictionary<NSString, AnyObject>);
                Some([num(b, "X")?, num(b, "Y")?, num(b, "Width")?, num(b, "Height")?])
            })
            .collect();
        CFRelease(arr);
        out
    }
}
