use super::drivers::{browser_screen, iphone_screen};
use super::memory::Memory;
use super::*;
use crate::device::observe;
use serde_json::json;

fn elem(role: &str, label: &str, kind: Kind) -> Elem {
    Elem { handle: format!("h-{label}"), role: role.into(), label: label.into(), frame: [16.0, 300.0, 370.0, 52.0], kind, ..Default::default() }
}

fn screen(app: &str, elems: Vec<Elem>) -> Screen {
    Screen { app: app.into(), elems, w: 402.0, h: 874.0, ..Default::default() }
}

fn inputs(kv: &[(&str, &str)]) -> BTreeMap<String, String> {
    kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn goal(text: &str, success: Vec<Check>) -> Goal {
    Goal { goal: text.into(), target: Target::Iphone, app: None, url: None, inputs: BTreeMap::new(), success, max_steps: 10, budget: Duration::from_secs(30), alerts: false }
}

// ---------- the candidate builder ----------

#[test]
fn candidates_from_an_iphone_tree() {
    let d = json!({"screen":{"w":402,"h":874},"nodes":[
        {"role":"application","label":"Settings","frame":[0,0,402,874],"depth":0,"parent":-1},
        // The screen it came from, still in the tree, shifted left by the push.
        {"role":"button","label":"Wi-Fi","frame":[-105,300,370,52],"depth":1,"parent":0},
        {"role":"heading","label":"General","frame":[32,241,80,26],"depth":1,"parent":0},
        {"role":"button","label":"About","identifier":"com.apple.settings.general.about","frame":[16,407,370,52],"depth":1,"parent":0},
        {"role":"text","label":"Name, iPhone","frame":[20,500,362,53],"depth":1,"parent":0},
        {"role":"text","label":"Small print","frame":[20,600,120,20],"depth":1,"parent":0},
        {"role":"textfield","placeholder":"Search","frame":[28,808,346,28],"depth":1,"parent":0,"focused":true},
        {"role":"button","label":"Disabled","frame":[16,700,370,52],"depth":1,"parent":0,"disabled":true},
        {"role":"group","frame":[0,0,402,874],"depth":1,"parent":0}]});
    let s = iphone_screen(&observe::parse(&d));
    assert_eq!(s.app, "Settings");
    assert!(s.keyboard && !s.alert && !s.home);
    let c = candidates(&s, &inputs(&[("query", "about")]), Target::Iphone);
    let lines: Vec<String> = c.iter().map(|a| format!("[{}] {}", a.id, a.describe())).collect();
    assert_eq!(
        lines,
        [
            "[0] tap button \"About\"",
            "[1] tap text \"Name, iPhone\"",
            "[2] set_text <query> into textfield \"Search\"",
            "[3] submit: press the keyboard's Return / Go key",
            "[4] scroll down",
            "[5] scroll up",
            "[6] back: go back one screen / page",
            "[7] done: the goal is achieved on this screen",
            "[8] stuck: no action here makes progress",
        ]
    );
    // The pushed-away screen and plain text are seen but not offered.
    assert!(s.elems.iter().any(|e| e.label == "Wi-Fi" && e.offscreen));
    assert!(s.mentions("small print"));
    // Every target carries the device tools' id.
    assert_eq!(c[0].target.as_ref().unwrap().id, s.elems.iter().find(|e| e.label == "About").unwrap().handle);
}

#[test]
fn a_system_alert_offers_only_its_buttons() {
    let d = json!({"screen":{"w":402,"h":874},"nodes":[
        {"role":"application","label":" ","frame":[0,0,402,874],"depth":0,"parent":-1},
        {"role":"text","label":"Allow “Maps” to use your location?","frame":[71,290,260,42],"depth":1,"parent":0},
        {"role":"button","label":"Allow Once","frame":[57,458,288,48],"depth":1,"parent":0},
        {"role":"button","label":"Don’t Allow","frame":[57,570,288,48],"depth":1,"parent":0}]});
    let s = iphone_screen(&observe::parse(&d));
    assert!(s.alert && !s.home);
    let c: Vec<String> = candidates(&s, &BTreeMap::new(), Target::Iphone).iter().map(|a| a.describe()).collect();
    assert_eq!(c.len(), 4, "{c:?}");
    assert!(c[0].contains("Allow Once") && c[1].contains("Don’t Allow"));
    // The home screen: SpringBoard with identified icons.
    let home = json!({"screen":{"w":402,"h":874},"nodes":[
        {"role":"application","label":" ","frame":[0,0,402,874],"depth":0,"parent":-1},
        {"role":"button","label":"Settings","identifier":"Settings","frame":[305,389,68,90],"depth":1,"parent":0}]});
    let h = iphone_screen(&observe::parse(&home));
    assert!(h.home && !h.alert);
    assert!(!candidates(&h, &BTreeMap::new(), Target::Iphone).iter().any(|a| a.verb == Verb::Back));
}

#[test]
fn candidates_from_a_page() {
    let snap: crate::device::web::Snap = serde_json::from_value(json!({
        "doc":"d1","url":"http://127.0.0.1:9/form","title":"Coffee order","ready":"complete","vw":800,"vh":600,
        "els":[
            {"id":3,"role":"textbox","name":"Name","x":24,"y":100,"w":300,"h":30,"focused":true},
            {"id":4,"role":"textbox","name":"Email","typ":"email","value":"a@b.c","x":24,"y":150,"w":300,"h":30},
            {"id":5,"role":"textbox","name":"Password","pw":true,"filled":true,"x":24,"y":200,"w":300,"h":30},
            {"id":6,"role":"button","name":"Add cup","x":24,"y":250,"w":80,"h":30},
            {"id":7,"role":"heading","name":"Coffee order","level":1,"x":24,"y":20,"w":300,"h":40},
            {"id":8,"role":"button","name":"Far","x":24,"y":2000,"w":80,"h":30,"off":true}],
        "text":"Coffee order\nCups: 2"}))
    .unwrap();
    let s = browser_screen(&snap);
    assert_eq!(s.url.as_deref(), Some("http://127.0.0.1:9/form"));
    assert!(s.keyboard);
    // A password's value never shows, only that it's filled.
    assert_eq!(s.elems.iter().find(|e| e.label == "Password").unwrap().value.as_deref(), Some("•"));
    let c = candidates(&s, &inputs(&[("name", "Ada"), ("email", "ada@example.com")]), Target::Browser);
    let d: Vec<String> = c.iter().map(|a| a.describe()).collect();
    assert_eq!(d.iter().filter(|x| x.starts_with("set_text")).count(), 6, "{d:?}");
    assert!(d.contains(&"tap button \"Add cup\"".to_string()));
    assert!(!d.iter().any(|x| x.contains("Far") || x.contains("tap heading")));
    assert!(d.iter().any(|x| x.starts_with("submit")) && d.iter().any(|x| x.starts_with("back")));
    assert!(Check::TextVisible("Cups: 2".into()).holds(&s));
}

// ---------- success checks ----------

#[test]
fn success_checks() {
    let mut s = screen("Settings", vec![elem("button", "iOS Version, 27.0", Kind::Tap), Elem { value: Some("3".into()), ..elem("text", "Cups", Kind::Text) }]);
    s.url = Some("http://x/thanks?id=1".into());
    let parse = |v: Value| Check::parse(&v).unwrap();
    assert!(parse(json!({"text_visible":"ios version"})).holds(&s));
    assert!(!parse(json!({"text_visible":"Model Name"})).holds(&s));
    assert!(parse(json!({"text_gone":"Model Name"})).holds(&s));
    assert!(parse(json!({"element":{"label":"iOS Version"}})).holds(&s));
    // A value may sit in the label (iOS joins them: "iOS Version, 27.0") or in the value.
    assert!(parse(json!({"element":{"label":"iOS Version","value":"27.0"}})).holds(&s));
    assert!(parse(json!({"element":{"label":"Cups","value":"3"}})).holds(&s));
    assert!(!parse(json!({"element":{"label":"Cups","value":"4"}})).holds(&s));
    assert!(parse(json!({"url_matches":"/thanks"})).holds(&s));
    assert!(!parse(json!({"url_matches":"/form"})).holds(&s));
    assert!(Check::parse(&json!({"element":{}})).is_err());
    assert!(Check::parse(&json!({"pixel":"red"})).is_err());
    let g = Goal::parse(&json!({"goal":"x","target":"browser","success":[{"url_matches":"/a"}],"inputs":{"n":3}})).unwrap();
    assert_eq!((g.target, g.success.len(), g.inputs["n"].as_str(), g.max_steps), (Target::Browser, 1, "3", 15));
    assert!(Goal::parse(&json!({"goal":"x","target":"watch"})).is_err());
    assert!(Goal::parse(&json!({"target":"iphone"})).is_err());
}

// ---------- muscle memory ----------

#[test]
fn memory_matches_exactly_and_persists() {
    let dir = std::env::temp_dir().join(format!("coool-pilot-mem-{}", std::process::id()));
    let mut m = Memory::open(&dir, "/projects/a");
    let k = super::memory::key("goal", "sig1", "start");
    assert_eq!(m.lookup(&k), None);
    assert_eq!(m.learn(&[(k.clone(), "tap|button|General||".into())]), 1);
    // The same goal, screen and previous action only.
    assert_eq!(m.lookup(&k).as_deref(), Some("tap|button|General||"));
    assert_eq!(m.lookup(&super::memory::key("goal", "sig2", "start")), None);
    assert_eq!(m.lookup(&super::memory::key("goal", "sig1", "tap|button|About||")), None);
    assert_eq!(m.lookup(&super::memory::key("other goal", "sig1", "start")), None);
    // On disk, per project.
    assert_eq!(Memory::open(&dir, "/projects/a").lookup(&k).as_deref(), Some("tap|button|General||"));
    assert_eq!(Memory::open(&dir, "/projects/b").len(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn signature_ignores_typed_values_and_positions_but_not_state() {
    let a = screen("Contacts", vec![Elem { value: Some("Ada".into()), ..elem("textfield", "First name", Kind::Input) }, elem("button", "Done", Kind::Tap)]);
    let mut b = a.clone();
    b.elems[0].value = Some("Grace".into());
    b.elems[1].frame[1] += 7.0;
    assert_eq!(signature(&a), signature(&b));
    let mut empty = a.clone();
    empty.elems[0].value = None;
    assert_ne!(signature(&a), signature(&empty), "filled vs empty is a different step");
    let mut sel = a.clone();
    sel.elems[1].selected = true;
    assert_ne!(signature(&a), signature(&sel));
}

#[test]
fn signature_ignores_what_comes_and_goes_on_an_iphone_screen() {
    // Settings > General, as read right after the push and a moment later.
    let row = |l: &str, y: f64| Elem { frame: [16.0, y, 370.0, 52.0], ..elem("button", l, Kind::Tap) };
    let settled = screen("Settings", vec![row("About", 408.0), row("Keyboard", 738.0)]);
    let mut early = settled.clone();
    // The back button joins the tree late.
    early.elems.insert(0, Elem { frame: [16.0, 62.0, 44.0, 44.0], ..elem("button", "Settings", Kind::Tap) });
    assert_eq!(signature(&early), signature(&settled));
    // The row cut by the screen's bottom edge, and the floating search bar with its mic.
    early.elems.push(row("Trackpad", 842.0));
    early.elems.push(Elem { frame: [28.0, 808.0, 300.0, 36.0], ..elem("textfield", "Search", Kind::Input) });
    early.elems.push(Elem { frame: [340.0, 808.0, 36.0, 36.0], ..elem("button", "Dictate", Kind::Tap) });
    assert_eq!(signature(&early), signature(&settled));
    // A search field in use, or a fully visible row, still counts.
    let mut typing = early.clone();
    typing.elems.iter_mut().find(|e| e.label == "Search").unwrap().value = Some("wifi".into());
    assert_ne!(signature(&typing), signature(&settled));
    let mut more = settled.clone();
    more.elems.push(row("Fonts", 686.0));
    assert_ne!(signature(&more), signature(&settled));
    // A page's elements aren't filtered (the browser reports what's in view itself).
    let mut page = early.clone();
    page.url = Some("http://x/".into());
    let mut page2 = settled.clone();
    page2.url = page.url.clone();
    assert_ne!(signature(&page), signature(&page2));
}

// ---------- the loop and its cascade ----------

/// Screens by name; acting moves along `edges` ((screen, action key) → next screen).
struct Fake {
    screens: HashMap<String, Screen>,
    edges: HashMap<(String, String), String>,
    at: String,
    acted: Vec<String>,
    ended: bool,
    /// Fresh starts (launches).
    starts: usize,
    /// The app is already in front (a warm start is possible).
    front: bool,
}

impl Fake {
    /// Settings → General → About (the About screen shows the version).
    fn settings() -> Self {
        let mut screens = HashMap::new();
        screens.insert("root".into(), screen("Settings", vec![elem("button", "General", Kind::Tap), elem("button", "Camera", Kind::Tap)]));
        screens.insert("general".into(), screen("Settings", vec![elem("button", "About", Kind::Tap), elem("button", "Fonts", Kind::Tap)]));
        screens.insert("about".into(), screen("Settings", vec![elem("button", "iOS Version, 27.0", Kind::Tap)]));
        let mut alert = screen("", vec![elem("button", "Allow", Kind::Tap)]);
        alert.alert = true;
        screens.insert("alert".into(), alert);
        let mut edges = HashMap::new();
        edges.insert(("root".into(), "tap|button|General||".into()), "general".into());
        edges.insert(("general".into(), "tap|button|About||".into()), "about".into());
        edges.insert(("root".into(), "tap|button|Camera||".into()), "alert".into());
        edges.insert(("about".into(), "back|||".into()), "general".into());
        edges.insert(("general".into(), "back|||".into()), "root".into());
        Fake { screens, edges, at: "root".into(), acted: Vec::new(), ended: false, starts: 0, front: false }
    }
}

impl Driver for Fake {
    fn start(&mut self, _g: &Goal) -> Result<String, String> {
        self.at = "root".into();
        self.starts += 1;
        Ok(String::new())
    }
    fn resume(&mut self, _g: &Goal, app: &str) -> Result<Option<String>, String> {
        Ok((self.front && self.screens[&self.at].app == app).then(|| "in front".to_string()))
    }
    fn perceive(&mut self) -> Result<(Screen, u64), String> {
        Ok((self.screens[&self.at].clone(), 1))
    }
    fn act(&mut self, a: &Action, _s: &Screen, _i: &BTreeMap<String, String>) -> Result<String, String> {
        self.acted.push(a.key());
        if let Some(n) = self.edges.get(&(self.at.clone(), a.key())) {
            self.at = n.clone();
        }
        Ok(String::new())
    }
    fn settle(&mut self, _v: Verb) -> u64 {
        1
    }
    fn finish(&mut self) {
        self.ended = true;
    }
}

/// Picks the candidate whose description contains the first matching word, else `stuck`.
struct Script {
    prefer: Vec<&'static str>,
    calls: usize,
}

impl Decider for Script {
    fn name(&self) -> &'static str {
        "haiku"
    }
    fn decide(&mut self, r: &DecideRequest) -> Result<Decision, String> {
        self.calls += 1;
        for p in &self.prefer {
            if let Some(a) = r.candidates.iter().find(|a| a.describe().contains(p)) {
                return Ok(Decision { id: a.id, ms: 5, usd: 0.0001, ..Default::default() });
            }
        }
        Ok(Decision { id: r.candidates.iter().find(|a| a.verb == Verb::Stuck).unwrap().id, ..Default::default() })
    }
}

fn about_goal() -> Goal {
    goal("Open General, then About", vec![Check::TextVisible("iOS Version".into())])
}

#[test]
fn cascade_learns_then_replays_from_memory() {
    let mut mem = Memory::in_memory();
    let mut d = Fake::settings();
    let mut model = Script { prefer: vec!["General", "About"], calls: 0 };
    let mut events = 0;
    let first = run(&about_goal(), &mut d, &mut mem, Some(&mut model), "Claude Haiku", &mut |_, _| events += 1);
    assert_eq!(first.status, Status::Done);
    assert!(first.verified && d.ended);
    assert_eq!(first.deciders.get("haiku"), Some(&2));
    assert_eq!(first.learned, 2);
    assert!(events >= 3);
    // The second run of the same goal: every step from memory, the model never asked.
    let mut d2 = Fake::settings();
    let mut model2 = Script { prefer: vec!["Camera"], calls: 0 };
    let second = run(&about_goal(), &mut d2, &mut mem, Some(&mut model2), "Claude Haiku", &mut |_, _| {});
    assert_eq!(second.status, Status::Done);
    assert_eq!(model2.calls, 0);
    assert_eq!(second.deciders.get("memory"), Some(&2));
    assert_eq!(d2.acted, ["tap|button|General||", "tap|button|About||"]);
}

#[test]
fn memory_misses_on_a_changed_screen_and_falls_through_to_the_model() {
    let mut mem = Memory::in_memory();
    run(&about_goal(), &mut Fake::settings(), &mut mem, Some(&mut Script { prefer: vec!["General", "About"], calls: 0 }), "", &mut |_, _| {});
    let mut d = Fake::settings();
    // General's screen gained a row: its signature differs, so memory must not guess there.
    d.screens.get_mut("general").unwrap().elems.push(elem("button", "Keyboard", Kind::Tap));
    let mut model = Script { prefer: vec!["About"], calls: 0 };
    let o = run(&about_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!(o.status, Status::Done);
    assert_eq!((o.deciders.get("memory"), o.deciders.get("haiku")), (Some(&1), Some(&1)));
}

#[test]
fn without_a_model_a_miss_returns_the_candidates() {
    let mut mem = Memory::in_memory();
    let mut d = Fake::settings();
    let o = run(&about_goal(), &mut d, &mut mem, None, "no Anthropic API key is set up", &mut |_, _| {});
    assert_eq!(o.status, Status::Stuck);
    assert!(o.reason.contains("no Anthropic API key"), "{}", o.reason);
    assert!(o.candidates.iter().any(|a| a.describe() == "tap button \"General\""));
    assert!(d.acted.is_empty() && d.ended);
    let text = result_text(&o);
    assert!(text.starts_with("pilot stuck in 0 steps"), "{text}");
    assert!(text.contains("\"id\": \"h-General\""));
}

#[test]
fn done_is_judged_by_the_checks_not_the_model() {
    let mut mem = Memory::in_memory();
    // The model claims done on the first screen twice: rejected both times, then stuck.
    let mut model = Script { prefer: vec!["done:"], calls: 0 };
    let o = run(&about_goal(), &mut Fake::settings(), &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!(o.status, Status::Stuck);
    assert!(!o.verified);
    assert_eq!(o.steps.len(), 2);
    assert!(o.steps[0].note.contains("success checks"));
    assert_eq!(mem.len(), 0, "nothing learned from a failed run");
    // Without checks, "done" is taken (and reported unverified).
    let o = run(&goal("Open Settings", vec![]), &mut Fake::settings(), &mut mem, Some(&mut Script { prefer: vec!["done:"], calls: 0 }), "", &mut |_, _| {});
    assert_eq!((o.status, o.verified), (Status::Done, false));
}

#[test]
fn an_alert_is_a_surprise_unless_allowed() {
    let mut mem = Memory::in_memory();
    let g = goal("Open Camera settings", vec![Check::TextVisible("Formats".into())]);
    let o = run(&g, &mut Fake::settings(), &mut mem, Some(&mut Script { prefer: vec!["Camera"], calls: 0 }), "", &mut |_, _| {});
    assert_eq!(o.status, Status::Surprised);
    assert!(o.reason.contains("alert"));
    assert!(o.candidates.iter().any(|a| a.describe().contains("Allow")));
}

#[test]
fn budgets_end_the_run() {
    let mut mem = Memory::in_memory();
    let mut g = about_goal();
    g.max_steps = 1;
    let o = run(&g, &mut Fake::settings(), &mut mem, Some(&mut Script { prefer: vec!["General", "About"], calls: 0 }), "", &mut |_, _| {});
    assert_eq!(o.status, Status::OutOfBudget);
    assert_eq!(o.steps.len(), 1);
}

#[test]
fn going_in_circles_is_stuck() {
    let mut mem = Memory::in_memory();
    // Scrolling changes nothing on this fake: the same screen keeps coming back.
    let o = run(&about_goal(), &mut Fake::settings(), &mut mem, Some(&mut Script { prefer: vec!["scroll down"], calls: 0 }), "", &mut |_, _| {});
    assert_eq!(o.status, Status::Stuck);
    assert!(o.reason.contains("circles"), "{}", o.reason);
}

// ---------- Haiku ----------

#[test]
fn haiku_request_is_cacheable_and_carries_no_input_values() {
    let mut g = about_goal();
    g.inputs = inputs(&[("password", "hunter2-secret")]);
    let s = screen("Settings", vec![elem("button", "General", Kind::Tap)]);
    let c = candidates(&s, &g.inputs, Target::Iphone);
    let history = vec!["tap button \"Camera\"".to_string()];
    let body = haiku::request_body(&DecideRequest { goal: &g, history: &history, screen: &s, candidates: &c });
    assert_eq!(body["model"], "claude-haiku-5-5");
    assert_eq!(body["tool_choice"]["name"], "act");
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    // The static prefix doesn't depend on the step.
    assert!(body["tools"][0]["input_schema"]["properties"]["action_id"].get("enum").is_none());
    let text = body.to_string();
    assert!(!text.contains("hunter2"), "input values never leave the machine");
    let user = body["messages"][0]["content"].as_str().unwrap();
    assert!(user.contains("<password>") && user.contains("[0] tap button \"General\""), "{user}");
    assert!(user.contains("1. tap button \"Camera\"") && user.contains("Done when: text \"iOS Version\" visible"));
    let reply = json!({"content":[{"type":"tool_use","name":"act","input":{"action_id":2}}],"stop_reason":"tool_use",
        "usage":{"input_tokens":300,"output_tokens":20,"cache_read_input_tokens":700,"cache_creation_input_tokens":0}});
    let (id, usd, tokens, cached) = haiku::parse_reply(&reply.to_string()).unwrap();
    assert_eq!((id, tokens, cached), (2, 1000, 700));
    assert!((usd - (300.0 * 0.10 + 20.0 * 0.50 + 700.0 * 0.01) / 1e6).abs() < 1e-12);
    assert!(haiku::parse_reply(&json!({"stop_reason":"refusal","content":[]}).to_string()).is_err());
    assert!(haiku::parse_reply(&json!({"content":[{"type":"text","text":"2"}]}).to_string()).is_err());
}

#[test]
fn tool_is_described_for_delegation() {
    let t = tool();
    assert_eq!(t["name"], "pilot_run");
    let d = t["description"].as_str().unwrap();
    assert!(d.contains("success") && d.contains("inputs") && d.contains("stuck"));
}

#[test]
#[ignore = "calls the real Anthropic API (spends a fraction of a cent)"]
fn real_haiku_decision() {
    let mut h = haiku::Haiku::from_keychain().expect("no API key configured");
    let g = about_goal();
    let s = screen("Settings", vec![elem("button", "Camera", Kind::Tap), elem("button", "General", Kind::Tap)]);
    let c = candidates(&s, &g.inputs, Target::Iphone);
    let d = h.decide(&DecideRequest { goal: &g, history: &[], screen: &s, candidates: &c }).unwrap();
    println!("chose {} in {} ms, ${:.6}, {} tokens ({} cached)", c[d.id].describe(), d.ms, d.usd, d.input_tokens, d.cached_tokens);
    assert!(c[d.id].describe().contains("General"));
}

// ---------- warm start ----------

fn app_goal() -> Goal {
    Goal { app: Some("com.apple.Preferences".into()), ..about_goal() }
}

fn route_of(d: &Fake) -> memory::Route {
    let sig = |n: &str| signature(&d.screens[n]);
    memory::Route {
        app: "Settings".into(),
        screens: vec![sig("root"), sig("general"), sig("about")],
        actions: vec!["tap|button|General||".into(), "tap|button|About||".into()],
    }
}

#[test]
fn warm_plan_recognises_only_route_screens() {
    let d = Fake::settings();
    let r = route_of(&d);
    let s = |n: &str| d.screens[n].clone();
    assert_eq!(warm_plan(&r, &s("root"), false), Warm::At(0));
    assert_eq!(warm_plan(&r, &s("general"), false), Warm::At(1));
    // The end: one step back first (the step there was a tap), by signature or because the checks hold.
    assert_eq!(warm_plan(&r, &s("about"), false), Warm::BackTo(1));
    let mut live = s("about");
    live.elems.push(elem("text", "Available, 48.87 GB", Kind::Tap));
    assert_eq!(warm_plan(&r, &live, true), Warm::BackTo(1));
    assert_eq!(warm_plan(&r, &live, false), Warm::Relaunch);
    // Unknown screen, another app, an alert: relaunch.
    let mut other = s("general");
    other.elems.push(elem("button", "Keyboard", Kind::Tap));
    assert_eq!(warm_plan(&r, &other, false), Warm::Relaunch);
    let mut maps = s("root");
    maps.app = "Maps".into();
    assert_eq!(warm_plan(&r, &maps, false), Warm::Relaunch);
    assert_eq!(warm_plan(&r, &s("alert"), true), Warm::Relaunch);
    // A screen the route shows twice can't tell where it is.
    let twice = memory::Route {
        screens: vec![r.screens[0].clone(), r.screens[1].clone(), r.screens[0].clone(), r.screens[2].clone()],
        actions: vec!["tap|button|General||".into(), "back|||".into(), "tap|button|Camera||".into()],
        ..r.clone()
    };
    assert_eq!(warm_plan(&twice, &s("root"), false), Warm::Relaunch);
    // Past a step that typed text: a field's contents aren't in the signature, so never continue there.
    let typed = memory::Route { actions: vec!["set_text|textfield|Name|name|".into(), "tap|button|About||".into()], ..r.clone() };
    assert_eq!(warm_plan(&typed, &s("root"), false), Warm::At(0));
    assert_eq!(warm_plan(&typed, &s("general"), false), Warm::Relaunch);
    assert_eq!(warm_plan(&typed, &s("about"), true), Warm::Relaunch);
    // The end reached by something other than a tap (a scroll): no way back to trust.
    let scrolled = memory::Route { actions: vec!["tap|button|General||".into(), "scroll||||down".into()], ..r };
    assert_eq!(warm_plan(&scrolled, &s("about"), true), Warm::Relaunch);
}

#[test]
fn warm_start_continues_on_the_route_and_relaunches_otherwise() {
    let mut mem = Memory::in_memory();
    let mut d = Fake::settings();
    d.front = true;
    // No route yet: a fresh start, which learns one.
    let first = run(&app_goal(), &mut d, &mut mem, Some(&mut Script { prefer: vec!["General", "About"], calls: 0 }), "", &mut |_, _| {});
    assert_eq!((first.status, d.starts), (Status::Done, 1));
    assert_eq!(mem.route(&app_goal().memory_key()), Some(route_of(&d)));
    // The app is still in front on About: one step back, then memory; no relaunch, no model.
    d.acted.clear();
    let mut model = Script { prefer: vec!["Camera"], calls: 0 };
    let o = run(&app_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!((o.status, o.verified, d.starts, model.calls), (Status::Done, true, 1, 0));
    assert_eq!(d.acted, ["back|||", "tap|button|About||"]);
    assert!(o.start.starts_with("warm:"), "{}", o.start);
    assert_eq!(o.deciders.get("memory"), Some(&1));
    // The route survives a warm run (its first screens, then this run's path).
    assert_eq!(mem.route(&app_goal().memory_key()), Some(route_of(&d)));
    // Left on the root: continues from the first step.
    d.at = "root".into();
    d.acted.clear();
    let o = run(&app_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!((o.status, d.starts), (Status::Done, 1));
    assert_eq!(d.acted, ["tap|button|General||", "tap|button|About||"]);
    // Left on a screen the route doesn't know: relaunch, then the normal replay from the root.
    d.screens.insert("camera".into(), screen("Settings", vec![elem("button", "Formats", Kind::Tap)]));
    d.at = "camera".into();
    d.acted.clear();
    let o = run(&app_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!((o.status, d.starts, model.calls), (Status::Done, 2, 0));
    assert!(o.start.contains("relaunching"), "{}", o.start);
    assert_eq!(d.acted, ["tap|button|General||", "tap|button|About||"]);
    // Back from the end leads somewhere unexpected: relaunch (no replay from there).
    d.edges.insert(("about".into(), "back|||".into()), "camera".into());
    d.at = "about".into();
    d.acted.clear();
    let o = run(&app_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!((o.status, d.starts, model.calls), (Status::Done, 3, 0));
    assert_eq!(d.acted, ["back|||", "tap|button|General||", "tap|button|About||"]);
    // The app isn't in front (or the driver can't resume): a fresh start.
    d.front = false;
    d.at = "general".into();
    let o = run(&app_goal(), &mut d, &mut mem, Some(&mut model), "", &mut |_, _| {});
    assert_eq!((o.status, d.starts), (Status::Done, 4));
}

// ---------- the decision log ----------

/// A sign-in form: email and password fields; the page echoes the email once it's filled.
fn form() -> (Fake, Goal) {
    let field = |label: &str, value: Option<&str>| Elem { value: value.map(String::from), ..elem("textbox", label, Kind::Input) };
    let mut screens = HashMap::new();
    screens.insert("empty".into(), screen("Sign in", vec![field("Email", None), field("Password", None), elem("button", "Sign in", Kind::Tap)]));
    screens.insert("email".into(), screen("Sign in", vec![field("Email", Some("ada@example.com")), field("Password", None), elem("button", "Sign in", Kind::Tap)]));
    let mut filled = screen("Sign in", vec![field("Email", Some("ada@example.com")), field("Password", Some("•••••••")), elem("button", "Sign in", Kind::Tap)]);
    filled.texts = vec!["Signing in as ADA@example.com".into()];
    screens.insert("filled".into(), filled);
    let mut done = screen("Welcome", vec![elem("text", "Welcome back, ada@example.com", Kind::Text)]);
    done.url = Some("http://x/home?u=ada@example.com".into());
    screens.insert("done".into(), done);
    let mut edges = HashMap::new();
    edges.insert(("empty".into(), "set_text|textbox|Email|email|".into()), "email".into());
    edges.insert(("email".into(), "set_text|textbox|Password|password|".into()), "filled".into());
    edges.insert(("filled".into(), "tap|button|Sign in||".into()), "done".into());
    let d = Fake { screens, edges, at: "empty".into(), acted: Vec::new(), ended: false, starts: 0, front: false };
    let mut g = goal("Sign in with the email and password", vec![Check::TextVisible("Welcome back".into())]);
    g.target = Target::Browser;
    g.url = Some("http://x/signin".into());
    g.inputs = inputs(&[("email", "ada@example.com"), ("password", "hunter2-secret")]);
    (d, g)
}

/// The form's driver: starts on the empty form.
struct FormFake(Fake);

impl Driver for FormFake {
    fn start(&mut self, _g: &Goal) -> Result<String, String> {
        self.0.at = "empty".into();
        Ok(String::new())
    }
    fn perceive(&mut self) -> Result<(Screen, u64), String> {
        self.0.perceive()
    }
    fn act(&mut self, a: &Action, s: &Screen, i: &BTreeMap<String, String>) -> Result<String, String> {
        self.0.act(a, s, i)
    }
    fn settle(&mut self, v: Verb) -> u64 {
        self.0.settle(v)
    }
}

/// Decides the `n`th call by the `n`th description (then `stuck`).
struct Seq(Vec<&'static str>, usize);

impl Decider for Seq {
    fn name(&self) -> &'static str {
        "haiku"
    }
    fn decide(&mut self, r: &DecideRequest) -> Result<Decision, String> {
        let want = self.0.get(self.1).copied().unwrap_or("stuck:");
        self.1 += 1;
        let a = r.candidates.iter().find(|a| a.describe().contains(want)).or_else(|| r.candidates.iter().find(|a| a.verb == Verb::Stuck)).unwrap();
        Ok(Decision { id: a.id, ms: 7, ..Default::default() })
    }
}

fn form_run(prefer: Vec<&'static str>) -> (Goal, Outcome) {
    let (d, g) = form();
    let o = run(&g, &mut FormFake(d), &mut Memory::in_memory(), Some(&mut Seq(prefer, 0)), "", &mut |_, _| {});
    (g, o)
}

const SIGN_IN: [&str; 3] = ["<email> into textbox \"Email\"", "<password> into textbox \"Password\"", "Sign in"];

#[test]
fn decision_records_have_the_shape_and_keep_no_values() {
    let (g, o) = form_run(SIGN_IN.to_vec());
    assert_eq!((o.status, o.verified), (Status::Done, true));
    let recs = dataset::records("r1", &g, &o);
    // Three model decisions, then the checks' `done`.
    assert_eq!(recs.iter().map(|r| r.decider.as_str()).collect::<Vec<_>>(), ["haiku", "haiku", "haiku", "checks"]);
    let r = &recs[0];
    assert_eq!((r.v, r.run.as_str(), r.step, r.target.as_str(), r.prev.as_str()), (1, "r1", 1, "browser", "start"));
    assert_eq!(r.input_keys, ["email", "password"]);
    assert_eq!(r.checks, ["text \"Welcome back\" visible"]);
    assert_eq!(r.screen.candidates[r.chosen].verb, "set_text");
    assert_eq!(r.screen.candidates[r.chosen].input_key.as_deref(), Some("email"));
    assert!(r.action.starts_with("set_text <email>"), "{}", r.action);
    assert_eq!((r.outcome.as_str(), r.verified, r.on_success_path), ("done", true, Some(true)));
    assert!(r.screen.summary.contains("textbox \"Email\""));
    assert_eq!(recs[1].prev, "set_text|textbox|Email|email|");
    assert_eq!(recs[3].screen.candidates[recs[3].chosen].verb, "done");
    assert!(recs.iter().all(|r| r.on_success_path == Some(true)));
    // The JSON lines: every field, and no value anywhere.
    let line = serde_json::to_string(&recs).unwrap();
    for k in [
        "\"ts\":",
        "\"goal\":",
        "\"screen\":",
        "\"summary\":",
        "\"candidates\":",
        "\"prev\":",
        "\"decider\":",
        "\"chosen\":",
        "\"decision_ms\":",
        "\"outcome\":",
        "\"on_success_path\":",
    ] {
        assert!(line.contains(k), "{k}");
    }
    assert!(!line.to_lowercase().contains("ada@example.com"), "an input value was stored: {line}");
    assert!(!line.contains("hunter2") && !line.contains('•'), "a password was stored");
    // Echoes of a value become its key (labels, page text, the URL); fields show only that they're filled.
    assert!(line.contains("Welcome back, <email>") && line.contains("Signing in as <email>") && line.contains("u=<email>"), "{line}");
    assert!(line.contains("<filled>"));
    // Reads back as written.
    let back: Vec<dataset::Record> = serde_json::from_str(&line).unwrap();
    assert_eq!(back, recs);
    // The model never saw a field's contents either (candidates show only `<filled>`).
    let c = candidates(&o.trace[2].screen, &g.inputs, g.target);
    assert!(!render_for_model(&o.trace[2].screen, &c).contains("ada@example.com"));
}

#[test]
fn decision_records_of_a_failed_run_are_off_the_path_and_drop_api_keys() {
    let (d, mut g) = form();
    g.goal = "Sign in (key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx)".into();
    let o = run(&g, &mut FormFake(d), &mut Memory::in_memory(), Some(&mut Seq(vec![SIGN_IN[0], "stuck:"], 0)), "", &mut |_, _| {});
    assert_eq!(o.status, Status::Stuck);
    let recs = dataset::records("r2", &g, &o);
    assert_eq!(recs.len(), 2);
    assert!(recs.iter().all(|r| r.on_success_path == Some(false) && r.outcome == "stuck" && !r.verified));
    let line = serde_json::to_string(&recs).unwrap();
    assert!(!line.contains("sk-ant-api03") && line.contains("<redacted>"), "{line}");
}

#[test]
fn the_log_rotates_and_stops_at_its_cap() {
    let dir = std::env::temp_dir().join(format!("coool-pilot-log-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (g, o) = form_run(SIGN_IN.to_vec());
    let recs = dataset::records("r", &g, &o);
    let one = serde_json::to_vec(&recs[0]).unwrap().len() as u64 + 1;
    let file = dataset::path(&dir, "/projects/a");
    // Room for three records per file, ten in the folder.
    let (max_file, max_total) = (one * 3 + 10, one * 10);
    for _ in 0..3 {
        assert_eq!(dataset::append(&file, &recs[..1], max_file, max_total).unwrap(), 1);
    }
    assert_eq!(dataset::files(&dir).len(), 1);
    // The fourth rotates: the current file becomes `.1`.
    dataset::append(&file, &recs[..1], max_file, max_total).unwrap();
    assert_eq!(dataset::files(&dir).len(), 2);
    assert!(file.with_extension("1.jsonl").exists());
    assert_eq!(dataset::read(&file).len(), 1);
    // One older file only, so the folder stays bounded; past the folder's cap nothing is written.
    for _ in 0..20 {
        let _ = dataset::append(&file, &recs[..1], max_file, max_total);
    }
    assert_eq!(dataset::files(&dir).len(), 2);
    let (bytes, _) = dataset::size(&dir);
    assert!(bytes <= max_total, "{bytes} > {max_total}");
    assert_eq!(dataset::append(&file, &recs, max_file, one * 2).unwrap(), 0, "over the cap: nothing written");
    // Delete removes the logs only.
    std::fs::write(dir.join("x.json"), "{}").unwrap();
    assert_eq!(dataset::delete(&dir), 2);
    assert_eq!(dataset::size(&dir), (0, 0));
    assert!(dir.join("x.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_log_reads_back_into_the_spikes_per_step_eval() {
    let dir = std::env::temp_dir().join(format!("coool-pilot-eval-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let file = dataset::path(&dir, "/p");
    let (g, ok) = form_run(SIGN_IN.to_vec());
    let (g2, failed) = form_run(vec![SIGN_IN[0], "stuck:"]);
    dataset::append(&file, &dataset::records("a", &g, &ok), dataset::MAX_FILE, dataset::MAX_TOTAL).unwrap();
    dataset::append(&file, &dataset::records("b", &g2, &failed), dataset::MAX_FILE, dataset::MAX_TOTAL).unwrap();
    let recs = dataset::read(&file);
    assert_eq!(recs.len(), 4 + 2);
    // Labelled states: the successful run's 4 steps only (a failed run's choices are no gold).
    assert_eq!(dataset::gold(&recs).len(), 4);
    let perfect = dataset::eval(&recs, |r| Some(r.chosen));
    assert_eq!((perfect.n, perfect.correct, perfect.accuracy), (4, 4, 1.0));
    // A scorer that always picks candidate 0: right only where that was the gold (the email field, listed first).
    let first = dataset::eval(&recs, |_| Some(0));
    assert_eq!((first.n, first.correct), (4, 1));
    assert!((first.accuracy - 0.25).abs() < 1e-9);
    assert_eq!(first.by_decider.get("checks"), Some(&(1, 0)));
    assert_eq!(dataset::decider_accuracy(&recs).get("haiku"), Some(&(3, 3)));
    let report = dataset::report(&file);
    assert!(report.contains("6 records") && report.contains("4 labelled"), "{report}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_callers_choice_after_stuck_is_logged_and_the_toggle_stops_logging() {
    let dir = std::env::temp_dir().join(format!("coool-pilot-caller-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let file = dataset::path(&dir, "/p");
    let chat = 90_001;
    // No model: stuck on the first screen, with the candidates.
    let o = run(&about_goal(), &mut Fake::settings(), &mut Memory::in_memory(), None, "no key", &mut |_, _| {});
    assert_eq!(o.status, Status::Stuck);
    dataset::log_run(&file, chat, "s1", &about_goal(), &o);
    // The agent looks, then taps General by its element id: one `caller` record, choosing that candidate.
    dataset::caller_acted(chat, "observe", &json!({}));
    dataset::caller_acted(chat, "tap", &json!({ "target": "h-General" }));
    let recs = dataset::read(&file);
    assert_eq!(recs.len(), 1, "{recs:?}");
    let r = &recs[0];
    assert_eq!((r.decider.as_str(), r.outcome.as_str(), r.on_success_path), ("caller", "stuck", None));
    assert_eq!(r.screen.candidates[r.chosen].target.as_ref().unwrap().label, "General");
    // Only the first action after the run counts.
    dataset::caller_acted(chat, "tap", &json!({ "target": "h-Camera" }));
    assert_eq!(dataset::read(&file).len(), 1);
    // Toggle off: nothing is written.
    dataset::set_enabled(false);
    dataset::log_run(&file, chat, "s2", &about_goal(), &o);
    dataset::caller_acted(chat, "tap", &json!({ "target": "h-General" }));
    dataset::set_enabled(true);
    assert_eq!(dataset::read(&file).len(), 1);
    // Browser ids are numbers; scrolls and Enter map to their candidates; free typing doesn't.
    let c = candidates(&screen("x", vec![Elem { handle: "7".into(), ..elem("button", "Go", Kind::Tap) }]), &BTreeMap::new(), Target::Browser);
    assert_eq!(dataset::match_call(&c, "browser_click", &json!({ "id": 7 })), Some(0));
    assert_eq!(dataset::match_call(&c, "browser_scroll", &json!({ "direction": "up" })).map(|i| c[i].dir), Some(Some("up")));
    assert_eq!(dataset::match_call(&c, "browser_press", &json!({ "key": "Enter" })), None, "no submit without a focused field");
    assert_eq!(dataset::match_call(&c, "browser_type", &json!({ "id": 7, "text": "hi" })), None);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- the permission gate inside a run ----------

/// The form's driver, with the gate the Browser panel's actions pass: a password and the submit are risky kinds.
struct GatedForm<'a>(Fake, &'a crate::device::gate::Gate);

impl Driver for GatedForm<'_> {
    fn start(&mut self, _g: &Goal) -> Result<String, String> {
        self.0.at = "empty".into();
        Ok(String::new())
    }
    fn perceive(&mut self) -> Result<(Screen, u64), String> {
        self.0.perceive()
    }
    fn act(&mut self, a: &Action, s: &Screen, i: &BTreeMap<String, String>) -> Result<String, String> {
        use crate::device::gate::{Act, Dev, Risk, site};
        let label = a.target.as_ref().map(|t| t.label.clone()).unwrap_or_default();
        let risk = match (a.verb, label.as_str()) {
            (Verb::SetText, "Password") => Some(Risk::Secret { kind: "password", field: label.clone() }),
            (Verb::Tap, "Sign in") => Some(Risk::Submit { label: label.clone() }),
            _ => None,
        };
        self.1.check(1, None, Act::new(Dev::Browser, format!("{:?} {label}", a.verb)).site(site("http://x/signin")).risk(risk))?;
        self.0.act(a, s, i)
    }
    fn settle(&mut self, v: Verb) -> u64 {
        self.0.settle(v)
    }
}

struct Answers(std::sync::Mutex<Vec<String>>, Vec<coool_core::chat::ExternalAnswer>);

impl crate::device::gate::Asker for std::sync::Arc<Answers> {
    fn mode(&self, _c: usize) -> Option<String> {
        Some("default".into())
    }
    fn ask(&self, _c: usize, _t: &str, summary: &str, input: Value, _r: Vec<coool_core::chat::RememberOption>) -> Option<(String, std::sync::mpsc::Receiver<coool_core::chat::ExternalAnswer>)> {
        let mut asked = self.0.lock().unwrap();
        asked.push(format!("{} {summary}", input["coool_device"]["kind"].as_str().unwrap_or("")));
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = tx.send(self.1.get(asked.len() - 1).cloned().unwrap_or(coool_core::chat::ExternalAnswer::Deny));
        Some((format!("coool-{}", asked.len()), rx))
    }
    fn withdraw(&self, _c: usize, _id: &str, _n: &str) {}
}

/// An approved run doesn't ask step by step, but its password and submit steps stop and ask: allowed, the run goes
/// on; denied, it ends stuck with the denial as the reason (and the step didn't happen).
#[test]
fn a_pilot_run_stops_and_asks_on_a_risky_step() {
    use coool_core::chat::ExternalAnswer::{Allow, Deny};
    use crate::device::gate::{Dev, Gate, PilotScope, pilot_scope, site};
    for (answers, want) in [(vec![Allow, Allow], Status::Done), (vec![Allow, Deny], Status::Stuck)] {
        let asker = std::sync::Arc::new(Answers(Default::default(), answers.clone()));
        let gate = Gate::default();
        gate.set_asker(Box::new(asker.clone()));
        let (d, g) = form();
        let _scope = pilot_scope(PilotScope { chat: 1, dev: Dev::Browser, sites: site("http://x/signin").into_iter().collect() });
        let mut drv = GatedForm(d, &gate);
        let o = run(&g, &mut drv, &mut Memory::in_memory(), Some(&mut Seq(SIGN_IN.to_vec(), 0)), "", &mut |_, _| {});
        let asked = asker.0.lock().unwrap().clone();
        assert_eq!(asked.len(), 2, "only the password and the submit asked: {asked:?}");
        assert!(asked[0].starts_with("secret ") && asked[1].starts_with("submit "), "{asked:?}");
        assert_eq!(o.status, want, "{answers:?}: {}", o.reason);
        if want == Status::Stuck {
            assert!(o.reason.contains("Denied by the person"), "{}", o.reason);
            assert!(!drv.0.acted.iter().any(|k| k.contains("Sign in")), "the denied submit didn't happen");
        }
    }
}
