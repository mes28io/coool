use serde_json::Value;
use std::time::{Duration, SystemTime};

/// "2026-11-14T08:09:06.024Z" -> "08:09:06" converted to local time.
///
/// The offset is looked up for the timestamp's own instant, so half-hour zones
/// and DST (including a DST switch while coool is running) come out right.
pub fn short_time(ts: &str) -> String {
    match parse_rfc3339(ts) {
        Some(secs) => hms(secs + local_offset_secs(secs)),
        // Not a timestamp we understand: show the raw clock part, if any.
        None => ts.get(11..19).unwrap_or("").to_string(),
    }
}

/// Epoch milliseconds for an RFC 3339 timestamp (fraction kept to the ms).
pub fn parse_rfc3339_ms(ts: &str) -> Option<u64> {
    let secs = u64::try_from(parse_rfc3339(ts)?).ok()?;
    let frac = ts.get(19..).and_then(|r| r.strip_prefix('.')).map(|r| r.bytes().take_while(u8::is_ascii_digit).take(3).fold((0u64, 0u32), |(a, n), c| (a * 10 + u64::from(c - b'0'), n + 1)));
    let ms = frac.map_or(0, |(v, n)| v * 10u64.pow(3 - n));
    Some(secs * 1000 + ms)
}

/// Seconds since the Unix epoch for `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
pub fn parse_rfc3339(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = ts.get(r)?;
        if s.bytes().all(|c| c.is_ascii_digit()) { s.parse().ok() } else { None }
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, s) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
            i += 1;
        }
    }
    let off = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = num(i + 1..i + 3)?;
            let om = if b.get(i + 3) == Some(&b':') { num(i + 4..i + 6)? } else { num(i + 3..i + 5).unwrap_or(0) };
            let o = oh * 3600 + om * 60;
            if sign == b'-' { -o } else { o }
        }
        _ => return None,
    };
    Some(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - off)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn hms(secs: i64) -> String {
    let t = secs.rem_euclid(86400);
    format!("{:02}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60)
}

/// The local zone's UTC offset in effect at `epoch` (seconds).
fn local_offset_secs(epoch: i64) -> i64 {
    #[allow(irrefutable_let_patterns)] // time_t is 32-bit on some targets
    let Ok(t) = libc::time_t::try_from(epoch) else { return 0 };
    // SAFETY: localtime_r only writes into the zeroed `tm` we own.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return 0;
        }
        tm.tm_gmtoff as i64
    }
}

pub fn one_line(s: &str, max: usize) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&s, max)
}

fn char_width(c: char) -> usize {
    unicode_width::UnicodeWidthChar::width(c).unwrap_or(0)
}

/// Terminal display width of `s` (wide CJK / emoji count as 2 columns).
pub fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// Shortens `s` to at most `max` terminal columns, ending in '…' when cut.
pub fn truncate(s: &str, max: usize) -> String {
    if display_width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = char_width(c);
        if w + cw > max - 1 {
            break;
        }
        w += cw;
        out.push(c);
    }
    out.push('…');
    out
}

pub fn fmt_tokens(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{:.1}k", n as f64 / 1e3),
        _ => format!("{:.2}M", n as f64 / 1e6),
    }
}

pub fn ago(t: SystemTime) -> String {
    let d = SystemTime::now().duration_since(t).unwrap_or(Duration::ZERO).as_secs();
    match d {
        0..=59 => format!("{d}s"),
        60..=3599 => format!("{}m", d / 60),
        3600..=86399 => format!("{}h", d / 3600),
        _ => format!("{}d", d / 86400),
    }
}

pub fn home_short(path: &str) -> String {
    if let Some(h) = dirs::home_dir() {
        let h = h.to_string_lossy();
        if let Some(rest) = path.strip_prefix(h.as_ref()) {
            return format!("~{rest}");
        }
    }
    path.to_string()
}

/// One-line human summary of a tool call's input.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let pick = |k: &str| input.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    let detail = match name {
        "Bash" | "shell" | "exec_command" => pick("command").or_else(|| pick("cmd")),
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick("file_path").map(|p| home_short(&p)),
        "Grep" | "Glob" => pick("pattern"),
        "Agent" | "Task" => pick("description"),
        "WebFetch" => pick("url"),
        "WebSearch" => pick("query"),
        "Skill" => pick("skill"),
        _ => None,
    }
    .or_else(|| {
        input.as_object().and_then(|o| o.values().find_map(|v| v.as_str().map(|s| s.to_string())))
    })
    .or_else(|| input.as_str().map(|s| s.to_string()))
    .unwrap_or_default();
    if detail.is_empty() { name.to_string() } else { format!("{name} · {}", one_line(&detail, 140)) }
}

/// What a file's metadata says about its content: length, mtime and (on unix)
/// inode. Unchanged key, unchanged content, with one caveat handled by
/// [`StatMemo`]: a write within the mtime's granularity of the last read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatKey {
    len: u64,
    mtime: SystemTime,
    ino: u64,
}

impl StatKey {
    pub fn of(m: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        let ino = std::os::unix::fs::MetadataExt::ino(m);
        #[cfg(not(unix))]
        let ino = 0;
        Self { len: m.len(), mtime: m.modified().unwrap_or(SystemTime::UNIX_EPOCH), ino }
    }
}

/// A value derived from a file (or a folder's listing), recomputed only when
/// its [`StatKey`] changed. "Racy" entries, read within [`StatMemo::SETTLE`]
/// of their mtime (a later write in the same mtime tick would go unnoticed on
/// a coarse-clock filesystem), are recomputed every time until they settle.
pub struct StatMemo<T> {
    map: std::collections::HashMap<std::path::PathBuf, (StatKey, SystemTime, T)>,
}

impl<T> Default for StatMemo<T> {
    fn default() -> Self {
        Self { map: Default::default() }
    }
}

impl<T> StatMemo<T> {
    /// Covers the coarsest mtime clocks in use (HFS+ 1 s, FAT 2 s).
    pub const SETTLE: Duration = Duration::from_secs(2);

    /// The value for `path` (whose current metadata is `meta`): the last one
    /// if the file is unchanged since a settled read, else `f()`.
    pub fn get(&mut self, path: &std::path::Path, meta: &std::fs::Metadata, f: impl FnOnce() -> T) -> &T {
        let key = StatKey::of(meta);
        let fresh = |(k, read_at, _): &(StatKey, SystemTime, T)| *k == key && read_at.duration_since(key.mtime).is_ok_and(|d| d >= Self::SETTLE);
        if !self.map.get(path).is_some_and(fresh) {
            let read_at = SystemTime::now();
            self.map.insert(path.to_path_buf(), (key, read_at, f()));
        }
        &self.map[path].2
    }

    /// Forgets every path `keep` says no to.
    pub fn retain(&mut self, mut keep: impl FnMut(&std::path::Path) -> bool) {
        self.map.retain(|p, _| keep(p));
    }
}

/// A folder's entries (paths), re-listed only when the folder itself changed
/// (an entry was added, removed or renamed: that moves the folder's mtime).
/// None when it can't be read.
pub fn list_dir(memo: &mut StatMemo<Vec<std::path::PathBuf>>, dir: &std::path::Path) -> Option<Vec<std::path::PathBuf>> {
    let meta = std::fs::metadata(dir).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let mut ok = true;
    let v = memo.get(dir, &meta, || match std::fs::read_dir(dir) {
        Ok(r) => r.flatten().map(|e| e.path()).collect(),
        Err(_) => {
            ok = false;
            Vec::new()
        }
    });
    let v = v.clone();
    if !ok {
        memo.retain(|p| p != dir);
        return None;
    }
    Some(v)
}

/// Whether `pid` names a live process. Rejects 0 and values that would wrap to a
/// negative pid: `kill(0 | -n, …)` addresses process *groups*, not one process.
pub fn pid_alive(pid: u32) -> bool {
    let Some(p) = valid_pid(pid) else { return false };
    // SAFETY: signal 0 only performs the existence/permission check.
    unsafe { libc::kill(p, 0) == 0 }
}

/// `pid` as a pid_t if it can only ever address a single, non-init process.
pub fn valid_pid(pid: u32) -> Option<libc::pid_t> {
    libc::pid_t::try_from(pid).ok().filter(|p| *p > 1)
}

/// Wall-clock start time of a process in epoch milliseconds, when the OS tells us.
/// Used to detect pid reuse: a pid read from a registry file earlier may belong
/// to an unrelated process by now.
pub fn process_start_ms(pid: u32) -> Option<u64> {
    let p = valid_pid(pid)?;
    imp_start_ms(p)
}

#[cfg(target_os = "macos")]
fn imp_start_ms(pid: libc::pid_t) -> Option<u64> {
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        (n == size).then(|| info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000)
    }
}

#[cfg(target_os = "linux")]
fn imp_start_ms(pid: libc::pid_t) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 22 (starttime, clock ticks after boot); comm (field 2) may contain spaces.
    let ticks: u64 = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()?;
    let btime: u64 = std::fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())?;
    // SAFETY: sysconf has no preconditions.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return None;
    }
    Some(btime * 1000 + ticks * 1000 / hz as u64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn imp_start_ms(_: libc::pid_t) -> Option<u64> {
    None
}

/// The parent pid of `pid`, if it is alive and readable. No external commands.
pub fn parent_pid(pid: u32) -> Option<u32> {
    let p = valid_pid(pid)?;
    imp_ppid(p)
}

#[cfg(target_os = "macos")]
fn imp_ppid(pid: libc::pid_t) -> Option<u32> {
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        (n == size).then_some(info.pbi_ppid)
    }
}

#[cfg(target_os = "linux")]
fn imp_ppid(pid: libc::pid_t) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 4 (ppid); comm (field 2) may contain spaces.
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn imp_ppid(_: libc::pid_t) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unchanged settled files are not read again; a change, or a file still
    /// within the settle window of its mtime, is.
    #[test]
    fn stat_memo_rereads_only_changed_or_racy_files() {
        let d = std::env::temp_dir().join(format!("coool-statmemo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("a.json");
        let ago = |s: u64| SystemTime::now() - Duration::from_secs(s);
        let write = |text: &str, mtime: Option<SystemTime>| {
            std::fs::write(&p, text).unwrap();
            if let Some(t) = mtime {
                std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
            }
        };
        let reads = std::cell::Cell::new(0);
        let mut m: StatMemo<String> = StatMemo::default();
        let get = |m: &mut StatMemo<String>| {
            let meta = std::fs::metadata(&p).unwrap();
            m.get(&p, &meta, || {
                reads.set(reads.get() + 1);
                std::fs::read_to_string(&p).unwrap()
            })
            .clone()
        };
        write("busy", Some(ago(60)));
        assert_eq!((get(&mut m), get(&mut m), reads.get()), ("busy".into(), "busy".into(), 1), "settled: read once");
        write("idle", Some(ago(30)));
        assert_eq!((get(&mut m), reads.get()), ("idle".into(), 2), "same length, new mtime");
        write("idle", None);
        get(&mut m);
        get(&mut m);
        assert_eq!(reads.get(), 4, "just written: read every time until it settles");

        // Folder listings follow entries being added and removed.
        let mut dirs = StatMemo::default();
        let set_dir_mtime = || std::fs::File::open(&d).unwrap().set_modified(ago(60)).unwrap();
        set_dir_mtime();
        assert_eq!(list_dir(&mut dirs, &d), Some(vec![p.clone()]));
        std::fs::write(d.join("b.json"), "x").unwrap();
        let mut got = list_dir(&mut dirs, &d).unwrap();
        got.sort();
        assert_eq!(got, vec![p.clone(), d.join("b.json")]);
        std::fs::remove_file(d.join("b.json")).unwrap();
        set_dir_mtime();
        assert_eq!(list_dir(&mut dirs, &d), Some(vec![p.clone()]));
        assert_eq!(list_dir(&mut dirs, &d.join("missing")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parent_pid_of_this_process() {
        let me = std::process::id();
        let pp = parent_pid(me);
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            assert!(pp.is_some_and(|p| p > 0 && p != me), "{pp:?}");
        }
        assert_eq!(parent_pid(0), None);
        assert_eq!(parent_pid(1), None);
    }

    #[test]
    fn rfc3339_parses_to_epoch() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-14T08:09:06.024Z"), Some(1_794_643_746));
        assert_eq!(parse_rfc3339("2026-11-14T13:39:06+05:30"), Some(1_794_643_746));
        assert_eq!(parse_rfc3339("2026-11-14T03:09:06.5-05:00"), Some(1_794_643_746));
        assert_eq!(parse_rfc3339("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        assert_eq!(parse_rfc3339("not a timestamp at all"), None);
        assert_eq!(parse_rfc3339("2026-11-14"), None);
    }

    #[test]
    fn hms_wraps_days() {
        assert_eq!(hms(1_794_643_746), "08:09:06");
        assert_eq!(hms(1_794_643_746 + 5 * 3600 + 1800), "13:39:06");
        assert_eq!(hms(-1), "23:59:59");
    }

    #[test]
    fn short_time_falls_back_on_garbage() {
        assert_eq!(short_time(""), "");
        assert_eq!(short_time("xxxxxxxxxxxAB:CD:EFzz"), "AB:CD:EF");
    }

    #[test]
    fn truncate_counts_columns() {
        assert_eq!(truncate("hello", 5), "hello");
        assert_eq!(truncate("hello world", 6), "hello…");
        // Each CJK char is 2 columns: 3 of them + '…' would be 7 > 6.
        let t = truncate("漢字漢字漢字", 6);
        assert_eq!(t, "漢字…");
        assert!(display_width(&t) <= 6);
        assert_eq!(truncate("🙂🙂🙂", 4), "🙂…");
        assert_eq!(truncate("abc", 0), "");
        assert_eq!(one_line("a\n  b\tc", 10), "a b c");
    }

    #[test]
    fn bogus_pids_are_never_alive() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(1));
        assert!(!pid_alive(u32::MAX));
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn own_start_time_is_in_the_past() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(process_start_ms(std::process::id()).is_some());
        if let Some(ms) = process_start_ms(std::process::id()) {
            let now = std::time::SystemTime::now().duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
            assert!(ms <= now && now - ms < 3_600_000, "start {ms} now {now}");
        }
    }
}
