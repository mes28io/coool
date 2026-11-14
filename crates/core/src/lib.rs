//! coool-core: provider adapters, session model and PTY management.
//! UI-agnostic: the TUI and the desktop app are both thin layers over [`hub::Hub`].

pub mod cache;
pub mod chat;
pub mod claude;
pub mod codex;
pub mod hub;
pub mod insights;
mod loader;
pub mod model;
pub mod pty;
pub mod tail;
pub mod util;
