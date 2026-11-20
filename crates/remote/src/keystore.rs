//! Where the Mac's private keys live.
//!
//! [`Keychain`]: the macOS login Keychain, one generic password of coool's own (service [`KEYCHAIN_SERVICE`],
//! account `coool`), through `/usr/bin/security` as crates/core/src/insights.rs does it: the secret goes to
//! `security -i` on stdin, never on a command line, and the item stays one `security` created, so reading it back
//! never raises a Keychain prompt for an unsigned, rebuilt app. The known weakness of that pattern (it applies
//! here too): the item's access list trusts `/usr/bin/security`, so any process running as the person can read it
//! with `security find-generic-password -w` without a prompt. That attacker is outside the threat model (docs/REMOTE.md:
//! "an attacker who already runs code as the user on the Mac"). Nothing here reads any other Keychain item.
//!
//! [`FileStore`]: a file (mode 0600), only for self-tests (kept in their throwaway folder, never the Keychain).
//! [`MemStore`]: in memory, for unit tests.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use std::sync::Mutex;
use zeroize::Zeroizing;

pub const KEYCHAIN_SERVICE: &str = "coool-remote-identity";
const KEYCHAIN_ACCOUNT: &str = "coool";

pub trait KeyStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>>;
    fn save(&self, secret: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

pub struct Keychain;

/// What `security -i` can take inside double quotes (the exported identity is base64url and dots).
fn safe(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

#[cfg(target_os = "macos")]
impl KeyStore for Keychain {
    fn load(&self) -> Result<Option<Zeroizing<String>>> {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .context("could not run /usr/bin/security")?;
        // Exit 44: no such item.
        if out.status.code() == Some(44) {
            return Ok(None);
        }
        if !out.status.success() {
            bail!("the Keychain refused to read coool's Remote keys (security exited with {})", out.status.code().unwrap_or(-1));
        }
        let s = Zeroizing::new(String::from_utf8(out.stdout).context("Keychain item is not text")?);
        let t = s.trim();
        Ok((!t.is_empty()).then(|| Zeroizing::new(t.to_string())))
    }

    fn save(&self, secret: &str) -> Result<()> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        if !safe(secret) {
            bail!("unexpected characters in the key");
        }
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("could not run /usr/bin/security")?;
        {
            let mut stdin = child.stdin.take().context("security stdin")?;
            let line = Zeroizing::new(format!("add-generic-password -U -a {KEYCHAIN_ACCOUNT} -s {KEYCHAIN_SERVICE} -l \"coool Remote identity\" -w \"{secret}\"\n"));
            stdin.write_all(line.as_bytes()).context("could not talk to /usr/bin/security")?;
        }
        child.wait().context("could not run /usr/bin/security")?;
        // `security -i` exits 0 even when a command fails: read it back.
        if self.load()?.as_deref().map(|s| s.as_str()) != Some(secret) {
            bail!("the Keychain refused to store coool's Remote keys");
        }
        Ok(())
    }

    fn delete(&self) -> Result<()> {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE])
            .stdin(std::process::Stdio::null())
            .output()
            .context("could not run /usr/bin/security")?;
        if !out.status.success() && out.status.code() != Some(44) {
            bail!("the Keychain refused to delete coool's Remote keys");
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
impl KeyStore for Keychain {
    fn load(&self) -> Result<Option<Zeroizing<String>>> {
        bail!("coool Remote keeps its keys in the macOS Keychain")
    }
    fn save(&self, _: &str) -> Result<()> {
        bail!("coool Remote keeps its keys in the macOS Keychain")
    }
    fn delete(&self) -> Result<()> {
        Ok(())
    }
}

/// Self-tests only: the key in a file of their own folder.
pub struct FileStore(pub PathBuf);

impl KeyStore for FileStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>> {
        match std::fs::read_to_string(&self.0) {
            Ok(s) => Ok(Some(Zeroizing::new(s.trim().to_string()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn save(&self, secret: &str) -> Result<()> {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        o.mode(0o600);
        o.open(&self.0)?.write_all(secret.as_bytes())?;
        Ok(())
    }
    fn delete(&self) -> Result<()> {
        match std::fs::remove_file(&self.0) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

#[derive(Default)]
pub struct MemStore(pub Mutex<Option<String>>);

impl KeyStore for MemStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>> {
        Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn save(&self, secret: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
