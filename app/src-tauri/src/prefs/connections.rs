//! A read-only view of the MCP servers, hooks and plugins Claude Code and
//! Codex are set up with, for Settings > Connections.
//!
//! Nothing is ever written. From `~/.claude.json` only the `mcpServers` keys
//! are touched (that file also holds account details). Env and header values
//! are never returned, only their names, and commands and URLs are masked so
//! a token typed into an argument or a query string doesn't reach the UI.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What a masked value is shown as.
pub const MASK: &str = "••••";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Connections {
    pub claude: ProviderConn,
    pub codex: ProviderConn,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ProviderConn {
    pub files: Vec<ConfigFile>,
    pub mcp: Vec<McpServer>,
    pub hooks: Vec<Hook>,
    pub plugins: Vec<Plugin>,
    /// One line per unreadable or malformed file, e.g. "~/.codex/config.toml: invalid TOML at line 3".
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub label: String,
    pub exists: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct McpServer {
    pub name: String,
    /// "user", "project" or "local".
    pub scope: String,
    /// "stdio", "http" or "sse".
    pub transport: String,
    /// Program and args, masked, joined by spaces.
    pub command: Option<String>,
    /// Masked.
    pub url: Option<String>,
    /// Names only.
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub disabled: bool,
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hook {
    /// e.g. "PreToolUse", or "notify" for Codex.
    pub event: String,
    pub matcher: Option<String>,
    /// Masked.
    pub command: String,
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Plugin {
    pub name: String,
    /// The marketplace.
    pub source: Option<String>,
    pub enabled: bool,
    pub version: Option<String>,
    pub file: String,
}

// ---------- masking ----------

/// Long flags whose value is a secret.
const SECRET_FLAGS: [&str; 10] = ["token", "api-key", "apikey", "key", "secret", "password", "pat", "auth", "access-token", "bearer"];
/// Prefixes of well-known token formats.
const SECRET_PREFIXES: [&str; 10] = ["sk-", "sk_", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "glpat-", "eyJ"];

/// A `--long` flag (without `=value`) whose value is a secret: one of [`SECRET_FLAGS`] or ending in `-token`, `-key`, `-secret`, `-password`.
fn is_secret_flag(flag: &str) -> bool {
    let Some(name) = flag.strip_prefix("--") else { return false };
    let name = name.to_ascii_lowercase().replace('_', "-");
    SECRET_FLAGS.contains(&name.as_str()) || ["-token", "-key", "-secret", "-password"].iter().any(|s| name.ends_with(s))
}

fn is_header_flag(flag: &str) -> bool {
    flag == "-H" || flag == "--header"
}

/// A token that looks like a secret on its own: a known prefix, or 32+
/// characters of `[A-Za-z0-9_\-+/=]` mixing letters and digits that isn't a path.
fn looks_secret(tok: &str) -> bool {
    if tok.len() >= 12 && SECRET_PREFIXES.iter().any(|p| tok.starts_with(p)) {
        return true;
    }
    tok.len() >= 32
        && !tok.contains('/')
        && tok.chars().all(|c| c.is_ascii_alphanumeric() || "_-+=".contains(c))
        && tok.chars().any(|c| c.is_ascii_alphabetic())
        && tok.chars().any(|c| c.is_ascii_digit())
}

/// `NAME=value` with a shell-style name.
fn env_assign(tok: &str) -> Option<(&str, &str)> {
    let (n, v) = tok.split_once('=')?;
    let mut cs = n.chars();
    let first = cs.next()?;
    ((first.is_ascii_alphabetic() || first == '_') && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')).then_some((n, v))
}

fn is_secret_name(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASS", "AUTH"].iter().any(|s| u.contains(s))
}

/// Splits a token wrapped in matching quotes into the quote and the inside.
fn unquote(tok: &str) -> (Option<char>, &str) {
    let c = tok.chars().next();
    match c {
        Some(q @ ('"' | '\'')) if tok.len() >= 2 && tok.ends_with(q) => (Some(q), &tok[1..tok.len() - 1]),
        _ => (None, tok),
    }
}

fn requote(q: Option<char>, s: String) -> String {
    match q {
        Some(q) => format!("{q}{s}{q}"),
        None => s,
    }
}

/// A value on its own: a URL is masked, a secret-looking token hidden.
fn mask_value(v: &str) -> String {
    if v.contains("://") {
        mask_url(v)
    } else if looks_secret(v) {
        MASK.into()
    } else {
        v.into()
    }
}

/// `Name: value` → `Name: ••••`.
fn mask_header(v: &str) -> String {
    match v.split_once(':') {
        Some((n, _)) => format!("{n}: {MASK}"),
        None if v.is_empty() => String::new(),
        None => MASK.into(),
    }
}

/// Masks one argument on its own: `--token=x`, `NAME_KEY=x`, URLs and secret-looking tokens.
pub fn mask_arg(arg: &str) -> String {
    let (q, inner) = unquote(arg);
    let masked = if inner.contains("://") && !inner.starts_with('-') && env_assign(inner).is_none() {
        mask_url(inner)
    } else if let Some((flag, val)) = inner.split_once('=').filter(|(f, _)| f.starts_with("--")) {
        if is_secret_flag(flag) {
            format!("{flag}={MASK}")
        } else if is_header_flag(flag) {
            format!("{flag}={}", mask_header(val))
        } else {
            format!("{flag}={}", mask_value(val))
        }
    } else if let Some((name, val)) = env_assign(inner) {
        if is_secret_name(name) && !val.is_empty() { format!("{name}={MASK}") } else { format!("{name}={}", mask_value(val)) }
    } else {
        mask_value(inner)
    };
    requote(q, masked)
}

/// Masks a token list in order: the value after a secret flag or a header flag is masked too.
fn mask_tokens<'a>(tokens: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let (mut secret_next, mut header_next) = (false, false);
    let mut out = Vec::new();
    for tok in tokens {
        let (q, inner) = unquote(tok);
        out.push(if secret_next {
            MASK.to_string()
        } else if header_next {
            requote(q, mask_header(inner))
        } else {
            mask_arg(tok)
        });
        secret_next = is_secret_flag(inner);
        header_next = is_header_flag(inner);
    }
    out
}

/// A program and its args, masked and joined by spaces (an arg with spaces is shown in quotes).
pub fn mask_command(program: &str, args: &[String]) -> String {
    let toks = std::iter::once(program).chain(args.iter().map(String::as_str));
    mask_tokens(toks)
        .into_iter()
        .map(|t| if t.contains(char::is_whitespace) && unquote(&t).0.is_none() { format!("\"{t}\"") } else { t })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Splits a shell command on whitespace outside quotes, keeping the quotes.
fn shell_tokens(s: &str) -> Vec<String> {
    let (mut v, mut cur, mut quote) = (Vec::new(), String::new(), None::<char>);
    for c in s.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    v.push(std::mem::take(&mut cur));
                }
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        v.push(cur);
    }
    v
}

/// A shell command line (a hook), masked token by token.
pub fn mask_shell(cmd: &str) -> String {
    let toks = shell_tokens(cmd);
    mask_tokens(toks.iter().map(String::as_str)).join(" ")
}

fn mask_pairs(s: &str) -> String {
    s.split('&')
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) if !v.is_empty() => format!("{k}={MASK}"),
            _ => kv.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// Drops the userinfo, masks every query value (keeping the keys) and any secret-looking path segment.
pub fn mask_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return mask_value(url) };
    let (rest, frag) = match rest.split_once('#') {
        Some((r, f)) => (r, Some(f)),
        None => (rest, None),
    };
    let (rest, query) = match rest.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (rest, None),
    };
    let (auth, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let auth = match auth.rsplit_once('@') {
        Some((_, host)) => format!("{MASK}@{host}"),
        None => auth.to_string(),
    };
    let path = path.split('/').map(|s| if looks_secret(s) { MASK } else { s }).collect::<Vec<_>>().join("/");
    let mut out = format!("{scheme}://{auth}{path}");
    if let Some(q) = query {
        out.push('?');
        out.push_str(&mask_pairs(q));
    }
    if let Some(f) = frag {
        out.push('#');
        out.push_str(&if f.contains('=') { mask_pairs(f) } else { f.to_string() });
    }
    out
}

// ---------- files ----------

/// The files `read` looks at, with labels.
struct Files {
    claude_json: PathBuf,
    mcp_json: Option<PathBuf>,
    /// User, project, local.
    settings: Vec<(PathBuf, &'static str)>,
    installed: PathBuf,
    codex: PathBuf,
}

fn files(home: &Path, project: Option<&Path>) -> Files {
    let mut settings = vec![(home.join(".claude/settings.json"), "User settings")];
    if let Some(p) = project {
        settings.push((p.join(".claude/settings.json"), "Project settings"));
        settings.push((p.join(".claude/settings.local.json"), "Local project settings"));
    }
    Files {
        claude_json: home.join(".claude.json"),
        mcp_json: project.map(|p| p.join(".mcp.json")),
        settings,
        installed: home.join(".claude/plugins/installed_plugins.json"),
        codex: home.join(".codex/config.toml"),
    }
}

/// Every path `read` may look at. "Open file" only opens a path in this list.
pub fn known_files(home: &Path, project: Option<&Path>) -> Vec<PathBuf> {
    let f = files(home, project);
    let mut v = vec![f.claude_json];
    v.extend(f.mcp_json);
    v.extend(f.settings.into_iter().map(|s| s.0));
    v.push(f.installed);
    v.push(f.codex);
    v
}

/// `~/...` for a path under home, for error lines.
fn tilde(home: &Path, p: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

/// Reads a file, recording it in `files`. None when missing or unreadable (the latter also an error line).
fn load(conn: &mut ProviderConn, home: &Path, path: &Path, label: &str) -> Option<String> {
    let r = std::fs::read_to_string(path);
    conn.files.push(ConfigFile { path: path.display().to_string(), label: label.into(), exists: path.exists() });
    match r {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            conn.errors.push(format!("{}: couldn't read ({})", tilde(home, path), e.kind()));
            None
        }
    }
}

/// Reads and parses a JSON file. A malformed one becomes an error line.
fn load_json(conn: &mut ProviderConn, home: &Path, path: &Path, label: &str) -> Option<Value> {
    let s = load(conn, home, path, label)?;
    match serde_json::from_str::<Value>(&s) {
        Ok(v) => Some(v),
        Err(e) => {
            conn.errors.push(format!("{}: invalid JSON at line {}", tilde(home, path), e.line()));
            None
        }
    }
}

fn keys(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).collect()).unwrap_or_default()
}

/// One Claude MCP server entry.
fn claude_server(name: &str, v: &Value, scope: &str, file: &Path) -> McpServer {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let command = s("command").map(|c| mask_command(c, &str_list(v.get("args"))));
    let url = s("url").map(mask_url);
    let transport = s("type").map(str::to_string).unwrap_or_else(|| if command.is_none() && url.is_some() { "http".into() } else { "stdio".into() });
    McpServer {
        name: name.into(),
        scope: scope.into(),
        transport,
        command,
        url,
        env_keys: keys(v.get("env")),
        header_keys: keys(v.get("headers")),
        disabled: false,
        file: file.display().to_string(),
    }
}

fn claude_servers(conn: &mut ProviderConn, servers: Option<&Value>, scope: &str, file: &Path) {
    for (name, v) in servers.and_then(Value::as_object).into_iter().flatten() {
        conn.mcp.push(claude_server(name, v, scope, file));
    }
}

/// The `projects` entry for this project in `~/.claude.json`, tolerating a trailing slash or a symlinked path.
fn project_entry<'a>(projects: &'a Map<String, Value>, project: &Path) -> Option<&'a Value> {
    let mut cands = vec![project.display().to_string()];
    if let Ok(c) = std::fs::canonicalize(project) {
        cands.push(c.display().to_string());
    }
    cands.iter().find_map(|c| projects.get(c.as_str()).or_else(|| projects.get(c.trim_end_matches('/'))))
}

fn settings_hooks(conn: &mut ProviderConn, v: &Value, file: &Path) {
    for (event, groups) in v.get("hooks").and_then(Value::as_object).into_iter().flatten() {
        for g in groups.as_array().into_iter().flatten() {
            let matcher = g.get("matcher").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string);
            for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                let command = match (h.get("command").and_then(Value::as_str), h.get("url").and_then(Value::as_str)) {
                    (Some(c), _) => mask_shell(c),
                    (None, Some(u)) => mask_url(u),
                    _ => format!("{} hook", h.get("type").and_then(Value::as_str).unwrap_or("unknown")),
                };
                conn.hooks.push(Hook { event: event.clone(), matcher: matcher.clone(), command, file: file.display().to_string() });
            }
        }
    }
}

/// What is known about a plugin from the settings files and the installed list.
#[derive(Default)]
struct PluginInfo {
    enabled: Option<(bool, String)>,
    version: Option<String>,
    installed_file: Option<String>,
}

fn read_claude(home: &Path, project: Option<&Path>) -> ProviderConn {
    let f = files(home, project);
    let mut c = ProviderConn::default();

    if let Some(v) = load_json(&mut c, home, &f.claude_json, "User MCP servers") {
        claude_servers(&mut c, v.get("mcpServers"), "user", &f.claude_json);
        if let (Some(p), Some(projects)) = (project, v.get("projects").and_then(Value::as_object)) {
            claude_servers(&mut c, project_entry(projects, p).and_then(|e| e.get("mcpServers")), "local", &f.claude_json);
        }
    }
    let project_start = c.mcp.len();
    if let Some(path) = &f.mcp_json
        && let Some(v) = load_json(&mut c, home, path, "Project .mcp.json")
    {
        claude_servers(&mut c, v.get("mcpServers"), "project", path);
    }

    let mut plugins: BTreeMap<String, PluginInfo> = BTreeMap::new();
    let mut disabled_project: Vec<String> = Vec::new();
    for (path, label) in &f.settings {
        let Some(v) = load_json(&mut c, home, path, label) else { continue };
        settings_hooks(&mut c, &v, path);
        for (name, on) in v.get("enabledPlugins").and_then(Value::as_object).into_iter().flatten() {
            plugins.entry(name.clone()).or_default().enabled = Some((on.as_bool().unwrap_or(false), path.display().to_string()));
        }
        disabled_project.extend(str_list(v.get("disabledMcpjsonServers")));
    }
    for s in c.mcp.iter_mut().skip(project_start).filter(|s| s.scope == "project") {
        s.disabled = disabled_project.contains(&s.name);
    }

    if let Some(v) = load_json(&mut c, home, &f.installed, "Installed plugins") {
        for (name, entry) in v.get("plugins").and_then(Value::as_object).into_iter().flatten() {
            // v2: a list of installs; v1: one object.
            let first = entry.as_array().and_then(|a| a.first()).unwrap_or(entry);
            let info = plugins.entry(name.clone()).or_default();
            info.version = first.get("version").and_then(Value::as_str).map(str::to_string);
            info.installed_file = Some(f.installed.display().to_string());
        }
    }
    for (full, info) in plugins {
        let (name, source) = match full.split_once('@') {
            Some((n, s)) => (n.to_string(), Some(s.to_string())),
            None => (full.clone(), None),
        };
        let (enabled, efile) = info.enabled.map_or((false, None), |(on, f)| (on, Some(f)));
        let file = efile.or(info.installed_file).unwrap_or_default();
        c.plugins.push(Plugin { name, source, enabled, version: info.version, file });
    }
    c
}

/// 1-based line of a byte offset.
fn line_of(s: &str, offset: usize) -> usize {
    s[..offset.min(s.len())].matches('\n').count() + 1
}

fn toml_strs(v: Option<&toml::Value>) -> Vec<String> {
    v.and_then(toml::Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn toml_keys(v: Option<&toml::Value>) -> Vec<String> {
    v.and_then(toml::Value::as_table).map(|t| t.keys().cloned().collect()).unwrap_or_default()
}

/// One `[mcp_servers.<name>]` table.
fn codex_server(name: &str, t: &toml::Table, file: &Path) -> McpServer {
    let s = |k: &str| t.get(k).and_then(toml::Value::as_str);
    let command = s("command").map(|c| mask_command(c, &toml_strs(t.get("args"))));
    let url = s("url").map(mask_url);
    let mut env_keys = toml_keys(t.get("env"));
    env_keys.extend(toml_strs(t.get("env_vars")));
    let mut header_keys = toml_keys(t.get("http_headers"));
    if let Some(h) = t.get("env_http_headers").and_then(toml::Value::as_table) {
        for (header, var) in h {
            header_keys.push(header.clone());
            env_keys.extend(var.as_str().map(str::to_string));
        }
    }
    env_keys.extend(s("bearer_token_env_var").map(str::to_string));
    env_keys.dedup();
    McpServer {
        name: name.into(),
        scope: "user".into(),
        transport: if command.is_none() && url.is_some() { "http".into() } else { "stdio".into() },
        command,
        url,
        env_keys,
        header_keys,
        disabled: t.get("enabled").and_then(toml::Value::as_bool) == Some(false),
        file: file.display().to_string(),
    }
}

fn read_codex(home: &Path) -> ProviderConn {
    let path = files(home, None).codex;
    let mut c = ProviderConn::default();
    let Some(s) = load(&mut c, home, &path, "Codex config") else { return c };
    let t = match s.parse::<toml::Table>() {
        Ok(t) => t,
        Err(e) => {
            let line = e.span().map_or(1, |r| line_of(&s, r.start));
            c.errors.push(format!("{}: invalid TOML at line {line}", tilde(home, &path)));
            return c;
        }
    };
    for (name, v) in t.get("mcp_servers").and_then(toml::Value::as_table).into_iter().flatten() {
        if let Some(st) = v.as_table() {
            c.mcp.push(codex_server(name, st, &path));
        }
    }
    let notify = toml_strs(t.get("notify"));
    if let Some((prog, args)) = notify.split_first() {
        c.hooks.push(Hook { event: "notify".into(), matcher: None, command: mask_command(prog, args), file: path.display().to_string() });
    }
    c
}

/// Everything Settings > Connections shows. `project` is the folder the person picked; None skips project files.
pub fn read(home: &Path, project: Option<&Path>) -> Connections {
    Connections { claude: read_claude(home, project), codex: read_codex(home) }
}

/// Claude Code plugins that are installed and turned on for `project` (user, project and local settings; a later
/// file wins): (name, install folder). Read only, like the rest of this module; the Context panel lists their skills.
pub fn enabled_plugins(home: &Path, project: Option<&Path>) -> Vec<(String, PathBuf)> {
    let f = files(home, project);
    let mut c = ProviderConn::default();
    let mut on: BTreeMap<String, bool> = BTreeMap::new();
    for (path, label) in &f.settings {
        let Some(v) = load_json(&mut c, home, path, label) else { continue };
        for (name, en) in v.get("enabledPlugins").and_then(Value::as_object).into_iter().flatten() {
            on.insert(name.clone(), en.as_bool().unwrap_or(false));
        }
    }
    let Some(v) = load_json(&mut c, home, &f.installed, "Installed plugins") else { return Vec::new() };
    let mut out = Vec::new();
    for (full, entry) in v.get("plugins").and_then(Value::as_object).into_iter().flatten() {
        if on.get(full) != Some(&true) {
            continue;
        }
        let first = entry.as_array().and_then(|a| a.first()).unwrap_or(entry);
        if let Some(p) = first.get("installPath").and_then(Value::as_str) {
            out.push((full.split('@').next().unwrap_or(full).to_string(), PathBuf::from(p)));
        }
    }
    out
}

/// [`read`] for the real home folder.
pub fn read_default(project: Option<&Path>) -> Connections {
    match dirs::home_dir() {
        Some(h) => read(&h, project),
        None => Connections::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn masks_args() {
        assert_eq!(mask_arg("--token=abc"), "--token=••••");
        assert_eq!(mask_arg("--github-token=abc"), "--github-token=••••");
        assert_eq!(mask_arg("--port=8080"), "--port=8080");
        assert_eq!(mask_arg("GITHUB_TOKEN=abc"), "GITHUB_TOKEN=••••");
        assert_eq!(mask_arg("api_key=abc"), "api_key=••••");
        assert_eq!(mask_arg("DEBUG=1"), "DEBUG=1");
        assert_eq!(mask_arg("sk-ant-api03-abcdefghijkl"), "••••");
        assert_eq!(mask_arg("ghp_abcdefghijklmnop1234"), "••••");
        assert_eq!(mask_arg("eyJhbGciOiJIUzI1NiJ9.e30.x"), "••••");
        assert_eq!(mask_arg("AKIAIOSFODNN7EXAMPLE"), "••••");
        assert_eq!(mask_arg("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7"), "••••");
        assert_eq!(mask_arg("/Users/x/.npm/_npx/abcdef0123456789abcdef0123456789/node_modules"), "/Users/x/.npm/_npx/abcdef0123456789abcdef0123456789/node_modules");
        assert_eq!(mask_arg("@modelcontextprotocol/server-filesystem"), "@modelcontextprotocol/server-filesystem");
        assert_eq!(mask_arg("-y"), "-y");
        assert_eq!(mask_arg("skill"), "skill");
        assert_eq!(mask_arg("abcdefghijklmnopqrstuvwxyzabcdefgh"), "abcdefghijklmnopqrstuvwxyzabcdefgh", "no digits");
        assert_eq!(mask_arg("\"TOKEN=x\""), "\"TOKEN=••••\"");
    }

    #[test]
    fn masks_commands() {
        assert_eq!(mask_command("npx", &a(&["-y", "srv", "--api-key", "abc123", "--verbose"])), "npx -y srv --api-key •••• --verbose");
        assert_eq!(mask_command("curl", &a(&["-H", "Authorization: Bearer abc", "--header=X-Key: v"])), "curl -H \"Authorization: ••••\" \"--header=X-Key: ••••\"");
        assert_eq!(mask_command("mcp-remote", &a(&["https://me:pw@x.com/sse?key=abc&v=2"])), "mcp-remote https://••••@x.com/sse?key=••••&v=••••");
        assert_eq!(mask_shell("TOKEN=abc ./hook.sh --secret 's p' -H 'Authorization: Bearer x'"), "TOKEN=•••• ./hook.sh --secret •••• -H 'Authorization: ••••'");
        assert_eq!(mask_shell("  echo   hi  "), "echo hi");
    }

    #[test]
    fn masks_urls() {
        assert_eq!(mask_url("https://user:pw@host.com/p"), "https://••••@host.com/p");
        assert_eq!(mask_url("https://h.com/mcp?token=abc&flag"), "https://h.com/mcp?token=••••&flag");
        assert_eq!(mask_url("https://h.com/x#access_token=abc"), "https://h.com/x#access_token=••••");
        assert_eq!(mask_url("https://hooks.x.com/services/T0/abcdefghijklmnop0123456789ABCDEF"), "https://hooks.x.com/services/T0/••••");
        assert_eq!(mask_url("http://localhost:3000/mcp"), "http://localhost:3000/mcp");
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-conn-{}-{:?}", std::process::id(), std::time::Instant::now()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    const CLAUDE_JSON: &str = r#"{
      "oauthAccount": {"emailAddress": "secret-person@example.com", "accountUuid": "SECRET-UUID-1"},
      "primaryApiKey": "sk-ant-SECRETSECRETSECRET",
      "userID": "SECRET-USER-ID",
      "mcpServers": {
        "gh": {"command": "npx", "args": ["-y", "gh-mcp", "--token", "SECRET-ARG-TOKEN"], "env": {"GITHUB_TOKEN": "SECRET-ENV-VALUE"}},
        "remote": {"type": "sse", "url": "https://x.com/sse?key=SECRET-QUERY", "headers": {"Authorization": "Bearer SECRET-HEADER"}}
      },
      "projects": {
        "PROJECT": {"mcpServers": {"localdb": {"url": "http://localhost:5432/mcp"}}, "history": [{"display": "SECRET-HISTORY"}]},
        "/other": {"mcpServers": {"nope": {"command": "x"}}}
      }
    }"#;

    #[test]
    fn reads_claude_and_codex_without_leaking() {
        let home = tmp();
        let proj = tmp();
        write(&home.join(".claude.json"), &CLAUDE_JSON.replace("PROJECT", &proj.display().to_string()));
        write(&proj.join(".mcp.json"), r#"{"mcpServers": {"fs": {"command": "npx", "args": ["fs-mcp", "."]}, "off": {"command": "y"}}}"#);
        write(
            &home.join(".claude/settings.json"),
            r#"{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "API_KEY=SECRET-HOOK ~/bin/check.sh"}]}],
                          "Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]},
               "enabledPlugins": {"fmt@official": true, "lint@official": false}}"#,
        );
        write(&proj.join(".claude/settings.local.json"), r#"{"disabledMcpjsonServers": ["off"]}"#);
        write(
            &home.join(".claude/plugins/installed_plugins.json"),
            r#"{"version": 2, "plugins": {"fmt@official": [{"scope": "user", "version": "1.0.0", "installPath": "/x"}], "extra@market": [{"version": "0.2.0"}]}}"#,
        );
        write(
            &home.join(".codex/config.toml"),
            r#"notify = ["python3", "/Users/x/notify.py", "--token", "SECRET-NOTIFY"]
model = "gpt"
[mcp_servers.docs]
command = "docs-mcp"
args = ["--api-key=SECRET-CODEX-ARG"]
env = { DOCS_KEY = "SECRET-CODEX-ENV" }
[mcp_servers.web]
url = "https://w.com/mcp?access_token=SECRET-CODEX-QUERY"
http_headers = { "X-Api-Key" = "SECRET-CODEX-HEADER" }
bearer_token_env_var = "WEB_TOKEN"
enabled = false
"#,
        );

        let c = read(&home, Some(&proj));
        let json = serde_json::to_string(&c).unwrap();
        for bad in ["SECRET", "secret-person", "oauthAccount", "history", "nope"] {
            assert!(!json.contains(bad), "{bad} leaked: {json}");
        }
        let cl = &c.claude;
        assert!(cl.errors.is_empty(), "{:?}", cl.errors);
        let srv = |n: &str| cl.mcp.iter().find(|s| s.name == n).unwrap();
        assert_eq!(srv("gh").command.as_deref(), Some("npx -y gh-mcp --token ••••"));
        assert_eq!(srv("gh").env_keys, ["GITHUB_TOKEN"]);
        assert_eq!((srv("gh").scope.as_str(), srv("gh").transport.as_str()), ("user", "stdio"));
        assert_eq!(srv("remote").transport, "sse");
        assert_eq!(srv("remote").header_keys, ["Authorization"]);
        assert_eq!((srv("localdb").scope.as_str(), srv("localdb").transport.as_str()), ("local", "http"));
        assert_eq!(srv("fs").scope, "project");
        assert!(srv("off").disabled && !srv("fs").disabled);
        assert_eq!(cl.hooks.len(), 2);
        let h = cl.hooks.iter().find(|h| h.event == "PreToolUse").unwrap();
        assert_eq!((h.matcher.as_deref(), h.command.as_str()), (Some("Bash"), "API_KEY=•••• ~/bin/check.sh"));
        let pl = |n: &str| cl.plugins.iter().find(|p| p.name == n).unwrap();
        assert!(pl("fmt").enabled && pl("fmt").version.as_deref() == Some("1.0.0") && pl("fmt").source.as_deref() == Some("official"));
        assert!(!pl("lint").enabled);
        assert!(!pl("extra").enabled && pl("extra").file.ends_with("installed_plugins.json"));
        assert!(cl.files.iter().any(|f| f.label == "Project settings" && !f.exists));

        let cx = &c.codex;
        assert!(cx.errors.is_empty() && cx.plugins.is_empty());
        let docs = cx.mcp.iter().find(|s| s.name == "docs").unwrap();
        assert_eq!(docs.command.as_deref(), Some("docs-mcp --api-key=••••"));
        assert_eq!(docs.env_keys, ["DOCS_KEY"]);
        let web = cx.mcp.iter().find(|s| s.name == "web").unwrap();
        assert!(web.disabled && web.transport == "http");
        assert_eq!(web.url.as_deref(), Some("https://w.com/mcp?access_token=••••"));
        assert_eq!((web.env_keys.clone(), web.header_keys.clone()), (a(&["WEB_TOKEN"]), a(&["X-Api-Key"])));
        assert_eq!(cx.hooks[0].command, "python3 /Users/x/notify.py --token ••••");
        assert_eq!(cx.hooks[0].event, "notify");

        let known = known_files(&home, Some(&proj));
        assert_eq!(known.len(), 7);
        for f in cl.files.iter().chain(&cx.files) {
            assert!(known.contains(&PathBuf::from(&f.path)), "{} not in known_files", f.path);
        }
    }

    #[test]
    fn missing_and_malformed_files() {
        let home = tmp();
        let c = read(&home, None);
        assert!(c.claude.errors.is_empty() && c.codex.errors.is_empty());
        assert!(c.claude.files.iter().all(|f| !f.exists) && c.claude.files.len() == 3);
        write(&home.join(".codex/config.toml"), "model = \"x\"\n\n[mcp_servers.a\ncommand = 1\n");
        write(&home.join(".claude.json"), "{\n  \"mcpServers\": ,\n}");
        let c = read(&home, None);
        assert_eq!(c.codex.errors, ["~/.codex/config.toml: invalid TOML at line 3"]);
        assert_eq!(c.claude.errors, ["~/.claude.json: invalid JSON at line 2"]);
        write(&home.join(".claude/plugins/installed_plugins.json"), r#"{"version": 1, "plugins": {"old@m": {"version": "0.1.0"}}}"#);
        assert_eq!(read(&home, None).claude.plugins[0].version.as_deref(), Some("0.1.0"), "v1 shape");
    }
}
