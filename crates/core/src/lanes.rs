//! Helpers a lead starts from its shell: `codex exec …` from a Claude lead's Bash tool, `claude -p …` from a
//! Codex lead's `exec_command` (Ladder's cross-provider lanes, docs/APP_SPEC.md "Ladder 2").
//!
//! - **Launches.** [`parse`] reads a shell command the way a shell would split it (quotes, `;` `&&` `||` `|` `&`,
//!   subshells, redirections, `cd`, simple `for v in a b; do … done` loops) and returns one [`Launch`] per helper
//!   it starts, with its model (`-m` / `--model`), working folder (`-C` / `--cd`, else the last `cd`), brief (the
//!   prompt argument, shortened; or where stdin comes from), the files it writes (`-o`, `>` redirections) and
//!   whether it is detached (`… &`, or a `( … ) &` group: the call or shell that ran it ends at once).
//! - **Records.** A transcript keeps a [`Lane`] per launch, with the call's time, its background task id and how
//!   the call (or its shell) ended.
//! - **Sessions.** The helper writes a session of its own (a Codex rollout, a Claude transcript). [`assign`] pairs
//!   lanes with those sessions: same CLI, the same folder (a loop variable matches anything), the same model when
//!   both are known, started within [`START_WINDOW_MS`] of the call; nearest start first, one session per lane.
//! - **State.** [`state`]: the helper session's own end (`task_complete`, `turn_aborted`, an error) decides; else
//!   how the call ended; else running while its session is in a turn, or while its call / shell runs.
//!
//! Nothing is run to find them: only transcripts and session files are read.

use crate::model::{AgentState, Provider};
use serde::{Deserialize, Serialize};

/// One helper a command starts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    pub provider: Option<Provider>,
    /// As written (`gpt-6.2-sol`, `haiku`); None when the CLI's default.
    pub model: Option<String>,
    /// Absolute when it could be told (`-C`, `cd`); may hold a `*` where a variable was not known.
    pub cwd: Option<String>,
    /// The prompt, one line, shortened; or where it is read from.
    pub brief: String,
    /// Files it writes: `-o` / `--output-last-message`, `>` / `>>` targets.
    pub files: Vec<String>,
    /// Started with a trailing `&` (itself or its group): the call returns while it runs.
    pub detached: bool,
    /// The brief asks for an image (Ladder's image lane).
    pub image: bool,
}

/// One launch as a transcript records it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane {
    /// The tool call that ran it, and its place among that call's launches.
    pub tool: String,
    pub index: u32,
    pub provider: Provider,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub brief: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub detached: bool,
    #[serde(default)]
    pub image: bool,
    /// The call was made with `run_in_background`.
    #[serde(default)]
    pub background: bool,
    /// When the call was made, epoch ms.
    pub at: u64,
    /// A background call's task id (`toolUseResult.backgroundTaskId`).
    #[serde(default)]
    pub task: Option<String>,
    /// How the call (a foreground one) or its background shell ended: epoch ms and how.
    #[serde(default)]
    pub end: Option<(u64, AgentState)>,
}

/// A lane as the app shows it: on the helper's session (`Session::lane`) and on its parent's (`Session::lanes`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LaneInfo {
    /// The session that started it, and the call.
    pub parent: String,
    pub tool: String,
    pub index: u32,
    pub provider: Provider,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub brief: String,
    pub background: bool,
    pub detached: bool,
    pub image: bool,
    /// The call, its start and end (epoch ms; the session's own span when one was found).
    pub at: u64,
    pub started: u64,
    pub ended: Option<u64>,
    pub state: AgentState,
    /// The helper's own session, when one was found.
    pub session: Option<String>,
}

impl LaneInfo {
    pub fn new(parent: &str, l: &Lane, child: Option<(&str, &Child)>, parent_live: bool, now: u64) -> Self {
        let st = state(l, child.map(|c| c.1), parent_live, now);
        let (started, ended) = span(l, child.map(|c| c.1), st);
        LaneInfo {
            parent: parent.to_string(),
            tool: l.tool.clone(),
            index: l.index,
            provider: l.provider,
            model: l.model.clone(),
            cwd: l.cwd.clone(),
            brief: l.brief.clone(),
            background: l.background,
            detached: l.detached,
            image: l.image,
            at: l.at,
            started,
            ended,
            state: st,
            session: child.map(|c| c.0.to_string()),
        }
    }
}

/// Lanes kept per transcript (oldest dropped).
pub const KEEP: usize = 64;

/// A helper session starts writing this soon after the call (Codex: well under a second; allows a slow start).
pub const START_WINDOW_MS: u64 = 120_000;
/// …and never before it (clock rounding: Codex records seconds).
const EARLY_MS: u64 = 3_000;
/// A detached launch with no session found this long after the call reads as quiet.
const NO_SESSION_MS: u64 = 120_000;

// ---------- the shell words ----------

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Word(String),
    /// `;` `&&` `||` `|` `&` `(` `)` (a newline is `;`).
    Op(&'static str),
    /// `<` `>` `>>` `&>` `<<<`.
    Redir(&'static str),
}

fn tokens(s: &str) -> Vec<Tok> {
    let c: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut w = String::new();
    let mut in_word = false;
    let mut i = 0;
    let flush = |w: &mut String, in_word: &mut bool, out: &mut Vec<Tok>| {
        if *in_word {
            out.push(Tok::Word(std::mem::take(w)));
            *in_word = false;
        }
    };
    while i < c.len() {
        let ch = c[i];
        match ch {
            ' ' | '\t' | '\r' => flush(&mut w, &mut in_word, &mut out),
            '\n' => {
                flush(&mut w, &mut in_word, &mut out);
                out.push(Tok::Op(";"));
            }
            '#' if !in_word => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '\\' => {
                if i + 1 < c.len() {
                    if c[i + 1] != '\n' {
                        w.push(c[i + 1]);
                        in_word = true;
                    }
                    i += 1;
                }
            }
            '\'' => {
                in_word = true;
                i += 1;
                while i < c.len() && c[i] != '\'' {
                    w.push(c[i]);
                    i += 1;
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                while i < c.len() && c[i] != '"' {
                    if c[i] == '\\' && i + 1 < c.len() && matches!(c[i + 1], '"' | '\\' | '$' | '`' | '\n') {
                        if c[i + 1] != '\n' {
                            w.push(c[i + 1]);
                        }
                        i += 2;
                        continue;
                    }
                    w.push(c[i]);
                    i += 1;
                }
            }
            '`' => {
                in_word = true;
                w.push('`');
                i += 1;
                while i < c.len() && c[i] != '`' {
                    w.push(c[i]);
                    i += 1;
                }
                w.push('`');
            }
            '$' if c.get(i + 1) == Some(&'(') => {
                in_word = true;
                let mut depth = 0;
                while i < c.len() {
                    w.push(c[i]);
                    if c[i] == '(' {
                        depth += 1;
                    } else if c[i] == ')' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    i += 1;
                }
            }
            ';' | '(' | ')' => {
                flush(&mut w, &mut in_word, &mut out);
                out.push(Tok::Op(match ch {
                    ';' => ";",
                    '(' => "(",
                    _ => ")",
                }));
            }
            '&' | '|' => {
                if ch == '&' && c.get(i + 1) == Some(&'>') {
                    flush(&mut w, &mut in_word, &mut out);
                    out.push(Tok::Redir(">"));
                    i += 2;
                    if c.get(i) == Some(&'>') {
                        i += 1;
                    }
                    continue;
                }
                flush(&mut w, &mut in_word, &mut out);
                if c.get(i + 1) == Some(&ch) {
                    out.push(Tok::Op(if ch == '&' { "&&" } else { "||" }));
                    i += 1;
                } else {
                    out.push(Tok::Op(if ch == '&' { "&" } else { "|" }));
                }
            }
            '<' | '>' => {
                // `2>`: the fd number is not a word.
                if in_word && w.chars().all(|d| d.is_ascii_digit()) {
                    w.clear();
                    in_word = false;
                }
                flush(&mut w, &mut in_word, &mut out);
                if ch == '<' {
                    if c.get(i + 1) == Some(&'<') && c.get(i + 2) == Some(&'<') {
                        out.push(Tok::Redir("<<<"));
                        i += 2;
                    } else if c.get(i + 1) == Some(&'<') {
                        // A here-document: its body is not words of the command.
                        out.push(Tok::Redir("<<"));
                        i += 1;
                    } else {
                        out.push(Tok::Redir("<"));
                    }
                } else if c.get(i + 1) == Some(&'&') {
                    // `>&2`, `2>&1`: a dup, no file.
                    i += 2;
                    while i < c.len() && (c[i].is_ascii_digit() || c[i] == '-') {
                        i += 1;
                    }
                    continue;
                } else if c.get(i + 1) == Some(&'>') {
                    out.push(Tok::Redir(">>"));
                    i += 1;
                } else {
                    out.push(Tok::Redir(">"));
                }
            }
            _ => {
                w.push(ch);
                in_word = true;
            }
        }
        i += 1;
    }
    flush(&mut w, &mut in_word, &mut out);
    out
}

/// One simple command: its words, redirections and the operator after it.
#[derive(Debug, Default)]
struct Simple {
    words: Vec<String>,
    stdin: Option<String>,
    here: bool,
    piped_in: bool,
    outs: Vec<String>,
    detached: bool,
    /// Loop variables in force: (name, values).
    loops: Vec<(String, Vec<String>)>,
}

fn simples(toks: &[Tok]) -> Vec<Simple> {
    let mut out: Vec<Simple> = Vec::new();
    let mut cur = Simple::default();
    let mut groups: Vec<usize> = Vec::new();
    let mut loops: Vec<(String, Vec<String>)> = Vec::new();
    // A `for` header waiting for its `do`.
    let mut pending: Option<(String, Vec<String>)> = None;
    let mut piped = false;
    let mut i = 0;
    let end = |cur: &mut Simple, out: &mut Vec<Simple>, loops: &mut Vec<(String, Vec<String>)>, pending: &mut Option<(String, Vec<String>)>, piped: &mut bool, op: &str| {
        let mut s = std::mem::take(cur);
        // Reserved words at the head of a command.
        while let Some(w) = s.words.first() {
            match w.as_str() {
                "do" => {
                    if let Some(l) = pending.take() {
                        loops.push(l);
                    }
                    s.words.remove(0);
                }
                "then" | "else" | "elif" | "{" | "}" | "!" | "time" | "while" | "until" | "if" => {
                    s.words.remove(0);
                }
                "done" => {
                    loops.pop();
                    s.words.remove(0);
                }
                _ => break,
            }
        }
        if s.words.first().map(String::as_str) == Some("for") {
            let var = s.words.get(1).cloned().unwrap_or_default();
            let vals: Vec<String> = if s.words.get(2).map(String::as_str) == Some("in") { s.words[3..].to_vec() } else { Vec::new() };
            let ok = !var.is_empty() && !vals.is_empty() && vals.len() <= 16 && vals.iter().all(|v| !v.contains(['$', '*', '?', '`', '[']));
            *pending = ok.then_some((var, vals));
            s.words.clear();
        }
        s.piped_in = *piped;
        *piped = op == "|";
        s.detached = op == "&";
        s.loops = loops.clone();
        if !s.words.is_empty() {
            out.push(s);
        }
    };
    while i < toks.len() {
        match &toks[i] {
            Tok::Word(w) => cur.words.push(w.clone()),
            Tok::Redir(r) => {
                let target = match toks.get(i + 1) {
                    Some(Tok::Word(t)) => {
                        i += 1;
                        Some(t.clone())
                    }
                    _ => None,
                };
                match *r {
                    "<" => cur.stdin = target,
                    "<<" | "<<<" => cur.here = true,
                    _ => cur.outs.extend(target),
                }
            }
            Tok::Op(op) => {
                match *op {
                    "(" => {
                        end(&mut cur, &mut out, &mut loops, &mut pending, &mut piped, ";");
                        groups.push(out.len());
                    }
                    ")" => {
                        end(&mut cur, &mut out, &mut loops, &mut pending, &mut piped, ";");
                        let from = groups.pop().unwrap_or(0);
                        // The operator after the group applies to all of it.
                        let next = toks.get(i + 1);
                        let mut j = i + 1;
                        // Redirections of the group: `( … ) > log &`.
                        let mut outs = Vec::new();
                        while let Some(Tok::Redir(r)) = toks.get(j) {
                            if let Some(Tok::Word(t)) = toks.get(j + 1) {
                                if !r.starts_with('<') {
                                    outs.push(t.clone());
                                }
                                j += 2;
                            } else {
                                j += 1;
                            }
                        }
                        let after = toks.get(j).or(next);
                        let from = from.min(out.len());
                        for s in &mut out[from..] {
                            s.outs.extend(outs.iter().cloned());
                            if after == Some(&Tok::Op("&")) {
                                s.detached = true;
                            }
                        }
                        i = j;
                        if after == Some(&Tok::Op("&")) || matches!(after, Some(Tok::Op(_))) {
                            // Consumed below as a plain separator.
                            if let Some(Tok::Op(o)) = after {
                                piped = *o == "|";
                                i += 1;
                            }
                        }
                        continue;
                    }
                    o => end(&mut cur, &mut out, &mut loops, &mut pending, &mut piped, o),
                }
            }
        }
        i += 1;
    }
    end(&mut cur, &mut out, &mut loops, &mut pending, &mut piped, ";");
    out
}

/// `$v` / `${v}` replaced by `val`.
fn subst(s: &str, var: &str, val: &str) -> String {
    s.replace(&format!("${{{var}}}"), val).replace(&format!("${var}"), val)
}

fn home() -> String {
    dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A folder as written, made absolute against `base` when it is relative; `~` and `$HOME` expanded; any other
/// `$var` left as `*` (matches anything, see [`dir_matches`]).
fn resolve(dir: &str, base: Option<&str>) -> Option<String> {
    let mut d = dir.to_string();
    if d == "~" || d.starts_with("~/") {
        d = format!("{}{}", home(), &d[1..]);
    }
    d = d.replace("${HOME}", &home()).replace("$HOME", &home());
    // Remaining variables: a wildcard segment.
    if d.contains('$') {
        let mut out = String::new();
        let mut it = d.chars().peekable();
        while let Some(ch) = it.next() {
            if ch == '$' {
                if it.peek() == Some(&'{') {
                    for x in it.by_ref() {
                        if x == '}' {
                            break;
                        }
                    }
                } else {
                    while it.peek().is_some_and(|x| x.is_ascii_alphanumeric() || *x == '_') {
                        it.next();
                    }
                }
                out.push('*');
            } else {
                out.push(ch);
            }
        }
        d = out;
    }
    if d.is_empty() || d.contains('`') {
        return None;
    }
    if d.starts_with('/') || d.starts_with('*') {
        return Some(d);
    }
    let b = base?;
    let joined = format!("{}/{}", b.trim_end_matches('/'), d.trim_start_matches("./"));
    Some(joined)
}

/// `d` against `base` when it is relative (variables kept for the loop expansion).
fn join(d: &str, base: Option<&str>) -> String {
    match base {
        Some(b) if !d.starts_with(['/', '~', '$']) => format!("{}/{}", b.trim_end_matches('/'), d.trim_start_matches("./")),
        _ => d.to_string(),
    }
}

/// Words that run the next word as the command.
fn wrapper_skip(words: &[String]) -> usize {
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let base = w.rsplit('/').next().unwrap_or(w);
        if w.contains('=') && !w.starts_with('-') && w.split('=').next().is_some_and(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
            i += 1;
            continue;
        }
        match base {
            "env" | "nohup" | "command" | "exec" | "caffeinate" | "stdbuf" | "nice" | "setsid" => {
                i += 1;
                while i < words.len() && (words[i].starts_with('-') || (base == "env" && words[i].contains('='))) {
                    // `nice -n 10`
                    if base == "nice" && words[i] == "-n" {
                        i += 1;
                    }
                    i += 1;
                }
            }
            "timeout" | "gtimeout" => {
                i += 1;
                while i < words.len() && words[i].starts_with('-') {
                    i += 1;
                }
                i += 1; // the duration
            }
            _ => break,
        }
    }
    i
}

const CODEX_VALUE: &[&str] = &[
    "-m", "--model", "-c", "--config", "-s", "--sandbox", "-C", "--cd", "-o", "--output-last-message", "-p", "--profile", "-i", "--image", "--add-dir",
    "--output-schema", "--color", "--enable", "--disable", "-a", "--ask-for-approval", "--local-provider",
];
const CLAUDE_VALUE: &[&str] = &[
    "--model", "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--tools", "--allowedTools", "--allowed-tools",
    "--disallowedTools", "--disallowed-tools", "--output-format", "--input-format", "--setting-sources", "--permission-mode", "--mcp-config", "--add-dir", "--max-turns",
    "--session-id", "-r", "--resume", "--settings", "--agents", "--agent", "--fallback-model", "--max-budget-usd", "--json-schema", "--effort", "--betas", "--plugin-dir",
    "--debug-file", "-n", "--name", "--permission-prompt-tool",
];

const IMAGE_WORDS: &[&str] = &["image", "icon", "illustration", "logo", "picture", "png", "sprite", "texture"];

fn brief_line(s: &str) -> String {
    crate::util::one_line(s, 160)
}

/// Every helper `cmd` starts (see the module docs). `cwd`: the folder the command runs in, when known.
pub fn parse(cmd: &str, cwd: Option<&str>) -> Vec<Launch> {
    if !cmd.contains("codex") && !cmd.contains("claude") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut dir: Option<String> = cwd.map(str::to_string);
    for s in simples(&tokens(cmd)) {
        let skip = wrapper_skip(&s.words).min(s.words.len());
        let words = &s.words[skip..];
        let Some(prog) = words.first() else { continue };
        let base = prog.rsplit('/').next().unwrap_or(prog);
        if base == "cd" {
            if let Some(d) = words.get(1).filter(|d| !d.starts_with('-')) {
                dir = resolve(d, dir.as_deref());
            } else if words.len() == 1 {
                dir = Some(home());
            }
            continue;
        }
        let provider = match base {
            "codex" if words.get(1).is_some_and(|w| w == "exec" || w == "e") => Provider::Codex,
            "claude" if words.iter().skip(1).any(|w| w == "-p" || w == "--print") => Provider::Claude,
            _ => continue,
        };
        let (args, values) = if provider == Provider::Codex { (&words[2..], CODEX_VALUE) } else { (&words[1..], CLAUDE_VALUE) };
        let mut model = None;
        let mut cd = None;
        let mut files = Vec::new();
        let mut prompt: Option<String> = None;
        let mut j = 0;
        while j < args.len() {
            let a = args[j].as_str();
            let (flag, inline) = match a.split_once('=') {
                Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
                _ => (a, None),
            };
            if flag.starts_with('-') && flag.len() > 1 && (values.contains(&flag) || inline.is_some()) {
                let v = match inline {
                    Some(v) => Some(v),
                    None => {
                        j += 1;
                        args.get(j).cloned()
                    }
                };
                match flag {
                    "-m" | "--model" => model = v.filter(|m| !m.is_empty()),
                    "-C" | "--cd" if provider == Provider::Codex => cd = v,
                    "-o" | "--output-last-message" if provider == Provider::Codex => files.extend(v),
                    _ => {}
                }
            } else if a == "-p" || a == "--print" || (a.starts_with('-') && a.len() > 1) {
                // A switch (`-p` is one for claude; codex's `-p` takes a profile and is handled above).
            } else if prompt.is_none() {
                prompt = Some(a.to_string());
                // codex exec resume <id> [prompt]: a resumed run.
                if provider == Provider::Codex && a == "resume" {
                    prompt = None;
                    j += 1;
                }
            }
            j += 1;
        }
        files.extend(s.outs.iter().cloned());
        let from_stdin = || {
            if let Some(f) = &s.stdin {
                (f != "/dev/null").then(|| format!("prompt from {}", crate::util::home_short(f)))
            } else if s.here {
                Some("prompt from a here-document".to_string())
            } else if s.piped_in {
                Some("prompt on stdin".to_string())
            } else {
                None
            }
        };
        let raw = match prompt.as_deref() {
            Some("-") | None => from_stdin().unwrap_or_default(),
            Some(p) => p.to_string(),
        };
        let base_launch = Launch {
            provider: Some(provider),
            model,
            cwd: match &cd {
                Some(c) => Some(join(c, dir.as_deref())),
                None => dir.clone(),
            },
            brief: raw,
            files,
            detached: s.detached,
            image: false,
        };
        // Expand loops (outermost first), at most 16 launches.
        let mut expanded = vec![base_launch];
        for (var, vals) in &s.loops {
            let mut next = Vec::new();
            for l in &expanded {
                for v in vals {
                    if next.len() >= 16 {
                        break;
                    }
                    let mut x = l.clone();
                    x.cwd = x.cwd.map(|c| subst(&c, var, v));
                    x.brief = subst(&x.brief, var, v);
                    x.files = x.files.iter().map(|f| subst(f, var, v)).collect();
                    x.model = x.model.map(|m| subst(&m, var, v));
                    next.push(x);
                }
            }
            expanded = next;
        }
        for mut l in expanded {
            if let Some(c) = &l.cwd {
                l.cwd = resolve(c, None).or(Some(c.clone()));
            }
            let base = l.cwd.clone().or(dir.clone());
            l.files = l.files.iter().map(|f| resolve(&join(f, base.as_deref()), None).unwrap_or_else(|| f.clone())).collect();
            let low = l.brief.to_lowercase();
            l.image = IMAGE_WORDS.iter().any(|w| low.split(|c: char| !c.is_ascii_alphanumeric()).any(|x| x == *w));
            l.brief = brief_line(&l.brief);
            out.push(l);
        }
    }
    out
}

/// The lanes a call records.
pub fn lanes_of(tool: &str, cmd: &str, cwd: Option<&str>, background: bool, at: u64) -> Vec<Lane> {
    parse(cmd, cwd)
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| {
            Some(Lane {
                tool: tool.to_string(),
                index: i as u32,
                provider: l.provider?,
                model: l.model,
                cwd: l.cwd,
                brief: l.brief,
                files: l.files,
                detached: l.detached,
                image: l.image,
                background,
                at,
                task: None,
                end: None,
            })
        })
        .collect()
}

/// Appends a call's lanes, keeping the newest [`KEEP`].
pub fn push(list: &mut Vec<Lane>, new: Vec<Lane>) {
    if new.is_empty() {
        return;
    }
    let tool = new[0].tool.clone();
    list.retain(|l| l.tool != tool);
    list.extend(new);
    if list.len() > KEEP {
        let drop = list.len() - KEEP;
        list.drain(..drop);
    }
}

/// A call's result: a foreground call ended (how), a background one names its task.
pub fn call_result(list: &mut [Lane], tool: &str, at: u64, ok: bool, interrupted: bool, task: Option<&str>) {
    for l in list.iter_mut().filter(|l| l.tool == tool) {
        if let Some(t) = task {
            l.task = Some(t.to_string());
            l.background = true;
        } else if !l.background && !l.detached {
            l.end = Some((at, if interrupted { AgentState::Stopped } else if ok { AgentState::Done } else { AgentState::Failed }));
        }
    }
}

/// A background shell's end (its task notification): ends the lanes it ran itself (not detached ones).
pub fn task_end(list: &mut [Lane], task: &str, at: u64, how: AgentState) {
    for l in list.iter_mut().filter(|l| l.task.as_deref() == Some(task) && !l.detached) {
        l.end = Some((at, how));
    }
}

// ---------- pairing lanes with helper sessions ----------

/// What [`assign`] and [`state`] know of a helper session.
#[derive(Clone, Debug, Default)]
pub struct Child {
    pub provider: Option<Provider>,
    pub cwd: String,
    pub model: String,
    /// When it started, epoch ms.
    pub started: Option<u64>,
    /// Its newest event, epoch ms.
    pub last: Option<u64>,
    /// In a turn now.
    pub busy: bool,
    /// Its own end record: epoch ms and how (Codex `task_complete` / `turn_aborted` / an error).
    pub end: Option<(u64, AgentState)>,
    /// No process and nothing written for a while (the session list's `ended`).
    pub gone: bool,
}

fn norm(p: &str) -> &str {
    let p = p.trim_end_matches('/');
    p.strip_prefix("/private").filter(|r| r.starts_with("/tmp/") || r.starts_with("/var/") || *r == "/tmp").unwrap_or(p)
}

/// `pattern` (may hold `*`: one or more characters within a path segment) against a folder.
pub fn dir_matches(pattern: &str, dir: &str) -> bool {
    fn glob(p: &[u8], d: &[u8]) -> bool {
        match p.first() {
            None => d.is_empty(),
            Some(b'*') => (1..=d.len()).take_while(|&k| d[k - 1] != b'/').any(|k| glob(&p[1..], &d[k..])),
            Some(c) => d.first() == Some(c) && glob(&p[1..], &d[1..]),
        }
    }
    let (p, d) = (norm(pattern), norm(dir));
    !p.is_empty() && !d.is_empty() && glob(p.as_bytes(), d.as_bytes())
}

/// The model a lane asked for against the one its session ran: Codex ids exactly, Claude aliases by family
/// (`haiku` ~ `claude-haiku-5-5`).
pub fn model_matches(asked: &str, ran: &str) -> bool {
    let (a, r) = (asked.to_ascii_lowercase(), ran.to_ascii_lowercase());
    a == r || (r.starts_with("claude-") && r.split('-').any(|w| w == a))
}

/// Pairs lanes with helper sessions. `lanes`: (the parent's folder, the lane); `children`: candidates.
/// Returns (lane index, child index) pairs, nearest start first, each used once.
pub fn assign(lanes: &[(&str, &Lane)], children: &[Child], allow: impl Fn(usize, usize) -> bool) -> Vec<(usize, usize)> {
    let mut pairs: Vec<(u64, usize, usize)> = Vec::new();
    for (li, (parent_cwd, l)) in lanes.iter().enumerate() {
        for (ci, c) in children.iter().enumerate() {
            if c.provider != Some(l.provider) || !allow(li, ci) {
                continue;
            }
            let Some(st) = c.started else { continue };
            if st + EARLY_MS < l.at || st > l.at + START_WINDOW_MS {
                continue;
            }
            // A call that returned before the session began did not run it.
            if let Some((e, _)) = l.end
                && !l.detached
                && e + EARLY_MS < st
            {
                continue;
            }
            let want = l.cwd.as_deref().unwrap_or(parent_cwd);
            if !dir_matches(want, &c.cwd) {
                continue;
            }
            if let Some(m) = &l.model
                && !c.model.is_empty()
                && !m.contains('$')
                && !model_matches(m, &c.model)
            {
                continue;
            }
            pairs.push((st.abs_diff(l.at), li, ci));
        }
    }
    pairs.sort();
    let mut used_l = vec![false; lanes.len()];
    let mut used_c = vec![false; children.len()];
    let mut out = Vec::new();
    for (_, li, ci) in pairs {
        if !used_l[li] && !used_c[ci] {
            used_l[li] = true;
            used_c[ci] = true;
            out.push((li, ci));
        }
    }
    out
}

/// How a lane stands, from its session (if one was found), its call and its parent.
pub fn state(l: &Lane, child: Option<&Child>, parent_live: bool, now: u64) -> AgentState {
    if let Some(c) = child {
        if let Some((_, how)) = c.end
            && !c.busy
        {
            return how;
        }
        // The process is gone (the call returned): a session that never closed its turn ended with it.
        if let Some((_, how)) = l.end {
            return how;
        }
        if c.gone {
            return if c.busy { AgentState::Quiet } else { AgentState::Done };
        }
        return AgentState::Running;
    }
    if let Some((_, how)) = l.end {
        return how;
    }
    if !parent_live {
        return AgentState::Quiet;
    }
    if l.detached && now.saturating_sub(l.at) > NO_SESSION_MS {
        return AgentState::Quiet;
    }
    AgentState::Running
}

/// When the lane began and ended, epoch ms: its session's span when one was found, else the call's.
pub fn span(l: &Lane, child: Option<&Child>, st: AgentState) -> (u64, Option<u64>) {
    let start = child.and_then(|c| c.started).unwrap_or(l.at);
    if st == AgentState::Running {
        return (start, None);
    }
    let end = child.and_then(|c| c.end.map(|e| e.0).or(c.last)).or(l.end.map(|e| e.0));
    (start, end.map(|e| e.max(start)))
}

/// A background shell that only waits on helpers: `until`/`while` with `sleep`, naming files the lanes write.
/// Returns (helpers it waits on, their CLI when all share one).
pub fn waits_on(cmd: &str, lanes: &[Lane]) -> Option<(usize, Option<Provider>)> {
    let t = cmd.trim_start();
    let loopy = (t.starts_with("until ") || t.starts_with("while ")) && cmd.contains("sleep");
    let waits_pid = t.starts_with("wait ") || t == "wait";
    if !(loopy || waits_pid) || !parse(cmd, None).is_empty() {
        return None;
    }
    let hit: Vec<&Lane> = lanes.iter().filter(|l| l.files.iter().any(|f| !f.is_empty() && (cmd.contains(f.as_str()) || cmd.contains(norm(f))))).collect();
    if hit.is_empty() {
        return None;
    }
    let p = hit[0].provider;
    Some((hit.len(), hit.iter().all(|l| l.provider == p).then_some(p)))
}

/// "waiting for 2 Codex helpers".
pub fn waits_label(n: usize, p: Option<Provider>) -> String {
    let who = match p {
        Some(Provider::Codex) => "Codex ",
        Some(Provider::Claude) => "Claude ",
        None => "",
    };
    format!("waiting for {n} {who}helper{}", if n == 1 { "" } else { "s" })
}

/// A shell's plain label: "waiting for 2 Codex helpers" for a wait loop on their files, "running 1 Codex helper"
/// for a command that starts helpers itself; None otherwise.
pub fn shell_label(cmd: &str, lanes: &[Lane]) -> Option<String> {
    if let Some((n, p)) = waits_on(cmd, lanes) {
        return Some(waits_label(n, p));
    }
    let started = parse(cmd, None);
    let p = started.first()?.provider;
    let same = started.iter().all(|l| l.provider == p);
    let who = match p.filter(|_| same) {
        Some(Provider::Codex) => "Codex ",
        Some(Provider::Claude) => "Claude ",
        None => "",
    };
    Some(format!("running {} {who}helper{}", started.len(), if started.len() == 1 { "" } else { "s" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use AgentState::*;

    const T0: u64 = 1_800_000_000_000;

    fn one(cmd: &str) -> Launch {
        let v = parse(cmd, Some("/w"));
        assert_eq!(v.len(), 1, "{cmd}: {v:?}");
        v.into_iter().next().unwrap()
    }

    #[test]
    fn codex_exec_flags_and_prompt() {
        let l = one(r#"codex exec -m gpt-6.2-sol -c model_reasoning_effort="low" -s workspace-write --skip-git-repo-check -C /tmp/wt/a -o /tmp/out/a.txt "Build the parser. Keep to src/." < /dev/null"#);
        assert_eq!(l.provider, Some(Provider::Codex));
        assert_eq!(l.model.as_deref(), Some("gpt-6.2-sol"));
        assert_eq!(l.cwd.as_deref(), Some("/tmp/wt/a"));
        assert_eq!(l.brief, "Build the parser. Keep to src/.");
        assert_eq!(l.files, vec!["/tmp/out/a.txt".to_string()]);
        assert!(!l.detached && !l.image);
        // --model=, a relative -C against the last cd, prompt from a file.
        let l = one("cd /repo && codex exec --model=gpt-6-luna --cd sub - < /tmp/brief.md > /tmp/log.txt 2>&1");
        assert_eq!((l.model.as_deref(), l.cwd.as_deref()), (Some("gpt-6-luna"), Some("/repo/sub")));
        assert_eq!(l.brief, "prompt from /tmp/brief.md");
        assert_eq!(l.files, vec!["/tmp/log.txt".to_string()]);
        // No -C: the folder the command runs in.
        assert_eq!(one("codex e 'make an app icon, png'").cwd.as_deref(), Some("/w"));
        assert!(one("codex e 'make an app icon, png'").image);
    }

    #[test]
    fn claude_print_from_a_codex_lead() {
        let l = one(r#"cd /tmp/wt/b && claude -p --model haiku --tools "" --output-format json "Summarise the README" | jq .result"#);
        assert_eq!(l.provider, Some(Provider::Claude));
        assert_eq!((l.model.as_deref(), l.cwd.as_deref()), (Some("haiku"), Some("/tmp/wt/b")));
        assert_eq!(l.brief, "Summarise the README");
        let l = one("printf '%s' \"$P\" | claude --print --model sonnet");
        assert_eq!(l.brief, "prompt on stdin");
    }

    #[test]
    fn not_a_launch() {
        for c in [
            r#"pgrep -fl "codex exec" | head"#,
            "grep -c 'claude -p' notes.md",
            "echo codex exec",
            "ls ~/.codex/sessions",
            "claude --version",
            "codex login status",
        ] {
            assert!(parse(c, None).is_empty(), "{c}");
        }
    }

    #[test]
    fn a_loop_launches_one_per_value_detached() {
        let cmd = r#"cd /tmp/s && for p in tasks bench; do (codex exec -m gpt-6.2-sol -s workspace-write -C /tmp/wt/$p -o /tmp/s/report-$p.txt "Read the brief at /tmp/s/brief-$p.md and carry it out." < /dev/null > /tmp/s/log-$p.txt 2>&1; echo "exit $?" >> /tmp/s/log-$p.txt) & done; sleep 2; echo launched"#;
        let v = parse(cmd, Some("/w"));
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].cwd.as_deref(), Some("/tmp/wt/tasks"));
        assert_eq!(v[1].cwd.as_deref(), Some("/tmp/wt/bench"));
        assert_eq!(v[1].brief, "Read the brief at /tmp/s/brief-bench.md and carry it out.");
        assert!(v.iter().all(|l| l.detached));
        assert_eq!(v[0].files, vec!["/tmp/s/report-tasks.txt".to_string(), "/tmp/s/log-tasks.txt".to_string()]);
        // Two launches in one command, the second one waited on.
        let v = parse("codex exec -m a 'one' & codex exec -m b 'two'; wait", None);
        assert_eq!(v.iter().map(|l| (l.model.clone().unwrap(), l.detached)).collect::<Vec<_>>(), vec![("a".into(), true), ("b".into(), false)]);
        // An unknown loop variable: a wildcard folder.
        let v = parse("for d in $(ls); do codex exec -C /tmp/wt/$d 'x'; done", None);
        assert_eq!(v[0].cwd.as_deref(), Some("/tmp/wt/*"));
    }

    /// Any text, cut anywhere, parses without a panic (it runs on every Bash call of every transcript).
    #[test]
    fn never_panics_on_odd_input() {
        let cmds = [
            r#"cd /tmp/s && for p in a b; do (codex exec -m x -C /w/$p -o /o/$p "go $p" < /dev/null > /l/$p 2>&1; echo "exit $?" >> /l/$p) & done; sleep 2"#,
            "timeout 30 nice -n 5 env A=1 codex exec --model=y 'q' | tee >(cat) $(echo hi) `date` <<< 'x' &> /dev/null",
            "claude -p --tools \"\" --model haiku \\\n \"a \\\"quoted\\\" prompt\" <<EOF\nbody\nEOF",
            "timeout", "nice -n", "env", "codex", "claude -p", "for", "for x in", "( ( ) ) & &", "cd", "\\", "'", "\"", "$(", "`",
        ];
        for c in cmds {
            for (i, _) in c.char_indices() {
                let _ = parse(&c[..i], Some("/w"));
                let _ = shell_label(&c[..i], &[]);
            }
        }
    }

    #[test]
    fn folders_and_models_match() {
        assert!(dir_matches("/tmp/wt/a", "/private/tmp/wt/a/"));
        assert!(dir_matches("/tmp/wt/*", "/tmp/wt/bench"));
        assert!(!dir_matches("/tmp/wt/*", "/tmp/wt/bench/deeper"));
        assert!(!dir_matches("/tmp/wt/*", "/tmp/wt/"));
        assert!(dir_matches("/tmp/wt/*/src", "/tmp/wt/x/src"));
        assert!(!dir_matches("/tmp/a", "/tmp/b"));
        assert!(model_matches("haiku", "claude-haiku-5-5"));
        assert!(model_matches("gpt-6.2-sol", "gpt-6.2-sol"));
        assert!(!model_matches("gpt-6.2-sol", "gpt-6-luna"));
    }

    fn lane(tool: &str, cwd: &str, model: &str, at: u64) -> Lane {
        Lane {
            tool: tool.into(),
            index: 0,
            provider: Provider::Codex,
            model: Some(model.into()),
            cwd: Some(cwd.into()),
            brief: String::new(),
            files: Vec::new(),
            detached: false,
            image: false,
            background: false,
            at,
            task: None,
            end: None,
        }
    }
    fn child(cwd: &str, model: &str, started: u64) -> Child {
        Child { provider: Some(Provider::Codex), cwd: cwd.into(), model: model.into(), started: Some(started), last: Some(started), busy: true, ..Child::default() }
    }

    #[test]
    fn lanes_pair_with_their_sessions() {
        let a = lane("t1", "/tmp/wt/tasks", "gpt-6.2-sol", T0);
        let b = Lane { index: 1, cwd: Some("/tmp/wt/bench".into()), ..a.clone() };
        let other = lane("t2", "/elsewhere", "gpt-6-luna", T0 - 3_600_000);
        let lanes = [("/p", &a), ("/p", &b), ("/p", &other)];
        let kids = [
            child("/tmp/wt/bench", "gpt-6.2-sol", T0 + 700),
            child("/tmp/wt/tasks", "gpt-6.2-sol", T0 + 600),
            child("/tmp/wt/tasks", "gpt-6.2-sol", T0 + 600_000), // ten minutes later: another run
            child("/tmp/wt/tasks", "gpt-6-luna", T0 + 800),      // another model
            Child { provider: Some(Provider::Claude), ..child("/tmp/wt/tasks", "", T0 + 100) },
        ];
        let mut got = assign(&lanes, &kids, |_, _| true);
        got.sort();
        assert_eq!(got, vec![(0, 1), (1, 0)]);
        // No folder given: the parent's.
        let c = Lane { cwd: None, ..lane("t3", "", "gpt-6.2-sol", T0) };
        assert_eq!(assign(&[("/p", &c)], &[child("/p", "gpt-6.2-sol", T0 + 1000)], |_, _| true), vec![(0, 0)]);
        // A foreground call that returned before the session began.
        let d = Lane { end: Some((T0 + 500, Done)), ..lane("t4", "/p", "gpt-6.2-sol", T0) };
        assert!(assign(&[("/p", &d)], &[child("/p", "gpt-6.2-sol", T0 + 10_000)], |_, _| true).is_empty());
    }

    #[test]
    fn lane_states() {
        let now = T0 + 60_000;
        let fg = lane("t", "/p", "m", T0);
        let running = child("/p", "m", T0 + 500);
        // Foreground, running: the call is open and the session is in its turn.
        assert_eq!(state(&fg, Some(&running), true, now), Running);
        // The session recorded its end.
        let done = Child { busy: false, end: Some((T0 + 50_000, Done)), ..running.clone() };
        assert_eq!(state(&fg, Some(&done), true, now), Done);
        assert_eq!(span(&fg, Some(&done), Done), (T0 + 500, Some(T0 + 50_000)));
        // The call failed (exit status) and the session never closed its turn.
        let failed = Lane { end: Some((T0 + 40_000, Failed)), ..fg.clone() };
        assert_eq!(state(&failed, Some(&running), true, now), Failed);
        // Aborted.
        let aborted = Child { busy: false, end: Some((T0 + 9_000, Stopped)), ..running.clone() };
        assert_eq!(state(&fg, Some(&aborted), true, now), Stopped);
        // Background and detached: only the session says; gone while in its turn is quiet.
        let bg = Lane { background: true, detached: true, task: Some("b1".into()), ..fg.clone() };
        assert_eq!(state(&bg, Some(&running), true, now), Running);
        assert_eq!(state(&bg, Some(&Child { gone: true, ..running.clone() }), true, now), Quiet);
        // No session file: running while the call runs; a detached one turns quiet after a while.
        assert_eq!(state(&fg, None, true, now), Running);
        assert_eq!(state(&bg, None, true, T0 + 10_000), Running);
        assert_eq!(state(&bg, None, true, T0 + 600_000), Quiet);
        assert_eq!(state(&fg, None, false, now), Quiet);
        // The shell's end decides for a lane it ran itself.
        let mut v = vec![Lane { background: true, ..fg.clone() }];
        call_result(&mut v, "t", T0 + 10, true, false, Some("b9"));
        assert_eq!((v[0].task.as_deref(), v[0].end), (Some("b9"), None));
        task_end(&mut v, "b9", T0 + 5_000, Failed);
        assert_eq!(v[0].end, Some((T0 + 5_000, Failed)));
    }

    #[test]
    fn wait_loops_on_helper_files() {
        let cmd = r#"cd /tmp/s && for p in tasks bench; do (codex exec -C /tmp/wt/$p "x" > /tmp/s/log-$p.txt 2>&1; echo "exit $?" >> /tmp/s/log-$p.txt) & done"#;
        let lanes = lanes_of("t", cmd, None, true, T0);
        let wait = "until grep -q '^exit' /tmp/s/log-tasks.txt 2>/dev/null && grep -q '^exit' /tmp/s/log-bench.txt 2>/dev/null; do sleep 20; done; tail -1 /tmp/s/log-tasks.txt";
        assert_eq!(waits_on(wait, &lanes), Some((2, Some(Provider::Codex))));
        assert_eq!(waits_label(2, Some(Provider::Codex)), "waiting for 2 Codex helpers");
        assert_eq!(waits_on("until [ -f /tmp/other ]; do sleep 5; done", &lanes), None);
        assert_eq!(waits_on("tail -f /tmp/s/log-tasks.txt", &lanes), None);
    }
}
