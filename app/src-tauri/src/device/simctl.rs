//! Simulator lifecycle through `xcrun simctl`. Booting never opens Simulator.app (`simctl boot` is headless), and
//! coool only creates, erases or deletes devices of its own (named "coool …"); the person's simulators are listed and
//! may be booted / shut down from the panel, nothing more.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// The device coool creates for itself on first use.
pub const COOOL_DEVICE_NAME: &str = "coool iPhone";

/// Set by the self-test ([`set_only_device`]): the one device that counts as coool's own this run.
static ONLY: OnceLock<String> = OnceLock::new();

/// Self-test: coool's own device is `name` (created on first use) and no other device counts as coool's, so the
/// person's "coool iPhone" is never picked, booted or driven by a test run.
pub fn set_only_device(name: &str) {
    let _ = ONLY.set(name.to_string());
}

/// The name of the device [`ensure_coool_device`] makes.
pub fn own_name() -> &'static str {
    ONLY.get().map(String::as_str).unwrap_or(COOOL_DEVICE_NAME)
}

fn is_coool(name: &str, only: Option<&str>) -> bool {
    match only {
        Some(n) => name == n,
        None => name.starts_with("coool "),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimDevice {
    pub udid: String,
    pub name: String,
    /// simctl's state: "Booted", "Shutdown", "Booting", "Shutting Down", ...
    pub state: String,
    /// "iOS 27.0"
    pub runtime: String,
    /// "iPhone 18 Pro"
    pub device_type: String,
    /// One of coool's own devices (named "coool …").
    pub coool: bool,
}

fn run(args: &[&str]) -> Result<String, String> {
    let out = Command::new("xcrun").arg("simctl").args(args).stdin(Stdio::null()).output().map_err(|e| format!("xcrun simctl: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("simctl {}: {}", args.first().copied().unwrap_or(""), error_text(&String::from_utf8_lossy(&out.stderr))))
    }
}

/// simctl's error output on one line. All of it: the reason ("Unable to shutdown device in current state: Shutdown")
/// comes after a generic first line, and `boot` / `shutdown` look for it.
fn error_text(stderr: &str) -> String {
    let t = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    if t.is_empty() { "failed".into() } else { t }
}

/// Why simulators can't be used here, if they can't (no Xcode / simctl).
pub fn unavailable() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return Some("The iOS Simulator needs macOS with Xcode.".into());
    }
    match Command::new("xcrun").args(["--find", "simctl"]).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => None,
        _ => Some("Install Xcode (with an iOS simulator runtime) to use the iPhone panel.".into()),
    }
}

/// "com.apple.CoreSimulator.SimRuntime.iOS-27-0" -> "iOS 27.0"
fn runtime_name(id: &str) -> String {
    let tail = id.rsplit('.').next().unwrap_or(id);
    match tail.split_once('-') {
        Some((os, v)) => format!("{os} {}", v.replace('-', ".")),
        None => tail.to_string(),
    }
}

/// "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro" -> "iPhone 18 Pro"
fn type_name(id: &str) -> String {
    id.rsplit('.').next().unwrap_or(id).replace('-', " ")
}

pub fn parse_devices(json: &str) -> Vec<SimDevice> {
    parse_devices_as(json, ONLY.get().map(String::as_str))
}

/// `only`: the one device that counts as coool's (the self-test's), else every "coool …" one.
fn parse_devices_as(json: &str, only: Option<&str>) -> Vec<SimDevice> {
    let v: Value = serde_json::from_str(json).unwrap_or_default();
    let mut out = Vec::new();
    let Some(map) = v["devices"].as_object() else { return out };
    for (rt, list) in map {
        if !rt.contains(".iOS-") {
            continue;
        }
        for d in list.as_array().into_iter().flatten() {
            if d["isAvailable"].as_bool() == Some(false) {
                continue;
            }
            let name = d["name"].as_str().unwrap_or_default().to_string();
            out.push(SimDevice {
                udid: d["udid"].as_str().unwrap_or_default().to_string(),
                coool: is_coool(&name, only),
                name,
                state: d["state"].as_str().unwrap_or_default().to_string(),
                runtime: runtime_name(rt),
                device_type: type_name(d["deviceTypeIdentifier"].as_str().unwrap_or_default()),
            });
        }
    }
    // coool's devices first, then booted, then by runtime (newest first) and name.
    out.sort_by(|a, b| {
        (!a.coool, a.state != "Booted", std::cmp::Reverse(version(&a.runtime)), a.name.clone()).cmp(&(
            !b.coool,
            b.state != "Booted",
            std::cmp::Reverse(version(&b.runtime)),
            b.name.clone(),
        ))
    });
    out
}

fn version(runtime: &str) -> Vec<u32> {
    runtime.split(' ').nth(1).unwrap_or("").split('.').filter_map(|x| x.parse().ok()).collect()
}

pub fn devices() -> Result<Vec<SimDevice>, String> {
    Ok(parse_devices(&run(&["list", "-j", "devices"])?))
}

pub fn device(udid: &str) -> Result<SimDevice, String> {
    devices()?.into_iter().find(|d| d.udid == udid).ok_or_else(|| "no such simulator".to_string())
}

/// The newest iOS runtime and, in it, the newest non-Max iPhone Pro (else any iPhone) device type.
fn pick_type() -> Result<(String, String), String> {
    let v: Value = serde_json::from_str(&run(&["list", "-j", "runtimes"])?).map_err(|e| e.to_string())?;
    let mut best: Option<(Vec<u32>, &Value)> = None;
    for r in v["runtimes"].as_array().into_iter().flatten() {
        if r["isAvailable"].as_bool() != Some(true) || !r["identifier"].as_str().unwrap_or("").contains(".iOS-") {
            continue;
        }
        let ver: Vec<u32> = r["version"].as_str().unwrap_or("").split('.').filter_map(|x| x.parse().ok()).collect();
        if best.as_ref().is_none_or(|(b, _)| ver > *b) {
            best = Some((ver, r));
        }
    }
    let (_, rt) = best.ok_or("No iOS simulator runtime is installed (Xcode > Settings > Components).")?;
    let types: Vec<&Value> = rt["supportedDeviceTypes"].as_array().into_iter().flatten().filter(|t| t["productFamily"] == "iPhone").collect();
    let name = |t: &&Value| t["name"].as_str().unwrap_or("").to_string();
    let pick = types
        .iter()
        .find(|t| name(t).ends_with(" Pro"))
        .or_else(|| types.first())
        .ok_or("This iOS runtime has no iPhone device types.")?;
    Ok((pick["identifier"].as_str().unwrap_or("").to_string(), rt["identifier"].as_str().unwrap_or("").to_string()))
}

/// coool's own device, created on first use.
pub fn ensure_coool_device() -> Result<String, String> {
    if let Some(d) = devices()?.into_iter().find(|d| d.name == own_name()) {
        return Ok(d.udid);
    }
    let (ty, rt) = pick_type()?;
    Ok(run(&["create", own_name(), &ty, &rt])?.trim().to_string())
}

/// Deletes one of coool's own devices (shutting it down first); refuses any other.
pub fn delete(udid: &str) -> Result<(), String> {
    if !device(udid)?.coool {
        return Err("not one of coool's own simulators".into());
    }
    shutdown(udid)?;
    run(&["delete", udid]).map(|_| ())
}

/// Boots headless (no Simulator.app) and waits until the device has finished booting.
pub fn boot(udid: &str) -> Result<(), String> {
    if let Err(e) = run(&["boot", udid]) {
        // Already booted (or booting) is fine; bootstatus below tells.
        if !e.contains("current state: Booted") && !e.contains("Booting") {
            return Err(e);
        }
    }
    run(&["bootstatus", udid]).map(|_| ())
}

pub fn shutdown(udid: &str) -> Result<(), String> {
    match run(&["shutdown", udid]) {
        Err(e) if e.contains("current state: Shutdown") => Ok(()),
        r => r.map(|_| ()),
    }
}

pub fn install(udid: &str, app: &str) -> Result<(), String> {
    run(&["install", udid, app]).map(|_| ())
}

/// Launches (relaunching when running); returns simctl's "bundle: pid" line.
pub fn launch(udid: &str, bundle: &str) -> Result<String, String> {
    run(&["launch", "--terminate-running-process", udid, bundle]).map(|s| s.trim().to_string())
}

pub fn terminate(udid: &str, bundle: &str) -> Result<(), String> {
    run(&["terminate", udid, bundle]).map(|_| ())
}

pub fn open_url(udid: &str, url: &str) -> Result<(), String> {
    run(&["openurl", udid, url]).map(|_| ())
}

pub fn appearance(udid: &str, mode: &str) -> Result<(), String> {
    run(&["ui", udid, "appearance", mode]).map(|_| ())
}

pub fn location(udid: &str, lat: f64, lon: f64) -> Result<(), String> {
    run(&["location", udid, "set", &format!("{lat},{lon}")]).map(|_| ())
}

pub fn privacy(udid: &str, action: &str, service: &str, bundle: &str) -> Result<(), String> {
    run(&["privacy", udid, action, service, bundle]).map(|_| ())
}

/// Puts text on the device's pasteboard.
pub fn pbcopy(udid: &str, text: &str) -> Result<(), String> {
    let mut child = Command::new("xcrun")
        .args(["simctl", "pbcopy", udid])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let s = child.wait().map_err(|e| e.to_string())?;
    if s.success() { Ok(()) } else { Err("simctl pbcopy failed".into()) }
}

/// Installed user apps: (bundle id, display name).
pub fn user_apps(udid: &str) -> Result<Vec<(String, String)>, String> {
    // `listapps` prints an old-style plist; convert it to JSON with plutil.
    let raw = run(&["listapps", udid])?;
    let mut child = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("stdin")?.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("listapps: {e}"))?;
    let mut apps: Vec<(String, String)> = v
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, a)| a["ApplicationType"] == "User")
        .map(|(id, a)| (id.clone(), a["CFBundleDisplayName"].as_str().or(a["CFBundleName"].as_str()).unwrap_or(id).to_string()))
        .collect();
    apps.sort();
    Ok(apps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_parse_ios_only_coool_first() {
        let j = r#"{"devices":{
          "com.apple.CoreSimulator.SimRuntime.watchOS-12-0":[{"udid":"W","name":"Watch","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"x.Apple-Watch"}],
          "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[
            {"udid":"A","name":"iPhone 18 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"},
            {"udid":"B","name":"coool iPhone","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"},
            {"udid":"C","name":"Gone","state":"Shutdown","isAvailable":false,"deviceTypeIdentifier":"x"}]}}"#;
        let d = parse_devices(j);
        assert_eq!(d.iter().map(|d| d.udid.as_str()).collect::<Vec<_>>(), ["B", "A"]);
        assert_eq!(d[0].runtime, "iOS 27.0");
        assert_eq!(d[0].device_type, "iPhone 18 Pro");
        assert!(d[0].coool && !d[1].coool);
    }

    #[test]
    fn errors_keep_the_reason_after_the_first_line() {
        let e = "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to shutdown device in current state: Shutdown\n";
        assert!(error_text(e).contains("current state: Shutdown"));
        assert_eq!(error_text("\n"), "failed");
    }

    #[test]
    fn selftest_device_is_the_only_coool_one() {
        let j = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[
            {"udid":"B","name":"coool iPhone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"x.iPhone-18-Pro"},
            {"udid":"T","name":"coool selftest iPhone","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"x.iPhone-18-Pro"}]}}"#;
        let d = parse_devices_as(j, Some("coool selftest iPhone"));
        assert_eq!(d[0].udid, "T");
        assert!(d[0].coool);
        assert!(!d.iter().find(|d| d.udid == "B").unwrap().coool);
        assert!(parse_devices_as(j, None).iter().all(|d| d.coool));
    }
}
