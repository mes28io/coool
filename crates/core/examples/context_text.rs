//! Prints the coool context (APP_SPEC "coool context") a chat would get, and its rough token count, for measuring
//! its real cost with the CLI's own context report.
//!
//! ```sh
//! cargo run -q -p coool-core --example context_text -- claude|codex [browser,iphone,mac,remote,helpers]
//! ```

use coool_core::agent_context::{AgentContext, text};
use coool_core::ladder::{Cli, approx_tokens};

fn main() {
    let mut a = std::env::args().skip(1);
    let cli = if a.next().as_deref() == Some("codex") { Cli::Codex } else { Cli::Claude };
    let has = a.next().unwrap_or_default();
    let on = |k: &str| has.split(',').any(|x| x == k);
    let c = AgentContext { browser: on("browser"), iphone: on("iphone"), mac: on("mac"), remote: on("remote") };
    let t = text(cli, &c, on("helpers"));
    print!("{t}");
    eprintln!("~{} tokens (4 chars per token)", approx_tokens(&t));
}
