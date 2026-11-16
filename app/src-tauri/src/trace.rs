//! Latency trace for the sessions payloads, off unless `COOOL_TRACE_SESSIONS=<file>`
//! is set. One line per emit (refresh / build / emit time, bytes, which sessions
//! changed) and one per payload the UI applied (`trace_sessions`, sent by the
//! frontend only when a payload carries `trace`). `COOOL_TRACE_SESSION=<id>`
//! adds that session's activity count to each emit line, to line them up with
//! writes to its transcript. Times are wall-clock ms, comparable across processes.

use crate::{Core, Published};
use std::fs::File;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::State;

pub struct Trace {
    file: Mutex<File>,
    session: Option<String>,
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn ms(d: Duration) -> String {
    format!("{:.2}", d.as_secs_f64() * 1000.0)
}

impl Trace {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("COOOL_TRACE_SESSIONS").filter(|p| !p.is_empty())?;
        let file = File::create(path).ok()?;
        let session = std::env::var("COOOL_TRACE_SESSION").ok().filter(|s| !s.is_empty());
        Some(Self { file: Mutex::new(file), session })
    }

    fn line(&self, s: &str) {
        let _ = writeln!(self.file.lock().unwrap(), "{} {s}", now_ms());
    }

    #[allow(clippy::too_many_arguments)]
    pub fn emit(&self, seq: u64, event: &str, refresh: Duration, build: Duration, emit: Duration, bytes: usize, changed: &[String], p: &Published) {
        let watched = self.session.as_ref().and_then(|id| {
            let s = &p.sessions.iter().find(|(k, _)| k.ends_with(&format!(":{id}")))?.1.session;
            Some(format!(" act={} status={}", s.activity.len(), serde_json::to_value(s.status).ok()?.as_str().unwrap_or("")))
        });
        self.line(&format!(
            "be seq={seq} event={event} refresh_ms={} build_ms={} emit_ms={} bytes={bytes} changed={}{}",
            ms(refresh),
            ms(build),
            ms(emit),
            changed.len(),
            watched.unwrap_or_default()
        ));
    }
}

/// The frontend reports a payload it applied (only while tracing).
#[tauri::command]
pub fn trace_sessions(core: State<'_, Arc<Core>>, line: String) {
    if let Some(t) = &core.trace {
        t.line(&format!("fe {}", line.replace('\n', " ")));
    }
}
