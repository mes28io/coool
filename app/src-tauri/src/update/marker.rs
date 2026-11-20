//! The note a restart into a new version leaves for the next launch, so that launch can say "Updated to 0.3.2".
//!
//! It is written only after the new bundle was swapped in (so a failed swap never claims success), just before the
//! restart, and taken (read and deleted) once at the next launch. It counts only if the version now running is the
//! one it names and differs from the one it came from: a launch of anything else (the old bundle, a later install)
//! deletes it unseen. A normal launch has no note, so it shows nothing.

use super::Version;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Updated {
    pub from: String,
    pub to: String,
}

/// Leaves the note (whole or not at all: a temporary file renamed into place).
pub fn write(path: &Path, from: &str, to: &str) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&Updated { from: from.into(), to: to.into() })?)?;
    std::fs::rename(&tmp, path)
}

/// Takes the note: what to confirm, if the launch running now (`running`) is the update it announced. The note is
/// gone afterwards either way.
pub fn take(path: &Path, running: &Version) -> Option<Updated> {
    let bytes = std::fs::read(path).ok()?;
    let _ = std::fs::remove_file(path);
    let u: Updated = serde_json::from_slice(&bytes).ok()?;
    let (from, to) = (Version::parse(&u.from)?, Version::parse(&u.to)?);
    (to == *running && from != to).then_some(u)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("coool-marker-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn shown_once_after_the_update() {
        let d = dir("once");
        let p = d.join("coool/updated.json");
        write(&p, "0.3.1", "0.3.2").unwrap();
        assert!(p.is_file(), "written before the restart");
        assert_eq!(take(&p, &v("0.3.2")), Some(Updated { from: "0.3.1".into(), to: "0.3.2".into() }));
        assert!(!p.exists());
        // The launch after: nothing.
        assert_eq!(take(&p, &v("0.3.2")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_normal_launch_shows_nothing() {
        let d = dir("normal");
        assert_eq!(take(&d.join("updated.json"), &v("0.3.1")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn not_shown_when_the_version_didnt_change() {
        let d = dir("same");
        let p = d.join("updated.json");
        // The swap didn't take: the old version opens again. The note is dropped, not kept for later.
        write(&p, "0.3.1", "0.3.2").unwrap();
        assert_eq!(take(&p, &v("0.3.1")), None);
        assert!(!p.exists());
        // A note that names no change.
        write(&p, "0.3.2", "0.3.2").unwrap();
        assert_eq!(take(&p, &v("0.3.2")), None);
        // A later version opens (installed some other way): not this update's confirmation.
        write(&p, "0.3.1", "0.3.2").unwrap();
        assert_eq!(take(&p, &v("0.3.3")), None);
        // Garbage.
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(take(&p, &v("0.3.2")), None);
        assert!(!p.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
