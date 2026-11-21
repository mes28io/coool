use super::guard::{self, Access, Create, SaveError, Scope};
use super::*;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};

/// A throwaway home with a repository at `home/work/repo` (and `sub/deep` in it); canonical paths.
struct T {
    root: PathBuf,
    home: PathBuf,
    repo: PathBuf,
    deep: PathBuf,
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn put(p: &Path, s: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, s).unwrap();
}

fn t(name: &str) -> T {
    let root = std::env::temp_dir().join(format!("coool-chatctx-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(&root).unwrap();
    let home = root.join("home");
    let repo = home.join("work").join("repo");
    let deep = repo.join("sub").join("deep");
    fs::create_dir_all(&deep).unwrap();
    fs::create_dir_all(repo.join(".git")).unwrap();
    put(&repo.join(".git").join("HEAD"), "ref: refs/heads/feature/x\n");
    T { root, home, repo, deep }
}

/// The layout the real Claude Code 2.1.330 was run against (see the module docs).
fn claude_tree(t: &T) {
    put(&t.home.join(".claude/CLAUDE.md"), "user. See @extra/imported.md\n");
    put(&t.home.join(".claude/extra/imported.md"), "user import\n");
    put(&t.home.join(".claude/rules/mine.md"), "user rule\n");
    put(&t.home.join("work/CLAUDE.md"), "above the repo\n");
    put(&t.repo.join("CLAUDE.md"), "repo. @docs/notes.md\n");
    put(&t.repo.join("docs/notes.md"), "repo import\n");
    put(&t.repo.join("CLAUDE.local.md"), "local\n");
    put(&t.repo.join(".claude/CLAUDE.md"), "dot claude\n");
    put(&t.repo.join(".claude/rules/style.md"), "repo rule\n");
    put(&t.repo.join("AGENTS.md"), "agents (not loaded: there is a CLAUDE.md)\n");
    put(&t.repo.join("sub/CLAUDE.md"), "sub\n");
    put(&t.deep.join("CLAUDE.md"), "deep\n");
    put(&t.repo.join(".claude/skills/proj-skill/SKILL.md"), "---\nname: proj-skill\ndescription: Project skill\n---\nbody\n");
    put(&t.home.join(".claude/skills/user-skill/SKILL.md"), "---\nname: user-skill\ndescription: \"User skill: quoted\"\n---\nbody\n");
    let mem = memory_dir(&t.home, &t.deep);
    put(&mem.join("MEMORY.md"), "- [Thing](thing.md) — a thing\n");
    put(&mem.join("thing.md"), "---\nname: thing\ndescription: A remembered thing\nmetadata:\n  type: project\n---\nbody\n");
}

fn labels(ov: &Overview, g: Group) -> Vec<String> {
    ov.items.iter().filter(|i| i.group == g).map(|i| i.path.clone().unwrap_or_else(|| i.label.clone())).collect()
}

fn rel(t: &T, v: Vec<String>) -> Vec<String> {
    v.into_iter().map(|p| p.strip_prefix(&t.home.display().to_string()).map(|r| format!("~{r}")).unwrap_or(p)).collect()
}

#[test]
fn claude_loads_in_the_order_the_cli_does_for_a_nested_folder() {
    let t = t("claude-order");
    claude_tree(&t);
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs::default());
    assert_eq!(
        rel(&t, labels(&ov, Group::Instructions)),
        vec![
            "~/.claude/CLAUDE.md",
            "~/.claude/extra/imported.md",
            "~/.claude/rules/mine.md",
            "~/work/CLAUDE.md",
            "~/work/repo/CLAUDE.md",
            "~/work/repo/docs/notes.md",
            "~/work/repo/.claude/CLAUDE.md",
            "~/work/repo/.claude/rules/style.md",
            "~/work/repo/CLAUDE.local.md",
            "~/work/repo/sub/CLAUDE.md",
            "~/work/repo/sub/deep/CLAUDE.md",
        ]
    );
    let by = |p: &str| ov.items.iter().find(|i| i.path.as_deref() == Some(&*format!("{}{}", t.home.display(), p.trim_start_matches('~')))).unwrap().clone();
    // Above the repository: loaded, read only. In it: editable. A project file's import waits for trust.
    assert!(!by("~/work/CLAUDE.md").editable && by("~/work/repo/CLAUDE.md").editable && by("~/work/repo/sub/deep/CLAUDE.md").editable);
    assert_eq!(by("~/work/repo/docs/notes.md").load, Load::Conditional);
    assert_eq!(by("~/work/repo/docs/notes.md").tokens, 0);
    assert_eq!(by("~/.claude/extra/imported.md").load, Load::Start);
    assert!(!by("~/.claude/extra/imported.md").editable && !by("~/.claude/rules/mine.md").editable);
    // Auto memory: the index loads, the files wait.
    assert_eq!(rel(&t, labels(&ov, Group::Memory)).iter().map(|p| p.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>(), vec!["MEMORY.md", "thing.md"]);
    let thing = ov.items.iter().find(|i| i.kind == "memory").unwrap();
    assert_eq!((thing.label.as_str(), thing.description.as_deref(), thing.load, thing.tokens), ("thing", Some("A remembered thing"), Load::OnDemand, 0));
    // Skills: the user's, then the project's; names and descriptions from the frontmatter.
    let skills: Vec<(String, String, Option<String>)> = ov.items.iter().filter(|i| i.group == Group::Skills).map(|i| (i.label.clone(), i.source.clone(), i.description.clone())).collect();
    assert_eq!(skills, vec![("user-skill".into(), "User".into(), Some("User skill: quoted".into())), ("proj-skill".into(), "Project (parent folder)".into(), Some("Project skill".into()))]);
    // The folder.
    assert_eq!(ov.folder.repo_root.as_deref(), Some(&*t.repo.display().to_string()));
    assert_eq!(ov.folder.branch.as_deref(), Some("feature/x"));
    assert!(ov.create.project_instructions.is_none() && ov.create.memory_dir.is_some());
    assert_eq!(ov.total, ov.items.iter().map(|i| i.tokens).sum::<u64>());
}

#[test]
fn claude_falls_back_to_agents_md_only_without_any_claude_md() {
    let t = t("claude-agents");
    put(&t.repo.join("AGENTS.md"), "repo agents\n");
    put(&t.deep.join("AGENTS.md"), "deep agents\n");
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs::default());
    assert_eq!(rel(&t, labels(&ov, Group::Instructions)), vec!["~/work/repo/AGENTS.md", "~/work/repo/sub/deep/AGENTS.md"]);
    assert_eq!(ov.create.project_instructions.as_deref(), Some(&*t.repo.join("CLAUDE.md").display().to_string()));
    // A CLAUDE.local.md anywhere on the path turns the fallback off (as seen with the CLI).
    put(&t.home.join("CLAUDE.local.md"), "x\n");
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs::default());
    assert!(!labels(&ov, Group::Instructions).iter().any(|p| p.ends_with("AGENTS.md")));
}

#[test]
fn codex_reads_user_then_root_to_folder_with_overrides() {
    let t = t("codex");
    put(&t.home.join(".codex/AGENTS.md"), "user\n");
    put(&t.repo.join("AGENTS.md"), "repo\n");
    put(&t.repo.join("sub/AGENTS.md"), "sub\n");
    put(&t.deep.join("AGENTS.md"), "deep (overridden)\n");
    put(&t.deep.join("AGENTS.override.md"), "deep override\n");
    put(&t.home.join("work/AGENTS.md"), "above the repository: not read\n");
    put(&t.repo.join("CLAUDE.md"), "not Codex's\n");
    for (dir, name) in [(t.repo.join(".codex/skills"), "pcodex"), (t.home.join(".codex/skills"), "ucodex"), (t.home.join(".agents/skills"), "uagents"), (t.home.join(".codex/skills/.system"), "system"), (t.repo.join(".agents/skills"), "pagents")] {
        put(&dir.join(name).join("SKILL.md"), &format!("---\nname: {name}\ndescription: d\n---\n"));
    }
    let ov = overview(Provider::Codex, &t.deep, &t.home, &Inputs::default());
    assert_eq!(rel(&t, labels(&ov, Group::Instructions)), vec!["~/.codex/AGENTS.md", "~/work/repo/AGENTS.md", "~/work/repo/sub/AGENTS.md", "~/work/repo/sub/deep/AGENTS.override.md"]);
    let skills: Vec<String> = ov.items.iter().filter(|i| i.group == Group::Skills).map(|i| i.label.clone()).collect();
    assert_eq!(skills, vec!["pcodex", "ucodex", "uagents", "system", "pagents"]);
    let ed = |n: &str| ov.items.iter().find(|i| i.label == n).unwrap().editable;
    assert!(ed("pcodex") && !ed("ucodex") && ed("uagents") && !ed("system") && ed("pagents"));
    // A user override replaces the user file.
    put(&t.home.join(".codex/AGENTS.override.md"), "user override\n");
    let ov = overview(Provider::Codex, &t.deep, &t.home, &Inputs::default());
    assert!(labels(&ov, Group::Instructions)[0].ends_with(".codex/AGENTS.override.md"));
}

#[test]
fn memory_slug_and_worktrees_use_the_main_repository() {
    assert_eq!(slug(Path::new("/Users/a b/Desktop/co.ol")), "-Users-a-b-Desktop-co-ol");
    let t = t("worktree");
    let wt = t.repo.join(".claude/worktrees/agent-1");
    fs::create_dir_all(t.repo.join(".git/worktrees/agent-1")).unwrap();
    put(&t.repo.join(".git/worktrees/agent-1/HEAD"), "ref: refs/heads/wt-branch\n");
    put(&wt.join(".git"), &format!("gitdir: {}\n", t.repo.join(".git/worktrees/agent-1").display()));
    assert_eq!(memory_key(&wt), t.repo);
    assert_eq!(memory_key(&t.deep), t.repo);
    let f = folder(&wt);
    assert_eq!((f.branch.as_deref(), f.worktree_of.as_deref(), f.repo_root.as_deref()), (Some("wt-branch"), Some(&*t.repo.display().to_string()), Some(&*wt.display().to_string())));
}

#[test]
fn transcript_facts_mark_used_skills_and_the_starting_model() {
    let t = t("facts");
    let p = t.root.join("s.jsonl");
    let lines = [
        r#"{"type":"attachment","attachment":{"type":"skill_listing","content":"- user-skill: User skill\n- dataviz: Charts\n- coool-ladder:briefs: Briefs"}}"#,
        r#"{"type":"attachment","attachment":{"type":"instructions","files":[{"path":"/x/CLAUDE.md","type":"Project","content":"x"}]}}"#,
        r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"tool_use","name":"Skill","input":{"skill":"user-skill"}}]}}"#,
        r#"{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Skill"}]}}"#,
        r#"{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"dataviz","path":"bundled:dataviz","content":"x"}]}}"#,
    ];
    fs::write(&p, lines.join("\n") + "\n").unwrap();
    let mut s = TranscriptScan::new(&p, Provider::Claude);
    let f = s.update().clone();
    assert_eq!(f.started_model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!(f.used, ["user-skill", "dataviz"].iter().map(|s| s.to_string()).collect());
    assert_eq!(f.listed.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["user-skill", "dataviz", "coool-ladder:briefs"]);
    assert_eq!(f.loaded, vec!["/x/CLAUDE.md"]);
    // The panel marks them, and a listed skill with no file on disk shows as built in.
    claude_tree(&t);
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs { facts: f, ..Inputs::default() });
    let it = |n: &str| ov.items.iter().find(|i| i.label == n).unwrap().clone();
    assert!(it("user-skill").used && !it("proj-skill").used && it("dataviz").used);
    assert_eq!(it("dataviz").source, "Built in or managed");
    assert!(it("user-skill").tokens > tokens(("user-skill".len() + "User skill: quoted".len() + 4) as u64));

    // Codex: a skill is used when the agent reads its SKILL.md.
    let p = t.root.join("c.jsonl");
    let skill = t.home.join(".agents/skills/uagents/SKILL.md");
    put(&skill, "---\nname: uagents\ndescription: d\n---\n");
    fs::write(
        &p,
        format!(
            "{}\n{}\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}"#,
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":serde_json::json!({"cmd": format!("sed -n 1,80p {}", skill.display())}).to_string()}})
        ),
    )
    .unwrap();
    let mut s = TranscriptScan::new(&p, Provider::Codex);
    let f = s.update().clone();
    assert_eq!((f.started_model.as_deref(), f.effort.as_deref()), (Some("gpt-5.5"), Some("high")));
    let ov = overview(Provider::Codex, &t.deep, &t.home, &Inputs { facts: f, ..Inputs::default() });
    assert!(ov.items.iter().find(|i| i.label == "uagents").unwrap().used);
    assert_eq!(ov.effort.as_deref(), Some("high"));
}

#[test]
fn what_coool_added_comes_from_the_launch() {
    let t = t("coool");
    let plugin = t.root.join("ladder-plugin/coool-ladder");
    put(&plugin.join(".claude-plugin/plugin.json"), r#"{"name":"coool-ladder"}"#);
    put(&plugin.join("skills/briefs/SKILL.md"), "---\nname: briefs\ndescription: Ladder brief shapes\n---\nbody\n");
    let text = "# Ladder (set by coool)\nYou lead.\n\n# You are in coool\nThe panels.\n";
    let launch = Launch {
        args: vec!["--model".into(), "opus".into(), format!("--append-system-prompt={text}"), format!("--plugin-dir={}", plugin.display())],
        developer_instructions: None,
        mcp: vec![McpInfo { name: "coool-device".into(), tools: 30, tokens: 4000 }],
        model: Some("opus".into()),
    };
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs { launch: Some(launch.clone()), ..Inputs::default() });
    let coool: Vec<(String, u64)> = ov.items.iter().filter(|i| i.group == Group::Coool).map(|i| (i.label.clone(), i.tokens)).collect();
    assert_eq!(coool.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["Ladder", "You are in coool", "coool-device"]);
    assert_eq!(coool[0].1, tokens("# Ladder (set by coool)\nYou lead.\n\n".len() as u64));
    // Claude Code defers MCP tools: nothing at start.
    assert_eq!(coool[2].1, 0);
    let skill = ov.items.iter().find(|i| i.label == "coool-ladder:briefs").unwrap();
    assert!(skill.source.contains("coool") && !skill.editable);
    assert_eq!(ov.launch_model.as_deref(), Some("opus"));
    // Codex: what coool sends as developer instructions; MCP definitions go with every request.
    let ov = overview(Provider::Codex, &t.deep, &t.home, &Inputs { launch: Some(Launch { args: vec![], developer_instructions: Some("# Ladder (set by coool)\nGo.\n".into()), ..launch }), ..Inputs::default() });
    let c: Vec<(String, String, u64)> = ov.items.iter().filter(|i| i.group == Group::Coool).map(|i| (i.label.clone(), i.source.clone(), i.tokens)).collect();
    assert_eq!(c[0].0, "Ladder");
    assert_eq!(c[0].1, "coool · developer instructions");
    assert_eq!(c[1].2, 4000);
    // A watched session (no launch): coool added nothing.
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs::default());
    assert!(!ov.items.iter().any(|i| i.group == Group::Coool));
}

#[test]
fn the_launch_record_matches_the_real_launch() {
    use crate::chat::{Chat, ChatOptions};
    use crate::ladder::{Ladder, Role, Tier};
    let t = t("launch");
    let opts = ChatOptions {
        provider: Provider::Claude,
        cwd: t.deep.display().to_string(),
        resume: None,
        model: Some("opus".into()),
        permission_mode: None,
        ladder: Some(Ladder { tiers: vec![Tier { role: Role::Small, model: "haiku".into(), label: "Haiku".into() }], max_parallel: 2, verify_tests: false }),
    };
    let (_, _, args) = Chat::launch(&opts, "coool", &[], Some(&t.root.join("lp")), None);
    let rec = Chat::launch_record(&opts, &args, &[]);
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs { launch: Some(rec), ..Inputs::default() });
    let ladder = ov.items.iter().find(|i| i.id.starts_with("coool:ladder")).unwrap();
    assert!(ladder.text.as_deref().unwrap().contains("haiku"));
    assert!(ov.items.iter().any(|i| i.label == "coool-ladder:briefs"));
    let codex = ChatOptions { provider: Provider::Codex, ..opts };
    let (_, _, args) = Chat::launch(&codex, "coool", &[], None, None);
    let rec = Chat::launch_record(&codex, &args, &[]);
    assert!(rec.developer_instructions.as_deref().unwrap().starts_with("# Ladder"));
}

#[test]
fn sizes_match_the_context_maps_memory_estimate() {
    let t = t("sizes");
    claude_tree(&t);
    let files = claude_start_files(&t.home, &t.deep);
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs { launch: Some(Launch::default()), ..Inputs::default() });
    let start: u64 = ov.items.iter().filter(|i| matches!(i.group, Group::Instructions | Group::Memory)).map(|i| i.tokens).sum();
    // The map turns bytes into tokens at PROSE_CPT, as the panel does per file.
    let map: u64 = files.iter().map(|(_, b)| tokens(*b)).sum();
    assert_eq!(start, map);
    assert!(files.iter().any(|(p, _)| p.ends_with("MEMORY.md")) && !files.iter().any(|(p, _)| p.ends_with("thing.md") || p.ends_with("notes.md")));
    assert_eq!(tokens(38), 10);
}

#[test]
fn skill_frontmatter_and_imports_parse() {
    assert_eq!(skill_meta("---\nname: a\ndescription: >\n  folded\n  text\n---\n"), (Some("a".into()), Some("folded text".into())));
    assert_eq!(skill_meta("---\nname: 'b'\ndescription: \"x: y\"\nother: 1\n---\n"), (Some("b".into()), Some("x: y".into())));
    assert_eq!(skill_meta("# no frontmatter\n"), (None, None));
    assert_eq!(imports("See @a/b.md and @~/x.md.\n`@not/this.md` me@example.com\n```\n@nor/this.md\n```\n(@./c.md)\n"), vec!["a/b.md", "~/x.md", "./c.md"]);
    assert_eq!(sections("pre\n# A\none\n# B (set by coool)\ntwo\n").iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), vec!["", "A", "B (set by coool)"]);
}

// ---------- the allow-list ----------

fn scope(t: &T) -> Scope {
    Scope::new(&t.home, &t.deep)
}

#[test]
fn allow_list_takes_only_the_chats_context() {
    let t = t("guard");
    claude_tree(&t);
    fs::create_dir_all(t.home.join(".codex")).unwrap();
    let s = scope(&t);
    let ok = |p: PathBuf, a: Access| guard::check(&s, &p, a).is_ok();
    // Writable.
    for p in [
        t.repo.join("CLAUDE.md"),
        t.repo.join("CLAUDE.local.md"),
        t.repo.join("AGENTS.md"),
        t.repo.join(".claude/CLAUDE.md"),
        t.deep.join("CLAUDE.md"),
        t.deep.join("AGENTS.md"),
        t.home.join(".claude/CLAUDE.md"),
        t.home.join(".codex/AGENTS.md"),
        t.repo.join(".claude/skills/proj-skill/SKILL.md"),
        t.repo.join(".claude/skills/new-one"),
        t.home.join(".claude/skills/user-skill/SKILL.md"),
        memory_dir(&t.home, &t.deep).join("thing.md"),
        memory_dir(&t.home, &t.deep).join("MEMORY.md"),
    ] {
        assert!(ok(p.clone(), Access::Write), "{p:?}");
    }
    // Readable, not writable.
    for p in [t.home.join("work/CLAUDE.md"), t.home.join(".claude/rules/mine.md"), t.repo.join(".claude/rules/style.md")] {
        assert!(ok(p.clone(), Access::Read) && !ok(p.clone(), Access::Write), "{p:?}");
    }
    // Neither.
    put(&t.home.join(".claude/settings.json"), "{}");
    put(&t.home.join(".claude/.credentials.json"), "{}");
    put(&t.home.join(".claude/sessions/1.key"), "k");
    put(&t.home.join(".claude/sessions/1.json"), "{}");
    put(&t.home.join(".codex/auth.json"), "{}");
    put(&t.home.join(".codex/config.toml"), "");
    put(&t.home.join(".claude.json"), "{}");
    let slugdir = t.home.join(".claude/projects").join(slug(&t.repo));
    put(&slugdir.join("abc.jsonl"), "{}");
    put(&t.home.join(".claude/plugins/cache/p/skills/s/SKILL.md"), "x");
    put(&t.home.join(".claude/plugins/cache/p/index.js"), "x");
    put(&t.repo.join("src/main.rs"), "fn main() {}");
    put(&t.root.join("elsewhere/CLAUDE.md"), "x");
    for p in [
        t.home.join(".claude/settings.json"),
        t.home.join(".claude/.credentials.json"),
        t.home.join(".claude/sessions/1.key"),
        t.home.join(".claude/sessions/1.json"),
        t.home.join(".codex/auth.json"),
        t.home.join(".codex/config.toml"),
        t.home.join(".claude.json"),
        slugdir.join("abc.jsonl"),
        t.home.join(".claude/plugins/cache/p/index.js"),
        t.home.join(".claude/plugins/cache/p/skills/s/SKILL.md"),
        t.repo.join("src/main.rs"),
        t.root.join("elsewhere/CLAUDE.md"),
        // Another project's memory.
        t.home.join(".claude/projects/-other/memory/MEMORY.md"),
        memory_dir(&t.home, &t.deep).join("notes.txt"),
        t.home.join(".claude/skills/.hidden/SKILL.md"),
    ] {
        assert!(!ok(p.clone(), Access::Write), "write {p:?}");
        assert!(!ok(p.clone(), Access::Read), "read {p:?}");
    }
    // A plugin's skill is readable only when the caller lists that plugin.
    let mut s2 = scope(&t);
    s2.extra_read.push(t.home.join(".claude/plugins/cache/p/skills"));
    assert!(guard::check(&s2, &t.home.join(".claude/plugins/cache/p/skills/s/SKILL.md"), Access::Read).is_ok());
    assert!(guard::check(&s2, &t.home.join(".claude/plugins/cache/p/skills/s/SKILL.md"), Access::Write).is_err());
    assert!(guard::check(&s2, &t.home.join(".claude/plugins/cache/p/index.js"), Access::Read).is_err());
}

#[test]
fn allow_list_refuses_traversal_and_symlinks_out() {
    let t = t("guard-links");
    claude_tree(&t);
    let s = scope(&t);
    let no = |p: &Path, a: Access| guard::check(&s, p, a).unwrap_err().0;
    // Traversal and relative paths, even when they would land on an allowed file.
    assert!(no(&t.deep.join("../CLAUDE.md"), Access::Read).contains(".."));
    assert!(no(&t.repo.join(".claude/skills/proj-skill/../../../../.claude/settings.json"), Access::Write).contains(".."));
    assert!(no(Path::new("CLAUDE.md"), Access::Read).contains("absolute"));
    // An allowed name that is a symlink to a file outside.
    put(&t.root.join("outside/CLAUDE.md"), "outside");
    let link = t.deep.join("CLAUDE.local.md");
    symlink(t.root.join("outside/CLAUDE.md"), &link).unwrap();
    assert!(guard::check(&s, &link, Access::Write).is_err());
    assert!(guard::check(&s, &link, Access::Read).is_err());
    // A symlink to the credentials, or to settings.
    put(&t.home.join(".claude/.credentials.json"), "{}");
    put(&t.home.join(".claude/settings.json"), "{}");
    fs::remove_file(t.repo.join("AGENTS.md")).unwrap();
    symlink(t.home.join(".claude/.credentials.json"), t.repo.join("AGENTS.md")).unwrap();
    assert!(no(&t.repo.join("AGENTS.md"), Access::Read).contains("never opens"));
    // A skill folder that is a symlink out of the skills folder.
    fs::create_dir_all(t.root.join("outside/evil")).unwrap();
    put(&t.root.join("outside/evil/SKILL.md"), "---\nname: evil\n---\n");
    symlink(t.root.join("outside/evil"), t.home.join(".claude/skills/evil")).unwrap();
    assert!(guard::check(&s, &t.home.join(".claude/skills/evil/SKILL.md"), Access::Write).is_err());
    // A project folder symlinked into ~/.codex: a skill there would land in ~/.codex/skills.
    fs::create_dir_all(t.home.join(".codex/skills")).unwrap();
    fs::create_dir_all(t.deep.join(".agents")).unwrap();
    symlink(t.home.join(".codex/skills"), t.deep.join(".agents/skills")).unwrap();
    assert!(guard::check(&s, &t.deep.join(".agents/skills/x"), Access::Write).is_err());
    let r = guard::create(&s, &Create::Skill { scope: "project-agents".into(), name: "x".into(), description: "d".into() });
    assert!(matches!(r, Err(SaveError::Refused(_))), "{r:?}");
    assert!(!t.home.join(".codex/skills/x").exists());
    // An import that points at the credentials is neither listed nor readable.
    put(&t.home.join(".claude/CLAUDE.md"), "@.credentials.json\n@settings.json\n");
    let ov = overview(Provider::Claude, &t.deep, &t.home, &Inputs::default());
    assert!(!ov.items.iter().any(|i| i.path.as_deref().is_some_and(|p| p.contains("credentials") || p.ends_with("settings.json"))));
}

#[test]
fn save_is_atomic_keeps_line_endings_and_refuses_a_changed_file() {
    let t = t("save");
    let p = t.repo.join("CLAUDE.md");
    fs::write(&p, "one\r\ntwo\r\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
    let s = scope(&t);
    let f = guard::read(&s, &p).unwrap();
    assert_eq!((f.text.as_str(), f.eol.as_str(), f.editable), ("one\ntwo\n", "crlf", true));
    let st = guard::save(&s, &p, "one\ntwo\nthree\n", Some(&f.stamp)).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "one\r\ntwo\r\nthree\r\n");
    assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o640);
    assert!(fs::read_dir(&t.repo).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("coool-")), "no temporary file left");
    // The old stamp no longer matches: refused, and the file is untouched.
    let r = guard::save(&s, &p, "clobber\n", Some(&f.stamp));
    assert!(matches!(r, Err(SaveError::Changed(Some(ref now))) if *now == st), "{r:?}");
    // Someone else edits it: refused with the new stamp, then saving over that works.
    fs::write(&p, "edited elsewhere\n").unwrap();
    let Err(SaveError::Changed(Some(now))) = guard::save(&s, &p, "mine\n", Some(&st)) else { panic!() };
    assert_eq!(fs::read_to_string(&p).unwrap(), "edited elsewhere\n");
    guard::save(&s, &p, "mine\n", Some(&now)).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "mine\n");
    // A new file must not exist yet; a deleted one can't be saved over a stamp.
    assert!(matches!(guard::save(&s, &p, "x", None), Err(SaveError::Changed(Some(_)))));
    fs::remove_file(&p).unwrap();
    assert!(matches!(guard::save(&s, &p, "x", Some(&now)), Err(SaveError::Changed(None))));
    // A symlink inside the project to an allowed file writes the file, keeping the link.
    put(&t.repo.join("AGENTS.md"), "agents\n");
    symlink(t.repo.join("AGENTS.md"), t.deep.join("AGENTS.md")).unwrap();
    let f = guard::read(&s, &t.deep.join("AGENTS.md")).unwrap();
    guard::save(&s, &t.deep.join("AGENTS.md"), "via link\n", Some(&f.stamp)).unwrap();
    assert!(fs::symlink_metadata(t.deep.join("AGENTS.md")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(t.repo.join("AGENTS.md")).unwrap(), "via link\n");
    // Refused writes leave nothing behind.
    assert!(matches!(guard::save(&s, &t.repo.join("src.rs"), "x", None), Err(SaveError::Refused(_))));
    assert!(!t.repo.join("src.rs").exists());
}

#[test]
fn create_and_delete() {
    let t = t("create");
    claude_tree(&t);
    let s = scope(&t);
    let mem = memory_dir(&t.home, &t.deep);
    // A memory file and its line in the index, in Claude Code's shape.
    let p = guard::create(&s, &Create::Memory { title: "Release checklist".into(), description: "Steps: tag, notes".into(), kind: Some("project".into()) }).unwrap();
    assert_eq!(p, mem.join("release-checklist.md"));
    let body = fs::read_to_string(&p).unwrap();
    assert!(body.starts_with("---\nname: release-checklist\ndescription: \"Steps: tag, notes\"\nmetadata:\n  type: project\n  modified: 20"), "{body}");
    assert_eq!(skill_meta(&body).1.as_deref(), Some("Steps: tag, notes"));
    assert_eq!(fs::read_to_string(mem.join("MEMORY.md")).unwrap(), "- [Thing](thing.md) — a thing\n- [Release checklist](release-checklist.md) — Steps: tag, notes\n");
    let p2 = guard::create(&s, &Create::Memory { title: "Release checklist".into(), description: "again".into(), kind: None }).unwrap();
    assert_eq!(p2, mem.join("release-checklist-2.md"));
    // A skill, into the project's skills folder; then the user's (whose folder doesn't exist yet in a fresh home).
    let sk = guard::create(&s, &Create::Skill { scope: "project".into(), name: "deploy".into(), description: "Ship it".into() }).unwrap();
    assert_eq!(sk, t.repo.join(".claude/skills/deploy/SKILL.md"));
    assert_eq!(skill_meta(&fs::read_to_string(&sk).unwrap()), (Some("deploy".into()), Some("Ship it".into())));
    assert!(matches!(guard::create(&s, &Create::Skill { scope: "project".into(), name: "deploy".into(), description: "x".into() }), Err(SaveError::Changed(None))));
    assert!(matches!(guard::create(&s, &Create::Skill { scope: "project".into(), name: "../x".into(), description: "x".into() }), Err(SaveError::Refused(_))));
    fs::remove_dir_all(t.home.join(".agents")).ok();
    let us = guard::create(&s, &Create::Skill { scope: "user-agents".into(), name: "mine".into(), description: "d".into() }).unwrap();
    assert_eq!(us, t.home.join(".agents/skills/mine/SKILL.md"));
    // The project's instruction file, only where allowed and only if missing.
    fs::remove_file(t.repo.join("CLAUDE.md")).unwrap();
    let ci = guard::create(&s, &Create::Instructions { path: t.repo.join("CLAUDE.md").display().to_string() }).unwrap();
    assert!(fs::read_to_string(ci).unwrap().starts_with("# CLAUDE.md"));
    assert!(guard::create(&s, &Create::Instructions { path: t.repo.join("CLAUDE.md").display().to_string() }).is_err());
    assert!(guard::create(&s, &Create::Instructions { path: t.repo.join("src/CLAUDE.md").display().to_string() }).is_err());
    // Delete: to the (throwaway) Trash. A skill goes with its folder; a memory file takes its index line along.
    let trash = |p: &Path| guard::trash_into(&t.home, p);
    let gone = guard::delete(&s, &sk, trash).unwrap();
    assert_eq!(gone, t.repo.join(".claude/skills/deploy"));
    assert!(!gone.exists() && t.home.join(".Trash/deploy/SKILL.md").is_file());
    guard::delete(&s, &p, trash).unwrap();
    assert!(!p.exists() && t.home.join(".Trash/release-checklist.md").is_file());
    assert!(!fs::read_to_string(mem.join("MEMORY.md")).unwrap().contains("(release-checklist.md)"));
    assert!(fs::read_to_string(mem.join("MEMORY.md")).unwrap().contains("(release-checklist-2.md)"));
    // Never anything outside the list.
    put(&t.home.join(".claude/settings.json"), "{}");
    assert!(matches!(guard::delete(&s, &t.home.join(".claude/settings.json"), trash), Err(SaveError::Refused(_))));
    assert!(t.home.join(".claude/settings.json").exists());
    assert!(matches!(guard::delete(&s, &t.home.join(".claude/skills"), trash), Err(SaveError::Refused(_))));
}

#[test]
fn names_and_dates() {
    assert!(guard::valid_name("my-skill2") && !guard::valid_name("My") && !guard::valid_name("-x") && !guard::valid_name("a/b") && !guard::valid_name(""));
    assert_eq!(guard::file_name_for("  Hello, World!  "), "hello-world");
    assert_eq!(guard::file_name_for("!!!"), "memory");
}
