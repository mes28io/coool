//! macOS media helpers for the Media feature (see `super`): video facts and frames (AVFoundation), image thumbnails
//! (ImageIO), and file URLs on the pasteboard (AppKit). Everything here is synchronous and may be slow: call it off
//! the main thread (Tauri `async` commands, the media scheme's worker thread).

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VideoInfo {
    /// Seconds.
    pub duration: f64,
    /// Display size in pixels (the video track's natural size with its preferred transform applied); 0 for audio only.
    pub width: u32,
    pub height: u32,
    /// Whether it has a video track (an .m4a has none).
    pub has_video: bool,
}

/// What AVFoundation says about a movie or audio file; None when it can't be opened as one.
pub fn video_info(path: &Path) -> Option<VideoInfo> {
    #[cfg(target_os = "macos")]
    return mac::guard(|| mac::video_info(path)).flatten();
    #[cfg(not(target_os = "macos"))]
    return { let _ = path; None };
}

/// Frames at `times` (seconds), each scaled so its longest edge is at most `max_edge` px (aspect kept, rotation
/// applied), as JPEG at `quality` (0..1). `exact`: zero time tolerance (slower, accurate); else the nearest
/// keyframe is fine. Returns (the frame's actual time, JPEG bytes) for each time that could be decoded, in order.
pub fn frames_at(path: &Path, times: &[f64], max_edge: u32, quality: f64, exact: bool) -> Vec<(f64, Vec<u8>)> {
    #[cfg(target_os = "macos")]
    return mac::guard(|| mac::frames(path, times, max_edge.max(1), exact, |img| mac::jpeg(img, quality))).unwrap_or_default();
    #[cfg(not(target_os = "macos"))]
    return { let _ = (path, times, max_edge, quality, exact); Vec::new() };
}

/// Tiny grayscale signatures of the frames at `times` (16 x 9 luma bytes, row-major, 144 per frame) for scene-change
/// detection: (actual time, bytes) per decodable time, in order. Fast (small maximum size, keyframe tolerance).
pub fn signatures(path: &Path, times: &[f64]) -> Vec<(f64, Vec<u8>)> {
    #[cfg(target_os = "macos")]
    return mac::guard(|| mac::frames(path, times, 64, false, mac::gray16x9)).unwrap_or_default();
    #[cfg(not(target_os = "macos"))]
    return { let _ = (path, times); Vec::new() };
}

/// A JPEG thumbnail (longest edge at most `max_edge`) of an image file ImageIO reads (PNG, JPEG, GIF's first frame,
/// WebP, HEIC, TIFF, BMP), with its EXIF orientation applied. None if it isn't an image ImageIO reads.
pub fn image_thumb(path: &Path, max_edge: u32) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    return mac::guard(|| mac::image_thumb(path, max_edge.max(1))).flatten();
    #[cfg(not(target_os = "macos"))]
    return { let _ = (path, max_edge); None };
}

/// Puts these files on the general pasteboard as file URLs (what Finder's Copy does), so Paste in Finder or another
/// app pastes the files. True on success. Must work from any thread (dispatches to the main thread if AppKit needs it).
pub fn copy_files(paths: &[PathBuf]) -> bool {
    #[cfg(target_os = "macos")]
    return mac::guard(|| mac::copy_files(None, paths)).unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    return { let _ = paths; false };
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use super::VideoInfo;
    use objc2_foundation::{NSArray, NSSize, NSString, NSURL};
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};

    type Ref = *const c_void;

    /// CoreMedia's CMTime.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CMTime {
        value: i64,
        timescale: i32,
        flags: u32,
        epoch: i64,
    }
    unsafe impl Encode for CMTime {
        const ENCODING: Encoding = Encoding::Struct("?", &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING]);
    }
    unsafe impl RefEncode for CMTime {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Affine {
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        tx: f64,
        ty: f64,
    }
    unsafe impl Encode for Affine {
        const ENCODING: Encoding = Encoding::Struct("CGAffineTransform", &[f64::ENCODING; 6]);
    }

    /// An opaque CGImage, so `copyCGImageAtTime:` returns a pointer of the right encoding.
    #[repr(C)]
    pub struct CGImage {
        _p: [u8; 0],
    }
    unsafe impl RefEncode for CGImage {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGImage", &[]));
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
        static kCFBooleanTrue: Ref;
        fn CFDictionaryCreate(a: Ref, keys: *const Ref, values: *const Ref, n: isize, kcb: Ref, vcb: Ref) -> Ref;
        fn CFNumberCreate(a: Ref, ty: isize, v: *const c_void) -> Ref;
        fn CFDataCreateMutable(a: Ref, cap: isize) -> Ref;
        fn CFDataGetLength(d: Ref) -> isize;
        fn CFDataGetBytePtr(d: Ref) -> *const u8;
        fn CFStringCreateWithCString(a: Ref, s: *const std::ffi::c_char, enc: u32) -> Ref;
        fn CFRelease(r: Ref);
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGColorSpaceCreateDeviceGray() -> Ref;
        fn CGColorSpaceRelease(c: Ref);
        fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, cs: Ref, info: u32) -> Ref;
        fn CGContextSetInterpolationQuality(c: Ref, q: i32);
        fn CGContextDrawImage(c: Ref, r: Rect, img: *const CGImage);
        fn CGContextRelease(c: Ref);
        fn CGImageRelease(i: Ref);
    }
    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        static kCGImageDestinationLossyCompressionQuality: Ref;
        static kCGImageSourceCreateThumbnailFromImageAlways: Ref;
        static kCGImageSourceThumbnailMaxPixelSize: Ref;
        static kCGImageSourceCreateThumbnailWithTransform: Ref;
        fn CGImageSourceCreateWithURL(url: Ref, opts: Ref) -> Ref;
        fn CGImageSourceGetCount(src: Ref) -> usize;
        fn CGImageSourceCreateThumbnailAtIndex(src: Ref, i: usize, opts: Ref) -> *const CGImage;
        fn CGImageDestinationCreateWithData(d: Ref, ty: Ref, count: usize, opts: Ref) -> Ref;
        fn CGImageDestinationAddImage(dst: Ref, img: Ref, props: Ref);
        fn CGImageDestinationFinalize(dst: Ref) -> bool;
    }
    #[link(name = "CoreMedia", kind = "framework")]
    unsafe extern "C" {
        static kCMTimeZero: CMTime;
        fn CMTimeMakeWithSeconds(s: f64, timescale: i32) -> CMTime;
        fn CMTimeGetSeconds(t: CMTime) -> f64;
    }
    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeVideo: &'static NSString;
    }
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    const UTF8: u32 = 0x0800_0100;
    const CF_NUMBER_F64: isize = 13;
    const CF_NUMBER_I64: isize = 4;

    /// Runs `f` with Objective-C exceptions caught (None instead of an abort), inside an autorelease pool.
    pub fn guard<R>(f: impl FnOnce() -> R) -> Option<R> {
        autoreleasepool(|_| objc2::exception::catch(std::panic::AssertUnwindSafe(f)).ok())
    }

    fn url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn asset(path: &Path) -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"AVURLAsset")?;
        let url = url(path);
        let none: *const AnyObject = std::ptr::null();
        unsafe { msg_send![cls, URLAssetWithURL: &*url, options: none] }
    }

    pub fn video_info(path: &Path) -> Option<VideoInfo> {
        let asset = asset(path)?;
        unsafe {
            let tracks: Retained<NSArray<AnyObject>> = msg_send![&asset, tracks];
            if tracks.count() == 0 {
                return None;
            }
            let duration = CMTimeGetSeconds(msg_send![&asset, duration]);
            if !duration.is_finite() || duration < 0.0 {
                return None;
            }
            let video: Retained<NSArray<AnyObject>> = msg_send![&asset, tracksWithMediaType: AVMediaTypeVideo];
            let (mut width, mut height) = (0, 0);
            if let Some(t) = video.firstObject() {
                let s: NSSize = msg_send![&t, naturalSize];
                let m: Affine = msg_send![&t, preferredTransform];
                width = (s.width * m.a + s.height * m.c).abs().round() as u32;
                height = (s.width * m.b + s.height * m.d).abs().round() as u32;
            }
            Some(VideoInfo { duration, width, height, has_video: video.count() > 0 })
        }
    }

    /// Decodes the frame nearest each time (within `max_edge`) and maps it with `each`; skips what fails.
    pub fn frames(path: &Path, times: &[f64], max_edge: u32, exact: bool, each: impl Fn(*const CGImage) -> Option<Vec<u8>>) -> Vec<(f64, Vec<u8>)> {
        let mut out = Vec::new();
        let Some(asset) = asset(path) else { return out };
        let Some(cls) = AnyClass::get(c"AVAssetImageGenerator") else { return out };
        unsafe {
            let Some(r#gen): Option<Retained<AnyObject>> = msg_send![cls, assetImageGeneratorWithAsset: &*asset] else { return out };
            let _: () = msg_send![&r#gen, setAppliesPreferredTrackTransform: true];
            let edge = max_edge as f64;
            let _: () = msg_send![&r#gen, setMaximumSize: NSSize::new(edge, edge)];
            if exact {
                let _: () = msg_send![&r#gen, setRequestedTimeToleranceBefore: kCMTimeZero];
                let _: () = msg_send![&r#gen, setRequestedTimeToleranceAfter: kCMTimeZero];
            }
            for &t in times {
                autoreleasepool(|_| {
                    let mut actual = kCMTimeZero;
                    let err: *mut *mut AnyObject = std::ptr::null_mut();
                    let at = CMTimeMakeWithSeconds(t.max(0.0), 600);
                    let img: *const CGImage = msg_send![&r#gen, copyCGImageAtTime: at, actualTime: &mut actual as *mut CMTime, error: err];
                    if img.is_null() {
                        return;
                    }
                    if let Some(bytes) = each(img) {
                        out.push((CMTimeGetSeconds(actual), bytes));
                    }
                    CGImageRelease(img as Ref);
                });
            }
        }
        out
    }

    /// A CFDictionary of these keys and (retained, then released here) values.
    unsafe fn dict(pairs: &[(Ref, Ref)]) -> Ref {
        let keys: Vec<Ref> = pairs.iter().map(|p| p.0).collect();
        let vals: Vec<Ref> = pairs.iter().map(|p| p.1).collect();
        unsafe {
            CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                vals.as_ptr(),
                pairs.len() as isize,
                &kCFTypeDictionaryKeyCallBacks as *const u8 as Ref,
                &kCFTypeDictionaryValueCallBacks as *const u8 as Ref,
            )
        }
    }

    /// The image as JPEG at `quality` (0..1).
    pub fn jpeg(img: *const CGImage, quality: f64) -> Option<Vec<u8>> {
        unsafe {
            let q = quality.clamp(0.0, 1.0);
            let num = CFNumberCreate(std::ptr::null(), CF_NUMBER_F64, &q as *const f64 as *const c_void);
            let opts = dict(&[(kCGImageDestinationLossyCompressionQuality, num)]);
            CFRelease(num);
            let out = CFDataCreateMutable(std::ptr::null(), 0);
            let ty = CFStringCreateWithCString(std::ptr::null(), c"public.jpeg".as_ptr(), UTF8);
            let dst = CGImageDestinationCreateWithData(out, ty, 1, std::ptr::null());
            let mut bytes = None;
            if !dst.is_null() {
                CGImageDestinationAddImage(dst, img as Ref, opts);
                if CGImageDestinationFinalize(dst) {
                    let n = CFDataGetLength(out) as usize;
                    bytes = Some(std::slice::from_raw_parts(CFDataGetBytePtr(out), n).to_vec());
                }
                CFRelease(dst);
            }
            CFRelease(ty);
            CFRelease(out);
            CFRelease(opts);
            bytes
        }
    }

    /// The image squeezed into 16 x 9 gray bytes (top row first).
    pub fn gray16x9(img: *const CGImage) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; 16 * 9];
        unsafe {
            let cs = CGColorSpaceCreateDeviceGray();
            // kCGImageAlphaNone
            let ctx = CGBitmapContextCreate(buf.as_mut_ptr() as *mut c_void, 16, 9, 8, 16, cs, 0);
            CGColorSpaceRelease(cs);
            if ctx.is_null() {
                return None;
            }
            CGContextSetInterpolationQuality(ctx, 3);
            CGContextDrawImage(ctx, Rect { x: 0.0, y: 0.0, w: 16.0, h: 9.0 }, img);
            CGContextRelease(ctx);
        }
        Some(buf)
    }

    pub fn image_thumb(path: &Path, max_edge: u32) -> Option<Vec<u8>> {
        let url = url(path);
        unsafe {
            let src = CGImageSourceCreateWithURL(Retained::as_ptr(&url) as Ref, std::ptr::null());
            if src.is_null() {
                return None;
            }
            let mut out = None;
            if CGImageSourceGetCount(src) > 0 {
                let edge = max_edge as i64;
                let num = CFNumberCreate(std::ptr::null(), CF_NUMBER_I64, &edge as *const i64 as *const c_void);
                let opts = dict(&[
                    (kCGImageSourceCreateThumbnailFromImageAlways, kCFBooleanTrue),
                    (kCGImageSourceThumbnailMaxPixelSize, num),
                    (kCGImageSourceCreateThumbnailWithTransform, kCFBooleanTrue),
                ]);
                CFRelease(num);
                let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts);
                CFRelease(opts);
                if !img.is_null() {
                    out = jpeg(img, 0.8);
                    CGImageRelease(img as Ref);
                }
            }
            CFRelease(src);
            out
        }
    }

    /// Writes file URLs to `pb`, or the general pasteboard when None. NSPasteboard is safe to use off the main thread.
    pub fn copy_files(pb: Option<&AnyObject>, paths: &[PathBuf]) -> bool {
        if paths.is_empty() {
            return false;
        }
        let Some(cls) = AnyClass::get(c"NSPasteboard") else { return false };
        let general: Option<Retained<AnyObject>>;
        let pb = match pb {
            Some(p) => p,
            None => {
                general = unsafe { msg_send![cls, generalPasteboard] };
                match general.as_deref() {
                    Some(p) => p,
                    None => return false,
                }
            }
        };
        let urls: Vec<Retained<NSURL>> = paths.iter().map(|p| url(p)).collect();
        let arr = NSArray::from_retained_slice(&urls);
        unsafe {
            let _: isize = msg_send![pb, clearContents];
            msg_send![pb, writeObjects: &*arr]
        }
    }

    #[cfg(test)]
    pub mod testing {
        use super::*;

        /// A private pasteboard, its file URLs after `copy_files`, then released.
        pub fn copy_to_private(paths: &[PathBuf]) -> (bool, Vec<String>) {
            super::guard(|| unsafe {
                let cls = AnyClass::get(c"NSPasteboard").unwrap();
                let pb: Retained<AnyObject> = msg_send![cls, pasteboardWithUniqueName];
                let ok = copy_files(Some(&pb), paths);
                let items: Option<Retained<NSArray<AnyObject>>> = msg_send![&pb, pasteboardItems];
                let ty = NSString::from_str("public.file-url");
                let mut got = Vec::new();
                for item in items.iter().flat_map(|a| a.to_vec()) {
                    let s: Option<Retained<NSString>> = msg_send![&item, stringForType: &*ty];
                    got.extend(s.map(|s| s.to_string()));
                }
                let _: () = msg_send![&pb, releaseGlobally];
                (ok, got)
            })
            .unwrap()
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::Command;

    const SWIFT: &str = r#"
import AVFoundation
import CoreVideo
let url = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: url)
let w = try! AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 240])
let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 240])
w.add(input)
w.startWriting()
w.startSession(atSourceTime: .zero)
for i in 0..<40 {
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, ad.pixelBufferPool!, &pb)
    CVPixelBufferLockBaseAddress(pb!, [])
    let p = CVPixelBufferGetBaseAddress(pb!)!.assumingMemoryBound(to: UInt8.self)
    let rb = CVPixelBufferGetBytesPerRow(pb!)
    for y in 0..<240 { for x in 0..<320 { let o = y * rb + x * 4
        if i < 20 { p[o] = 0; p[o+1] = 0; p[o+2] = 255 } else { p[o] = 255; p[o+1] = 0; p[o+2] = 0 }
        p[o+3] = 255 } }
    CVPixelBufferUnlockBaseAddress(pb!, [])
    ad.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 10))
}
input.markAsFinished()
w.endSession(atSourceTime: CMTime(value: 40, timescale: 10))
let sem = DispatchSemaphore(value: 0)
w.finishWriting { sem.signal() }
sem.wait()
if w.status != .completed { print(w.error!); exit(1) }
"#;

    fn run(cmd: &str, args: &[&str]) -> bool {
        Command::new(cmd).args(args).output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn dir(name: &str) -> PathBuf {
        let d = PathBuf::from(format!("/private/tmp/coool-media-native-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn jpeg_size(b: &[u8]) -> (u32, u32) {
        // Walk the JPEG markers to the first SOFn.
        let mut i = 2;
        while i + 9 < b.len() {
            let m = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
                return (u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32, u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32);
            }
            i += 2 + len;
        }
        (0, 0)
    }

    #[test]
    fn video_and_audio() {
        let d = dir("av");
        let (swift, mp4) = (d.join("make.swift"), d.join("clip.mp4"));
        std::fs::write(&swift, SWIFT).unwrap();
        if !run("/usr/bin/swift", &[swift.to_str().unwrap(), mp4.to_str().unwrap()]) {
            println!("skipped: /usr/bin/swift could not make the test movie");
            return;
        }
        let info = video_info(&mp4).expect("video info");
        assert!((info.duration - 4.0).abs() < 0.2, "{info:?}");
        assert_eq!((info.width, info.height, info.has_video), (320, 240, true));

        let frames = frames_at(&mp4, &[0.5, 3.0], 160, 0.7, true);
        assert_eq!(frames.len(), 2);
        for (t, j) in &frames {
            assert_eq!(&j[..3], &[0xFF, 0xD8, 0xFF]);
            let (w, h) = jpeg_size(j);
            assert!(w.max(h) <= 160 && w > 0, "{t}: {w}x{h}");
        }
        assert!((frames[0].0 - 0.5).abs() < 0.11 && (frames[1].0 - 3.0).abs() < 0.11);
        assert_eq!(frames_at(&mp4, &[1.0], 160, 0.7, false).len(), 1);

        let sigs = signatures(&mp4, &[0.5, 3.0]);
        assert_eq!(sigs.len(), 2);
        assert!(sigs.iter().all(|s| s.1.len() == 144));
        let diff = sigs[0].1.iter().zip(&sigs[1].1).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / 144.0;
        assert!(diff > 20.0, "mean diff {diff}");

        let (aiff, m4a) = (d.join("v.aiff"), d.join("v.m4a"));
        if run("/usr/bin/say", &["-o", aiff.to_str().unwrap(), "test one two three"])
            && run("/usr/bin/afconvert", &["-f", "m4af", "-d", "aac", aiff.to_str().unwrap(), m4a.to_str().unwrap()])
        {
            let a = video_info(&m4a).expect("audio info");
            assert!(!a.has_video && a.width == 0 && a.height == 0 && a.duration > 0.0, "{a:?}");
            assert!(frames_at(&m4a, &[0.1], 100, 0.7, false).is_empty());
        } else {
            println!("skipped audio: say/afconvert unavailable");
        }
        assert!(video_info(&swift).is_none());
        assert!(video_info(&d.join("missing.mp4")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn thumbs_and_pasteboard() {
        let d = dir("img");
        let (seed, png) = (d.join("seed.tiff"), d.join("pic.png"));
        // A 400x200 image: a tiny hand-made TIFF, scaled up and converted to PNG with sips.
        let mut tiff = vec![0x49, 0x49, 42, 0, 8, 0, 0, 0];
        let entries: [(u16, u16, u32); 8] =
            [(256, 3, 2), (257, 3, 1), (258, 3, 8), (262, 3, 1), (273, 4, 110), (277, 3, 1), (278, 3, 1), (279, 4, 2)];
        tiff.extend((entries.len() as u16).to_le_bytes());
        for (tag, ty, v) in entries {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(ty.to_le_bytes());
            tiff.extend(1u32.to_le_bytes());
            tiff.extend(v.to_le_bytes());
        }
        tiff.extend(0u32.to_le_bytes());
        tiff.resize(110, 0);
        tiff.extend([20, 220]);
        std::fs::write(&seed, &tiff).unwrap();
        if !run("/usr/bin/sips", &["-s", "format", "png", "-z", "200", "400", seed.to_str().unwrap(), "--out", png.to_str().unwrap()]) {
            println!("skipped: sips unavailable");
            return;
        }
        let j = image_thumb(&png, 100).expect("thumb");
        assert_eq!(&j[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!(jpeg_size(&j), (100, 50));
        let note = d.join("note.txt");
        std::fs::write(&note, "not an image").unwrap();
        assert!(image_thumb(&note, 100).is_none());

        // Off the main thread (test threads aren't main), against a private pasteboard, never the user's.
        let (ok, urls) = std::thread::spawn(move || mac::testing::copy_to_private(&[png, note])).join().unwrap();
        assert!(ok);
        assert_eq!(urls.len(), 2, "{urls:?}");
        assert!(urls[0].starts_with("file:///") && urls[0].ends_with("pic.png"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
