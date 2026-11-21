//! The coool context (APP_SPEC "coool context"): what a chat's agent is told about coool itself, so it acts on what
//! coool offers it (its own devices, the person's view of the chat) without being asked.
//!
//! It rides on the same per-launch channels as Ladder ([`crate::ladder`]): Claude Code's `--append-system-prompt`
//! (after Ladder's policy, in one argument) and Codex's `developerInstructions` (after the person's own and Ladder's).
//! Nothing is written anywhere. Each paragraph is sent only when what it describes exists in this chat: the device
//! paragraph when the chat has the `coool-device` server (and names only the devices this Mac can run), the phone line
//! when a phone is paired, the helpers line when Ladder has cheaper tiers.

use crate::ladder::Cli;
use serde::{Deserialize, Serialize};

/// What this chat really has, as the app fills it in at launch (the frontend sends `{}` for "on").
/// `ChatOptions.context` None: off.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentContext {
    /// The Browser panel's `browser_*` tools.
    #[serde(default)]
    pub browser: bool,
    /// The iPhone simulator's tools (Xcode's simctl is installed).
    #[serde(default)]
    pub iphone: bool,
    /// The sandboxed Mac's `mac_*` tools (this Mac can run it).
    #[serde(default)]
    pub mac: bool,
    /// A phone is paired with coool Remote.
    #[serde(default)]
    pub remote: bool,
}

impl AgentContext {
    /// Without the `coool-device` server the agent has no device tools, whatever the app said.
    pub fn without_devices(mut self) -> Self {
        self.browser = false;
        self.iphone = false;
        self.mac = false;
        self
    }
    fn any_device(&self) -> bool {
        self.browser || self.iphone || self.mac
    }
}

/// The text for a chat. `helpers`: Ladder is on with at least one cheaper tier.
pub fn text(cli: Cli, c: &AgentContext, helpers: bool) -> String {
    let mut s = String::from("# coool\n");
    s.push_str(if c.remote {
        "You run in coool, a Mac app where the person watches this chat, steers it and answers or approves you, also from their phone: lead with the outcome."
    } else {
        "You run in coool, a Mac app where the person watches this chat, steers it and answers or approves you."
    });
    s.push_str(match cli {
        Cli::Claude => " Approvals show your command's `description` and a risk tag: say in it what the command does and why.",
        Cli::Codex => " Approvals show your command's justification and a risk tag: say in it what the command does and why.",
    });
    s.push_str(" Attachments arrive as images or `<attachment path=…>` lines.");
    if c.any_device() {
        s.push_str("\n\nYour own devices, in coool's window (never the person's screen):");
        if c.browser {
            s.push_str("\n- Browser panel (`browser_*`): a change to a web page or web app is done only once you have opened it there and seen the change. `browser_navigate` takes a URL or a project file's path (e.g. `index.html`); a dev server you start goes in the background.");
        }
        if c.iphone {
            s.push_str("\n- iPhone simulator (`observe`, `tap`, `app`): after changing an iOS app, build it for the simulator, install and launch it with `app`, check it.");
        }
        if c.mac {
            s.push_str("\n- Sandboxed Mac (`mac_*`): Mac desktop or system tasks go there, never to the person's desktop.");
        }
        s.push_str("\n- `pilot_run`: hand it routine multi-step navigation or forms, with `success` checks; faster than step-by-step calls.");
    }
    if helpers {
        s.push_str("\n\nHelpers show in the person's Jobs panel; parallel helpers that change files each get their own git worktree.");
    }
    s.push('\n');
    s
}

/// Claude Code: one `--append-system-prompt` carrying Ladder's policy (if any) then this text. The CLI keeps only one
/// value of the flag, so the two are joined here.
pub fn join_prompts(ladder: Option<&str>, context: Option<&str>) -> Option<String> {
    match (ladder, context) {
        (Some(l), Some(c)) => Some(format!("{}\n\n{c}", l.trim_end())),
        (Some(l), None) => Some(l.to_string()),
        (None, Some(c)) => Some(c.to_string()),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ladder::approx_tokens;

    fn all() -> AgentContext {
        AgentContext { browser: true, iphone: true, mac: true, remote: true }
    }

    #[test]
    fn paragraphs_only_for_what_the_chat_has() {
        let bare = text(Cli::Claude, &AgentContext::default(), false);
        assert!(bare.starts_with("# coool\nYou run in coool"));
        assert!(bare.contains("`description`") && bare.contains("<attachment"));
        for absent in ["Browser panel", "iPhone", "Sandboxed Mac", "pilot_run", "Jobs panel", "phone"] {
            assert!(!bare.contains(absent), "{absent} in {bare}");
        }
        let full = text(Cli::Claude, &all(), true);
        for present in ["Browser panel", "is done only once you have opened it there", "a project file's path", "iPhone simulator", "Sandboxed Mac", "never to the person's desktop", "pilot_run", "`success`", "Jobs panel", "git worktree", "from their phone", "outcome"] {
            assert!(full.contains(present), "{present} missing");
        }
        // Only the browser: no iPhone or Mac line, the pilot still (it drives the browser too).
        let web = text(Cli::Codex, &AgentContext { browser: true, ..Default::default() }, false);
        assert!(web.contains("Browser panel") && web.contains("pilot_run") && !web.contains("iPhone") && !web.contains("mac_"));
        assert!(web.contains("justification") && !web.contains("`description`"));
        assert_eq!(all().without_devices(), AgentContext { remote: true, ..Default::default() });
    }

    #[test]
    fn small() {
        let full = text(Cli::Claude, &all(), true);
        let bare = text(Cli::Claude, &AgentContext::default(), false);
        assert!(approx_tokens(&full) < 300, "{} tokens", approx_tokens(&full));
        assert!(approx_tokens(&bare) < 80, "{} tokens", approx_tokens(&bare));
    }

    #[test]
    fn joined_after_the_ladder_policy() {
        assert_eq!(join_prompts(None, None), None);
        assert_eq!(join_prompts(Some("L\n"), None).as_deref(), Some("L\n"));
        assert_eq!(join_prompts(None, Some("C")).as_deref(), Some("C"));
        assert_eq!(join_prompts(Some("L\n"), Some("C")).as_deref(), Some("L\n\nC"));
    }
}
