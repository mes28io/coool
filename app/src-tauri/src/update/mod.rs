//! In-app updates: the same steps as scripts/install.sh, run by the app on itself.
//!
//! coool ships as an ad-hoc signed, un-notarised `coool.app` in `coool-macos-arm64.tar.gz` on the GitHub release of
//! `mes28io/coool`, next to `coool-macos-arm64.tar.gz.sha256` (scripts/package.sh). Tauri's updater plugin needs a
//! signing key pair and an update manifest of its own; this follows the install script instead:
//!
//! 1. Check: GET the latest release from GitHub's API, with a generic User-Agent and nothing else about the person.
//!    Only the tag and the two assets' names and URLs are read (never the release's title or notes); the tag must be
//!    proper semver and newer than the running version, and both URLs must sit under
//!    `https://github.com/mes28io/coool/releases/download/<tag>/`.
//! 2. Install (only when the person clicks, and only from a real `.app` whose folder is writable; never `tauri dev`):
//!    download into a folder next to the bundle (same volume), check the SHA-256, unpack, check the new bundle's id
//!    and version, `codesign --verify --deep --strict`, then swap it with the installed bundle in one atomic rename
//!    (`renamex_np(RENAME_SWAP)`). Any failure before the swap leaves the installed app as it was.
//! 3. Relaunch: a detached `sh` waits for this process to exit, then `open`s the bundle again.
//!
//! Tests (debug builds only) can point the check at a loopback server: `COOOL_UPDATE_BASE=http://127.0.0.1:<port>`.
//! A release build compiles that switch out.

use crate::Core;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtOrd};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub mod cli;
pub mod gate;

pub const ASSET: &str = "coool-macos-arm64.tar.gz";
const BUNDLE_ID: &str = "sh.coool.app";
const API_LATEST: &str = "https://api.github.com/repos/mes28io/coool/releases/latest";
const DOWNLOADS: &str = "https://github.com/mes28io/coool/releases/download/";
/// Generic on purpose: no version, machine or account in it.
const USER_AGENT: &str = "coool-updater";
const MAX_TARBALL: u64 = 512 * 1024 * 1024;
const MAX_JSON: u64 = 4 * 1024 * 1024;
const MAX_SUM: u64 = 4096;

// ---------- versions ----------

/// A semantic version (semver.org 2.0): MAJOR.MINOR.PATCH, an optional pre-release; build metadata is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<String>,
}

fn num(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    s.parse().ok()
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl Version {
    /// `1.2.3`, `v1.2.3`, `1.2.3-beta.2`, `1.2.3+build.5`. Anything else (`1.2`, `01.2.3`, spaces) is `None`.
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.strip_prefix('v').unwrap_or(s);
        let s = match s.split_once('+') {
            Some((v, build)) => {
                if !build.split('.').all(ident_ok) {
                    return None;
                }
                v
            }
            None => s,
        };
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut it = core.split('.');
        let (major, minor, patch) = (num(it.next()?)?, num(it.next()?)?, num(it.next()?)?);
        if it.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(p) => {
                let ids: Vec<String> = p.split('.').map(str::to_string).collect();
                for id in &ids {
                    // Numeric identifiers have no leading zeros (they may be longer than a u64).
                    if !ident_ok(id) || (id.bytes().all(|b| b.is_ascii_digit()) && id.len() > 1 && id.starts_with('0')) {
                        return None;
                    }
                }
                ids
            }
        };
        Some(Version { major, minor, patch, pre })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

fn cmp_ident(a: &str, b: &str) -> Ordering {
    let an = a.bytes().all(|c| c.is_ascii_digit());
    let bn = b.bytes().all(|c| c.is_ascii_digit());
    match (an, bn) {
        // No leading zeros (parse checks), so a longer number is a bigger one; no overflow on huge ones.
        (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(o.major, o.minor, o.patch)).then_with(|| match (self.pre.is_empty(), o.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            // A pre-release comes before its release.
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&o.pre) {
                    let c = cmp_ident(a, b);
                    if c != Ordering::Equal {
                        return c;
                    }
                }
                self.pre.len().cmp(&o.pre.len())
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

// ---------- where releases come from ----------

/// The release API and the only prefix download URLs may have.
#[derive(Debug, Clone)]
pub struct Source {
    pub api: String,
    pub downloads: String,
    /// The npm registry (the CLIs' newest versions, cli.rs).
    pub registry: String,
    /// Plain http is allowed (a loopback test server only).
    loopback: bool,
}

impl Source {
    pub fn github() -> Source {
        Source { api: API_LATEST.into(), downloads: DOWNLOADS.into(), registry: "https://registry.npmjs.org/".into(), loopback: false }
    }

    /// A test server on this Mac: exactly `http://127.0.0.1:<port>`, serving the same paths as GitHub.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn loopback(base: &str) -> Option<Source> {
        let port = base.strip_prefix("http://127.0.0.1:")?;
        num(port).filter(|p| (1..=65535).contains(p))?;
        Some(Source { api: format!("{base}/repos/mes28io/coool/releases/latest"), downloads: format!("{base}/mes28io/coool/releases/download/"), registry: format!("{base}/npm/"), loopback: true })
    }

    /// GitHub, or in a debug build a loopback server named by `COOOL_UPDATE_BASE`.
    pub fn current() -> Source {
        #[cfg(debug_assertions)]
        if let Some(s) = std::env::var("COOOL_UPDATE_BASE").ok().and_then(|b| Source::loopback(&b)) {
            return s;
        }
        Source::github()
    }

    /// `url` is exactly `<downloads><tag>/<name>`: no other host, path, query or fragment.
    pub fn allows(&self, url: &str, tag: &str, name: &str) -> bool {
        url.strip_prefix(&self.downloads).is_some_and(|rest| rest == format!("{tag}/{name}"))
    }

    fn agent(&self) -> ureq::Agent {
        self.agent_with(None)
    }

    /// `limit`: the longest a whole request may take (the launch checks); `None` for downloads.
    fn agent_with(&self, limit: Option<Duration>) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_connect(Some(limit.unwrap_or(Duration::from_secs(20))))
            .timeout_global(limit)
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .https_only(!self.loopback)
            .http_status_as_error(false)
            .build()
            .into()
    }
}

// ---------- checking ----------

/// A newer release that can be installed: its version and the two asset URLs (checked against the `Source`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Release {
    pub version: String,
    /// The release's tag, as its download URLs carry it.
    #[serde(skip)]
    pub tag: String,
    #[serde(skip)]
    pub tarball: String,
    #[serde(skip)]
    pub checksum: String,
}

/// Only these fields of GitHub's release object are read; the title, notes and the rest are ignored.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// The release the API answered, if it is newer than `current` and carries both assets at allowed URLs.
pub fn pick(json: &[u8], current: &Version, src: &Source) -> Result<Option<Release>, String> {
    let r: GhRelease = serde_json::from_slice(json).map_err(|_| "GitHub's answer wasn't a release.".to_string())?;
    if r.draft || r.prerelease {
        return Ok(None);
    }
    let tag = r.tag_name.trim();
    if tag.is_empty() || tag.len() > 64 || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b)) {
        return Ok(None);
    }
    let Some(v) = Version::parse(tag) else { return Ok(None) };
    // Never the same version or an older one.
    if v <= *current {
        return Ok(None);
    }
    let url = |name: &str| r.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone()).filter(|u| src.allows(u, tag, name));
    let sum_name = format!("{ASSET}.sha256");
    match (url(ASSET), url(&sum_name)) {
        (Some(tarball), Some(checksum)) => Ok(Some(Release { version: v.to_string(), tag: tag.to_string(), tarball, checksum })),
        _ => Ok(None),
    }
}

fn get(agent: &ureq::Agent, url: &str, accept: &str) -> Result<ureq::http::Response<ureq::Body>, String> {
    let resp = agent.get(url).header("User-Agent", USER_AGENT).header("Accept", accept).call().map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(format!("The server answered {status}."));
    }
    Ok(resp)
}

fn read_limited(resp: &mut ureq::http::Response<ureq::Body>, max: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    resp.body_mut().as_reader().take(max + 1).read_to_end(&mut out).map_err(|e| format!("Network error: {e}"))?;
    if out.len() as u64 > max {
        return Err("The answer was larger than expected.".into());
    }
    Ok(out)
}

/// Asks the release API for the latest release; `None` when there is nothing newer.
pub fn check(src: &Source, current: &Version, limit: Option<Duration>) -> Result<Option<Release>, String> {
    let agent = src.agent_with(limit);
    let mut resp = get(&agent, &src.api, "application/vnd.github+json")?;
    let body = read_limited(&mut resp, MAX_JSON)?;
    pick(&body, current, src)
}

// ---------- where coool runs from ----------

/// The `.app` an executable sits in (`X.app/Contents/MacOS/<exe>`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && app.extension()? == "app").then(|| app.to_path_buf())
}

fn writable(p: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// The bundle this process can replace, or why it can't update itself.
pub fn installable(exe: &Path) -> Result<PathBuf, String> {
    let exe = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
    let app = bundle_of(&exe).ok_or("coool isn't running from an app bundle, so it can't update itself.")?;
    if app.to_string_lossy().contains("/AppTranslocation/") {
        return Err("macOS is running coool from a read-only copy. Move coool.app into Applications, then try again.".into());
    }
    let dir = app.parent().ok_or("coool's folder can't be found.")?;
    if !writable(dir) || !writable(&app) {
        return Err(format!("coool can't replace itself in {}. Update with the install command instead.", dir.display()));
    }
    Ok(app)
}

// ---------- installing ----------

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Download,
    Verify,
    Install,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: Phase,
    pub done: u64,
    pub total: Option<u64>,
}

/// The staging folder next to the bundle; removed (with the old bundle in it, after a swap) when dropped.
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The hash in a `shasum -a 256` line (`<64 hex>  <name>`), lower-cased.
pub fn parse_sum(text: &str) -> Option<String> {
    let h = text.split_whitespace().next()?;
    (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
}

/// Streams `url` into `dest`, returning the SHA-256 of what was written.
fn download(agent: &ureq::Agent, url: &str, dest: &Path, progress: &mut dyn FnMut(Progress)) -> Result<String, String> {
    let mut resp = get(agent, url, "application/octet-stream")?;
    let total = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if total.is_some_and(|t| t > MAX_TARBALL) {
        return Err("The download is larger than expected.".into());
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("Can't write {}: {e}", dest.display()))?;
    let mut body = resp.body_mut().as_reader();
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    progress(Progress { phase: Phase::Download, done, total });
    loop {
        let n = body.read(&mut buf).map_err(|e| format!("The download was interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > MAX_TARBALL {
            return Err("The download is larger than expected.".into());
        }
        h.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("Can't write {}: {e}", dest.display()))?;
        if last.elapsed() >= Duration::from_millis(150) {
            last = std::time::Instant::now();
            progress(Progress { phase: Phase::Download, done, total });
        }
    }
    if total.is_some_and(|t| t != done) {
        return Err("The download was cut off.".into());
    }
    file.sync_all().map_err(|e| e.to_string())?;
    progress(Progress { phase: Phase::Download, done, total: Some(done) });
    Ok(hex(&h.finalize()))
}

fn plist_value(app: &Path, key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/plutil").args(["-extract", key, "raw", "-o", "-"]).arg(app.join("Contents/Info.plist")).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The version an installed bundle says it is.
pub fn bundle_version(app: &Path) -> Option<String> {
    plist_value(app, "CFBundleShortVersionString")
}

/// Checks a bundle unpacked from a release before it may replace the installed one.
pub fn verify_bundle(app: &Path, version: &str) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(app).map_err(|_| "The download doesn't contain coool.app.".to_string())?;
    if !meta.is_dir() {
        return Err("The download doesn't contain coool.app.".into());
    }
    let exe = app.join("Contents/MacOS/coool");
    let exe_ok = std::fs::symlink_metadata(&exe).is_ok_and(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    });
    if !exe_ok {
        return Err("The download doesn't contain coool.app.".into());
    }
    if plist_value(app, "CFBundleIdentifier").as_deref() != Some(BUNDLE_ID) {
        return Err("The downloaded app isn't coool.".into());
    }
    let v = bundle_version(app).and_then(|v| Version::parse(&v));
    if v.is_none() || v != Version::parse(version) {
        return Err("The downloaded app isn't the version the release says.".into());
    }
    let ok = std::process::Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(app).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
    if !ok {
        return Err("The downloaded app's signature didn't verify.".into());
    }
    Ok(())
}

fn cpath(p: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
}

/// Puts `new` at `dest` and the old `dest` at `new`'s path, in one step where the volume can (APFS can), else in two
/// renames that put the old one back if the second fails. `dest` is never left missing on failure.
pub fn swap(new: &Path, dest: &Path) -> std::io::Result<()> {
    if !dest.exists() {
        return std::fs::rename(new, dest);
    }
    #[cfg(target_os = "macos")]
    {
        let (a, b) = (cpath(new)?, cpath(dest)?);
        // SAFETY: valid NUL-terminated paths.
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        if !matches!(e.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EINVAL)) {
            return Err(e);
        }
    }
    let aside = new.with_file_name(format!("{}.old", new.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    std::fs::rename(dest, &aside)?;
    if let Err(e) = std::fs::rename(new, dest) {
        let _ = std::fs::rename(&aside, dest);
        return Err(e);
    }
    std::fs::rename(&aside, new)
}

/// `<folder>/.coool-update`: the verified next version (`coool.app`) and the work folders of downloads.
pub fn update_dir(app: &Path) -> Option<PathBuf> {
    app.parent().map(|d| d.join(".coool-update"))
}

/// The verified next version waiting beside the installed bundle, if any.
pub fn staged_path(app: &Path) -> Option<PathBuf> {
    update_dir(app).map(|d| d.join("coool.app")).filter(|p| p.join("Contents/Info.plist").is_file())
}

/// Downloads, checks and unpacks `rel`, and keeps the verified bundle beside the installed one
/// (`.coool-update/coool.app`). The installed bundle, and so the running app, is never touched: the swap happens
/// at restart, at quit or at the next launch (`apply_staged`). Any error leaves no new staged bundle behind.
pub fn stage(src: &Source, rel: &Release, app: &Path, progress: &mut dyn FnMut(Progress)) -> Result<PathBuf, String> {
    if !src.allows(&rel.tarball, &rel.tag, ASSET) || !src.allows(&rel.checksum, &rel.tag, &format!("{ASSET}.sha256")) {
        return Err("That download isn't from coool's releases.".into());
    }
    let root = update_dir(app).ok_or("coool's folder can't be found.")?;
    std::fs::create_dir_all(&root).map_err(|e| format!("Can't write to {}: {e}", root.display()))?;
    // Work folders left by an interrupted download (any process) go first.
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("work-") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let work = Staging(root.join(format!("work-{}", std::process::id())));
    std::fs::create_dir(&work.0).map_err(|e| format!("Can't write to {}: {e}", root.display()))?;
    let agent = src.agent();

    let mut resp = get(&agent, &rel.checksum, "text/plain")?;
    let want = parse_sum(&String::from_utf8_lossy(&read_limited(&mut resp, MAX_SUM)?)).ok_or("The release's checksum file is malformed.")?;
    let tarball = work.0.join(ASSET);
    let got = download(&agent, &rel.tarball, &tarball, progress)?;
    progress(Progress { phase: Phase::Verify, done: 0, total: None });
    if got != want {
        return Err("The download didn't match its published checksum.".into());
    }
    let x = work.0.join("x");
    std::fs::create_dir(&x).map_err(|e| e.to_string())?;
    let ok = std::process::Command::new("/usr/bin/tar").arg("-xzf").arg(&tarball).arg("-C").arg(&x).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
    if !ok {
        return Err("The download couldn't be unpacked.".into());
    }
    let new = x.join("coool.app");
    verify_bundle(&new, &rel.version)?;
    let _ = std::process::Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&new).stderr(std::process::Stdio::null()).status();
    progress(Progress { phase: Phase::Install, done: 0, total: None });
    // Replaces an older staged version in one step (a staged bundle is either whole or absent).
    let dest = root.join("coool.app");
    swap(&new, &dest).map_err(|e| format!("Can't write to {}: {e}", root.display()))?;
    Ok(dest)
}

/// Swaps the staged bundle in, if there is one newer than `running` that still verifies; it is removed otherwise.
/// Returns the version now installed. Called before anything runs (launch), on Restart, and as the app quits.
pub fn apply_staged(app: &Path, running: &Version) -> Result<Option<String>, String> {
    let Some(staged) = staged_path(app) else { return Ok(None) };
    let root = update_dir(app).ok_or("coool's folder can't be found.")?;
    let v = bundle_version(&staged).and_then(|v| Version::parse(&v));
    let Some(v) = v.filter(|v| v > running) else {
        let _ = std::fs::remove_dir_all(&root);
        return Ok(None);
    };
    if let Err(e) = verify_bundle(&staged, &v.to_string()) {
        let _ = std::fs::remove_dir_all(&root);
        return Err(e);
    }
    swap(&staged, app).map_err(|e| format!("Can't replace {}: {e}", app.display()))?;
    // `staged` now holds the old bundle.
    let _ = std::fs::remove_dir_all(&root);
    Ok(Some(v.to_string()))
}

/// After this process exits, open the bundle again (a detached shell, so it outlives us).
fn relaunch(app: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$2\"")
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
}

// ---------- the app's side ----------

/// How long the launch checks may take together.
const CHECK_BUDGET: Duration = Duration::from_secs(5);
/// The longest chats wait at launch for the updater, whatever it is doing.
const GATE_MAX: Duration = Duration::from_secs(15);
/// The longest a CLI update may run (its process group is killed after).
const CLI_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A chat of a CLI being updated waits at most this long for it.
const CLI_HOLD_MAX: Duration = Duration::from_secs(5 * 60 + 10);
const RECHECK: Duration = Duration::from_secs(6 * 3600);
/// After a quiet failure (offline, a broken download), the next try.
const RETRY: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    /// Not checked (yet), or the check failed quietly.
    Unknown,
    Checking,
    Current,
    /// Newer exists. coool: automatic updates are off (the action downloads it). A CLI: the action updates it.
    Available,
    Downloading,
    Installing,
    /// coool: installed beside the running app; restart to apply.
    Staged,
    /// A CLI update held back: its processes are running.
    Waiting,
    /// Needs a command the person runs (`command`).
    Manual,
    Failed,
    /// The CLI isn't installed.
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: &'static str,
    pub name: &'static str,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub state: ItemState,
    /// A plain line: why it waits, what failed.
    pub detail: Option<String>,
    /// A command to run in Terminal (manual updates, repairs).
    pub command: Option<String>,
    /// How the CLI is installed ("npm", "standalone installer"...).
    pub method: Option<String>,
    pub progress: Option<Progress>,
}

impl Item {
    fn new(id: &'static str, name: &'static str) -> Item {
        Item { id, name, current: None, latest: None, state: ItemState::Unknown, detail: None, command: None, method: None, progress: None }
    }
}

#[derive(Clone, Serialize)]
pub struct Status {
    /// coool, Claude Code, Codex.
    items: Vec<Item>,
    /// Keep coool up to date (Settings > General).
    auto_app: bool,
    /// Keep Claude Code and Codex up to date.
    auto_cli: bool,
    /// Chats may start (the launch step finished or timed out).
    gate_open: bool,
    /// Epoch ms of the last check.
    checked_at: Option<u64>,
    /// Why this copy of coool can't update itself, if so.
    blocked: Option<String>,
}

pub struct Updater {
    items: Mutex<[Item; 3]>,
    latest: Mutex<Option<Release>>,
    checked_at: Mutex<Option<u64>>,
    /// A coool download is under way.
    busy: AtomicBool,
    /// Per CLI: an update is under way.
    cli_busy: [AtomicBool; 2],
    pub gate: gate::Gate,
    /// Debug builds: look for the CLIs only in this folder (`COOOL_UPDATE_CLI_DIR`, the tests' stand-ins).
    cli_dir: Option<PathBuf>,
    /// May update the CLIs at all (never in `tauri dev`, nor in a self-test unless it brings stand-ins).
    cli_writes: bool,
    /// May check coool itself (a self-test only with a loopback server).
    app_checks: bool,
}

impl Updater {
    pub fn new(selftest: bool) -> Updater {
        #[cfg(debug_assertions)]
        let cli_dir = std::env::var_os("COOOL_UPDATE_CLI_DIR").map(PathBuf::from).filter(|p| p.is_dir());
        #[cfg(not(debug_assertions))]
        let cli_dir: Option<PathBuf> = None;
        #[cfg(debug_assertions)]
        let loop_src = std::env::var("COOOL_UPDATE_BASE").ok().and_then(|b| Source::loopback(&b)).is_some();
        #[cfg(not(debug_assertions))]
        let loop_src = false;
        Updater {
            items: Mutex::new([Item::new("coool", "coool"), Item::new("claude", "Claude Code"), Item::new("codex", "Codex")]),
            latest: Mutex::new(None),
            checked_at: Mutex::new(None),
            busy: AtomicBool::new(false),
            cli_busy: [AtomicBool::new(false), AtomicBool::new(false)],
            gate: gate::Gate::new(GATE_MAX),
            cli_writes: if selftest || tauri::is_dev() { cli_dir.is_some() } else { true },
            app_checks: !selftest || loop_src,
            cli_dir,
        }
    }

    fn set(&self, app: &AppHandle, i: usize, f: impl FnOnce(&mut Item)) {
        f(&mut self.items.lock().unwrap()[i]);
        let _ = app.emit("update-state", self.status(app));
    }

    fn state(&self, i: usize) -> ItemState {
        self.items.lock().unwrap()[i].state
    }

    fn status(&self, app: &AppHandle) -> Status {
        let core = app.state::<Arc<Core>>();
        let s = crate::settings::load(core.selftest.as_ref());
        let mut items = self.items.lock().unwrap().to_vec();
        items[0].current = Some(app.package_info().version.to_string());
        Status { items, auto_app: s.update_checks, auto_cli: s.update_clis, gate_open: self.gate.is_open(), checked_at: *self.checked_at.lock().unwrap(), blocked: blocked() }
    }
}

fn running_version(app: &AppHandle) -> Version {
    let v = app.package_info().version.to_string();
    Version::parse(&v).unwrap_or(Version { major: 0, minor: 0, patch: 0, pre: vec![] })
}

fn blocked() -> Option<String> {
    if tauri::is_dev() {
        return Some("This is a development build: it doesn't update itself.".into());
    }
    match std::env::current_exe() {
        Ok(exe) => installable(&exe).err(),
        Err(_) => Some("coool's own location can't be found.".into()),
    }
}

/// The bundle this process may update, when it may.
fn own_bundle() -> Option<PathBuf> {
    if tauri::is_dev() {
        return None;
    }
    installable(&std::env::current_exe().ok()?).ok()
}

fn up(app: &AppHandle) -> Arc<Updater> {
    app.state::<Arc<Updater>>().inner().clone()
}

/// Before a chat or terminal session starts: wait (bounded) for the launch step, and for an update of its CLI.
pub fn hold(app: &AppHandle, provider: coool_core::model::Provider) {
    let i = match provider {
        coool_core::model::Provider::Claude => 0,
        coool_core::model::Provider::Codex => 1,
    };
    up(app).gate.wait(Some(i), CLI_HOLD_MAX);
}

/// Checks coool; `Err` (quietly) when offline.
fn check_app(u: &Updater, app: &AppHandle, limit: Option<Duration>) -> Result<Option<Release>, String> {
    if !u.app_checks {
        return Err("not checked".into());
    }
    let found = check(&Source::current(), &running_version(app), limit)?;
    *u.latest.lock().unwrap() = found.clone();
    Ok(found)
}

/// Where a CLI stands: installed version and method, the newest version.
struct CliCheck {
    probe: Option<cli::Probe>,
    latest: Result<Version, String>,
}

fn check_cli(u: &Updater, c: cli::Cli, limit: Duration) -> CliCheck {
    let probe = cli::probe(c, u.cli_dir.as_deref());
    let latest = if probe.is_some() { cli::latest(&Source::current(), c, limit) } else { Err("not installed".into()) };
    CliCheck { probe, latest }
}

fn show_cli(u: &Updater, app: &AppHandle, c: cli::Cli, r: &CliCheck) {
    let i = 1 + c.index();
    u.set(app, i, |it| {
        it.progress = None;
        it.detail = None;
        it.command = None;
        let Some(p) = &r.probe else {
            *it = Item { state: ItemState::Missing, ..Item::new(it.id, it.name) };
            return;
        };
        it.method = Some(p.method.label().into());
        it.current = p.version.as_ref().map(|v| v.to_string());
        it.latest = r.latest.as_ref().ok().map(|v| v.to_string());
        it.state = match (&p.version, &r.latest) {
            (None, _) => {
                it.detail = Some(p.error.clone().unwrap_or_else(|| format!("{} doesn't start.", c.name())));
                it.command = Some(cli::repair(c, &p.method));
                ItemState::Failed
            }
            (Some(_), Err(_)) => ItemState::Unknown,
            (Some(have), Ok(new)) if new > have => {
                let plan = cli::plan(c, &p.method, &p.bin, &new.to_string(), crate::env::which("npm").as_deref());
                if plan.argv.is_none() || !u.cli_writes {
                    it.detail = plan.manual.clone().or_else(|| Some("This build of coool doesn't update the CLIs.".into()));
                    it.command = Some(plan.shown);
                    ItemState::Manual
                } else {
                    ItemState::Available
                }
            }
            (Some(_), Ok(_)) => ItemState::Current,
        };
    });
}

fn running_of(u: &Updater, c: cli::Cli) -> Option<usize> {
    match &u.cli_dir {
        // With stand-ins (tests), only their own processes count.
        Some(d) => {
            let out = std::process::Command::new("/bin/ps").args(["-axo", "pid=,args="]).output().ok()?;
            let ps = String::from_utf8_lossy(&out.stdout).into_owned();
            let d = d.to_string_lossy().into_owned();
            let mine: String = ps.lines().filter(|l| l.contains(&d)).map(|l| format!("{l}\n")).collect();
            Some(cli::count_running(&mine, c, std::process::id()))
        }
        None => cli::running(c),
    }
}

/// Updates a CLI when no process of it runs; else marks it waiting. Blocking (run it on a thread of its own).
fn update_cli(u: &Updater, app: &AppHandle, c: cli::Cli) {
    let i = 1 + c.index();
    if !u.cli_writes {
        return;
    }
    let Some(p) = cli::probe(c, u.cli_dir.as_deref()) else { return };
    let Some(latest) = u.items.lock().unwrap()[i].latest.clone() else { return };
    let plan = cli::plan(c, &p.method, &p.bin, &latest, crate::env::which("npm").as_deref());
    if plan.argv.is_none() || u.cli_busy[c.index()].swap(true, AtOrd::SeqCst) {
        return;
    }
    // Chats of this CLI wait from here on (gate), so none starts between the count and the update.
    u.gate.set_busy(c.index(), true);
    let done = |state: ItemState, detail: Option<String>, command: Option<String>| {
        u.gate.set_busy(c.index(), false);
        u.cli_busy[c.index()].store(false, AtOrd::SeqCst);
        u.set(app, i, |it| {
            it.state = state;
            it.detail = detail;
            it.command = command;
        });
    };
    let n = running_of(u, c);
    if n != Some(0) {
        let why = match n {
            Some(1) => format!("1 {} session is running. It updates once none are.", c.name()),
            Some(n) => format!("{n} {} sessions are running. It updates once none are.", c.name()),
            None => "coool couldn't tell whether it's in use, so it waits.".into(),
        };
        return done(ItemState::Waiting, Some(why), Some(plan.shown));
    }
    u.set(app, i, |it| {
        it.state = ItemState::Installing;
        it.detail = None;
    });
    let ran = cli::run(&plan, CLI_TIMEOUT);
    let works = cli::probe(c, u.cli_dir.as_deref()).and_then(|a| a.version);
    match (ran, works) {
        (Ok(()), Some(v)) => {
            u.set(app, i, |it| it.current = Some(v.to_string()));
            if Version::parse(&latest).is_some_and(|l| v < l) {
                done(ItemState::Failed, Some(format!("The update ran, but {} still reports {v}.", c.name())), Some(plan.shown))
            } else {
                done(ItemState::Current, None, None)
            }
        }
        (r, None) => done(
            ItemState::Failed,
            Some(format!("{} doesn't start after the update{}. Run this in Terminal to repair it:", c.name(), r.err().map(|e| format!(" ({e})")).unwrap_or_default())),
            Some(cli::repair(c, &p.method)),
        ),
        (Err(e), Some(_)) => done(ItemState::Failed, Some(format!("{e} {} still works as it was.", c.name())), Some(plan.shown)),
    }
}

/// Downloads and stages coool's newer version. A failure is quiet: back to "available", retried later.
fn stage_app(u: &Updater, app: &AppHandle) -> bool {
    let Some(bundle) = own_bundle() else { return false };
    let Some(rel) = u.latest.lock().unwrap().clone() else { return false };
    if staged_path(&bundle).and_then(|s| bundle_version(&s)).as_deref() == Some(rel.version.as_str()) {
        u.set(app, 0, |it| it.state = ItemState::Staged);
        return true;
    }
    if u.busy.swap(true, AtOrd::SeqCst) {
        return false;
    }
    u.set(app, 0, |it| {
        it.state = ItemState::Downloading;
        it.latest = Some(rel.version.clone());
        it.detail = None;
    });
    let r = stage(&Source::current(), &rel, &bundle, &mut |p| {
        let st = if p.phase == Phase::Download { ItemState::Downloading } else { ItemState::Installing };
        u.set(app, 0, |it| {
            it.state = st;
            it.progress = Some(p);
        })
    });
    u.busy.store(false, AtOrd::SeqCst);
    let ok = r.is_ok();
    u.set(app, 0, |it| {
        it.progress = None;
        it.state = if ok { ItemState::Staged } else { ItemState::Available };
        it.detail = r.err();
    });
    ok
}

type Answer = (usize, Option<CliCheck>, Option<Result<Option<Release>, String>>);

/// All three at once, each request bounded by `limit`. Returns coool's newer release, if any.
fn check_all(u: &Arc<Updater>, app: &AppHandle, limit: Duration) -> Option<Release> {
    for i in 0..3 {
        u.set(app, i, |it| {
            if matches!(it.state, ItemState::Unknown | ItemState::Current) {
                it.state = ItemState::Checking;
            }
        });
    }
    let (tx, rx) = std::sync::mpsc::channel::<Answer>();
    {
        let (u, app, tx) = (u.clone(), app.clone(), tx.clone());
        std::thread::spawn(move || {
            let _ = tx.send((0, None, Some(check_app(&u, &app, Some(limit)))));
        });
    }
    for c in cli::Cli::ALL {
        let (u, tx) = (u.clone(), tx.clone());
        std::thread::spawn(move || {
            let _ = tx.send((1 + c.index(), Some(check_cli(&u, c, limit)), None));
        });
    }
    drop(tx);
    // `--version` has its own limit (prefs::clis::TIMEOUT); the whole check never takes longer than this.
    let deadline = std::time::Instant::now() + limit + Duration::from_secs(1);
    let mut found = None;
    let mut seen = [false; 3];
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Ok((i, cli_r, app_r)) = rx.recv_timeout(left) else { break };
        seen[i] = true;
        if let Some(r) = cli_r {
            show_cli(u, app, cli::Cli::ALL[i - 1], &r);
        }
        if let Some(r) = app_r {
            let staged = own_bundle().and_then(|b| staged_path(&b)).and_then(|s| bundle_version(&s));
            u.set(app, 0, |it| {
                if matches!(it.state, ItemState::Downloading | ItemState::Installing) {
                    return;
                }
                it.state = match &r {
                    Ok(Some(rel)) => {
                        it.latest = Some(rel.version.clone());
                        found = Some(rel.clone());
                        if staged.as_deref() == Some(rel.version.as_str()) { ItemState::Staged } else { ItemState::Available }
                    }
                    _ if staged.is_some() => ItemState::Staged,
                    Ok(None) => ItemState::Current,
                    Err(_) => ItemState::Unknown,
                };
            });
        }
    }
    // What didn't answer in time is unknown (quietly).
    for (i, s) in seen.iter().enumerate() {
        if !s {
            u.set(app, i, |it| {
                if it.state == ItemState::Checking {
                    it.state = ItemState::Unknown;
                }
            });
        }
    }
    *u.checked_at.lock().unwrap() = Some(crate::perf::now_ms());
    found
}

/// Starts the updates of the CLIs that have one (or were held), each on a thread.
fn spawn_cli_updates(u: &Arc<Updater>, app: &AppHandle) -> Vec<std::thread::JoinHandle<()>> {
    cli::Cli::ALL
        .into_iter()
        .filter(|c| matches!(u.state(1 + c.index()), ItemState::Available | ItemState::Waiting))
        .map(|c| {
            let (u, app) = (u.clone(), app.clone());
            std::thread::spawn(move || update_cli(&u, &app, c))
        })
        .collect()
}

/// The launch step (a thread started in setup): apply a staged coool, check all three, update what may be
/// updated, then let chats start. Chats wait for it at most `GATE_MAX`, and the gate opens however it ends.
pub fn spawn_launch(app: AppHandle) {
    std::thread::spawn(move || {
        let u = up(&app);
        let core = app.state::<Arc<Core>>().inner().clone();
        {
            struct Open<'a>(&'a gate::Gate);
            impl Drop for Open<'_> {
                fn drop(&mut self) {
                    self.0.open();
                }
            }
            let _open = Open(&u.gate);
            if launch_step(&u, &app, &core) {
                return;
            }
        }
        let _ = app.emit("update-state", u.status(&app));
        // Then: a check every few hours, and held CLI updates retried every minute.
        let mut next = std::time::Instant::now() + if u.state(0) == ItemState::Available { RETRY } else { RECHECK };
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let s = crate::settings::load(core.selftest.as_ref());
            if std::time::Instant::now() >= next {
                let rel = if s.update_checks || s.update_clis { check_all(&u, &app, Duration::from_secs(20)) } else { None };
                let ok = rel.is_none() || !s.update_checks || stage_app(&u, &app);
                next = std::time::Instant::now() + if ok { RECHECK } else { RETRY };
            }
            if s.update_clis {
                spawn_cli_updates(&u, &app);
            }
        }
    });
}

/// The bounded part of the launch. `true`: coool is restarting into a new version.
fn launch_step(u: &Arc<Updater>, app: &AppHandle, core: &Arc<Core>) -> bool {
    let s = crate::settings::load(core.selftest.as_ref());
    let selftest = core.selftest.is_some();
    let restart = |b: &Path| {
        if selftest || relaunch(b).is_err() {
            return false;
        }
        core.allow_exit.store(true, AtOrd::SeqCst);
        app.exit(0);
        true
    };
    // 1. A version staged last time and not applied (a crash, a force quit).
    if let Some(b) = own_bundle()
        && let Ok(Some(_)) = apply_staged(&b, &running_version(app))
        && restart(&b)
    {
        return true;
    }
    // 2. The checks.
    let rel = if s.update_checks || s.update_clis { check_all(u, app, CHECK_BUDGET) } else { None };
    // 3. coool: download and install now, and restart into it if that's done while chats still wait. A download
    //    that runs long carries on in the background and ends as "restart to apply".
    if rel.is_some() && s.update_checks && own_bundle().is_some() {
        let (u2, app2) = (u.clone(), app.clone());
        let h = std::thread::spawn(move || stage_app(&u2, &app2));
        while !h.is_finished() && !u.gate.is_open() {
            std::thread::sleep(Duration::from_millis(100));
        }
        if h.is_finished()
            && !u.gate.is_open()
            && h.join().unwrap_or(false)
            && core.running() == 0
            && let Some(b) = own_bundle()
            && let Ok(Some(_)) = apply_staged(&b, &running_version(app))
            && restart(&b)
        {
            return true;
        }
    }
    // 4. The CLIs (they may take longer than the gate: then only their own chats keep waiting).
    if s.update_clis {
        let hs = spawn_cli_updates(u, app);
        while hs.iter().any(|h| !h.is_finished()) && !u.gate.is_open() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    false
}

/// As the app quits: a staged version goes in, so it is what opens next time.
pub fn on_exit(app: &AppHandle) {
    if let Some(b) = own_bundle() {
        let _ = apply_staged(&b, &running_version(app));
    }
}

#[tauri::command(async)]
pub fn update_status(app: AppHandle) -> Status {
    up(&app).status(&app)
}

/// "Check now" (Settings, the panel): checks all three, then installs what the switches allow, in the background.
#[tauri::command(async)]
pub fn update_check(app: AppHandle, core: State<'_, Arc<Core>>) -> Status {
    let u = up(&app);
    let rel = check_all(&u, &app, Duration::from_secs(10));
    let s = crate::settings::load(core.selftest.as_ref());
    if rel.is_some() && s.update_checks {
        let (u, app) = (u.clone(), app.clone());
        std::thread::spawn(move || stage_app(&u, &app));
    }
    if s.update_clis {
        spawn_cli_updates(&u, &app);
    }
    u.status(&app)
}

/// Settings' switches: `app` keeps coool up to date, `cli` Claude Code and Codex.
#[tauri::command(async)]
pub fn update_set_auto(core: State<'_, Arc<Core>>, app: Option<bool>, cli: Option<bool>) -> Result<(), String> {
    let mut s = crate::settings::load(core.selftest.as_ref());
    if let Some(a) = app {
        s.update_checks = a;
    }
    if let Some(c) = cli {
        s.update_clis = c;
    }
    crate::settings::save(core.selftest.as_ref(), &s).map_err(|e| e.to_string())
}

/// Downloads and stages coool's newer version now (with automatic updates off). Never a URL from the page: the
/// release the last check found.
#[tauri::command(async)]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    if let Some(why) = blocked() {
        return Err(why);
    }
    let u = up(&app);
    if u.latest.lock().unwrap().is_none() {
        return Err("There's no update to install. Check again.".into());
    }
    if stage_app(&u, &app) { Ok(()) } else { Err(u.items.lock().unwrap()[0].detail.clone().unwrap_or_else(|| "The update couldn't be installed.".into())) }
}

/// Updates one CLI now ("claude" or "codex"), unless its sessions are running (then it waits).
#[tauri::command(async)]
pub fn update_cli_now(app: AppHandle, provider: String) -> Result<(), String> {
    let c = cli::Cli::ALL.into_iter().find(|c| c.id() == provider).ok_or("unknown CLI")?;
    let u = up(&app);
    if !u.cli_writes {
        return Err("This build of coool doesn't update the CLIs.".into());
    }
    update_cli(&u, &app, c);
    Ok(())
}

/// Restart into the staged version: stop what coool runs (as Quit does), swap it in, open it again.
#[tauri::command(async)]
pub fn update_restart(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<(), String> {
    let bundle = own_bundle().ok_or_else(|| blocked().unwrap_or_else(|| "coool can't update itself here.".into()))?;
    if staged_path(&bundle).is_none() {
        return Err("No update is waiting. Check again.".into());
    }
    apply_staged(&bundle, &running_version(&app))?;
    if core.selftest.is_none() {
        relaunch(&bundle).map_err(|e| format!("coool was updated, but couldn't restart itself ({e}). Quit and open it again."))?;
    }
    core.allow_exit.store(true, AtOrd::SeqCst);
    core.hub.lock().unwrap().kill_all();
    app.exit(0);
    Ok(())
}

/// `coool --coool-update-selftest <stage|apply|version>` (debug builds only): the steps above on this executable's
/// own bundle, without the UI and without relaunching, against `COOOL_UPDATE_BASE`.
#[cfg(debug_assertions)]
pub fn selftest_cli(args: &[String]) -> i32 {
    let current = env!("CARGO_PKG_VERSION");
    let cmd = args.first().map(String::as_str).unwrap_or("stage");
    if cmd == "version" {
        println!("{current}");
        return 0;
    }
    let src = Source::current();
    let app = match std::env::current_exe().map_err(|e| e.to_string()).and_then(|e| installable(&e)) {
        Ok(a) => a,
        Err(e) => {
            println!("blocked={e}");
            return 1;
        }
    };
    println!("current={current} bundle={}", app.display());
    let cur = Version::parse(current).expect("own version");
    if cmd == "apply" {
        return match apply_staged(&app, &cur) {
            Ok(v) => {
                println!("applied={v:?} installed={}", bundle_version(&app).unwrap_or_default());
                0
            }
            Err(e) => {
                println!("error={e}");
                1
            }
        };
    }
    let rel = match check(&src, &cur, Some(CHECK_BUDGET)) {
        Ok(Some(r)) => r,
        Ok(None) => {
            println!("latest=none");
            return 0;
        }
        Err(e) => {
            println!("error={e}");
            return 1;
        }
    };
    println!("latest={} tarball={}", rel.version, rel.tarball);
    let mut last = None;
    match stage(&src, &rel, &app, &mut |p| {
        if last != Some(p.phase) || p.total == Some(p.done) {
            println!("progress={:?} {}/{:?}", p.phase, p.done, p.total);
            last = Some(p.phase);
        }
    }) {
        Ok(s) => {
            println!("staged={} version={}", s.display(), bundle_version(&s).unwrap_or_default());
            0
        }
        Err(e) => {
            println!("error={e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn versions_parse_strictly() {
        assert_eq!(v("v1.2.3"), Version { major: 1, minor: 2, patch: 3, pre: vec![] });
        assert_eq!(v("1.2.3-beta.2+build.7").pre, vec!["beta", "2"]);
        for bad in ["", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "1.2.3-a..b", "1.2.3+", " 1.2.3", "1.2.3 ", "vv1.2.3", "1.2.x", "-1.2.3", "1.2.3-é"] {
            assert!(Version::parse(bad).is_none(), "{bad:?} should not parse");
        }
        assert_eq!(v("1.2.3-rc.1").to_string(), "1.2.3-rc.1");
    }

    #[test]
    fn versions_compare_as_semver() {
        // The spec's own example order.
        let order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"];
        for w in order.windows(2) {
            assert!(v(w[0]) < v(w[1]), "{} < {}", w[0], w[1]);
        }
        assert_eq!(v("0.1.0").cmp(&v("v0.1.0+meta")), Ordering::Equal);
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("0.1.10") > v("0.1.9"));
        assert!(v("1.0.0-2") < v("1.0.0-10"));
        assert!(v("1.0.0-99999999999999999999999") > v("1.0.0-1"));
    }

    fn release_json(tag: &str, urls: &[(&str, &str)]) -> Vec<u8> {
        let assets: Vec<_> = urls.iter().map(|(n, u)| serde_json::json!({ "name": n, "browser_download_url": u })).collect();
        serde_json::to_vec(&serde_json::json!({ "tag_name": tag, "name": "Release `rm -rf ~`", "body": "see https://evil.example/x.sh", "draft": false, "prerelease": false, "assets": assets })).unwrap()
    }

    fn gh(tag: &str) -> Vec<u8> {
        let base = format!("https://github.com/mes28io/coool/releases/download/{tag}/");
        release_json(tag, &[(ASSET, &format!("{base}{ASSET}")), ("coool-macos-arm64.tar.gz.sha256", &format!("{base}{ASSET}.sha256"))])
    }

    #[test]
    fn picks_only_newer_releases() {
        let src = Source::github();
        let cur = v("0.2.0");
        let r = pick(&gh("v0.3.0"), &cur, &src).unwrap().unwrap();
        assert_eq!(r.version, "0.3.0");
        assert_eq!(r.tarball, "https://github.com/mes28io/coool/releases/download/v0.3.0/coool-macos-arm64.tar.gz");
        assert!(pick(&gh("v0.2.0"), &cur, &src).unwrap().is_none(), "same version");
        assert!(pick(&gh("v0.1.9"), &cur, &src).unwrap().is_none(), "downgrade");
        assert!(pick(&gh("v0.2.0-rc.1"), &cur, &src).unwrap().is_none(), "older pre-release");
        assert!(pick(&gh("latest"), &cur, &src).unwrap().is_none(), "not semver");
        assert!(pick(b"{\"message\":\"Not Found\"}", &cur, &src).is_err());
        let mut draft: serde_json::Value = serde_json::from_slice(&gh("v9.0.0")).unwrap();
        draft["draft"] = true.into();
        assert!(pick(&serde_json::to_vec(&draft).unwrap(), &cur, &src).unwrap().is_none());
        let mut pre: serde_json::Value = serde_json::from_slice(&gh("v9.0.0")).unwrap();
        pre["prerelease"] = true.into();
        assert!(pick(&serde_json::to_vec(&pre).unwrap(), &cur, &src).unwrap().is_none());
    }

    #[test]
    fn download_urls_are_allow_listed() {
        let src = Source::github();
        let cur = v("0.1.0");
        let bad = [
            "https://evil.example/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz",
            "http://github.com/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz",
            "https://github.com/someone/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz",
            "https://github.com/mes28io/coool/releases/download/v0.1.0/coool-macos-arm64.tar.gz",
            "https://github.com/mes28io/coool/releases/download/v0.2.0/../../../x/coool-macos-arm64.tar.gz",
            "https://github.com/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz?x=1",
            "https://github.com/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz#x",
            "https://github.com.evil.example/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz",
            "https://github.com@evil.example/mes28io/coool/releases/download/v0.2.0/coool-macos-arm64.tar.gz",
        ];
        let good_sum = format!("https://github.com/mes28io/coool/releases/download/v0.2.0/{ASSET}.sha256");
        for url in bad {
            let json = release_json("v0.2.0", &[(ASSET, url), ("coool-macos-arm64.tar.gz.sha256", &good_sum)]);
            assert!(pick(&json, &cur, &src).unwrap().is_none(), "{url} must be refused");
        }
        // A release missing an asset offers nothing.
        assert!(pick(&release_json("v0.2.0", &[("coool-macos-arm64.tar.gz.sha256", &good_sum)]), &cur, &src).unwrap().is_none());
        assert!(src.allows(&good_sum, "v0.2.0", "coool-macos-arm64.tar.gz.sha256"));
    }

    #[test]
    fn loopback_override_is_loopback_only() {
        assert!(Source::loopback("http://127.0.0.1:8123").is_some());
        for bad in ["http://localhost:8123", "https://127.0.0.1:8123", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:8123/x", "http://127.0.0.1:99999", "http://127.0.0.1.evil.example:80", "http://10.0.0.1:80"] {
            assert!(Source::loopback(bad).is_none(), "{bad}");
        }
        let s = Source::loopback("http://127.0.0.1:8123").unwrap();
        assert!(s.allows(&format!("http://127.0.0.1:8123/mes28io/coool/releases/download/v1.0.0/{ASSET}"), "v1.0.0", ASSET));
        assert!(!s.allows(&format!("https://github.com/mes28io/coool/releases/download/v1.0.0/{ASSET}"), "v1.0.0", ASSET));
    }

    #[test]
    fn checksum_lines() {
        let h = "A".repeat(64);
        assert_eq!(parse_sum(&format!("{h}  coool-macos-arm64.tar.gz\n")), Some("a".repeat(64)));
        assert_eq!(parse_sum(""), None);
        assert_eq!(parse_sum("abc  x"), None);
        assert_eq!(parse_sum(&format!("{}  x", "g".repeat(64))), None);
    }

    #[test]
    fn bundles_are_found_from_the_executable() {
        assert_eq!(bundle_of(Path::new("/Applications/coool.app/Contents/MacOS/coool")), Some(PathBuf::from("/Applications/coool.app")));
        assert_eq!(bundle_of(Path::new("/x/target/debug/coool")), None);
        assert_eq!(bundle_of(Path::new("/x/coool/Contents/MacOS/coool")), None);
        assert!(installable(Path::new("/x/target/debug/coool")).is_err());
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-update-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_app(at: &Path, marker: &str) {
        std::fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
        std::fs::write(at.join("Contents/MacOS/coool"), marker).unwrap();
    }

    #[test]
    fn swap_replaces_the_bundle_and_keeps_the_old_one_aside() {
        let d = tmp("swap");
        let (app, new) = (d.join("coool.app"), d.join("stage/coool.app"));
        fake_app(&app, "old");
        fake_app(&new, "new");
        swap(&new, &app).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/coool")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(new.join("Contents/MacOS/coool")).unwrap(), "old");
        // Nothing installed yet: a plain move.
        let fresh = d.join("fresh.app");
        swap(&new, &fresh).unwrap();
        assert!(fresh.exists() && !new.exists());
        // A missing source fails and leaves the installed bundle alone.
        assert!(swap(&d.join("missing.app"), &app).is_err());
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/coool")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_bad_bundle_is_refused() {
        let d = tmp("verify");
        let app = d.join("coool.app");
        assert!(verify_bundle(&app, "1.0.0").is_err(), "missing");
        fake_app(&app, "x");
        // Not executable, no Info.plist, unsigned: refused.
        assert!(verify_bundle(&app, "1.0.0").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A one-shot loopback server answering each path from `files` (404 otherwise).
    fn serve(files: Vec<(String, Vec<u8>)>) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { break };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                match files.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => {
                        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = s.write_all(body);
                    }
                    None => {
                        let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            }
        });
        base
    }

    #[test]
    fn a_checksum_mismatch_leaves_the_installed_bundle_alone() {
        let d = tmp("mismatch");
        let app = d.join("coool.app");
        fake_app(&app, "old");
        let tarball = b"not really a tarball".to_vec();
        let sum = format!("{}  {ASSET}\n", "0".repeat(64));
        let dl = |name: &str| format!("/mes28io/coool/releases/download/v9.0.0/{name}");
        let base = serve(vec![(dl(ASSET), tarball), (dl(&format!("{ASSET}.sha256")), sum.into_bytes())]);
        let src = Source::loopback(&base).unwrap();
        let rel = Release { version: "9.0.0".into(), tag: "v9.0.0".into(), tarball: format!("{base}{}", dl(ASSET)), checksum: format!("{base}{}", dl(&format!("{ASSET}.sha256"))) };
        let mut phases = vec![];
        let err = stage(&src, &rel, &app, &mut |p| phases.push(p.phase)).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(phases.contains(&Phase::Download) && !phases.contains(&Phase::Install));
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/coool")).unwrap(), "old");
        // Nothing was staged, and the work folder is gone.
        assert!(staged_path(&app).is_none());
        assert_eq!(std::fs::read_dir(d.join(".coool-update")).unwrap().count(), 0);
        // A URL outside the source's releases is refused before anything is fetched.
        let off = Release { tarball: "https://evil.example/coool-macos-arm64.tar.gz".into(), ..rel };
        assert!(stage(&src, &off, &app, &mut |_| {}).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_check_reads_a_release_from_the_server() {
        let tag = "v9.1.0";
        // The JSON names URLs on the server itself, so it is built after the port is known: bind first.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let dl = format!("{base}/mes28io/coool/releases/download/{tag}/");
        let json = release_json(tag, &[(ASSET, &format!("{dl}{ASSET}")), ("coool-macos-arm64.tar.gz.sha256", &format!("{dl}{ASSET}.sha256"))]);
        std::thread::spawn(move || {
            if let Some(Ok(mut s)) = l.incoming().next() {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                assert!(req.starts_with("get /repos/mes28io/coool/releases/latest "));
                assert!(req.contains("user-agent: coool-updater\r\n"), "{req}");
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", json.len());
                let _ = s.write_all(&json);
            }
        });
        let src = Source::loopback(&base).unwrap();
        let r = check(&src, &v("0.1.0"), None).unwrap().unwrap();
        assert_eq!(r.version, "9.1.0");
    }

    #[test]
    fn versions_agree_across_the_tree() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"), "tauri.conf.json");
        assert_eq!(pkg["version"], env!("CARGO_PKG_VERSION"), "app/package.json");
        assert!(Version::parse(env!("CARGO_PKG_VERSION")).is_some());
    }
}
