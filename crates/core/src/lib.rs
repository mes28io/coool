//! coool-core: provider adapters, session model and PTY management.
//! UI-agnostic: the TUI and the desktop app are both thin layers over [`hub::Hub`].

pub mod artifact;
pub mod attach;
pub mod cache;
pub mod chat;
pub mod chatctx;
pub mod context;
pub mod explain;
pub mod gitlog;
pub mod claude;
pub mod codex;
pub mod hub;
pub mod insights;
pub mod agent_context;
pub mod ladder;
pub mod lineage;
mod loader;
pub mod model;
pub mod origin;
pub mod polish;
pub mod project;
pub mod pty;
pub mod shells;
mod subagents;
pub mod tail;
pub mod titles;
pub mod usage;
pub mod util;
pub mod watch;
pub mod wire;
