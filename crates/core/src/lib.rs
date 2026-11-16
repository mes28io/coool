//! coool-core: provider adapters, session model and PTY management.
//! UI-agnostic: the TUI and the desktop app are both thin layers over [`hub::Hub`].

pub mod cache;
pub mod chat;
pub mod claude;
pub mod codex;
pub mod hub;
pub mod insights;
pub mod lineage;
mod loader;
pub mod model;
pub mod origin;
pub mod project;
pub mod pty;
pub mod shells;
pub mod tail;
pub mod usage;
pub mod util;
pub mod watch;
pub mod wire;
