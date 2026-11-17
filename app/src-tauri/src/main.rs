// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A chat's CLI runs coool's executable as its `coool-device` MCP server: relay to the app and never start the UI.
    if std::env::args().nth(1).as_deref() == Some(coool_app_lib::DEVICE_MCP_FLAG) {
        std::process::exit(coool_app_lib::device_mcp_proxy());
    }
    if std::env::args().nth(1).as_deref() == Some("--coool-device-serve") {
        let dir = std::env::args().nth(2).expect("usage: coool --coool-device-serve <dir>");
        std::process::exit(coool_app_lib::device_serve_headless(std::path::Path::new(&dir)));
    }
    coool_app_lib::run()
}
