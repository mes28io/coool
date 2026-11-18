//! The device gate (APP_SPEC "Device permissions"): coool's own permission check inside the `coool-device` MCP
//! server, so the Browser, iPhone and Mac tools ask the person the same way for Claude and Codex chats, whatever
//! either CLI would do. The CLIs pre-approve the server's tools (that is what makes them callable at all); this gate
//! decides, per call, whether to ask.
//!
//! - It follows the chat's permission mode ([`mode_of`]): where the CLI would not ask for a command or an edit
//!   (Claude `bypassPermissions` / `auto`, Codex approval `never`) nothing here asks either; Claude's `dontAsk`
//!   denies what would ask; every other mode asks by the rules below.
//! - Reading never asks (the tools call [`Gate::check`] only for actions that change something).
//! - The first change on a device in a chat asks once ("Let Claude use the Browser in this chat?"): once, this chat,
//!   or always in this project (kept in coool's data, `device-grants.json`, shown and revocable in Settings >
//!   Devices).
//! - Some kinds always ask, with a sentence saying exactly what will happen ([`Risk`]): a browser site not yet allowed
//!   in this chat (its registrable domain, [`site`]), a form submit, typing into a password or payment field; a
//!   command in the Mac, launching or opening something from its shared folder, sharing a file from outside the
//!   project into it; installing an app on the iPhone (agents have no tool to erase or delete one); and each `pilot_run` (once for the run: its own steps then
//!   don't ask, but the kinds above still stop it and ask). "Always in this project" never covers them, except the
//!   browser's site list the person builds up.
//! - A held call shows a `permission_request` in its chat ([`coool_core::chat::ChatHandle::ask`]) and continues or
//!   answers "denied by the person"; no answer within [`TIMEOUT`] is a denial; the turn ending cancels it.
//! - The person's own clicks and typing in a panel never come through here.

use coool_core::chat::{ExternalAnswer, RememberOption, RememberScope};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// How long a held call waits for the person before it is denied.
pub const TIMEOUT: Duration = Duration::from_secs(300);
/// Where "Always in this project" is kept (shown in the request and in Settings > Devices).
pub const STORE_LABEL: &str = "coool (Settings > Devices)";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dev {
    Browser,
    Iphone,
    Mac,
}

impl Dev {
    pub fn name(self) -> &'static str {
        match self {
            Dev::Browser => "Browser",
            Dev::Iphone => "iPhone",
            Dev::Mac => "Mac",
        }
    }
    fn the(self) -> &'static str {
        match self {
            Dev::Browser => "the Browser",
            Dev::Iphone => "the iPhone",
            Dev::Mac => "the sandbox Mac",
        }
    }
}

/// The kinds that always ask (in an asking mode), with what the card says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Risk {
    /// A browser action that submits a form: its submit button's label (or "the form").
    Submit { label: String },
    /// Typing into a password (`password`) or payment (`payment`) field: the field's name.
    Secret { kind: &'static str, field: String },
    /// `mac_shell`: the command.
    Shell { command: String },
    /// Installing an app (iPhone: the .app path).
    Install { what: String },
    /// Launching or opening something from the Mac's shared folder.
    Launch { what: String },
    /// Copying a host file from outside the project into the Mac's shared folder.
    Share { path: String },
}

/// One action a tool is about to take (only actions that change something are checked).
#[derive(Clone, Debug, Default)]
pub struct Act {
    pub dev: Option<Dev>,
    /// What it does, short, for the card: "Open example.com", "Tap “General”".
    pub what: String,
    /// Browser: the site (registrable domain) the action happens on, or goes to.
    pub site: Option<String>,
    pub risk: Option<Risk>,
    /// `pilot_run` itself: (goal, where it starts).
    pub pilot: Option<(String, String)>,
}

impl Act {
    pub fn new(dev: Dev, what: impl Into<String>) -> Self {
        Act { dev: Some(dev), what: what.into(), ..Default::default() }
    }
    pub fn site(mut self, s: Option<String>) -> Self {
        self.site = s;
        self
    }
    pub fn risk(mut self, r: Option<Risk>) -> Self {
        self.risk = r;
        self
    }
}

/// What the chat's permission mode means for the device tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The CLI would not ask for a command or an edit here: neither does the gate.
    Free,
    /// Ask by the rules.
    Ask,
    /// Claude's `dontAsk`: what would ask is denied instead.
    Deny,
}

/// Claude: `bypassPermissions` and `auto` don't ask; `dontAsk` denies; `default`, `acceptEdits` (it still asks
/// before commands) and `plan` ask. Codex (its approval policy): `never` doesn't ask; `untrusted`, `on-request`,
/// `on-failure` ask. Unknown or not yet reported: ask.
pub fn mode_of(mode: &str) -> Mode {
    match mode {
        "bypassPermissions" | "auto" | "never" => Mode::Free,
        "dontAsk" => Mode::Deny,
        _ => Mode::Ask,
    }
}

// ---------- sites ----------

/// Public suffixes under which every name is someone else's (two labels, or hosting platforms where each subdomain is
/// its own site). Not the whole Public Suffix List: the common ones.
const MULTI: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.br", "net.br", "org.br", "com.cn", "net.cn", "org.cn", "gov.cn", "com.tw", "com.hk",
    "com.sg", "com.my", "co.in", "net.in", "org.in", "firm.in", "co.za", "org.za", "com.mx", "com.ar", "com.tr", "com.ua", "co.il", "com.pl", "co.id", "or.id",
    "com.vn", "com.ph", "com.pk", "com.eg", "com.sa", "co.th", "in.th", "com.co", "com.pe", "com.ng", "co.ke",
    // Hosting platforms: each subdomain is a different owner.
    "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
    "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com", "fly.dev", "onrender.com", "ngrok.io", "ngrok-free.app", "ngrok.app", "blogspot.com",
    "glitch.me", "replit.dev", "repl.co", "surge.sh", "deno.dev", "railway.app", "up.railway.app", "trycloudflare.com",
];

/// The site of a URL or host: its registrable domain (`www.example.co.uk` → `example.co.uk`, `a.b.github.io` →
/// `b.github.io`), an IP address or `localhost` as itself. None for what has no host (about:blank, data:).
pub fn site(url_or_host: &str) -> Option<String> {
    let t = url_or_host.trim();
    // A scheme (`https://…`, `about:blank`), unless what follows the colon is a port (`localhost:3000/x`).
    let scheme = t.contains("://") || t.split_once(':').is_some_and(|(a, b)| !a.contains('/') && !a.starts_with('[') && !b.split('/').next().unwrap_or("").chars().all(|c| c.is_ascii_digit()));
    let host = if scheme { tauri::Url::parse(t).ok()?.host_str()?.to_string() } else { t.split(['/', '?', '#']).next()?.to_string() };
    let mut h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.starts_with('[') {
        return Some(h);
    }
    if h.matches(':').count() == 1 {
        h = h.split(':').next().unwrap_or("").to_string();
    }
    if h.is_empty() {
        return None;
    }
    if h == "localhost" || h.parse::<std::net::IpAddr>().is_ok() || !h.contains('.') {
        return Some(h);
    }
    let labels: Vec<&str> = h.split('.').collect();
    let n = labels.len();
    // The longest known suffix it ends with, plus one label.
    let mut take = 2;
    for suffix in MULTI {
        let k = suffix.split('.').count();
        if n > k && h.ends_with(&format!(".{suffix}")) {
            take = take.max(k + 1);
        }
    }
    Some(labels[n.saturating_sub(take)..].join("."))
}

// ---------- grants ----------

/// What a chat allowed ("this chat"): kept while coool runs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grants {
    pub devices: HashSet<Dev>,
    pub sites: HashSet<String>,
}

/// What a project allowed ("always in this project"): kept in coool's data.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGrants {
    #[serde(default)]
    pub devices: BTreeSet<Dev>,
    #[serde(default)]
    pub sites: BTreeSet<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    projects: BTreeMap<String, ProjectGrants>,
}

/// The pilot run in progress on this thread (its run was approved): its device and its start site count as allowed.
#[derive(Clone, Debug)]
pub struct PilotScope {
    pub chat: usize,
    pub dev: Dev,
    pub sites: HashSet<String>,
}

thread_local! {
    static PILOT: RefCell<Option<PilotScope>> = const { RefCell::new(None) };
}

/// Marks the pilot run on this thread as approved until the guard drops.
pub fn pilot_scope(s: PilotScope) -> impl Drop {
    struct G;
    impl Drop for G {
        fn drop(&mut self) {
            PILOT.with(|p| *p.borrow_mut() = None);
        }
    }
    PILOT.with(|p| *p.borrow_mut() = Some(s));
    G
}

fn pilot_now(chat: usize) -> Option<PilotScope> {
    PILOT.with(|p| p.borrow().clone().filter(|s| s.chat == chat))
}

// ---------- the policy ----------

/// What a request card offers to remember.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Remember {
    /// "This chat": the device and/or the site.
    Chat,
    /// "Always in this project".
    Project,
}

/// A request for the person.
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub dev: Dev,
    /// The card's title after "Claude wants to": "use the Browser in this chat", "submit a form".
    pub lead: String,
    /// One or two lines: exactly what and where.
    pub body: String,
    pub note: Option<String>,
    /// What answering "this chat" / "always" grants (empty: only once).
    pub grant_device: bool,
    pub grant_site: Option<String>,
    pub remember: Vec<(Remember, String, String)>,
    pub kind: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Allow,
    Deny(String),
    Ask(Box<Card>),
}

/// The policy table: given the mode, what this chat and project allowed, and the pilot run in progress (if any),
/// whether `act` goes ahead, is denied, or asks (and with what card).
pub fn decide(mode: Mode, chat: &Grants, project: &ProjectGrants, pilot: Option<&PilotScope>, act: &Act) -> Verdict {
    if mode == Mode::Free {
        return Verdict::Allow;
    }
    let Some(dev) = act.dev else { return Verdict::Allow };
    // A pilot run always asks once for itself (its steps then go through this with `pilot` set).
    if let Some((goal, start)) = &act.pilot {
        if mode == Mode::Deny {
            return Verdict::Deny(deny_mode());
        }
        return Verdict::Ask(Box::new(Card {
            dev,
            lead: format!("run the pilot on {}", dev.the()),
            body: format!("{goal}\n{start}"),
            note: Some("Its steps then don't ask one by one; a form submit, a password, a new site or a command still stops it and asks.".into()),
            grant_device: false,
            grant_site: None,
            remember: Vec::new(),
            kind: "pilot",
        }));
    }
    let in_pilot = pilot.is_some_and(|p| p.dev == dev);
    let use_ok = chat.devices.contains(&dev) || project.devices.contains(&dev) || in_pilot;
    let site_ok = act.site.as_ref().is_none_or(|s| chat.sites.contains(s) || project.sites.contains(s) || pilot.is_some_and(|p| p.sites.contains(s)));
    if use_ok && site_ok && act.risk.is_none() {
        return Verdict::Allow;
    }
    if mode == Mode::Deny {
        return Verdict::Deny(deny_mode());
    }
    let on = act.site.as_ref().map(|s| format!(" on {s}")).unwrap_or_default();
    if let Some(r) = &act.risk {
        let (lead, body, kind) = match r {
            Risk::Submit { label } => ("submit a form".to_string(), format!("Press “{label}”{on}"), "submit"),
            Risk::Secret { kind: "payment", field } => ("type into a payment field".into(), format!("“{field}”{on}"), "secret"),
            Risk::Secret { field, .. } => ("type a password".into(), format!("Into “{field}”{on}"), "secret"),
            Risk::Shell { command } => ("run a command in the sandbox Mac".into(), command.clone(), "shell"),
            Risk::Install { what } => (format!("install an app on {}", dev.the()), what.clone(), "install"),
            Risk::Launch { what } => ("open something from the shared folder".into(), what.clone(), "launch"),
            Risk::Share { path } => ("copy a file into the sandbox Mac".into(), path.clone(), "share"),
        };
        let note = match r {
            Risk::Share { .. } => Some("It is outside this project. While the Mac's network is on, what is in its shared folder can leave this computer.".into()),
            Risk::Shell { .. } | Risk::Launch { .. } if !use_ok => Some(format!("This is also the first change on {} in this chat.", dev.the())),
            _ if !site_ok => Some(format!("{} isn't allowed in this chat yet; allowing this once doesn't add it.", act.site.as_deref().unwrap_or(""))),
            _ => None,
        };
        return Verdict::Ask(Box::new(Card { dev, lead, body, note, grant_device: false, grant_site: None, remember: Vec::new(), kind }));
    }
    let site = act.site.clone().filter(|_| !site_ok);
    if !use_ok {
        let mut chat_label = format!("Allow {} in this chat", dev.the());
        let mut always = format!("Always allow {} in this project", dev.the());
        if let Some(s) = &site {
            chat_label = format!("Allow {} and {s} in this chat", dev.the());
            always = format!("Always allow {} and {s} in this project", dev.the());
        }
        return Verdict::Ask(Box::new(Card {
            dev,
            lead: format!("use {}", dev.the()),
            body: act.what.clone(),
            note: None,
            grant_device: true,
            grant_site: site,
            remember: vec![
                (Remember::Chat, chat_label, "Later changes ask only for submits, passwords, new sites and commands. Nothing is saved.".into()),
                (Remember::Project, always, format!("Saved in {STORE_LABEL}; form submits, passwords, commands and installs still ask.")),
            ],
            kind: "use",
        }));
    }
    let s = site.unwrap_or_default();
    Verdict::Ask(Box::new(Card {
        dev,
        lead: format!("open {s}"),
        body: act.what.clone(),
        note: Some("A site not yet allowed in this chat. Pages where you're signed in act as you.".into()),
        grant_device: false,
        grant_site: Some(s.clone()),
        remember: vec![
            (Remember::Chat, format!("Allow {s} in this chat"), "Pages of this site then don't ask (submits and passwords still do). Nothing is saved.".into()),
            (Remember::Project, format!("Always allow {s} in this project"), format!("Added to this project's site list in {STORE_LABEL}.")),
        ],
        kind: "site",
    }))
}

fn deny_mode() -> String {
    "This chat's permission mode (Don't ask) denies what would ask; coool did not do it. Switch the mode to let it ask.".into()
}

// ---------- the gate ----------

/// The chats as the gate sees them (the app's chat handles; a fake in tests).
pub trait Asker: Send + Sync {
    /// The chat's permission mode (`ready.permission_mode`), or None for a chat coool didn't start (no gate).
    fn mode(&self, chat: usize) -> Option<String>;
    /// Shows the request in the chat: its id and where the answer comes.
    fn ask(&self, chat: usize, tool: &str, summary: &str, input: Value, remember: Vec<RememberOption>) -> Option<(String, Receiver<ExternalAnswer>)>;
    fn withdraw(&self, chat: usize, id: &str, note: &str);
}

#[derive(Default)]
pub struct Gate {
    asker: OnceLock<Box<dyn Asker>>,
    chats: Mutex<HashMap<usize, Grants>>,
    store: Mutex<Option<(PathBuf, StoreFile)>>,
    timeout: OnceLock<Duration>,
}

impl Gate {
    pub fn set_asker(&self, a: Box<dyn Asker>) {
        let _ = self.asker.set(a);
    }

    /// Where "always in this project" is kept (`<data>/device-grants.json`).
    pub fn set_store(&self, path: PathBuf) {
        let file = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<StoreFile>(&b).ok()).unwrap_or_default();
        *self.store.lock().unwrap() = Some((path, file));
    }

    pub fn set_timeout(&self, t: Duration) {
        let _ = self.timeout.set(t);
    }

    /// The chat's mode, for callers that do extra work (a page inspection) only when the gate may ask. Free when
    /// coool didn't start the chat (the headless server, the self-test's scripted client).
    pub fn mode(&self, chat: usize) -> Mode {
        match self.asker.get().and_then(|a| a.mode(chat)) {
            Some(m) => mode_of(&m),
            None => Mode::Free,
        }
    }

    /// Whether `act` may go ahead now, asking the person when the policy says so (blocking until they answer, the
    /// turn ends, or [`TIMEOUT`]). Err: why it was denied, for the agent.
    pub fn check(&self, chat: usize, project: Option<&str>, act: Act) -> Result<(), String> {
        let mode = self.mode(chat);
        if mode == Mode::Free {
            return Ok(());
        }
        let pilot = pilot_now(chat);
        let verdict = {
            let grants = self.chats.lock().unwrap().get(&chat).cloned().unwrap_or_default();
            let pg = self.project(project);
            decide(mode, &grants, &pg, pilot.as_ref(), &act)
        };
        let card = match verdict {
            Verdict::Allow => return Ok(()),
            Verdict::Deny(why) => return Err(why),
            Verdict::Ask(c) => c,
        };
        let Some(asker) = self.asker.get() else { return Ok(()) };
        let remember: Vec<RememberOption> = card
            .remember
            .iter()
            .map(|(r, label, detail)| RememberOption {
                id: if *r == Remember::Chat { "chat".into() } else { "project".into() },
                label: label.clone(),
                detail: detail.clone(),
                scope: if *r == Remember::Chat { RememberScope::Chat } else { RememberScope::Project },
                file: (*r == Remember::Project).then(|| STORE_LABEL.to_string()),
                mode: None,
                rules: Vec::new(),
            })
            .collect();
        let summary = format!("{} · {}", card.dev.name(), card.body.lines().next().unwrap_or(""));
        let input = json!({ "coool_device": { "device": card.dev, "kind": card.kind, "lead": card.lead, "body": card.body, "note": card.note } });
        let Some((id, rx)) = asker.ask(chat, card.dev.name(), &summary, input, remember) else {
            return Err("the chat has ended".into());
        };
        let timeout = *self.timeout.get().unwrap_or(&TIMEOUT);
        let what = format!("{} {}", card.lead, card.body.lines().next().unwrap_or(""));
        match rx.recv_timeout(timeout) {
            Ok(ExternalAnswer::Allow) => Ok(()),
            Ok(ExternalAnswer::Remember(r)) => {
                self.remember(chat, project, &card, if r == "project" { Remember::Project } else { Remember::Chat });
                Ok(())
            }
            Ok(ExternalAnswer::Deny) => Err(format!("Denied by the person: {what}. coool did not do it; don't try another way around. Ask in the chat if it is needed.")),
            Ok(ExternalAnswer::Cancelled(why)) => Err(format!("Not done: {why}.")),
            Err(_) => {
                let secs = timeout.as_secs().max(1);
                asker.withdraw(chat, &id, &format!("No answer within {} min, so coool denied: {what}", secs.div_ceil(60)));
                Err(format!("Denied: the person didn't answer within {} min ({what}). coool did not do it.", secs.div_ceil(60)))
            }
        }
    }

    fn remember(&self, chat: usize, project: Option<&str>, card: &Card, r: Remember) {
        {
            let mut chats = self.chats.lock().unwrap();
            let g = chats.entry(chat).or_default();
            if card.grant_device {
                g.devices.insert(card.dev);
            }
            if let Some(s) = &card.grant_site {
                g.sites.insert(s.clone());
            }
        }
        if r == Remember::Project
            && let Some(p) = project.filter(|p| !p.is_empty())
        {
            self.update_project(p, |pg| {
                if card.grant_device {
                    pg.devices.insert(card.dev);
                }
                if let Some(s) = &card.grant_site {
                    pg.sites.insert(s.clone());
                }
            });
        }
    }

    fn project(&self, project: Option<&str>) -> ProjectGrants {
        let Some(p) = project else { return ProjectGrants::default() };
        self.store.lock().unwrap().as_ref().and_then(|(_, f)| f.projects.get(p).cloned()).unwrap_or_default()
    }

    fn update_project(&self, project: &str, f: impl FnOnce(&mut ProjectGrants)) {
        let mut st = self.store.lock().unwrap();
        let Some((path, file)) = st.as_mut() else { return };
        let pg = file.projects.entry(project.to_string()).or_default();
        f(pg);
        if pg.devices.is_empty() && pg.sites.is_empty() {
            file.projects.remove(project);
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(b) = serde_json::to_vec_pretty(&*file)
            && std::fs::write(&tmp, b).is_ok()
        {
            let _ = std::fs::rename(&tmp, &*path);
        }
    }

    /// Settings > Devices: every project's saved grants.
    pub fn projects(&self) -> Vec<(String, ProjectGrants)> {
        self.store.lock().unwrap().as_ref().map(|(_, f)| f.projects.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
    }

    /// Settings > Devices: revoke a device, a site, or (neither) everything a project saved.
    pub fn revoke(&self, project: &str, dev: Option<Dev>, site: Option<&str>) {
        self.update_project(project, |pg| match (dev, site) {
            (Some(d), _) => {
                pg.devices.remove(&d);
            }
            (None, Some(s)) => {
                pg.sites.remove(s);
            }
            (None, None) => {
                pg.devices.clear();
                pg.sites.clear();
            }
        });
    }
}

#[derive(Serialize)]
pub struct GrantRow {
    project: String,
    devices: Vec<Dev>,
    sites: Vec<String>,
}

#[tauri::command]
pub fn device_grants(devices: tauri::State<'_, std::sync::Arc<super::Devices>>) -> Vec<GrantRow> {
    devices.gate.projects().into_iter().map(|(project, g)| GrantRow { project, devices: g.devices.into_iter().collect(), sites: g.sites.into_iter().collect() }).collect()
}

#[tauri::command]
pub fn device_grants_revoke(devices: tauri::State<'_, std::sync::Arc<super::Devices>>, project: String, device: Option<Dev>, site: Option<String>) -> Vec<GrantRow> {
    devices.gate.revoke(&project, device, site.as_deref());
    device_grants(devices)
}

#[cfg(test)]
mod tests;
