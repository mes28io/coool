//! Motion footage of the real window for the launch film (`COOOL_SELFTEST=film`, app/scripts/readme-shots/film.sh).
//!
//! A burst is a run of window-alone stills (`screencapture -l<window id>`, the same capture as `selftest_shot`, so
//! nothing else on the screen can end up in it and no new permission is asked for) taken back to back by a few
//! workers at once, each still named after the moment its capture started (ms since the burst began). film.sh turns
//! a burst into constant-rate video afterwards, each output frame showing the latest still taken by then.
//!
//! `selftest_film` with `action`:
//! - `start` (`name`, optional `workers`, else `COOOL_FILM_WORKERS`, else 3, and `format`, default `png`): the burst goes to
//!   `<shots>/film-<name>/`; one burst at a time.
//! - `stop`: waits for the workers' last stills and returns `{ name, frames, ms }`.
//! - `visible`: tells WebKit not to treat the off-screen window as hidden (no throttled timers or animations), and
//!   returns `{ slow }`: `COOOL_FILM_SLOW`, how many times slower than real time the scene plays while it is filmed
//!   (the page's animations, the stand-in CLIs and the live workspace all slow down; the assembler speeds it back up),
//!   so a capture slower than 30 stills a second still makes smooth 30 fps video.

use super::{active, keep_visible, no_shots, window_number};
use crate::Core;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

struct Burst {
    name: String,
    stop: Arc<AtomicBool>,
    frames: Arc<AtomicUsize>,
    started: Instant,
    workers: Vec<std::thread::JoinHandle<()>>,
}

static BURST: Mutex<Option<Burst>> = Mutex::new(None);

#[tauri::command(async)]
pub fn selftest_film(app: AppHandle, core: State<'_, Arc<Core>>, action: String, name: Option<String>, workers: Option<usize>, format: Option<String>) -> Result<serde_json::Value, String> {
    let t = active(&core)?;
    match action.as_str() {
        "visible" => {
            if let Some(v) = app.get_webview("main") {
                v.with_webview(|pw| keep_visible(pw.inner())).map_err(|e| e.to_string())?;
            }
            // How many times slower than real time the scene plays while it is filmed (`COOOL_FILM_SLOW`, film.sh).
            let slow = std::env::var("COOOL_FILM_SLOW").ok().and_then(|v| v.parse::<f64>().ok()).filter(|s| *s >= 1.0).unwrap_or(1.0);
            // What slows down: `all` (default: animations and the page's clock) or `animations` (CSS / Web Animations only).
            let dilate = std::env::var("COOOL_FILM_DILATE").unwrap_or_else(|_| "all".into());
            t.log(&format!("FILM slow {slow} {dilate}"));
            Ok(serde_json::json!({ "slow": slow, "dilate": dilate }))
        }
        "start" => {
            if no_shots() {
                return Err("screenshots are off in this run".into());
            }
            let mut slot = BURST.lock().map_err(|e| e.to_string())?;
            if slot.is_some() {
                return Err("a burst is already running".into());
            }
            let name: String = name.unwrap_or_default().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
            if name.is_empty() {
                return Err("a burst needs a name".into());
            }
            let fmt = match format.as_deref().unwrap_or("png") {
                f @ ("png" | "jpg" | "bmp" | "tiff") => f.to_string(),
                f => return Err(format!("format {f}?")),
            };
            let w = app.get_window("main").ok_or("no window")?;
            let wid = window_number(&w).ok_or("no window id")?;
            let dir: PathBuf = t.shots.join(format!("film-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stop = Arc::new(AtomicBool::new(false));
            let frames = Arc::new(AtomicUsize::new(0));
            let started = Instant::now();
            // Unless asked, `COOOL_FILM_WORKERS` (film.sh): the best count depends on the machine and how busy it is.
            let n = workers.or_else(|| std::env::var("COOOL_FILM_WORKERS").ok().and_then(|v| v.parse().ok())).unwrap_or(3).clamp(1, 8);
            let handles = (0..n)
                .map(|k| {
                    let (stop, frames, dir, fmt) = (stop.clone(), frames.clone(), dir.clone(), fmt.clone());
                    std::thread::spawn(move || {
                        // Staggered, so the workers' stills interleave instead of bunching.
                        std::thread::sleep(std::time::Duration::from_millis(40 * k as u64));
                        while !stop.load(Ordering::Relaxed) {
                            let at = started.elapsed().as_millis();
                            let path = dir.join(format!("{at:08}-{k}.{fmt}"));
                            let ok = std::process::Command::new("/usr/sbin/screencapture")
                                .args(["-x", "-o", &format!("-l{wid}"), "-t", &fmt])
                                .arg(&path)
                                .status()
                                .is_ok_and(|s| s.success());
                            if ok {
                                frames.fetch_add(1, Ordering::Relaxed);
                            } else {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                        }
                    })
                })
                .collect();
            t.log(&format!("FILM start {name} ({n} workers, {fmt})"));
            *slot = Some(Burst { name, stop, frames, started, workers: handles });
            Ok(serde_json::json!({}))
        }
        "stop" => {
            let b = BURST.lock().map_err(|e| e.to_string())?.take().ok_or("no burst running")?;
            b.stop.store(true, Ordering::Relaxed);
            let ms = b.started.elapsed().as_millis();
            for h in b.workers {
                let _ = h.join();
            }
            let frames = b.frames.load(Ordering::Relaxed);
            t.log(&format!("FILM stop {} {frames} frames in {ms} ms", b.name));
            Ok(serde_json::json!({ "name": b.name, "frames": frames, "ms": ms }))
        }
        a => Err(format!("action {a}?")),
    }
}
