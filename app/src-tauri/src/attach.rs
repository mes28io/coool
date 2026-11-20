//! Chat attachments (images and files in the composer, and their previews): the app's commands around
//! `coool_core::attach`.
//!
//! What may be read:
//! - `attach_paths` / `attach_bytes`: files the person dropped, picked or pasted (their choice).
//! - `attach_image`: an image by key, only from coool's own store, or from the transcript of the named session
//!   (found through the hub, never a path the page gives).
//! - `attach_preview`: a file the person clicked (a file chip, or an image path an agent mentioned). Text comes back as
//!   text, an image or a PDF as a `data:` URL; nothing is run, and the page shows it without loading anything else.
//!   `images_only` (paths taken from what an agent wrote) refuses anything but PNG / JPEG / GIF / WebP.
//! - `attach_reveal`: shows a file in Finder (`open -R`), never opens it.

use crate::{Core, Res, err};
use coool_core::attach::{self, Attachment, Preview};
use coool_core::model::Provider;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

fn store() -> Res<PathBuf> {
    attach::store_dir().ok_or_else(|| "no folder for attachments".to_string())
}

/// One dropped or picked path: the attachment, or why it can't be added.
#[derive(Serialize)]
pub struct Added {
    pub path: String,
    pub name: String,
    pub attachment: Option<Attachment>,
    pub error: Option<String>,
}

#[tauri::command(async)]
pub fn attach_paths(paths: Vec<String>) -> Res<Vec<Added>> {
    let dir = store()?;
    Ok(paths
        .into_iter()
        .take(attach::MAX_COUNT * 4)
        .map(|p| {
            let path = PathBuf::from(&p);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
            match attach::inspect_path(&dir, &path) {
                Ok(a) => Added { path: p, name, attachment: Some(a), error: None },
                Err(e) => Added { path: p, name, attachment: None, error: Some(format!("{e:#}")) },
            }
        })
        .collect())
}

/// Pasted content (base64): a clipboard image, or a file the page only got as bytes.
#[tauri::command(async)]
pub fn attach_bytes(name: String, data: String) -> Res<Attachment> {
    use base64::Engine;
    if data.len() as u64 > attach::MAX_STORED_BYTES / 3 * 4 + 16 {
        return Err(format!("too large: pasted files can be up to {} MB", attach::MAX_STORED_BYTES / 1024 / 1024));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "couldn't read the pasted data".to_string())?;
    attach::store_bytes(&store()?, &name, &bytes).map_err(|e| format!("{e:#}"))
}

/// An image by key as a `data:` URL: from coool's store, else from that session's transcript.
#[tauri::command(async)]
pub fn attach_image(core: State<'_, Arc<Core>>, key: String, provider: Option<Provider>, session: Option<String>) -> Res<String> {
    use base64::Engine;
    if !attach::valid_key(&key) {
        return Err("not an image key".into());
    }
    let dir = store()?;
    let found = attach::stored(&dir, &key).or_else(|| {
        let (p, s) = (provider?, session?);
        let t = core.hub.lock().unwrap().transcript_path(p, &s, None)?;
        attach::image_from_transcript(&dir, &t, &key)
    });
    let (p, mime) = found.ok_or("the image isn't available any more")?;
    let b = std::fs::read(p).map_err(err)?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(p),
    }
}

/// A preview of a file the person clicked (see the module comment). `images_only` (a path an agent wrote) needs
/// `root`, the chat's folder: the file must resolve inside it (symlinks followed first) and be a real image.
/// A PDF comes back as its first pages drawn to PNG here (Quartz): the page never loads the PDF itself.
#[tauri::command(async)]
pub fn attach_preview(path: String, images_only: Option<bool>, root: Option<String>) -> Res<Preview> {
    let p = expand(&path);
    if !p.is_absolute() {
        return Err("not a full path".into());
    }
    if images_only.unwrap_or(false) {
        let root = root.filter(|r| !r.is_empty()).ok_or("no chat folder to check the path against")?;
        return attach::preview_image_within(&p, &expand(&root)).map_err(|e| format!("{e:#}"));
    }
    match attach::preview(&p, false).map_err(|e| format!("{e:#}"))? {
        Preview::Pdf { size, .. } => Ok(match pdf::pages(&p, PDF_PAGES, 1400.0) {
            Some((pages, count)) if !pages.is_empty() => Preview::Pdf { pages, count, size },
            _ => Preview::Other { size, mime: "application/pdf".into(), reason: "this PDF couldn't be drawn".into() },
        }),
        other => Ok(other),
    }
}

/// Pages of a PDF drawn for the preview.
const PDF_PAGES: usize = 12;

/// PDF pages to PNG with Quartz (CoreGraphics + ImageIO): the PDF is parsed and drawn, nothing in it runs (Quartz
/// has no scripting) and nothing is fetched.
#[cfg(target_os = "macos")]
mod pdf {
    use base64::Engine;
    use std::ffi::c_void;
    use std::path::Path;

    type Ref = *const c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        o: Point,
        s: Size,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataCreate(a: Ref, bytes: *const u8, len: isize) -> Ref;
        fn CFDataCreateMutable(a: Ref, cap: isize) -> Ref;
        fn CFDataGetLength(d: Ref) -> isize;
        fn CFDataGetBytePtr(d: Ref) -> *const u8;
        fn CFStringCreateWithCString(a: Ref, s: *const std::ffi::c_char, enc: u32) -> Ref;
        fn CFRelease(r: Ref);
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDataProviderCreateWithCFData(d: Ref) -> Ref;
        fn CGDataProviderRelease(p: Ref);
        fn CGPDFDocumentCreateWithProvider(p: Ref) -> Ref;
        fn CGPDFDocumentRelease(d: Ref);
        fn CGPDFDocumentIsEncrypted(d: Ref) -> bool;
        fn CGPDFDocumentIsUnlocked(d: Ref) -> bool;
        fn CGPDFDocumentGetNumberOfPages(d: Ref) -> usize;
        fn CGPDFDocumentGetPage(d: Ref, n: usize) -> Ref;
        fn CGPDFPageGetBoxRect(p: Ref, b: i32) -> Rect;
        fn CGColorSpaceCreateDeviceRGB() -> Ref;
        fn CGColorSpaceRelease(c: Ref);
        fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, cs: Ref, info: u32) -> Ref;
        fn CGBitmapContextCreateImage(c: Ref) -> Ref;
        fn CGContextRelease(c: Ref);
        fn CGContextSetRGBFillColor(c: Ref, r: f64, g: f64, b: f64, a: f64);
        fn CGContextFillRect(c: Ref, r: Rect);
        fn CGContextScaleCTM(c: Ref, sx: f64, sy: f64);
        fn CGContextTranslateCTM(c: Ref, tx: f64, ty: f64);
        fn CGContextDrawPDFPage(c: Ref, p: Ref);
        fn CGImageRelease(i: Ref);
    }
    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageDestinationCreateWithData(d: Ref, ty: Ref, count: usize, opts: Ref) -> Ref;
        fn CGImageDestinationAddImage(dst: Ref, img: Ref, props: Ref);
        fn CGImageDestinationFinalize(dst: Ref) -> bool;
    }

    const CROP_BOX: i32 = 1;
    /// kCGImageAlphaPremultipliedLast
    const RGBA: u32 = 1;
    const UTF8: u32 = 0x0800_0100;

    /// The first `max` pages, each `width` pixels wide at most, as PNG data URLs; and the page count.
    pub fn pages(path: &Path, max: usize, width: f64) -> Option<(Vec<String>, usize)> {
        let bytes = std::fs::read(path).ok()?;
        // SAFETY: plain CoreFoundation / CoreGraphics calls; every object created here is released here.
        unsafe {
            let data = CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize);
            if data.is_null() {
                return None;
            }
            let prov = CGDataProviderCreateWithCFData(data);
            let doc = if prov.is_null() { std::ptr::null() } else { CGPDFDocumentCreateWithProvider(prov) };
            let mut out = Vec::new();
            let mut count = 0;
            if !doc.is_null() && (!CGPDFDocumentIsEncrypted(doc) || CGPDFDocumentIsUnlocked(doc)) {
                count = CGPDFDocumentGetNumberOfPages(doc);
                for n in 1..=count.min(max) {
                    let page = CGPDFDocumentGetPage(doc, n);
                    if page.is_null() {
                        break;
                    }
                    match draw(page, width) {
                        Some(png) => out.push(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))),
                        None => break,
                    }
                }
            }
            if !doc.is_null() {
                CGPDFDocumentRelease(doc);
            }
            if !prov.is_null() {
                CGDataProviderRelease(prov);
            }
            CFRelease(data);
            Some((out, count))
        }
    }

    unsafe fn draw(page: Ref, width: f64) -> Option<Vec<u8>> {
        unsafe {
            let r = CGPDFPageGetBoxRect(page, CROP_BOX);
            if r.s.w <= 0.0 || r.s.h <= 0.0 {
                return None;
            }
            let scale = (width / r.s.w).min(4.0);
            let (w, h) = ((r.s.w * scale).round() as usize, (r.s.h * scale).round() as usize);
            if w == 0 || h == 0 || w * h > 40_000_000 {
                return None;
            }
            let cs = CGColorSpaceCreateDeviceRGB();
            let ctx = CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, cs, RGBA);
            CGColorSpaceRelease(cs);
            if ctx.is_null() {
                return None;
            }
            CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
            CGContextFillRect(ctx, Rect { o: Point { x: 0.0, y: 0.0 }, s: Size { w: w as f64, h: h as f64 } });
            CGContextScaleCTM(ctx, scale, scale);
            CGContextTranslateCTM(ctx, -r.o.x, -r.o.y);
            CGContextDrawPDFPage(ctx, page);
            let img = CGBitmapContextCreateImage(ctx);
            CGContextRelease(ctx);
            if img.is_null() {
                return None;
            }
            let out = CFDataCreateMutable(std::ptr::null(), 0);
            let ty = CFStringCreateWithCString(std::ptr::null(), c"public.png".as_ptr(), UTF8);
            let dst = CGImageDestinationCreateWithData(out, ty, 1, std::ptr::null());
            let mut png = None;
            if !dst.is_null() {
                CGImageDestinationAddImage(dst, img, std::ptr::null());
                if CGImageDestinationFinalize(dst) {
                    let n = CFDataGetLength(out) as usize;
                    png = Some(std::slice::from_raw_parts(CFDataGetBytePtr(out), n).to_vec());
                }
                CFRelease(dst);
            }
            CFRelease(ty);
            CFRelease(out);
            CGImageRelease(img);
            png
        }
    }

    #[cfg(test)]
    mod tests {
        /// A hand-made one-page PDF draws to a PNG that isn't blank.
        #[test]
        fn draws_a_page() {
            let content = "BT /F1 48 Tf 40 700 Td (Hello PDF) Tj ET 0 0 1 rg 40 400 300 200 re f";
            let objs = [
                "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
                format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            ];
            let mut pdf = String::from("%PDF-1.4\n");
            let mut offs = Vec::new();
            for (i, o) in objs.iter().enumerate() {
                offs.push(pdf.len());
                pdf.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1));
            }
            let x = pdf.len();
            pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1));
            for o in offs {
                pdf.push_str(&format!("{o:010} 00000 n \n"));
            }
            pdf.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF", objs.len() + 1));
            let p = std::env::temp_dir().join(format!("coool-pdf-test-{}.pdf", std::process::id()));
            std::fs::write(&p, pdf).unwrap();
            let (pages, count) = super::pages(&p, 5, 600.0).unwrap();
            assert_eq!((pages.len(), count), (1, 1));
            assert!(pages[0].starts_with("data:image/png;base64,") && pages[0].len() > 2000);
            // Not a PDF: nothing drawn, no crash.
            std::fs::write(&p, "not a pdf").unwrap();
            assert_eq!(super::pages(&p, 5, 600.0).map(|x| x.0.len()), Some(0));
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod pdf {
    pub fn pages(_: &std::path::Path, _: usize, _: f64) -> Option<(Vec<String>, usize)> {
        None
    }
}

/// Shows a file in Finder.
#[tauri::command(async)]
pub fn attach_reveal(path: String) -> Res<()> {
    let p = expand(&path);
    if !p.is_absolute() || !Path::new(&p).exists() {
        return Err("the file is gone (moved or deleted?)".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).status().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod picker_tests {
    /// The attach button's picker in a packaged app: the dialog plugin is registered, and the main window's
    /// webview's capability grants its `open` (the plugin's `default` set includes `allow-open`).
    #[test]
    fn the_file_picker_is_registered_and_allowed() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains(".plugin(tauri_plugin_dialog::init())"));
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(cap["webviews"].as_array().unwrap().iter().any(|w| w == "main"));
        let perms: Vec<&str> = cap["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(perms.iter().any(|p| *p == "dialog:default" || *p == "dialog:allow-open"), "{perms:?}");
    }
}
