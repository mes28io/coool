//! The app's side of the chat host (APP_SPEC "Chats that outlive the app"; the host itself is
//! `coool_core::chat::host`): finding the hosts in coool's folder at launch, taking in their chats, starting one when
//! a chat needs it, draining a host of another version, and what a quit stops.
//!
//! "Keep chats running when coool quits" (Settings > General, on by default) decides whether new chats start in the
//! host. Hosted chats from an earlier run are always taken in, whatever the setting says.

use crate::{ChatStream, Core};
use coool_core::chat::host::{self, Client, PROTOCOL};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// The hosts this app is connected to (the current one first): kept so a draining host's chats stay reachable.
#[derive(Default)]
pub struct Hosts {
    dir: Mutex<Option<PathBuf>>,
    clients: Mutex<Vec<Arc<Client>>>,
    /// Held while a host is being started (one at a time).
    starting: Mutex<()>,
    /// When the last start failed.
    failed_at: Mutex<Option<std::time::Instant>>,
    /// The person was told once that a chat runs inside coool because the host couldn't start.
    told: std::sync::atomic::AtomicBool,
}

fn version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The host folder: `<app local data>/chat-host`, or in a debug build `COOOL_CHAT_HOST_DIR` under `/tmp/coool-host-…`.
/// A self-test uses a host only with that set, so it never finds the person's host (or they its).
fn host_dir(app: &AppHandle, core: &Core) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("COOOL_CHAT_HOST_DIR").map(PathBuf::from) {
        if host::test_dir_ok(&d) {
            return Some(d);
        }
        eprintln!("coool: COOOL_CHAT_HOST_DIR must be under /tmp/coool-host-…; the chat host is off");
        return None;
    }
    if core.selftest.is_some() {
        return None;
    }
    app.path().app_local_data_dir().ok().map(|d| d.join("chat-host"))
}

/// At launch: connects to every host in coool's folder and takes in their chats. A host of this version becomes the
/// one new chats start in (with the setting on); one of another version is told to drain (it ends with its last
/// chat). A host of a protocol this app doesn't speak is left alone.
///
/// It talks to the hosts on a thread of its own (a host that doesn't answer must never hold the window at launch);
/// a chat started meanwhile waits for it (`starting`), bounded by the hosts' own timeouts.
pub fn init(app: &AppHandle, core: &Arc<Core>) {
    let Some(dir) = host_dir(app, core) else { return };
    *core.hosts.dir.lock().unwrap() = Some(dir.clone());
    let (app, core) = (app.clone(), core.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _one = core.hosts.starting.lock().unwrap_or_else(|e| e.into_inner());
        let _ = tx.send(());
        take_in(&app, &core, &dir);
    });
    // Holding `starting` before setup goes on, so no chat can start a second host meanwhile.
    let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
}

fn take_in(app: &AppHandle, core: &Core, dir: &std::path::Path) {
    let dir = dir.to_path_buf();
    let mine = version(app);
    let mut current = None;
    for hf in host::hosts(&dir) {
        if hf.protocol != PROTOCOL {
            eprintln!("coool: chat host {} speaks protocol {}, this app {PROTOCOL}: left alone", hf.pid, hf.protocol);
            continue;
        }
        let c = match Client::open(&dir, &hf, &format!("coool {mine}")) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("coool: chat host {} not reachable: {e:#}", hf.pid);
                continue;
            }
        };
        adopt(app, core, &c);
        if hf.version != mine || c.hello.draining {
            let _ = c.drain();
        } else if current.is_none() {
            current = Some(c.clone());
        }
        core.hosts.clients.lock().unwrap().push(c);
    }
    if core.keep_chats.load(Ordering::Relaxed) {
        core.hub.lock().unwrap().set_host(current);
    }
}

/// Takes in a host's chats this app doesn't hold yet: the pump, notifications (quiet for what already happened), the
/// device and Ladder tokens their MCP proxies still hold, and Ladder's helper records.
fn adopt(app: &AppHandle, core: &Core, c: &Arc<Client>) {
    let taken = match core.hub.lock().unwrap().adopt(c) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("coool: chat host {}: {e:#}", c.hello.pid);
            return;
        }
    };
    if taken.is_empty() {
        return;
    }
    let devices = app.state::<Arc<crate::device::Devices>>();
    for (id, e) in &taken {
        let handle = core.hub.lock().unwrap().chat(*id).map(|x| x.handle());
        let Some(handle) = handle else { continue };
        devices.mcp.adopt(*id, &e.mcp, &e.opts.cwd, e.opts.provider);
        core.ladder.adopt(*id, &e.opts, &e.mcp, &e.meta, e.started_ms);
        core.chats.lock().unwrap().insert(*id, ChatStream { handle, seq: 0, exit_sent: false, title: crate::chat_title(e.opts.provider, &e.opts.cwd), key: None, ask: None, quiet_until: e.last_seq });
    }
    core.pump_waker.kick();
    core.kick();
}

/// Before a chat starts with the setting on: the host new chats go to, started when there is none (or it is gone).
/// None (the chat starts inside coool): the setting is off, there is no host folder, or the host can't start.
/// `Err`: the setting is on but no host could be reached or started; the chat starts inside coool, and the error is
/// what it says about that (only the first time in a launch: later ones start inside coool quietly, and the host is
/// tried again after a minute).
pub fn ensure(app: &AppHandle, core: &Core) -> Result<Option<Arc<Client>>, String> {
    if !core.keep_chats.load(Ordering::Relaxed) {
        core.hub.lock().unwrap().set_host(None);
        return Ok(None);
    }
    if let Some(h) = core.hub.lock().unwrap().host().filter(|h| h.is_alive()) {
        return Ok(Some(h));
    }
    let Some(dir) = core.hosts.dir.lock().unwrap().clone() else { return Ok(None) };
    // One start at a time; after a failure, chats start inside coool for a minute before the host is tried again.
    let _one = core.hosts.starting.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = core.hub.lock().unwrap().host().filter(|h| h.is_alive()) {
        return Ok(Some(h));
    }
    if core.hosts.failed_at.lock().unwrap().is_some_and(|t| t.elapsed() < RETRY_AFTER) {
        return Ok(None);
    }
    let started = std::env::current_exe()
        .map_err(anyhow::Error::from)
        .and_then(|exe| host::spawn_host(&exe, &dir, &version(app)))
        .and_then(|hf| Client::open(&dir, &hf, &format!("coool {}", version(app))));
    match started {
        Ok(c) => {
            *core.hosts.failed_at.lock().unwrap() = None;
            core.hosts.clients.lock().unwrap().insert(0, c.clone());
            core.hub.lock().unwrap().set_host(Some(c.clone()));
            Ok(Some(c))
        }
        Err(e) => {
            eprintln!("coool: chat host not started: {e:#}");
            *core.hosts.failed_at.lock().unwrap() = Some(std::time::Instant::now());
            if core.hosts.told.swap(true, Ordering::SeqCst) {
                return Ok(None);
            }
            Err(format!("coool's chat host couldn't start ({e:#}), so this chat runs inside coool and stops if coool quits. Chats started later try the host again."))
        }
    }
}

/// After a failed host start, chats start inside coool this long before the host is tried again.
const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// The setting changed: off, new chats start inside coool (hosted ones keep running until they end or coool quits);
/// on, the next chat starts in a host.
pub fn set_keep(core: &Core, on: bool) {
    core.keep_chats.store(on, Ordering::Relaxed);
    if !on {
        core.hub.lock().unwrap().set_host(None);
    }
}

/// What a quit stops: with the setting on, only what runs inside coool (terminal sessions, chats started while it
/// was off); off, everything, hosted chats too (as before).
pub fn stop_for_quit(core: &Core) {
    let mut hub = core.hub.lock().unwrap();
    if core.keep_chats.load(Ordering::Relaxed) { hub.kill_local() } else { hub.kill_all() }
}

/// (what a quit would stop, what keeps running).
pub fn counts(core: &Core) -> (usize, usize) {
    counts_of(&core.hub.lock().unwrap(), core)
}

/// [`counts`] when the hub is free right now.
pub fn try_counts(core: &Core) -> Option<(usize, usize)> {
    let hub = core.hub.try_lock().ok()?;
    Some(counts_of(&hub, core))
}

fn counts_of(hub: &coool_core::hub::Hub, core: &Core) -> (usize, usize) {
    let all = hub.running_count() + hub.running_chats();
    let kept = if core.keep_chats.load(Ordering::Relaxed) { hub.running_hosted() } else { 0 };
    (all - kept, kept)
}

/// The host processes this app is connected to (the self-test checks them).
pub fn host_pids(core: &Core) -> Vec<u32> {
    core.hosts.clients.lock().unwrap().iter().filter(|c| c.is_alive()).map(|c| c.hello.pid).collect()
}
