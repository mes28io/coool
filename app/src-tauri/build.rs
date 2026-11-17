fn main() {
    sim_helper();
    tauri_build::build()
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
