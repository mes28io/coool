// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A chat's CLI runs coool's executable as its `coool-device` MCP server: relay to the app and never start the UI.
    if std::env::args().nth(1).as_deref() == Some(coool_app_lib::DEVICE_MCP_FLAG) {
        std::process::exit(coool_app_lib::device_mcp_proxy());
    }
    if std::env::args().nth(1).as_deref() == Some(coool_app_lib::LADDER_MCP_FLAG) {
        std::process::exit(coool_app_lib::ladder_mcp_proxy());
    }
    // The chat host: owns chats' CLIs so they keep running when the app quits (started by the app, detached).
    if std::env::args().nth(1).as_deref() == Some(coool_app_lib::CHAT_HOST_FLAG) {
        let dir = std::env::args().nth(2).expect("usage: coool --coool-chat-host <dir>");
        let version = std::env::args().nth(3);
        std::process::exit(coool_app_lib::chat_host(std::path::Path::new(&dir), version.as_deref()));
    }
    if std::env::args().nth(1).as_deref() == Some("--coool-device-serve") {
        let dir = std::env::args().nth(2).expect("usage: coool --coool-device-serve <dir>");
        std::process::exit(coool_app_lib::device_serve_headless(std::path::Path::new(&dir)));
    }
    // The device pilot's decision log, summarised for a future fine-tune's eval (device/pilot/dataset.rs).
    if std::env::args().nth(1).as_deref() == Some("--coool-pilot-eval") {
        let file = std::env::args().nth(2).expect("usage: coool --coool-pilot-eval <file.decisions.jsonl>");
        println!("{}", coool_app_lib::pilot_eval_report(std::path::Path::new(&file)));
        return;
    }
    // The in-app update's steps without the UI, for the end-to-end test (debug builds only; update.rs).
    #[cfg(debug_assertions)]
    if std::env::args().nth(1).as_deref() == Some("--coool-update-selftest") {
        let rest: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(coool_app_lib::update_selftest(&rest));
    }
    coool_app_lib::run()
}
