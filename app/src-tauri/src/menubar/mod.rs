//! coool in the macOS menu bar (Settings > General > Menu bar): while coool runs, an item of its own shows a reading
//! of the Mac (CPU by default) and a mark when a session needs the person; its menu has the Mac's figures (CPU,
//! memory, disk, network, heat, battery, the busiest processes with the agents' ones named by session) and coool's
//! own (sessions working / needing you / done, the ones that need you, plan usage, Open, New session, Quit).
//!
//! A native `NSMenu`, not a popover: it opens under the item on whichever display and beside the notch, closes on an
//! outside click or Esc, never takes the keyboard focus from another app's window, and costs nothing while closed.
//!
//! The item lives and dies with the process (the window server drops it if coool crashes); quitting removes it first.
//! The red close button still quits coool, asking first when agents run (as before the item existed).
//!
//! Sampling ([`model::interval`]): about every 2 s while the bar shows a figure, slower as the person steps away (10 s
//! after a minute idle, 30 s after five), nothing while the display sleeps or the screen is locked, nothing at all of
//! the Mac when the bar shows no figure and the menu is closed. The open menu samples every 2 s, processes included.
//! coool's own counts come from each refresh ([`on_sessions`]), already running.
//!
//! A self-test, or a launch with `COOOL_MENUBAR_HIDDEN=1`, creates the item with its visibility off: real in every
//! way but drawn nowhere. Self-tests only create it at all for the `menubar` scenarios.

pub mod agents;
pub mod model;
pub mod stats;
#[cfg(target_os = "macos")]
mod ui;

use agents::{Agents, ChatIn, ChatRun, Cli, In, Run};
use model::{Mode, Prefs, Reading, Usage};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

struct State {
    prefs: Prefs,
    hidden: bool,
    test: bool,
    /// The item is in the bar (or hidden in it).
    shown: bool,
    open: bool,
    agents: Agents,
    usage: Vec<Usage>,
    reading: Reading,
    /// What the sampler did: samples taken, time spent in them (ns), its current interval (ms, 0: none).
    samples: u64,
    busy_ns: u64,
    interval_ms: u64,
    /// Bumped on every change the sampler should act on.
    seq: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

fn with<T>(f: impl FnOnce(&mut State) -> T) -> Option<T> {
    STATE.lock().ok()?.as_mut().map(f)
}

fn kick(s: &mut State) {
    s.seq += 1;
    WAKE.notify_all();
}

/// `COOOL_MENUBAR_HIDDEN=1`: create the item without drawing it (smoke launches).
pub fn hidden_by_env() -> bool {
    std::env::var("COOOL_MENUBAR_HIDDEN").is_ok_and(|v| v == "1")
}

/// Starts the item and its sampler (from `setup`). `enabled`: a self-test that isn't a menubar scenario gets no item.
pub fn init(app: &AppHandle, prefs: Prefs, test: bool, enabled: bool) {
    let _ = APP.set(app.clone());
    let hidden = test || hidden_by_env();
    *STATE.lock().unwrap() = Some(State { prefs: prefs.clone(), hidden, test, shown: false, open: false, agents: Agents::default(), usage: Vec::new(), reading: Reading::default(), samples: 0, busy_ns: 0, interval_ms: 0, seq: 0 });
    if !enabled {
        return;
    }
    apply(prefs);
    std::thread::Builder::new().name("coool-menubar".into()).spawn(sampler).ok();
}

/// New settings: shows or removes the item and switches what the bar shows.
pub fn apply(p: Prefs) {
    let Some((hidden, test)) = with(|s| {
        s.prefs = p.clone();
        s.shown = p.show;
        kick(s);
        (s.hidden, s.test)
    }) else {
        return;
    };
    #[cfg(target_os = "macos")]
    ui::on_main(move || {
        if p.show {
            ui::create(hidden, test);
        } else {
            ui::remove();
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (hidden, test);
}

/// Quitting: the item goes first. Its sampler's cost so far goes to stderr (a release build has no self-test).
pub fn shutdown() {
    if let Some((n, ns)) = with(|s| {
        s.shown = false;
        (s.samples, s.busy_ns)
    }) {
        eprintln!("coool menubar: {n} samples, {:.1} ms in the sampler", ns as f64 / 1e6);
    }
    #[cfg(target_os = "macos")]
    if objc2::MainThreadMarker::new().is_some() {
        ui::remove();
    }
}

/// From each refresh: coool's sessions and chats, and plan usage.
pub(crate) fn on_sessions(rows: &[(String, coool_core::model::Session, Option<coool_core::insights::Insight>)], chats: &[(usize, coool_core::chat::ChatState, bool, Option<u32>, coool_core::model::Provider)], usage: [Option<&coool_core::usage::PlanUsage>; 2], show_automation: bool) {
    use coool_core::chat::ChatState;
    use coool_core::model::{Origin, Provider, Status};
    if STATE.lock().map(|g| g.as_ref().is_none_or(|s| !s.shown)).unwrap_or(true) {
        return;
    }
    let cli = |p: Provider| if p == Provider::Codex { Cli::Codex } else { Cli::Claude };
    let ins: Vec<In> = rows
        .iter()
        .map(|(key, s, insight)| In {
            key: key.clone(),
            id: s.id.clone(),
            cli: Some(cli(s.provider)),
            title: s.name.as_ref().map(|n| n.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| s.title.clone()),
            project: s.project.clone(),
            status: Some(match s.status {
                Status::Busy => Run::Busy,
                Status::Idle => Run::Idle,
                Status::Ended => Run::Ended,
            }),
            chat: s.chat,
            pid: s.pid,
            automation: s.origin == Origin::Automation,
            parent: s.parent.clone(),
            waiting_for: s.waiting_for.clone(),
            insight_needs: insight.as_ref().and_then(|i| i.needs_you.clone()),
            background: s.status != Status::Ended && (s.agents.iter().any(|a| !a.finished) || s.live_children > 0 || !s.shells.is_empty() || s.background_tasks),
        })
        .collect();
    let chats: Vec<ChatIn> = chats
        .iter()
        .map(|&(id, st, running, pid, p)| ChatIn {
            id,
            state: match st {
                ChatState::Working => ChatRun::Working,
                ChatState::WaitingPermission => ChatRun::Waiting,
                ChatState::Idle => ChatRun::Idle,
            },
            running,
            pid,
            cli: cli(p),
        })
        .collect();
    let a = agents::summarize(&ins, &chats, show_automation);
    let usage: Vec<Usage> = usage
        .into_iter()
        .flatten()
        .map(|u| Usage {
            cli: cli(u.provider),
            limits: u.windows.iter().filter(|w| w.window_minutes.is_some() && w.model.is_none()).filter_map(|w| w.used_percent.map(|p| model::Limit { label: w.label.clone(), left: (100.0 - p.clamp(0.0, 100.0)).round() as u32 })).collect(),
            stale: u.stale,
        })
        .collect();
    with(|s| {
        let changed = s.agents != a;
        if changed || s.usage != usage {
            s.agents = a;
            s.usage = usage;
            kick(s);
        }
    });
}

#[cfg(target_os = "macos")]
fn on_menu(open: bool) {
    let pushed = with(|s| {
        s.open = open;
        kick(s);
        open.then(|| model::rows(&s.reading))
    })
    .flatten();
    // The menu shows the latest reading at once; the sampler refreshes it every 2 s while it stays open.
    if let Some(rows) = pushed {
        ui::set_rows(&rows);
    }
}

#[cfg(target_os = "macos")]
fn on_act(a: ui::Act) {
    let Some(app) = APP.get() else { return };
    match a {
        ui::Act::Action(id) => match id.as_str() {
            "open" => crate::notify::open_from_menubar(None),
            "new" => crate::notify::open_from_menubar(Some(crate::notify::Route { kind: "new".into(), chat: None, session: None, request: None, action: "default".into() })),
            "quit" => crate::quit_from_menubar(app),
            _ => {}
        },
        ui::Act::Open(o) => crate::notify::open_from_menubar(Some(crate::notify::Route { kind: "needs".into(), chat: o.chat, session: o.key, request: None, action: "default".into() })),
    }
}

/// How many CPU readings the history keeps (about a minute at 2 s).
const HISTORY: usize = 30;

/// The sampler: reads what [`model::interval`] says is worth reading, rebuilds the model, hands it to the main thread.
fn sampler() {
    let mut ticks: Option<Vec<stats::Ticks>> = None;
    let mut history: VecDeque<(Instant, f64)> = VecDeque::new();
    let mut net: Option<(Instant, stats::NetCounters)> = None;
    let mut procs: Option<(Instant, Vec<stats::Proc>)> = None;
    let mut last_disk: Option<Instant> = None;
    let mut last_power: Option<Instant> = None;
    let mut last_sample: Option<Instant> = None;
    let mut seen_gen = u64::MAX;
    let mut was_open = false;
    loop {
        let Some((prefs, open, shown, seq, test)) = with(|s| (s.prefs.clone(), s.open, s.shown, s.seq, s.test)) else { return };
        if !shown {
            // Nothing in the bar: nothing to read. Wait for the setting.
            let g = STATE.lock().unwrap();
            let _ = WAKE.wait_timeout_while(g, Duration::from_secs(60), |s| s.as_ref().is_some_and(|s| s.seq == seq));
            ticks = None;
            continue;
        }
        let presence = stats::presence();
        let iv = model::interval(prefs.mode, open, &presence);
        let due = iv.is_some_and(|iv| last_sample.is_none_or(|t| t.elapsed() + Duration::from_millis(150) >= iv) || (open && !was_open));
        let t0 = Instant::now();
        let mut r = with(|s| s.reading.clone()).unwrap_or_default();
        if due {
            let now = Instant::now();
            if let Some(t) = stats::cpu_ticks() {
                // Readings further apart than a minute say little about now: start over.
                let fresh = last_sample.is_some_and(|l| l.elapsed() < Duration::from_secs(65));
                if let (Some(prev), true) = (&ticks, fresh)
                    && let Some((all, cores)) = stats::cpu_between(prev, &t)
                {
                    r.cpu = Some(all);
                    r.cores = cores;
                    history.push_back((now, all));
                } else {
                    r.cpu = None;
                    history.clear();
                }
                ticks = Some(t);
            }
            while history.len() > HISTORY {
                history.pop_front();
            }
            r.history = history.iter().map(|h| h.1).collect();
            r.history_secs = history.front().map(|h| now.duration_since(h.0).as_secs() as u32).unwrap_or(0);
            r.memory = stats::memory();
            r.load = stats::load_avg();
            // The rest only matters to the open menu, or is read rarely to be ready when it opens.
            let slow = |t: &Option<Instant>, every: u64| open && !was_open || t.is_none_or(|t| t.elapsed() >= Duration::from_secs(every));
            if slow(&last_disk, 30) {
                r.disk = stats::disk();
                last_disk = Some(now);
            }
            if slow(&last_power, 15) {
                let h = crate::motion::read();
                r.thermal = Some(h.thermal);
                r.battery = h.on_battery.zip(h.battery_pct);
                r.low_power = h.low_power;
                last_power = Some(now);
            }
            if open || net.as_ref().is_none_or(|(t, _)| t.elapsed() >= Duration::from_secs(10)) {
                if let Some(n) = stats::net() {
                    r.net = net.as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(15)).and_then(|(t, prev)| stats::net_rate(prev, &n, now.duration_since(*t).as_secs_f64()));
                    net = Some((now, n));
                }
            }
            if open || procs.as_ref().is_none_or(|(t, _)| t.elapsed() >= Duration::from_secs(10)) {
                let p = stats::procs();
                let agents = with(|s| s.agents.clone()).unwrap_or_default();
                match procs.as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(30)) {
                    Some((t, prev)) => {
                        let wall = now.duration_since(*t);
                        let uses = stats::proc_uses(prev, &p, wall.as_nanos() as u64);
                        r.procs = Some(agents::top_rows(&uses, &p, &agents, 5));
                        r.procs_secs = wall.as_secs_f64();
                        r.agents_cpu = (agents.working + agents.needs + agents.done > 0).then(|| agents::agents_cpu(&uses, &p, &agents));
                    }
                    None => r.procs = None,
                }
                procs = Some((now, p));
            }
            last_sample = Some(now);
        }
        let (model, busy) = with(|s| {
            r.agents = s.agents.clone();
            r.usage = s.usage.clone();
            s.reading = r.clone();
            if due {
                s.samples += 1;
            }
            s.interval_ms = iv.map(|d| d.as_millis() as u64).unwrap_or(0);
            (model::model(&r, s.prefs.mode, test), t0.elapsed())
        })
        .unwrap_or((model::model(&r, prefs.mode, test), t0.elapsed()));
        if due || seq != seen_gen {
            #[cfg(target_os = "macos")]
            ui::on_main(move || {
                ui::set_bar(&model.bar);
                if open {
                    ui::set_rows(&model.rows);
                }
            });
        }
        let log = with(|s| {
            s.busy_ns += busy.as_nanos() as u64;
            (s.hidden && !s.test && due && s.samples % 30 == 0).then(|| (s.samples, s.busy_ns))
        })
        .flatten();
        // A hidden launch (`COOOL_MENUBAR_HIDDEN=1`, the release smoke test) reports the sampler's cost now and then,
        // and what the bar would show.
        if let Some((n, ns)) = log {
            eprintln!("coool menubar: {n} samples, {:.1} ms in the sampler so far; bar {:?}", ns as f64 / 1e6, with(|s| model::bar(&s.reading, s.prefs.mode, false).segs.iter().map(|x| x.text.clone()).collect::<String>()).unwrap_or_default());
        }
        seen_gen = seq;
        was_open = open;
        // Sleep until the next reading is due, or something changed (settings, sessions, the menu).
        let wait = iv.map(|iv| iv.saturating_sub(last_sample.map(|t| t.elapsed()).unwrap_or_default())).unwrap_or(Duration::from_secs(60)).max(Duration::from_millis(50));
        let g = STATE.lock().unwrap();
        let _ = WAKE.wait_timeout_while(g, wait, |s| s.as_ref().is_some_and(|s| s.seq == seq));
    }
}

// ---- the self-test's view (selftest_menubar) ----

#[derive(Serialize)]
pub struct Status {
    pub exists: bool,
    pub visible: bool,
    pub hidden: bool,
    /// Status-bar windows of this process the window server has on screen (0 for a hidden item).
    pub bar_windows: usize,
    pub title: String,
    pub tooltip: String,
    pub show: bool,
    pub mode: Mode,
    pub open: bool,
    pub samples: u64,
    pub busy_ms: f64,
    pub interval_ms: u64,
    pub reading: Reading,
    pub needs: u32,
}

/// Runs `f` on the main thread and waits for its answer (at most 3 s).
#[cfg(target_os = "macos")]
fn main_sync<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    ui::on_main(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "the main thread didn't answer".to_string())
}

#[cfg(target_os = "macos")]
pub fn selftest(action: &str, arg: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::json;
    fn v(x: impl Serialize) -> Result<serde_json::Value, String> {
        serde_json::to_value(x).map_err(|e| e.to_string())
    }
    match action {
        "status" => {
            let (exists, visible, tooltip, title) = main_sync(ui::state)?;
            let st = with(|s| (s.hidden, s.prefs.clone(), s.open, s.samples, s.busy_ns, s.interval_ms, s.reading.clone())).ok_or("no state")?;
            let needs = st.6.agents.needs;
            v(Status { exists, visible, hidden: st.0, bar_windows: ui::bar_windows(), title, tooltip, show: st.1.show, mode: st.1.mode, open: st.2, samples: st.3, busy_ms: st.4 as f64 / 1e6, interval_ms: st.5, reading: st.6, needs })
        }
        "agents" => {
            let a = with(|s| s.agents.clone()).ok_or("no state")?;
            let mut pids: Vec<_> = a.pids.iter().map(|(p, o)| json!({ "pid": p, "key": o.key, "chat": o.chat, "title": o.title })).collect();
            pids.sort_by_key(|x| x["pid"].as_i64());
            Ok(json!({ "working": a.working, "needs": a.needs, "done": a.done, "needing": a.needing, "pids": pids }))
        }
        // The menu as built from the current reading (never opened on screen): each item's text, enabled, tooltip.
        "menu" => {
            let rows = with(|s| model::rows(&s.reading)).ok_or("no state")?;
            let items = main_sync(move || {
                ui::set_rows(&rows);
                ui::menu_items()
            })?;
            Ok(json!(items.into_iter().map(|(t, e, tip)| json!({ "text": t, "enabled": e, "tip": tip })).collect::<Vec<_>>()))
        }
        // A click on the menu row whose text starts with `arg`, without opening the menu.
        "click" => {
            let t = arg.as_str().ok_or("the row's text")?.to_string();
            let a = main_sync(move || ui::act_of(&t))?.ok_or("no such row, or it does nothing")?;
            let what = format!("{a:?}");
            ui::on_main(move || on_act(a));
            Ok(json!(what))
        }
        // The menu's delegate as if it opened / closed (the sampler's open-menu cadence), nothing drawn.
        "open" | "close" => {
            let open = action == "open";
            main_sync(move || on_menu(open))?;
            Ok(json!(open))
        }
        // Widths in points of the bar's title for every CPU reading 0..=100% in `mode` (the reading padded to three
        // digits in tabular figures must give one width).
        "widths" => {
            let mode: Mode = serde_json::from_value(arg).map_err(|e| e.to_string())?;
            let base = with(|s| s.reading.clone()).ok_or("no state")?;
            let widths = main_sync(move || {
                let mut w: Vec<f64> = (0..=100)
                    .map(|i| {
                        let r = Reading { cpu: Some(i as f64 / 100.0), memory: base.memory.map(|m| stats::Memory { used: m.total * (100 - i) / 100, ..m }), ..base.clone() };
                        (ui::title_width(&model::bar(&r, mode, true)) * 100.0).round() / 100.0
                    })
                    .collect();
                w.dedup();
                w
            })?;
            Ok(json!(widths))
        }
        // The same figures read now by us and by the system's own tools, side by side.
        "compare" => compare(),
        // Every process the scan ties to a session, measured over `arg` ms.
        "procs" => {
            let ms = arg.as_u64().unwrap_or(1000);
            let a = stats::procs();
            std::thread::sleep(Duration::from_millis(ms));
            let b = stats::procs();
            let agents = with(|s| s.agents.clone()).ok_or("no state")?;
            let uses = stats::proc_uses(&a, &b, ms * 1_000_000);
            v(agents::owned_rows(&uses, &b, &agents))
        }
        _ => Err(format!("unknown action {action}")),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn selftest(_action: &str, _arg: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("macOS only".into())
}

#[cfg(target_os = "macos")]
fn compare() -> Result<serde_json::Value, String> {
    use serde_json::json;
    use std::process::Command;
    let run = |c: &str, a: &[&str]| Command::new(c).args(a).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).map_err(|e| format!("{c}: {e}"));
    // CPU: top's second sample (the first is since boot) against our ticks over the same seconds.
    let t0 = stats::cpu_ticks().ok_or("no ticks")?;
    let top = run("/usr/bin/top", &["-l", "2", "-s", "2", "-n", "0"])?;
    let t1 = stats::cpu_ticks().ok_or("no ticks")?;
    let ours_cpu = stats::cpu_between(&t0, &t1).map(|c| c.0 * 100.0);
    let top_cpu = top.lines().filter(|l| l.starts_with("CPU usage:")).last().and_then(|l| {
        let idle = l.split(',').find(|p| p.contains("idle"))?.trim().split('%').next()?.trim().parse::<f64>().ok()?;
        Some(100.0 - idle)
    });
    // Memory: Activity Monitor's Memory Used from vm_stat's pages, at the same moment as ours.
    let vm = run("/usr/bin/vm_stat", &[])?;
    let mem = stats::memory().ok_or("no memory")?;
    let page: f64 = vm.lines().next().and_then(|l| l.split("page size of ").nth(1)).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse().ok()).unwrap_or(16384.0);
    let field = |name: &str| vm.lines().find(|l| l.starts_with(name)).and_then(|l| l.rsplit(':').next()).and_then(|v| v.trim().trim_end_matches('.').parse::<f64>().ok());
    let vm_used = match (field("Anonymous pages"), field("Pages purgeable"), field("Pages wired down"), field("Pages occupied by compressor")) {
        (Some(a), Some(p), Some(w), Some(c)) => Some((a - p + w + c) * page),
        _ => None,
    };
    // Disk: df's available on /, in 1K blocks.
    let df = run("/bin/df", &["-k", "/"])?;
    let disk = stats::disk().ok_or("no disk")?;
    let df_free = df.lines().nth(1).and_then(|l| l.split_whitespace().nth(3)).and_then(|v| v.parse::<f64>().ok()).map(|k| k * 1024.0);
    let swap = run("/usr/sbin/sysctl", &["-n", "vm.swapusage"])?;
    let swap_used = swap.split("used = ").nth(1).and_then(|s| s.split('M').next()).and_then(|v| v.trim().parse::<f64>().ok()).map(|m| m * 1024.0 * 1024.0);
    Ok(json!({
        "cpu": { "ours": ours_cpu, "top": top_cpu },
        "memory_used": { "ours": mem.used, "vm_stat": vm_used, "total": mem.total, "pressure": mem.pressure },
        "swap_used": { "ours": mem.swap_used, "sysctl": swap_used },
        "disk_free": { "ours": disk.free, "df": df_free },
        "load": stats::load_avg(),
    }))
}
