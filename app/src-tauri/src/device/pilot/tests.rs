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

// ---------- the loop and its cascade ----------

/// Screens by name; acting moves along `edges` ((screen, action key) → next screen).
struct Fake {
    screens: HashMap<String, Screen>,
    edges: HashMap<(String, String), String>,
    at: String,
    acted: Vec<String>,
    ended: bool,
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
        Fake { screens, edges, at: "root".into(), acted: Vec::new(), ended: false }
    }
}

impl Driver for Fake {
    fn start(&mut self, _g: &Goal) -> Result<String, String> {
        self.at = "root".into();
        Ok(String::new())
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
