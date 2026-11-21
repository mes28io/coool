//! Claude Platform: Claude Code chats billed to an Anthropic API key (a Claude Console / Platform key) instead of the
//! person's Claude subscription. See docs/APP_SPEC.md, "Claude Platform".
//!
//! - Keys live in the macOS Keychain only, one generic-password item each (`coool-platform-key-<id>`, account
//!   `coool`, stored through `security -i` on stdin exactly as Assist's key is, so the secret is never in argv).
//!   Assist's own key (`coool-anthropic-api-key`) is offered as one more choice ([`ASSIST_ID`]), never copied.
//! - [`Store`] (a small JSON file in the app's data folder) holds only what is safe to show: each key's id, name and
//!   last four characters, the per-folder defaults, and which account each chat's session ran on (so a resume keeps
//!   it). A key itself is never logged, serialized, persisted outside the Keychain or put into an error string.
//! - A chat's [`crate::chat::ChatOptions::account`] names the key by id. The process that spawns the CLI (the app, or
//!   the chat host for a hosted chat) reads the key from the Keychain right then ([`key`]) and hands it to the CLI in
//!   its environment ([`KEY_ENV`]), with the variables that would make it use another login removed
//!   ([`OTHER_AUTH`]). Nothing crosses the host's socket but the id.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The account id of Assist's key (Settings > Assist), offered as one of the choices.
pub const ASSIST_ID: &str = "assist";
/// What the page sends for "the subscription" when it chose explicitly (as opposed to "use the default").
pub const SUBSCRIPTION: &str = "subscription";
/// The variable Claude Code reads the key from. In print mode (`claude -p`, how coool runs chats) the CLI uses it
/// without the interactive "use this API key?" approval (observed in Claude Code 2.1.330: non-interactive sessions
/// take `ANTHROPIC_API_KEY` as the key source, ahead of the claude.ai login).
pub const KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Variables removed from an API-key chat's environment: other credentials and providers the CLI would prefer or
/// combine with the key, so the bill lands on the chosen key.
pub const OTHER_AUTH: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
];
const SERVICE_PREFIX: &str = "coool-platform-key-";
const NAME_MAX: usize = 40;
/// Debug builds only: every key lookup answers this invented key, and saving accepts only it (nothing reaches the
/// Keychain), so end-to-end tests run without touching the person's Keychain.
const TEST_KEY_ENV: &str = "COOOL_PLATFORM_TEST_KEY";

/// One stored key, as the page sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyMeta {
    pub id: String,
    pub name: String,
    /// The key's last four characters (to tell keys apart; never more).
    pub last4: String,
    pub added_ms: u64,
}

/// What the page lists: the stored keys, Assist's key when there is one, and the folder defaults.
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub keys: Vec<Choice>,
    pub folders: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub id: String,
    pub name: String,
    /// None for Assist's key (its value isn't read to list it).
    pub last4: Option<String>,
    /// Assist's key: removed or replaced in Settings > Assist, not here.
    pub assist: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub keys: Vec<KeyMeta>,
    /// Folder (absolute path) -> account id. A folder's default covers its subfolders (the nearest one wins).
    #[serde(default)]
    pub folders: BTreeMap<String, String>,
    /// Session id -> account id, for the sessions API-key chats ran: a resume and a restart keep the account.
    #[serde(default)]
    pub sessions: BTreeMap<String, String>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The last four characters of a key (what the page may show).
pub fn last4(key: &str) -> String {
    let k: Vec<char> = key.trim().chars().collect();
    k[k.len().saturating_sub(4)..].iter().collect()
}

/// Checks a pasted key without saying any of it back.
pub fn validate(key: &str) -> Result<()> {
    let k = key.trim();
    if k.is_empty() {
        bail!("paste an API key first");
    }
    if k.starts_with("sk-ant-admin") {
        bail!("that is an Admin API key; Claude Code needs a regular API key from the Claude Console");
    }
    if !k.starts_with("sk-ant-") || k.len() < 20 {
        bail!("that doesn't look like an Anthropic API key (they start with sk-ant-)");
    }
    if !crate::insights::keychain_safe(k) {
        bail!("that doesn't look like an Anthropic API key (unexpected characters)");
    }
    Ok(())
}

fn clean_name(name: &str) -> Result<String> {
    let n: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NAME_MAX).collect();
    let n = n.trim().to_string();
    if n.is_empty() {
        bail!("give the key a name (e.g. Work)");
    }
    Ok(n)
}

fn service(id: &str) -> String {
    format!("{SERVICE_PREFIX}{id}")
}

fn test_key() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(TEST_KEY_ENV).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

fn new_id() -> String {
    crate::chat::uuid_v4().replace('-', "")[..12].to_string()
}

#[cfg(target_os = "macos")]
fn keychain_set(id: &str, key: &str) -> Result<()> {
    if let Some(t) = test_key() {
        if t != key {
            bail!("this test build only takes its test key");
        }
        return Ok(());
    }
    crate::insights::keychain_set_in(&service(id), key)
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(_id: &str, _key: &str) -> Result<()> {
    bail!("API keys are stored in the macOS Keychain; this needs macOS")
}

#[cfg(target_os = "macos")]
fn keychain_delete(id: &str) -> Result<()> {
    if test_key().is_some() {
        return Ok(());
    }
    crate::insights::keychain_delete_in(&service(id))
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete(_id: &str) -> Result<()> {
    Ok(())
}

/// The key for account `id`, read from the Keychain now (by the process about to start the CLI). The error never
/// contains the key.
pub fn key(id: &str) -> Result<String> {
    if let Some(t) = test_key() {
        return Ok(t);
    }
    if id == ASSIST_ID {
        return crate::insights::api_key().ok_or_else(|| anyhow::anyhow!("Assist's API key is gone (Settings > Assist); pick another account for this chat"));
    }
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        bail!("unknown API key");
    }
    #[cfg(target_os = "macos")]
    if let Some(k) = crate::insights::keychain_get_in(&service(id)) {
        return Ok(k);
    }
    bail!("the API key for this chat is no longer in the Keychain (Settings > Claude Platform); pick another account")
}

/// The environment an API-key chat's CLI gets on top of coool's own (see [`OTHER_AUTH`] for what is removed).
pub fn env_for(id: &str) -> Result<Vec<(String, String)>> {
    Ok(vec![(KEY_ENV.to_string(), key(id)?)])
}

impl Store {
    /// Reads `path` (a missing or unreadable file is an empty store).
    pub fn load(path: &Path) -> Self {
        let mut s: Store = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        s.path = Some(path.to_path_buf());
        s
    }

    fn save(&self) -> Result<()> {
        let Some(p) = &self.path else { return Ok(()) };
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, p)?;
        Ok(())
    }

    pub fn status(&self) -> Status {
        let mut keys: Vec<Choice> = self.keys.iter().map(|k| Choice { id: k.id.clone(), name: k.name.clone(), last4: Some(k.last4.clone()), assist: false }).collect();
        if crate::insights::has_api_key() || test_key().is_some() {
            keys.push(Choice { id: ASSIST_ID.into(), name: "Assist key".into(), last4: None, assist: true });
        }
        Status { keys, folders: self.folders.clone() }
    }

    /// Whether `id` names a key coool can use (a stored one, or Assist's while it has one).
    pub fn knows(&self, id: &str) -> bool {
        self.keys.iter().any(|k| k.id == id) || (id == ASSIST_ID && (crate::insights::has_api_key() || test_key().is_some()))
    }

    /// Stores `key` in the Keychain under a new id; only its name and last four are kept here.
    pub fn add(&mut self, name: &str, key: &str) -> Result<KeyMeta> {
        let name = clean_name(name)?;
        let key = key.trim();
        validate(key)?;
        if self.keys.iter().any(|k| k.name.eq_ignore_ascii_case(&name)) {
            bail!("there is already a key named {name}");
        }
        let id = new_id();
        keychain_set(&id, key)?;
        let meta = KeyMeta { id, name, last4: last4(key), added_ms: now_ms() };
        self.keys.push(meta.clone());
        if let Err(e) = self.save() {
            let _ = keychain_delete(&meta.id);
            self.keys.retain(|k| k.id != meta.id);
            return Err(e);
        }
        Ok(meta)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        let name = clean_name(name)?;
        if self.keys.iter().any(|k| k.id != id && k.name.eq_ignore_ascii_case(&name)) {
            bail!("there is already a key named {name}");
        }
        let k = self.keys.iter_mut().find(|k| k.id == id).ok_or_else(|| anyhow::anyhow!("no such key"))?;
        k.name = name;
        self.save()
    }

    /// Removes a stored key from the Keychain and the folders that defaulted to it (they go back to the subscription).
    /// Chats running on it keep running; a later restart or resume of one says the key is gone.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        if id == ASSIST_ID {
            bail!("Assist's key is removed in Settings > Assist");
        }
        if !self.keys.iter().any(|k| k.id == id) {
            bail!("no such key");
        }
        keychain_delete(id)?;
        self.keys.retain(|k| k.id != id);
        self.folders.retain(|_, a| a != id);
        self.save()
    }

    /// Sets (Some) or clears (None, or [`SUBSCRIPTION`]) the default account of `folder`.
    pub fn set_folder(&mut self, folder: &str, account: Option<&str>) -> Result<()> {
        let folder = folder.trim_end_matches('/');
        if folder.is_empty() {
            bail!("no folder");
        }
        match account.filter(|a| *a != SUBSCRIPTION) {
            Some(a) if !self.knows(a) => bail!("no such key"),
            Some(a) => {
                self.folders.insert(folder.to_string(), a.to_string());
            }
            None => {
                self.folders.remove(folder);
            }
        }
        self.save()
    }

    /// The default account for a chat in `cwd`: the nearest folder (itself or a parent) with one. None: the subscription.
    pub fn folder_default(&self, cwd: &str) -> Option<String> {
        let mut p = Some(Path::new(cwd));
        while let Some(d) = p {
            if let Some(a) = d.to_str().and_then(|s| self.folders.get(s.trim_end_matches('/'))) {
                return self.knows(a).then(|| a.clone());
            }
            p = d.parent();
        }
        None
    }

    /// The account a chat starting with `requested` (the page's choice: None = the default, [`SUBSCRIPTION`], or an
    /// id) in `cwd`, resuming `resume`, runs on. None: the subscription.
    pub fn resolve(&self, requested: Option<&str>, cwd: &str, resume: Option<&str>) -> Result<Option<String>> {
        match requested {
            Some(SUBSCRIPTION) | Some("") => Ok(None),
            Some(id) if self.knows(id) => Ok(Some(id.to_string())),
            Some(_) => bail!("that API key is no longer in Settings > Claude Platform"),
            None => {
                if let Some(sid) = resume.filter(|s| !s.is_empty()) {
                    // A resumed session keeps the account it ran on (the subscription when coool never ran it on a key).
                    return Ok(self.sessions.get(sid).filter(|a| self.knows(a)).cloned());
                }
                Ok(self.folder_default(cwd))
            }
        }
    }

    /// Records the account session `sid` ran on (None: the subscription). Returns whether anything changed.
    pub fn note_session(&mut self, sid: &str, account: Option<&str>) -> bool {
        if sid.is_empty() || self.sessions.get(sid).map(String::as_str) == account {
            return false;
        }
        match account {
            Some(a) => self.sessions.insert(sid.to_string(), a.to_string()),
            None => self.sessions.remove(sid),
        };
        let _ = self.save();
        true
    }

    pub fn session_account(&self, sid: &str) -> Option<&str> {
        self.sessions.get(sid).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let mut s = Store::default();
        s.keys.push(KeyMeta { id: "aaa111".into(), name: "Work".into(), last4: "TEST".into(), added_ms: 0 });
        s.keys.push(KeyMeta { id: "bbb222".into(), name: "Client X".into(), last4: "WXYZ".into(), added_ms: 0 });
        s
    }

    #[test]
    fn last4_and_validation_say_nothing_more() {
        assert_eq!(last4(" sk-ant-api03-TESTTESTTEST "), "TEST");
        assert_eq!(last4("ab"), "ab");
        assert!(validate("sk-ant-api03-TESTTESTTEST").is_ok());
        for bad in ["", "sk-ant-api03-a\"b-cdefghijklmn", "sk-ant-admin01-TESTTESTTESTTEST", "sk-proj-TESTTESTTESTTEST", "sk-ant-short"] {
            let e = validate(bad).unwrap_err().to_string();
            assert!(!e.contains("TEST") && !e.contains("cdef"), "{e}");
        }
    }

    #[test]
    fn folder_defaults_cover_subfolders_and_resolve_follows_the_choice() {
        let mut s = store();
        s.folders.insert("/work/acme".into(), "aaa111".into());
        s.folders.insert("/work/acme/client".into(), "bbb222".into());
        s.folders.insert("/work/gone".into(), "zzz999".into());
        assert_eq!(s.folder_default("/work/acme").as_deref(), Some("aaa111"));
        assert_eq!(s.folder_default("/work/acme/app/src").as_deref(), Some("aaa111"));
        assert_eq!(s.folder_default("/work/acme/client/web").as_deref(), Some("bbb222"));
        assert_eq!(s.folder_default("/work/other"), None);
        assert_eq!(s.folder_default("/work/gone/x"), None, "a key that was removed isn't a default");

        assert_eq!(s.resolve(None, "/work/acme/app", None).unwrap().as_deref(), Some("aaa111"));
        assert_eq!(s.resolve(Some(SUBSCRIPTION), "/work/acme/app", None).unwrap(), None);
        assert_eq!(s.resolve(Some("bbb222"), "/elsewhere", None).unwrap().as_deref(), Some("bbb222"));
        assert!(s.resolve(Some("nope"), "/elsewhere", None).is_err());
        // A resume keeps the session's own account, whatever the folder says.
        s.sessions.insert("sid-1".into(), "bbb222".into());
        assert_eq!(s.resolve(None, "/work/acme", Some("sid-1")).unwrap().as_deref(), Some("bbb222"));
        assert_eq!(s.resolve(None, "/work/acme", Some("sid-sub")).unwrap(), None, "a session coool ran on the subscription stays there");
    }

    #[test]
    fn the_store_file_holds_names_never_keys() {
        let d = std::env::temp_dir().join(format!("coool-platform-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("platform.json");
        let mut s = Store::load(&p);
        s.keys = store().keys;
        s.set_folder("/work/acme/", Some("aaa111")).unwrap();
        assert!(s.set_folder("/work/x", Some("nope")).is_err());
        assert!(s.note_session("sid-1", Some("aaa111")));
        assert!(!s.note_session("sid-1", Some("aaa111")));
        s.rename("bbb222", "  Client\nY ").unwrap();
        assert!(s.rename("bbb222", "work").is_err(), "names are unique");
        let back = Store::load(&p);
        assert_eq!(back.folders.get("/work/acme").map(String::as_str), Some("aaa111"));
        assert_eq!(back.session_account("sid-1"), Some("aaa111"));
        assert_eq!(back.keys[1].name, "Client Y");
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("sk-ant"), "{text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        s.set_folder("/work/acme", None).unwrap();
        assert!(Store::load(&p).folders.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_key_errors_without_the_key() {
        if test_key().is_some() {
            return;
        }
        let e = key("doesnotexist000").unwrap_err().to_string();
        assert!(e.contains("Keychain"), "{e}");
        assert!(key("../evil").is_err());
    }

    /// Round trip through the real login Keychain on a throwaway item with an invented key (never a real one); the item
    /// is deleted at the end. `cargo test -p coool-core platform -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the login Keychain"]
    fn keychain_round_trip_on_a_test_item() {
        let d = std::env::temp_dir().join(format!("coool-platform-kc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mut s = Store::load(&d.join("platform.json"));
        let m = s.add("Test only", "sk-ant-api03-TESTTESTTEST").unwrap();
        assert_eq!(m.last4, "TEST");
        assert!(crate::insights::keychain_has_in(&service(&m.id)));
        assert_eq!(key(&m.id).unwrap(), "sk-ant-api03-TESTTESTTEST");
        assert_eq!(env_for(&m.id).unwrap(), vec![(KEY_ENV.to_string(), "sk-ant-api03-TESTTESTTEST".to_string())]);
        s.remove(&m.id).unwrap();
        assert!(!crate::insights::keychain_has_in(&service(&m.id)));
        assert!(key(&m.id).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
