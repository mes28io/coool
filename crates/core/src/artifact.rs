//! Claude Code "artifacts": HTML pages a session publishes to claude.ai with its
//! `Artifact` tool. A publish call names a local page (`file_path`) and the
//! supporting files it references (`files`: published path -> local path); its
//! result says where the page now lives:
//!
//! ```text
//! Published <file_path> at https://claude.ai/artifact/<id> (Version 3, version id …) Icon: "wrench".
//! ```
//!
//! Other actions of the same tool (`quickstart`, `list`, `read`, asset uploads,
//! a create from a `type_url`) are not pages and stay ordinary steps.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

/// One published version of an artifact. Publishes with the same `url` are
/// versions of one artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactInfo {
    /// `https://claude.ai/artifact/<id>`.
    pub url: String,
    /// The version this publish made (1, 2, …), when the result says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// The local page that was published.
    pub file_path: String,
    /// Supporting files: the path the page references (relative) -> local path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// One generic word for the page's icon ("wrench", "chart", …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// From the result, else the page's `<title>`, else the file name.
    pub title: String,
}

/// Bytes of a page read to find its `<title>`.
const TITLE_SCAN: u64 = 16 * 1024;

/// A tool call that publishes a page: `Artifact` with a local `file_path`,
/// and no other action (publish is the default).
pub fn is_publish(name: &str, input: &Value) -> bool {
    name == "Artifact"
        && input["file_path"].as_str().is_some_and(|p| !p.is_empty())
        && input["action"].as_str().is_none_or(|a| a == "publish")
        && input["asset"].as_bool() != Some(true)
}

/// What a publish call made, from its input and its result (`text`, and the
/// transcript's structured `toolUseResult` when there is one). `None` when the
/// result is not a successful publish to claude.ai.
pub fn from_publish(input: &Value, text: &str, structured: &Value) -> Option<ArtifactInfo> {
    let file_path = input["file_path"].as_str()?.to_string();
    let line = text.lines().find(|l| l.trim_start().starts_with("Published "))?;
    let url = structured["url"]
        .as_str()
        .map(str::to_string)
        .or_else(|| line.split(" at ").nth(1)?.split_whitespace().next().map(|u| u.trim_end_matches(['.', ',', ')']).to_string()))
        .filter(|u| valid_url(u))?;
    let version = structured["seq"]
        .as_u64()
        .map(|n| n as u32)
        .or_else(|| line.split("(Version ").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok());
    let icon = structured["icon"]
        .as_str()
        .map(str::to_string)
        .or_else(|| Some(line.split("Icon: \"").nth(1)?.split('"').next()?.to_string()))
        .or_else(|| input["icon"].as_str().map(str::to_string))
        .filter(|w| !w.is_empty() && w.len() <= 40);
    let files = input["files"]
        .as_object()
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), local_of(v)?))).collect())
        .unwrap_or_default();
    let title = structured["title"]
        .as_str()
        .or(input["title"].as_str())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| html_title(Path::new(&file_path)))
        .unwrap_or_else(|| Path::new(&file_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file_path.clone()));
    Some(ArtifactInfo { url, version, file_path, files, icon, title })
}

/// A `files` value: a local path, or `{ "from": path, … }`. Copies from
/// another artifact (`{ "artifact": … }`) have no local file.
fn local_of(v: &Value) -> Option<String> {
    v.as_str().or(v["from"].as_str()).filter(|p| !p.is_empty()).map(str::to_string)
}

/// Only claude.ai artifact links are kept (the app opens them in the browser).
pub fn valid_url(u: &str) -> bool {
    u.strip_prefix("https://claude.ai/").is_some_and(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace))
}

/// The `<title>` in the first [`TITLE_SCAN`] bytes of a local page, if it is there.
pub fn html_title(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut buf = Vec::new();
    f.take(TITLE_SCAN).read_to_end(&mut buf).ok()?;
    let s = String::from_utf8_lossy(&buf);
    let lower = s.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let t = crate::util::one_line(&decode_entities(&s[start..end]), 200);
    (!t.is_empty()).then_some(t)
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_page_publishes_count() {
        assert!(is_publish("Artifact", &json!({ "file_path": "/x/a.html" })));
        assert!(is_publish("Artifact", &json!({ "file_path": "/x/a.html", "action": "publish", "url": "https://claude.ai/artifact/a" })));
        assert!(!is_publish("Artifact", &json!({ "action": "quickstart", "intent": "other" })));
        assert!(!is_publish("Artifact", &json!({ "action": "read", "url": "https://claude.ai/artifact/a" })));
        assert!(!is_publish("Artifact", &json!({ "action": "list" })));
        assert!(!is_publish("Artifact", &json!({ "file_path": "/x/a.png", "asset": true, "url": "https://claude.ai/artifact/a" })));
        assert!(!is_publish("Write", &json!({ "file_path": "/x/a.html" })));
    }

    #[test]
    fn result_text_alone_is_enough() {
        let input = json!({ "file_path": "/nonexistent/dir/page.html", "files": { "img/a.jpg": "/nonexistent/a.jpg", "b.css": { "from": "/nonexistent/b.css" }, "c.js": { "artifact": "https://claude.ai/artifact/z", "path": "c.js" } } });
        let text = "Published /nonexistent/dir/page.html at https://claude.ai/artifact/AbC123 (Version 3, version id 99-aa) Icon: \"chart\".\n\nMore lines.";
        let a = from_publish(&input, text, &Value::Null).unwrap();
        assert_eq!(a.url, "https://claude.ai/artifact/AbC123");
        assert_eq!(a.version, Some(3));
        assert_eq!(a.icon.as_deref(), Some("chart"));
        assert_eq!(a.title, "page.html", "no result title, no local file: the file name");
        assert_eq!(a.files.len(), 2, "a copy from another artifact has no local file");
        assert_eq!(a.files["img/a.jpg"], "/nonexistent/a.jpg");
        assert_eq!(a.files["b.css"], "/nonexistent/b.css");
    }

    #[test]
    fn errors_and_other_hosts_are_not_artifacts() {
        let input = json!({ "file_path": "/x/a.html" });
        assert!(from_publish(&input, "Error: file not found", &Value::Null).is_none());
        assert!(from_publish(&input, "Published /x/a.html at https://evil.example/artifact/a (Version 1)", &Value::Null).is_none());
    }

    #[test]
    fn title_from_the_page_when_the_result_has_none() {
        let dir = std::env::temp_dir().join(format!("coool-artifact-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("page.html");
        std::fs::write(&p, "<!doctype html><html><head><TITLE>Sensor &amp; fix\n guide</TITLE></head></html>").unwrap();
        let input = json!({ "file_path": p.to_string_lossy() });
        let a = from_publish(&input, "Published x at https://claude.ai/artifact/q (Version 1, version id 1)", &Value::Null).unwrap();
        assert_eq!(a.title, "Sensor & fix guide");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
