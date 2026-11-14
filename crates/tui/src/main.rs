//! coool — a terminal cockpit for coding agents.

mod app;
mod keys;
mod theme;
mod ui;

use anyhow::Result;
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
use crossterm::execute;
use std::io::stdout;

const HELP: &str = "coool — a terminal cockpit for Claude Code and Codex

usage: coool [options]

options:
  --light            light theme
  --dark             dark theme
  --window <hours>   how far back to show ended sessions (default 24)
  -h, --help         show this help
  -V, --version      show version

env:
  COOOL_THEME=light|dark
";

fn main() -> Result<()> {
    let mut opts = app::Opts { theme: None, window_hours: 24 };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--light" => opts.theme = Some(false),
            "--dark" => opts.theme = Some(true),
            "--window" => {
                opts.window_hours = args.next().and_then(|v| v.parse().ok()).unwrap_or(24);
            }
            "--snapshot" => {
                // Render one frame as plain text (debugging / docs / CI).
                let dark = opts.theme;
                let w = args.next().and_then(|v| v.parse().ok()).unwrap_or(140);
                let h = args.next().and_then(|v| v.parse().ok()).unwrap_or(36);
                let mut app = app::App::new(app::Opts { theme: dark, window_hours: opts.window_hours });
                // One frame only: show it fully loaded (sessions parse in the background).
                app.wait_loaded(std::time::Duration::from_secs(20));
                let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h))?;
                term.draw(|f| ui::draw(f, &mut app))?;
                let buf = term.backend().buffer();
                for y in 0..h {
                    let line: String = (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect();
                    println!("{}", line.trim_end());
                }
                return Ok(());
            }
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(());
            }
            "-V" | "--version" => {
                println!("coool {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            other => {
                eprintln!("unknown option: {other}\n\n{HELP}");
                std::process::exit(2);
            }
        }
    }

    let mut terminal = ratatui::init();
    let _ = execute!(stdout(), EnableBracketedPaste);
    let result = app::App::new(opts).run(&mut terminal);
    let _ = execute!(stdout(), DisableBracketedPaste);
    ratatui::restore();
    result
}
