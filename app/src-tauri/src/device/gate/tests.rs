use super::*;
use std::sync::Arc;
use std::sync::mpsc;

fn act(dev: Dev) -> Act {
    Act::new(dev, "Tap “General”")
}
fn browser(site_: &str) -> Act {
    Act::new(Dev::Browser, format!("Open {site_}")).site(site(site_))
}
fn grants(devs: &[Dev], sites: &[&str]) -> Grants {
    Grants { devices: devs.iter().copied().collect(), sites: sites.iter().map(|s| s.to_string()).collect() }
}
fn kind(v: &Verdict) -> &str {
    match v {
        Verdict::Allow => "allow",
        Verdict::Deny(_) => "deny",
        Verdict::Ask(c) => c.kind,
    }
}

#[test]
fn modes_map_onto_asking_or_not() {
    for m in ["bypassPermissions", "auto", "never"] {
        assert_eq!(mode_of(m), Mode::Free, "{m}");
    }
    for m in ["default", "acceptEdits", "plan", "untrusted", "on-request", "on-failure", "", "something-new"] {
        assert_eq!(mode_of(m), Mode::Ask, "{m}");
    }
    assert_eq!(mode_of("dontAsk"), Mode::Deny);
}

/// The policy table: mode × what the action is × what the chat / project / pilot run allowed.
#[test]
fn the_policy_table() {
    let none = Grants::default();
    let np = ProjectGrants::default();
    let submit = || browser("example.com").risk(Some(Risk::Submit { label: "Sign in".into() }));
    let shell = || Act::new(Dev::Mac, "Run a command").risk(Some(Risk::Shell { command: "ls ~".into() }));
    let install = || Act::new(Dev::Iphone, "Install an app").risk(Some(Risk::Install { what: "/tmp/My.app".into() }));
    let chat_all = grants(&[Dev::Browser, Dev::Iphone, Dev::Mac], &["example.com"]);
    let proj_all = ProjectGrants { devices: [Dev::Browser, Dev::Iphone, Dev::Mac].into_iter().collect(), sites: ["example.com".to_string()].into_iter().collect() };
    let pilot = PilotScope { chat: 1, dev: Dev::Browser, sites: ["example.com".to_string()].into_iter().collect() };
    let b_only = grants(&[Dev::Browser], &[]);
    let b_ex = grants(&[Dev::Browser], &["example.com"]);
    #[rustfmt::skip]
    let rows: Vec<(Mode, &Grants, &ProjectGrants, Option<&PilotScope>, Act, &str)> = vec![
        // Free modes never ask, whatever it is.
        (Mode::Free, &none, &np, None, submit(), "allow"),
        (Mode::Free, &none, &np, None, shell(), "allow"),
        (Mode::Free, &none, &np, None, install(), "allow"),
        // Asking modes: the first change on a device asks to use it (with the site when there is one).
        (Mode::Ask, &none, &np, None, act(Dev::Iphone), "use"),
        (Mode::Ask, &none, &np, None, browser("example.com"), "use"),
        (Mode::Ask, &chat_all, &np, None, act(Dev::Iphone), "allow"),
        (Mode::Ask, &none, &proj_all, None, act(Dev::Mac), "allow"),
        // A site not yet allowed asks, even with the Browser allowed; an allowed one doesn't.
        (Mode::Ask, &b_only, &np, None, browser("example.com"), "site"),
        (Mode::Ask, &b_only, &np, None, browser("www.example.com"), "site"),
        (Mode::Ask, &b_ex, &np, None, browser("shop.example.com"), "allow"),
        (Mode::Ask, &b_ex, &np, None, browser("example.org"), "site"),
        (Mode::Ask, &b_only, &proj_all, None, browser("example.com"), "allow"),
        // The always-ask kinds ask after "this chat" and after "always in this project".
        (Mode::Ask, &chat_all, &proj_all, None, submit(), "submit"),
        (Mode::Ask, &chat_all, &proj_all, None, browser("example.com").risk(Some(Risk::Secret { kind: "password", field: "Password".into() })), "secret"),
        (Mode::Ask, &chat_all, &proj_all, None, shell(), "shell"),
        (Mode::Ask, &chat_all, &proj_all, None, install(), "install"),
        (Mode::Ask, &chat_all, &proj_all, None, Act::new(Dev::Mac, "Open").risk(Some(Risk::Launch { what: "/Volumes/My Shared Files/X.app".into() })), "launch"),
        (Mode::Ask, &chat_all, &proj_all, None, Act::new(Dev::Mac, "Share").risk(Some(Risk::Share { path: "/Users/x/.ssh".into() })), "share"),
        // pilot_run asks for the run every time; inside the approved run its device and start site are allowed,
        // a new site and the risky kinds still ask.
        (Mode::Ask, &chat_all, &proj_all, None, Act { pilot: Some(("Fill the form".into(), "http://x/".into())), ..act(Dev::Browser) }, "pilot"),
        (Mode::Ask, &none, &np, Some(&pilot), browser("example.com"), "allow"),
        (Mode::Ask, &none, &np, Some(&pilot), browser("example.org"), "site"),
        (Mode::Ask, &none, &np, Some(&pilot), submit(), "submit"),
        (Mode::Ask, &none, &np, Some(&pilot), act(Dev::Iphone), "use"),
        // Don't ask: denied instead of asking, but what was allowed goes ahead.
        (Mode::Deny, &none, &np, None, act(Dev::Iphone), "deny"),
        (Mode::Deny, &chat_all, &np, None, act(Dev::Iphone), "allow"),
        (Mode::Deny, &chat_all, &proj_all, None, shell(), "deny"),
    ];
    for (i, (mode, g, p, pl, a, want)) in rows.into_iter().enumerate() {
        let v = decide(mode, g, p, pl, &a);
        assert_eq!(kind(&v), want, "row {i}: {mode:?} {a:?} -> {v:?}");
    }
}

#[test]
fn cards_say_exactly_what_and_where() {
    let none = Grants::default();
    let np = ProjectGrants::default();
    let Verdict::Ask(c) = decide(Mode::Ask, &none, &np, None, &browser("https://www.github.com/login")) else { panic!() };
    assert_eq!(c.lead, "use the Browser");
    assert_eq!(c.grant_site.as_deref(), Some("github.com"));
    assert_eq!(c.remember[0].1, "Allow the Browser and github.com in this chat");
    assert_eq!(c.remember[1].1, "Always allow the Browser and github.com in this project");
    let Verdict::Ask(c) = decide(Mode::Ask, &grants(&[Dev::Browser], &[]), &np, None, &browser("example.com").risk(Some(Risk::Submit { label: "Place order".into() }))) else { panic!() };
    assert_eq!((c.lead.as_str(), c.body.as_str()), ("submit a form", "Press “Place order” on example.com"));
    assert!(c.remember.is_empty(), "risky kinds are once only");
    let Verdict::Ask(c) = decide(Mode::Ask, &none, &np, None, &Act::new(Dev::Mac, "x").risk(Some(Risk::Shell { command: "rm -rf ~/Desktop".into() }))) else { panic!() };
    assert_eq!((c.lead.as_str(), c.body.as_str()), ("run a command in the sandbox Mac", "rm -rf ~/Desktop"));
    let Verdict::Ask(c) = decide(Mode::Ask, &none, &np, None, &browser("x.com").risk(Some(Risk::Secret { kind: "payment", field: "Card number".into() }))) else { panic!() };
    assert_eq!((c.lead.as_str(), c.body.as_str()), ("type into a payment field", "“Card number” on x.com"));
}

#[test]
fn sites_are_registrable_domains() {
    for (input, want) in [
        ("https://www.example.com/a?b", "example.com"),
        ("example.com", "example.com"),
        ("EXAMPLE.com.", "example.com"),
        ("https://a.b.example.co.uk/", "example.co.uk"),
        ("https://user.github.io/repo", "user.github.io"),
        ("https://my-app-123.vercel.app", "my-app-123.vercel.app"),
        ("http://localhost:3000/x", "localhost"),
        ("http://127.0.0.1:18765/form", "127.0.0.1"),
        ("http://[::1]:8080/", "[::1]"),
        ("https://mail.google.com", "google.com"),
        ("https://accounts.google.co.jp", "google.co.jp"),
        ("intranet", "intranet"),
    ] {
        assert_eq!(site(input).as_deref(), Some(want), "{input}");
    }
    assert_eq!(site("about:blank"), None);
    assert_eq!(site(""), None);
}

// ---------- the gate with a fake chat ----------

#[derive(Default)]
struct Fake {
    mode: Mutex<String>,
    /// Answers to give, in order (None: never answer).
    answers: Mutex<Vec<Option<ExternalAnswer>>>,
    asked: Mutex<Vec<(String, Value, Vec<String>)>>,
    withdrawn: Mutex<Vec<String>>,
    /// Senders kept alive for unanswered requests (so the gate times out rather than seeing a closed channel).
    held: Mutex<Vec<mpsc::Sender<ExternalAnswer>>>,
}

impl Asker for Arc<Fake> {
    fn mode(&self, _chat: usize) -> Option<String> {
        Some(self.mode.lock().unwrap().clone())
    }
    fn ask(&self, _chat: usize, _tool: &str, summary: &str, input: Value, remember: Vec<RememberOption>) -> Option<(String, Receiver<ExternalAnswer>)> {
        self.asked.lock().unwrap().push((summary.to_string(), input, remember.iter().map(|r| r.id.clone()).collect()));
        let (tx, rx) = mpsc::channel();
        let next = { let mut a = self.answers.lock().unwrap(); if a.is_empty() { None } else { a.remove(0) } };
        match next {
            Some(a) => {
                let _ = tx.send(a);
            }
            None => self.held.lock().unwrap().push(tx),
        }
        Some((format!("coool-{}", self.asked.lock().unwrap().len()), rx))
    }
    fn withdraw(&self, _chat: usize, id: &str, _note: &str) {
        self.withdrawn.lock().unwrap().push(id.to_string());
    }
}

fn gate(mode: &str, answers: Vec<Option<ExternalAnswer>>, store: Option<PathBuf>) -> (Gate, Arc<Fake>) {
    let f = Arc::new(Fake::default());
    *f.mode.lock().unwrap() = mode.into();
    *f.answers.lock().unwrap() = answers;
    let g = Gate::default();
    g.set_asker(Box::new(f.clone()));
    g.set_timeout(Duration::from_millis(150));
    if let Some(p) = store {
        g.set_store(p);
    }
    (g, f)
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("coool-gate-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("device-grants.json")
}

#[test]
fn once_asks_again_this_chat_does_not() {
    let (g, f) = gate("default", vec![Some(ExternalAnswer::Allow), Some(ExternalAnswer::Remember("chat".into()))], None);
    g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    assert_eq!(f.asked.lock().unwrap().len(), 2, "once: the next change asks again");
    g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    assert_eq!(f.asked.lock().unwrap().len(), 2, "this chat: no more asks");
    // Another chat, another device: their own asks.
    g.check(2, Some("/p"), act(Dev::Iphone)).unwrap_err();
    assert_eq!(f.asked.lock().unwrap().len(), 3);
    let (_, input, remember) = f.asked.lock().unwrap()[0].clone();
    assert_eq!(input["coool_device"]["kind"], "use");
    assert_eq!(remember, ["chat", "project"]);
    // A risky kind in that chat still asks, once only.
    *f.answers.lock().unwrap() = vec![Some(ExternalAnswer::Allow)];
    g.check(1, Some("/p"), act(Dev::Iphone).risk(Some(Risk::Install { what: "/tmp/A.app".into() }))).unwrap();
    assert!(f.asked.lock().unwrap()[3].2.is_empty());
}

#[test]
fn deny_and_timeout_are_denials_for_the_agent() {
    let (g, f) = gate("on-request", vec![Some(ExternalAnswer::Deny), None, Some(ExternalAnswer::Cancelled("the turn ended before the person answered".into()))], None);
    let e = g.check(1, None, Act::new(Dev::Mac, "x").risk(Some(Risk::Shell { command: "ls".into() }))).unwrap_err();
    assert!(e.starts_with("Denied by the person: run a command in the sandbox Mac ls"), "{e}");
    let t = std::time::Instant::now();
    let e = g.check(1, None, act(Dev::Mac)).unwrap_err();
    assert!(e.contains("didn't answer") && t.elapsed() >= Duration::from_millis(150), "{e}");
    assert_eq!(f.withdrawn.lock().unwrap().len(), 1, "a timed-out request is taken back from the chat");
    let e = g.check(1, None, act(Dev::Mac)).unwrap_err();
    assert!(e.contains("turn ended"), "{e}");
}

#[test]
fn free_modes_never_ask_and_dont_ask_denies() {
    let (g, f) = gate("bypassPermissions", vec![], None);
    g.check(1, None, Act::new(Dev::Mac, "x").risk(Some(Risk::Shell { command: "ls".into() }))).unwrap();
    *f.mode.lock().unwrap() = "never".into();
    g.check(1, None, browser("example.com").risk(Some(Risk::Submit { label: "Go".into() }))).unwrap();
    *f.mode.lock().unwrap() = "dontAsk".into();
    assert!(g.check(1, None, act(Dev::Iphone)).unwrap_err().contains("Don't ask"));
    assert!(f.asked.lock().unwrap().is_empty());
}

#[test]
fn project_grants_persist_cover_sites_and_can_be_revoked() {
    let store = tmp("project");
    let (g, f) = gate("default", vec![Some(ExternalAnswer::Remember("project".into()))], Some(store.clone()));
    g.check(1, Some("/work/app"), browser("example.com")).unwrap();
    // A new chat in the same project, a coool restarted on the same file: allowed without asking.
    let (g2, f2) = gate("default", vec![], Some(store.clone()));
    g2.check(9, Some("/work/app"), browser("www.example.com")).unwrap();
    assert!(f2.asked.lock().unwrap().is_empty());
    assert_eq!(g2.projects(), vec![("/work/app".to_string(), ProjectGrants { devices: [Dev::Browser].into_iter().collect(), sites: ["example.com".to_string()].into_iter().collect() })]);
    // Another project: asks.
    g2.check(9, Some("/work/other"), browser("example.com")).unwrap_err();
    // The project grant never covers a submit.
    *f2.answers.lock().unwrap() = vec![Some(ExternalAnswer::Deny)];
    g2.check(9, Some("/work/app"), browser("example.com").risk(Some(Risk::Submit { label: "Buy".into() }))).unwrap_err();
    // Revoking the site keeps the Browser; revoking the device asks again.
    g2.revoke("/work/app", None, Some("example.com"));
    *f2.answers.lock().unwrap() = vec![Some(ExternalAnswer::Allow)];
    g2.check(10, Some("/work/app"), browser("example.com")).unwrap();
    assert_eq!(f2.asked.lock().unwrap().last().unwrap().1["coool_device"]["kind"], "site");
    g2.revoke("/work/app", Some(Dev::Browser), None);
    assert!(g2.projects().is_empty(), "an empty project entry is removed");
    let saved: Value = serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
    assert_eq!(saved["projects"], json!({}));
    assert_eq!(f.asked.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(store.parent().unwrap());
}

#[test]
fn a_pilot_scope_allows_its_device_and_start_site_only() {
    let (g, f) = gate("default", vec![], None);
    {
        let _s = pilot_scope(PilotScope { chat: 1, dev: Dev::Browser, sites: ["127.0.0.1".to_string()].into_iter().collect() });
        g.check(1, None, browser("http://127.0.0.1:8000/")).unwrap();
        // Another chat on this thread doesn't inherit it.
        g.check(2, None, browser("http://127.0.0.1:8000/")).unwrap_err();
    }
    g.check(1, None, browser("http://127.0.0.1:8000/")).unwrap_err();
    assert_eq!(f.asked.lock().unwrap().len(), 2);
}

/// The ungated paths: a mode lookup and nothing else (the hot path every action pays in a free mode).
#[test]
fn the_free_path_costs_nothing_measurable() {
    let (g, _) = gate("bypassPermissions", vec![], None);
    let t = std::time::Instant::now();
    for _ in 0..10_000 {
        g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    }
    let per = t.elapsed() / 10_000;
    assert!(per < Duration::from_micros(50), "{per:?} per check");
    let (g, _) = gate("default", vec![Some(ExternalAnswer::Remember("chat".into()))], None);
    g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    let t = std::time::Instant::now();
    for _ in 0..10_000 {
        g.check(1, Some("/p"), act(Dev::Iphone)).unwrap();
    }
    let per = t.elapsed() / 10_000;
    assert!(per < Duration::from_micros(50), "{per:?} per allowed check");
}
