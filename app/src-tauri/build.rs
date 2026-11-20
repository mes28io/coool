fn main() {
    sim_helper();
    vm_helpers();
    lid_helper();
    let manifest = tauri_build::AppManifest::new().commands(app_commands());
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("failed to run tauri-build");
}

/// The app's own commands, read from the `generate_handler!` list in src/lib.rs (the one source of truth). Handing
/// them to Tauri as the app manifest makes it check every one against the capabilities, as it does plugin commands;
/// capabilities/default.json grants them to the `main` webview only. Without a manifest Tauri checks app commands
/// only for remote origins, so any webview showing a local-origin page (every custom scheme, `coool-artifact://`
/// among them) could call them all.
///
/// Fails the build when a command isn't granted there (it would be refused in the app), or when the capability
/// grants one that isn't in the list.
fn app_commands() -> &'static [&'static str] {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=capabilities");
    let lib = std::fs::read_to_string("src/lib.rs").expect("read src/lib.rs");
    let open = "generate_handler![";
    let start = lib.find(open).expect("no generate_handler! in src/lib.rs") + open.len();
    let end = start + lib[start..].find(']').expect("generate_handler! isn't closed");
    let commands: Vec<&'static str> = lib[start..end]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .flat_map(|l| l.split(','))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        // `voice::voice_status` is invoked as `voice_status`.
        .map(|c| &*String::leak(c.rsplit("::").next().unwrap_or(c).to_string()))
        .collect();
    let cap = std::fs::read_to_string("capabilities/default.json").expect("read capabilities/default.json");
    // Plugin permissions are prefixed (`core:…`, `opener:allow-open-url`); the app's own are bare `allow-<command>`.
    let granted: Vec<&str> = cap.split('"').filter_map(|s| s.strip_prefix("allow-")).collect();
    let slug = |c: &str| c.replace('_', "-");
    let missing: Vec<String> = commands.iter().map(|c| slug(c)).filter(|c| !granted.contains(&c.as_str())).collect();
    assert!(missing.is_empty(), "capabilities/default.json doesn't grant these commands to `main` (add \"allow-<name>\" for each): {missing:?}");
    let unknown: Vec<&&str> = granted.iter().filter(|g| !commands.iter().any(|c| slug(c) == **g)).collect();
    assert!(unknown.is_empty(), "capabilities/default.json grants commands that aren't in generate_handler!: {unknown:?}");
    Vec::leak(commands)
}

/// Builds `native/coool-sim.m` (the iOS Simulator helper, see src/device/helper.rs) into OUT_DIR on macOS. The app
/// embeds the binary and writes it to its data folder on first use, so `tauri dev` and bundles behave the same.
/// Without a working `clang` (no Xcode command line tools) an empty file is embedded and the iPhone panel says so.
fn sim_helper() {
    println!("cargo:rerun-if-changed=native/coool-sim.m");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("coool-sim");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let mut ok = false;
    if target_os == "macos" {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default().as_str() {
            "x86_64" => "x86_64",
            _ => "arm64",
        };
        let min = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "13.0".into());
        let status = std::process::Command::new("xcrun")
            .args(["clang", "-O2", "-fobjc-arc", "-Wall", "-arch", arch])
            .arg(format!("-mmacosx-version-min={min}"))
            .args(["-framework", "Foundation", "-framework", "CoreImage", "-framework", "IOSurface", "-framework", "ImageIO"])
            .args(["-framework", "CoreGraphics", "-o"])
            .arg(&out)
            .arg("native/coool-sim.m")
            .status();
        ok = matches!(status, Ok(s) if s.success());
        if !ok {
            println!("cargo:warning=couldn't build the iOS Simulator helper (native/coool-sim.m); the iPhone panel will be unavailable");
        }
    }
    if !ok {
        std::fs::write(&out, b"").unwrap();
    }
}

/// Builds the sandbox Mac's two native pieces into OUT_DIR on Apple silicon (see src/device/vm.rs):
/// - `coool-vm` (native/coool-vm.m), the host side: the Virtualization.framework VM. It must carry the
///   `com.apple.security.virtualization` entitlement, so it is signed ad-hoc here with native/coool-vm.entitlements
///   (the signature travels inside the binary, so the copy the app writes to its data folder stays signed). The app
///   itself needs no entitlement, in `tauri dev` or a bundle.
/// - `coool-vm-agent` (native/coool-vm-agent.m), the guest side: installed into the VM during its first-run setup
///   and signed there.
///
/// Either one that can't be built is embedded empty, and the Mac panel says so.
fn vm_helpers() {
    for f in ["native/coool-vm.m", "native/coool-vm-agent.m", "native/coool-vm.entitlements"] {
        println!("cargo:rerun-if-changed={f}");
    }
    let dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let ok_target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "macos"
        && std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default() == "aarch64";
    let build = |name: &str, src: &str, frameworks: &[&str], libs: &[&str]| -> bool {
        let out = dir.join(name);
        let mut cmd = std::process::Command::new("xcrun");
        cmd.args(["clang", "-O2", "-fobjc-arc", "-Wall", "-Wno-unguarded-availability-new", "-arch", "arm64", "-mmacosx-version-min=13.0"]);
        for f in frameworks {
            cmd.args(["-framework", f]);
        }
        cmd.args(libs).arg("-o").arg(&out).arg(src);
        matches!(cmd.status(), Ok(s) if s.success())
    };
    let host = ok_target
        && build("coool-vm", "native/coool-vm.m", &["Foundation", "Virtualization", "CoreImage", "ImageIO", "Vision", "AppKit", "IOSurface", "QuartzCore", "vmnet"], &["-lz"])
        && matches!(
            std::process::Command::new("codesign")
                .args(["-s", "-", "-f", "--entitlements", "native/coool-vm.entitlements"])
                .arg(dir.join("coool-vm"))
                .status(),
            Ok(s) if s.success()
        );
    let guest = ok_target && build("coool-vm-agent", "native/coool-vm-agent.m", &["Foundation", "AppKit", "ApplicationServices"], &[]);
    if ok_target && !(host && guest) {
        println!("cargo:warning=couldn't build the sandbox Mac helpers (native/coool-vm*.m); the Mac panel will be unavailable");
    }
    for (name, ok) in [("coool-vm", host), ("coool-vm-agent", guest)] {
        if !ok {
            std::fs::write(dir.join(name), b"").unwrap();
        }
    }
}

/// Builds `native/coool-lid-helper.m` (the root helper of "Keep working with the lid closed", see src/lid/) into
/// OUT_DIR on macOS. The app embeds it; installing copies these bytes to /Library/PrivilegedHelperTools, so the
/// installed helper doesn't change when coool is rebuilt. Without `clang` an empty file is embedded and Settings says
/// the helper is unavailable in this build.
fn lid_helper() {
    println!("cargo:rerun-if-changed=native/coool-lid-helper.m");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("coool-lid-helper");
    let mut ok = false;
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "macos" {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default().as_str() {
            "x86_64" => "x86_64",
            _ => "arm64",
        };
        let status = std::process::Command::new("xcrun")
            .args(["clang", "-O2", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-arch", arch, "-mmacosx-version-min=13.0"])
            .args(["-framework", "Foundation", "-framework", "IOKit", "-framework", "CoreFoundation", "-o"])
            .arg(&out)
            .arg("native/coool-lid-helper.m")
            .status();
        ok = matches!(status, Ok(s) if s.success());
        if !ok {
            println!("cargo:warning=couldn't build the lid helper (native/coool-lid-helper.m); \"Keep working with the lid closed\" will work only in closed-display mode");
        }
    }
    if !ok {
        std::fs::write(&out, b"").unwrap();
    }
}
