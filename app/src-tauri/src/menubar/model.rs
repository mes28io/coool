//! What the menu bar item shows, built from a reading: the text beside the glyph and the rows of its menu. Pure (the
//! AppKit side in ui.rs only draws it), so the browser demo renders the very same rows (menubarDemo.json, made by the
//! `demo_fixture` test from invented readings) and the formatting is unit-tested.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::agents::{Agents, Cli, ProcRow};
use super::stats::{Disk, Memory, Presence, Pressure};
use crate::motion::Thermal;

/// What the bar shows beside the glyph (Settings > General > Menu bar).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The glyph alone (and the needs-you mark).
    Nothing,
    #[default]
    Cpu,
    CpuMemory,
    /// How many sessions need the person (nothing when none does).
    Needs,
}

impl Mode {
    /// The bar reads the Mac itself (so the sampler runs while the menu is closed).
    pub fn reads_system(self) -> bool {
        matches!(self, Mode::Cpu | Mode::CpuMemory)
    }
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prefs {
    /// "Show coool in the menu bar" (on by default).
    #[serde(default = "yes")]
    pub show: bool,
    #[serde(default)]
    pub mode: Mode,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { show: true, mode: Mode::Cpu }
    }
}

/// How often the sampler reads the Mac: None when nothing it would read is on screen (it then only redraws for
/// coool's own changes). The open menu wants fresh figures; the bar's reading slows down as the person steps away and
/// stops while the display sleeps or the screen is locked.
pub fn interval(mode: Mode, menu_open: bool, p: &Presence) -> Option<Duration> {
    if menu_open {
        return Some(Duration::from_secs(2));
    }
    if !mode.reads_system() || p.display_asleep || p.locked {
        return None;
    }
    match p.idle_secs {
        Some(s) if s >= 300.0 => Some(Duration::from_secs(30)),
        Some(s) if s >= 60.0 => Some(Duration::from_secs(10)),
        _ => Some(Duration::from_secs(2)),
    }
}

/// U+2007 FIGURE SPACE: as wide as a digit in a font with tabular digits (the bar's).
pub const FIG: char = '\u{2007}';

/// A share (0..=1) as a percentage that is always three digits wide ("  7%", " 42%", "100%"), so the bar never
/// changes width as the number does. No reading: a dash in the same width.
pub fn pct3(share: Option<f64>) -> String {
    match share {
        Some(v) if v.is_finite() => {
            let n = (v.clamp(0.0, 1.0) * 100.0).round() as u32;
            format!("{:>3}%", n).replace(' ', &FIG.to_string())
        }
        _ => format!("{FIG}{FIG}\u{2012}%"),
    }
}

/// Bytes in binary units, as Activity Monitor shows memory ("20.6 GB", "512 MB").
pub fn bytes_bin(b: u64) -> String {
    let gib = b as f64 / (1u64 << 30) as f64;
    if gib >= 100.0 {
        format!("{gib:.0} GB")
    } else if gib >= 1.0 {
        format!("{gib:.1} GB").replace(".0 GB", " GB")
    } else {
        format!("{:.0} MB", b as f64 / (1u64 << 20) as f64)
    }
}

/// Bytes in decimal units, as Finder shows disks ("51.2 GB", "1.2 TB").
pub fn bytes_dec(b: u64) -> String {
    let f = b as f64;
    if f >= 1e12 {
        format!("{:.1} TB", f / 1e12)
    } else if f >= 100e9 {
        format!("{:.0} GB", f / 1e9)
    } else if f >= 1e9 {
        format!("{:.1} GB", f / 1e9)
    } else {
        format!("{:.0} MB", f / 1e6)
    }
}

/// A transfer rate ("1.2 MB/s", "80 KB/s", "0 KB/s").
pub fn rate(bps: f64) -> String {
    if bps >= 1e6 {
        format!("{:.1} MB/s", bps / 1e6)
    } else {
        format!("{:.0} KB/s", bps / 1e3)
    }
}

/// A process's CPU (percent of one core): "312%", "4.5%", "0.2%".
pub fn proc_pct(cpu: f64) -> String {
    if cpu >= 10.0 { format!("{cpu:.0}%") } else { format!("{cpu:.1}%") }
}

/// At most `n` values: neighbours averaged into `n` buckets (so a minute of readings fits one short line).
pub fn squeeze(v: &[f64], n: usize) -> Vec<f64> {
    if v.len() <= n || n == 0 {
        return v.to_vec();
    }
    (0..n)
        .map(|i| {
            let (a, b) = (i * v.len() / n, ((i + 1) * v.len() / n).max(i * v.len() / n + 1));
            v[a..b].iter().sum::<f64>() / (b - a) as f64
        })
        .collect()
}

const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/// Shares (0..=1) as block characters, one per value.
pub fn spark(v: &[f64]) -> String {
    v.iter().map(|x| BARS[((x.clamp(0.0, 1.0) * 7.0).round() as usize).min(7)]).collect()
}

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end()) }
}

/// One limit as the app's usage pill shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Limit {
    pub label: String,
    pub left: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Usage {
    pub cli: Cli,
    pub limits: Vec<Limit>,
    /// The numbers are older than 15 minutes.
    pub stale: bool,
}

/// Everything the menu is built from.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Reading {
    /// Whole machine, 0..=1, over the last interval.
    pub cpu: Option<f64>,
    pub cores: Vec<f64>,
    /// CPU over the last minute or so, oldest first, and how many seconds it spans.
    pub history: Vec<f64>,
    pub history_secs: u32,
    pub load: Option<[f64; 3]>,
    pub memory: Option<Memory>,
    pub disk: Option<Disk>,
    /// Bytes per second (in, out).
    pub net: Option<(f64, f64)>,
    pub thermal: Option<Thermal>,
    /// (on battery, percent); None without a battery.
    pub battery: Option<(bool, u8)>,
    pub low_power: bool,
    /// The busiest processes, None while the first two scans aren't in yet.
    pub procs: Option<Vec<ProcRow>>,
    /// Seconds the process figures span.
    pub procs_secs: f64,
    /// The agents and their tools together, percent of one core.
    pub agents_cpu: Option<f64>,
    pub agents: Agents,
    pub usage: Vec<Usage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SegKind {
    /// A small label ("CPU").
    Label,
    /// A figure, in tabular digits.
    Value,
    /// The needs-you mark (the needs-you colour).
    Needs,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Seg {
    pub text: String,
    pub kind: SegKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Bar {
    pub segs: Vec<Seg>,
    pub tooltip: String,
    pub needs: u32,
}

/// Where a click on a row goes in the app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Open {
    pub key: Option<String>,
    pub chat: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Row {
    Header { text: String },
    /// A figure: its name, the figure, an optional second line, and what it means (the tooltip).
    Stat { id: String, label: String, value: String, detail: Option<String>, tip: String },
    Proc { id: String, name: String, what: Option<String>, cpu: String, open: Option<Open> },
    Need { id: String, title: String, detail: String, open: Open },
    Note { text: String },
    Action { id: String, title: String },
    Sep,
}

impl Row {
    /// Rows of the same id and kind are updated in place while the menu is open.
    pub fn id(&self) -> String {
        match self {
            Row::Header { text } => format!("h:{text}"),
            Row::Stat { id, .. } | Row::Need { id, .. } => id.clone(),
            // A process row that becomes clickable (or stops being) is built anew.
            Row::Proc { id, open, .. } => format!("{id}:{}", open.is_some()),
            Row::Note { .. } => "note".into(),
            Row::Action { id, .. } => format!("a:{id}"),
            Row::Sep => "sep".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Model {
    pub bar: Bar,
    pub rows: Vec<Row>,
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn bar(r: &Reading, mode: Mode, test: bool) -> Bar {
    let needs = r.agents.needs;
    let mem_share = r.memory.map(|m| m.used as f64 / m.total.max(1) as f64);
    let mut segs = Vec::new();
    if needs > 0 {
        segs.push(Seg { text: "●".into(), kind: SegKind::Needs });
    }
    let v = |t: String| Seg { text: t, kind: SegKind::Value };
    let l = |t: &str| Seg { text: t.into(), kind: SegKind::Label };
    match mode {
        Mode::Nothing => {}
        Mode::Cpu => segs.push(v(pct3(r.cpu))),
        Mode::CpuMemory => {
            segs.push(l("CPU"));
            segs.push(v(pct3(r.cpu)));
            segs.push(l("MEM"));
            segs.push(v(pct3(mem_share)));
            // Free space on the startup volume, in whole GB, padded so the width holds from 1 to 9999.
            if let Some(d) = r.disk {
                let gb = (d.free as f64 / 1e9).round() as u64;
                let t = format!("{gb}G");
                segs.push(l("DISK"));
                segs.push(v(format!("{}{t}", "\u{2007}".repeat(5usize.saturating_sub(t.chars().count())))));
            }
        }
        Mode::Needs => {
            if needs > 0 {
                segs.push(v(needs.to_string()));
            }
        }
    }
    let mut tip = vec![if test { "coool self-test (not your coool)".to_string() } else { "coool".to_string() }];
    if let Some(c) = r.cpu {
        tip.push(format!("CPU {}%", (c * 100.0).round()));
    }
    if let Some(m) = mem_share {
        tip.push(format!("memory {}% used", (m * 100.0).round()));
    }
    if needs > 0 {
        tip.push(format!("{} you", plural(needs, "session needs", "sessions need")));
    }
    Bar { segs, tooltip: tip.join(" · "), needs }
}

fn thermal_text(t: Thermal) -> (&'static str, &'static str) {
    match t {
        Thermal::Nominal => ("Normal", "macOS isn't limiting anything for heat."),
        Thermal::Fair => ("Warm", "Slightly raised; macOS may start fans or ease off background work."),
        Thermal::Serious => ("Hot", "macOS is slowing the CPU to cool down: agents run slower."),
        Thermal::Critical => ("Very hot", "macOS is slowing the CPU hard to cool down."),
    }
}

fn pressure_text(p: Option<Pressure>) -> &'static str {
    match p {
        Some(Pressure::Normal) => "pressure normal",
        Some(Pressure::Warning) => "pressure high",
        Some(Pressure::Critical) => "pressure critical",
        None => "pressure unknown",
    }
}

/// The menu's rows.
pub fn rows(r: &Reading) -> Vec<Row> {
    let mut out = vec![Row::Header { text: "This Mac".into() }];
    let stat = |id: &str, label: &str, value: String, detail: Option<String>, tip: &str| Row::Stat { id: id.into(), label: label.into(), value, detail, tip: tip.into() };

    // CPU.
    let mut cpu_detail = Vec::new();
    if r.history.len() >= 2 {
        cpu_detail.push(format!("{}  last {} s", spark(&squeeze(&r.history, 15)), r.history_secs));
    }
    if !r.cores.is_empty() {
        cpu_detail.push(format!("{}  {} cores now", spark(&r.cores), r.cores.len()));
    }
    if let Some(l) = r.load {
        cpu_detail.push(format!("Load average {:.1} · {:.1} · {:.1}", l[0], l[1], l[2]));
    }
    out.push(stat(
        "cpu",
        "CPU",
        r.cpu.map(|c| format!("{}%", (c * 100.0).round())).unwrap_or_else(|| "Measuring…".into()),
        (!cpu_detail.is_empty()).then(|| cpu_detail.join("\n")),
        "All cores together, user + system time, as Activity Monitor's CPU Load. The bars: the last minute, then each core now. Load average: processes running or waiting to run, over 1, 5 and 15 minutes.",
    ));

    // Memory.
    if let Some(m) = r.memory {
        let mut d = vec![pressure_text(m.pressure).to_string()];
        if let Some(s) = m.swap_used.filter(|&s| s > 0) {
            d.push(format!("swap {} used", bytes_bin(s)));
        }
        d.push(format!("cached files {}", bytes_bin(m.cached)));
        out.push(stat(
            "mem",
            "Memory",
            format!("{} of {} used", bytes_bin(m.used), bytes_bin(m.total)),
            Some(capital(&d.join(" · "))),
            "Used: app memory + wired + compressed, as Activity Monitor's Memory Used. Cached files are kept only until something needs the room. Pressure is macOS's own reading: while it is normal, used memory near the total is fine.",
        ));
    }

    // Disk.
    if let Some(d) = r.disk {
        out.push(stat("disk", "Disk", format!("{} free", bytes_dec(d.free)), Some(format!("of {} on the startup volume", bytes_dec(d.total))), "Available space on the startup volume, as df counts it. Finder may show more: it also counts purgeable space as free."));
    }

    // Network.
    if let Some((i, o)) = r.net {
        out.push(stat("net", "Network", format!("↓ {}  ↑ {}", rate(i), rate(o)), None, "Wi-Fi, Ethernet and cellular, over the last few seconds. VPN tunnels are not counted twice."));
    }

    // Heat and power.
    if let Some(t) = r.thermal {
        let (word, tip) = thermal_text(t);
        out.push(stat("heat", "Heat", word.into(), None, tip));
    }
    if let Some((on_battery, pct)) = r.battery {
        let mut v = format!("{pct}% · {}", if on_battery { "on battery" } else { "on power" });
        if r.low_power {
            v.push_str(" · Low Power Mode");
        }
        out.push(stat("power", "Battery", v, None, "The internal battery, and whether the Mac runs on it."));
    } else if r.low_power {
        out.push(stat("power", "Power", "Low Power Mode".into(), None, "Low Power Mode is on."));
    }

    // Processes.
    out.push(Row::Sep);
    out.push(Row::Header { text: "Busiest processes".into() });
    match &r.procs {
        None => out.push(Row::Note { text: "Measuring…".into() }),
        Some(ps) if ps.is_empty() => out.push(Row::Note { text: "Nothing busy".into() }),
        Some(ps) => {
            for p in ps {
                let what = match (&p.owner, p.stray_cli) {
                    (Some(o), _) if p.is_cli => Some(format!("{} · {}", o.cli.name(), clip(&o.title, 36))),
                    (Some(o), _) => Some(format!("run by {} · {}", o.cli.name(), clip(&o.title, 30))),
                    (None, Some(c)) => Some(format!("{}, not a session coool lists", c.name())),
                    (None, None) => None,
                };
                let open = p.owner.as_ref().map(|o| Open { key: o.key.clone(), chat: o.chat });
                out.push(Row::Proc { id: format!("p:{}", out.len()), name: clip(&p.name, 28), what, cpu: proc_pct(p.cpu), open });
            }
        }
    }
    let mut note = format!("% of one core over the last {} s · your processes only", r.procs_secs.round().max(1.0));
    if let Some(a) = r.agents_cpu.filter(|a| *a >= 0.05) {
        note = format!("Agents and the tools they run: {}\n{note}", proc_pct(a));
    }
    out.push(Row::Note { text: note });

    // coool.
    let a = &r.agents;
    out.push(Row::Sep);
    out.push(Row::Header { text: "coool".into() });
    let counts = if a.working + a.needs + a.done == 0 { "No sessions running".to_string() } else { format!("{} working · {} need{} you · {} done", a.working, a.needs, if a.needs == 1 { "s" } else { "" }, a.done) };
    out.push(stat("agents", "Sessions", counts, None, "Working: mid-turn. Needs you: a permission, a question or a plan waits. Done: finished its turn, the CLI still open."));
    for (i, n) in a.needing.iter().take(6).enumerate() {
        let title = if n.project.is_empty() { clip(&n.title, 40) } else { format!("{} — {}", clip(&n.title, 28), clip(&n.project, 14)) };
        out.push(Row::Need { id: format!("n:{i}"), title, detail: clip(&n.ask, 50), open: Open { key: n.key.clone(), chat: n.chat } });
    }
    if a.needing.len() > 6 {
        out.push(Row::Note { text: format!("and {} more on the Needs you page", a.needing.len() - 6) });
    }
    for u in &r.usage {
        // The figure: what is left of the tightest limit; every limit on the line under it.
        let mut v = u.limits.iter().map(|l| l.left).min().map(|l| format!("{l}% left")).unwrap_or_else(|| "No usage data yet".into());
        if u.stale {
            v.push_str(" (old)");
        }
        let detail = (!u.limits.is_empty()).then(|| u.limits.iter().map(|l| format!("{} {}% left", l.label, l.left)).collect::<Vec<_>>().join(" · "));
        let id = match u.cli {
            Cli::Claude => "use:claude",
            Cli::Codex => "use:codex",
        };
        out.push(stat(id, u.cli.name(), v, detail, "Plan usage left, as the usage ring in the app shows it."));
    }

    out.push(Row::Sep);
    out.push(Row::Action { id: "open".into(), title: "Open coool".into() });
    out.push(Row::Action { id: "new".into(), title: "New session…".into() });
    out.push(Row::Sep);
    out.push(Row::Action { id: "quit".into(), title: "Quit coool".into() });
    out
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub fn model(r: &Reading, mode: Mode, test: bool) -> Model {
    Model { bar: bar(r, mode, test), rows: rows(r) }
}

/// Invented readings for the browser demo and the tests: an idle Mac, a busy one, agents needing you, nothing running.
#[cfg(test)]
pub fn demo_readings() -> Vec<(&'static str, Reading)> {
    use super::agents::{Need, Owner};
    let gb = 1u64 << 30;
    let mem = |used_gb: f64, p: Pressure, swap_gb: f64| Memory {
        total: 24 * gb,
        used: (used_gb * gb as f64) as u64,
        app: (used_gb * 0.55 * gb as f64) as u64,
        wired: (used_gb * 0.3 * gb as f64) as u64,
        compressed: (used_gb * 0.15 * gb as f64) as u64,
        cached: 3 * gb,
        pressure: Some(p),
        swap_used: Some((swap_gb * gb as f64) as u64),
    };
    let disk = Some(Disk { free: 51_200_000_000, total: 494_380_000_000 });
    let usage = vec![
        Usage { cli: Cli::Claude, limits: vec![Limit { label: "5-hour".into(), left: 82 }, Limit { label: "Weekly".into(), left: 64 }], stale: false },
        Usage { cli: Cli::Codex, limits: vec![Limit { label: "5-hour".into(), left: 97 }, Limit { label: "Weekly".into(), left: 88 }], stale: false },
    ];
    let owner = |t: &str, cli| Owner { key: Some(format!("claude:{t}")), chat: None, title: t.into(), cli };
    let row = |pid, name: &str, cpu, owner: Option<Owner>, is_cli, stray| ProcRow { pid, name: name.into(), cpu, owner, is_cli, stray_cli: stray };
    let wave = |base: f64, n: usize| (0..n).map(|i| (base + 0.18 * ((i as f64) * 0.7).sin()).clamp(0.02, 1.0)).collect::<Vec<_>>();
    let idle = Reading {
        cpu: Some(0.07),
        cores: vec![0.12, 0.05, 0.09, 0.03, 0.02, 0.01, 0.04, 0.02, 0.15, 0.1, 0.08, 0.06],
        history: wave(0.08, 30).iter().map(|v| v * 0.5).collect(),
        history_secs: 60,
        load: Some([1.8, 2.1, 2.4]),
        memory: Some(mem(11.2, Pressure::Normal, 0.0)),
        disk,
        net: Some((12_000.0, 3_000.0)),
        thermal: Some(Thermal::Nominal),
        battery: Some((false, 80)),
        low_power: false,
        procs: Some(vec![row(612, "WindowServer", 4.2, None, false, None), row(901, "coool", 1.1, None, false, None), row(733, "Safari", 0.8, None, false, None)]),
        procs_secs: 2.0,
        agents_cpu: None,
        agents: Agents { working: 0, needs: 0, done: 2, ..Default::default() },
        usage: usage.clone(),
    };
    let busy = Reading {
        cpu: Some(0.86),
        cores: vec![1.0, 0.98, 0.95, 0.99, 0.9, 0.84, 1.0, 0.97, 0.7, 0.66, 0.74, 0.61],
        history: wave(0.72, 30),
        load: Some([19.4, 14.2, 9.8]),
        memory: Some(mem(21.4, Pressure::Warning, 5.1)),
        net: Some((1_240_000.0, 86_000.0)),
        thermal: Some(Thermal::Serious),
        battery: Some((true, 41)),
        procs: Some(vec![
            row(4410, "rustc", 412.0, Some(owner("Port the renderer to wgpu 26", Cli::Claude)), false, None),
            row(4380, "cargo", 96.0, Some(owner("Add a rate limiter to the API", Cli::Codex)), false, None),
            row(3920, "claude", 14.2, Some(owner("Port the renderer to wgpu 26", Cli::Claude)), true, None),
            row(3988, "codex", 6.1, Some(owner("Add a rate limiter to the API", Cli::Codex)), true, None),
            row(2210, "claude", 3.4, None, false, Some(Cli::Claude)),
        ]),
        agents_cpu: Some(528.3),
        agents: Agents { working: 4, needs: 0, done: 1, ..Default::default() },
        ..idle.clone()
    };
    let needs = Reading {
        cpu: Some(0.34),
        history: wave(0.3, 30),
        cores: vec![0.5, 0.4, 0.45, 0.3, 0.2, 0.25, 0.3, 0.28, 0.4, 0.3, 0.35, 0.2],
        load: Some([5.2, 6.0, 6.3]),
        memory: Some(mem(16.8, Pressure::Normal, 1.2)),
        procs: Some(vec![
            row(5120, "node", 48.0, Some(owner("Add a rate limiter to the API", Cli::Claude)), false, None),
            row(5003, "claude", 9.4, Some(owner("Add a rate limiter to the API", Cli::Claude)), true, None),
            row(612, "WindowServer", 7.9, None, false, None),
        ]),
        agents_cpu: Some(57.4),
        agents: Agents {
            working: 2,
            needs: 2,
            done: 3,
            needing: vec![
                Need { key: Some("claude:a".into()), chat: None, title: "Clear the shader cache".into(), project: "pixelforge".into(), ask: "Waiting for you: permission to run `rm -rf target/shader-cache`".into() },
                Need { key: Some("claude:b".into()), chat: Some(2), title: "Why do invoices from March show the wrong month?".into(), project: "invoices".into(), ask: "Waiting for your answer".into() },
            ],
            ..Default::default()
        },
        ..idle.clone()
    };
    let none = Reading { agents: Agents::default(), procs: Some(vec![row(612, "WindowServer", 3.1, None, false, None), row(901, "coool", 0.6, None, false, None)]), usage: vec![Usage { cli: Cli::Claude, limits: vec![], stale: false }], ..idle.clone() };
    vec![("idle", idle), ("busy", busy), ("needs", needs), ("none", none)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentages_are_always_three_digits_wide() {
        for (v, s) in [(Some(0.0), "\u{2007}\u{2007}0%"), (Some(0.07), "\u{2007}\u{2007}7%"), (Some(0.424), "\u{2007}42%"), (Some(1.0), "100%"), (Some(1.7), "100%"), (Some(-0.2), "\u{2007}\u{2007}0%"), (None, "\u{2007}\u{2007}\u{2012}%"), (Some(f64::NAN), "\u{2007}\u{2007}\u{2012}%")] {
            assert_eq!(pct3(v), s, "{v:?}");
            assert_eq!(pct3(v).chars().count(), 4);
        }
        // Every reading from 0 to 100 has the same character count.
        assert!((0..=100).all(|i| pct3(Some(i as f64 / 100.0)).chars().count() == 4));
    }

    #[test]
    fn units() {
        assert_eq!(bytes_bin(21 * (1 << 30) + (1 << 29)), "21.5 GB");
        assert_eq!(bytes_bin(512 << 20), "512 MB");
        assert_eq!(bytes_bin(24 << 30), "24 GB");
        assert_eq!(bytes_bin(128 << 30), "128 GB");
        assert_eq!(bytes_dec(51_234_000_000), "51.2 GB");
        assert_eq!(bytes_dec(494_000_000_000), "494 GB");
        assert_eq!(bytes_dec(2_000_000_000_000), "2.0 TB");
        assert_eq!(rate(1_240_000.0), "1.2 MB/s");
        assert_eq!(rate(86_000.0), "86 KB/s");
        assert_eq!(proc_pct(412.3), "412%");
        assert_eq!(proc_pct(4.25), "4.2%");
        assert_eq!(spark(&[0.0, 0.5, 1.0, 2.0]), "▁▅██");
        assert_eq!(squeeze(&[0.0, 1.0, 0.5, 0.5, 1.0], 2), vec![0.5, 2.0 / 3.0]);
        assert_eq!(squeeze(&[0.1, 0.2], 15), vec![0.1, 0.2]);
        assert_eq!(squeeze(&[0.5; 30], 15).len(), 15);
    }

    #[test]
    fn the_sampler_backs_off_when_nobody_looks() {
        let active = Presence { idle_secs: Some(3.0), ..Default::default() };
        let s = |n| Some(Duration::from_secs(n));
        assert_eq!(interval(Mode::Cpu, false, &active), s(2));
        assert_eq!(interval(Mode::CpuMemory, false, &Presence { idle_secs: Some(90.0), ..active }), s(10));
        assert_eq!(interval(Mode::Cpu, false, &Presence { idle_secs: Some(600.0), ..active }), s(30));
        assert_eq!(interval(Mode::Cpu, false, &Presence { display_asleep: true, ..active }), None);
        assert_eq!(interval(Mode::Cpu, false, &Presence { locked: true, ..active }), None);
        // A bar that shows no figure reads nothing of the Mac until the menu opens.
        assert_eq!(interval(Mode::Nothing, false, &active), None);
        assert_eq!(interval(Mode::Needs, false, &active), None);
        assert_eq!(interval(Mode::Nothing, true, &Presence { idle_secs: Some(900.0), ..active }), s(2));
        assert_eq!(interval(Mode::Cpu, false, &Presence::default()), s(2), "unknown idle time: as if active");
    }

    #[test]
    fn the_bar_in_each_mode() {
        let all = demo_readings();
        let (idle, needs) = (&all[0].1, &all[2].1);
        let texts = |b: &Bar| b.segs.iter().map(|s| s.text.clone()).collect::<Vec<_>>();
        assert_eq!(texts(&bar(idle, Mode::Nothing, false)), Vec::<String>::new());
        assert_eq!(texts(&bar(idle, Mode::Cpu, false)), vec!["\u{2007}\u{2007}7%"]);
        assert_eq!(texts(&bar(idle, Mode::CpuMemory, false)), vec!["CPU", "\u{2007}\u{2007}7%", "MEM", "\u{2007}47%", "DISK", "\u{2007}\u{2007}51G"]);
        assert_eq!(texts(&bar(idle, Mode::Needs, false)), Vec::<String>::new());
        // The mark leads in every mode when a session needs the person.
        for m in [Mode::Nothing, Mode::Cpu, Mode::CpuMemory, Mode::Needs] {
            let b = bar(needs, m, false);
            assert_eq!((b.segs[0].kind, b.segs[0].text.as_str(), b.needs), (SegKind::Needs, "●", 2), "{m:?}");
        }
        assert_eq!(texts(&bar(needs, Mode::Needs, false)), vec!["●", "2"]);
        assert!(bar(needs, Mode::Cpu, false).tooltip.ends_with("2 sessions need you"));
        assert!(bar(idle, Mode::Cpu, true).tooltip.starts_with("coool self-test"));
    }

    #[test]
    fn the_menu_says_what_each_figure_is_and_hides_what_it_cannot_measure() {
        let all = demo_readings();
        let r = rows(&all[2].1);
        let stat = |id: &str| r.iter().find_map(|x| if let Row::Stat { id: i, value, tip, .. } = x { (i == id).then(|| (value.clone(), tip.clone())) } else { None });
        assert_eq!(stat("mem").unwrap().0, "16.8 GB of 24 GB used");
        assert!(stat("mem").unwrap().1.contains("Activity Monitor"));
        assert!(stat("disk").unwrap().1.contains("df"));
        assert_eq!(stat("agents").unwrap().0, "2 working · 2 need you · 3 done");
        let needs: Vec<_> = r.iter().filter_map(|x| if let Row::Need { title, open, .. } = x { Some((title.clone(), open.key.clone())) } else { None }).collect();
        assert_eq!(needs[0], ("Clear the shader cache — pixelforge".to_string(), Some("claude:a".to_string())));
        // No battery, no network reading, no memory: no rows that would make one up.
        let bare = Reading { battery: None, net: None, memory: None, disk: None, thermal: None, ..all[0].1.clone() };
        let ids: Vec<String> = rows(&bare).iter().map(|x| x.id()).collect();
        for gone in ["power", "net", "mem", "disk", "heat"] {
            assert!(!ids.contains(&gone.to_string()), "{gone} shown without a reading");
        }
        let first = Reading { cpu: None, procs: None, ..bare };
        let rs = rows(&first);
        assert!(rs.iter().any(|x| matches!(x, Row::Stat { id, value, .. } if id == "cpu" && value == "Measuring…")));
        assert!(rs.iter().any(|x| matches!(x, Row::Note { text } if text == "Measuring…")));
        // The actions, last.
        let acts: Vec<String> = rows(&all[3].1).iter().filter_map(|x| if let Row::Action { id, .. } = x { Some(id.clone()) } else { None }).collect();
        assert_eq!(acts, ["open", "new", "quit"]);
        assert!(rows(&all[3].1).iter().any(|x| matches!(x, Row::Stat { value, .. } if value == "No sessions running")));
    }

    /// The browser demo renders these exact rows (app/src/lib/menubarDemo.json). Regenerate after a change with
    /// `COOOL_WRITE_MENUBAR_DEMO=1 cargo test -p coool-app demo_fixture`.
    #[test]
    fn demo_fixture() {
        let modes = [Mode::Nothing, Mode::Cpu, Mode::CpuMemory, Mode::Needs];
        let v: serde_json::Value = demo_readings()
            .into_iter()
            .map(|(name, r)| {
                let bars: serde_json::Map<String, serde_json::Value> = modes.iter().map(|m| (serde_json::to_value(m).unwrap().as_str().unwrap().to_string(), serde_json::to_value(bar(&r, *m, false)).unwrap())).collect();
                (name.to_string(), serde_json::json!({ "bars": bars, "rows": rows(&r) }))
            })
            .collect::<serde_json::Map<_, _>>()
            .into();
        let text = serde_json::to_string_pretty(&v).unwrap() + "\n";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/menubarDemo.json");
        if std::env::var("COOOL_WRITE_MENUBAR_DEMO").is_ok_and(|v| v == "1") {
            std::fs::write(&path, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(on_disk == text, "app/src/lib/menubarDemo.json is out of date: COOOL_WRITE_MENUBAR_DEMO=1 cargo test -p coool-app demo_fixture");
    }
}
