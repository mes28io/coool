//! Project files in the Browser panel (APP_SPEC "Agent browser tools"): `browser_navigate` (and `tabs new`, a batch's
//! `navigate`, the pilot's `url`) given the path of a file in the chat's project folder opens it over http from a small
//! read-only server coool runs on 127.0.0.1, so an agent can look at a page it just changed without starting a server
//! of its own. The panel itself still loads http(s) only.
//!
//! - One listener, on a random port, started on first use; one random token per project folder, the first segment of
//!   every URL (`http://127.0.0.1:<port>/<token>/index.html`), so another process on this Mac can't guess a URL.
//! - Only files under that folder are served: the path is resolved (symlinks too) and refused when it leads outside.
//!   A folder serves its `index.html`. GET and HEAD only; `Cache-Control: no-store`, so a reload shows the file as it
//!   is now.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

struct Server {
    port: u16,
    /// token -> project folder (canonical).
    roots: Mutex<HashMap<String, PathBuf>>,
}

static SERVER: OnceLock<Result<Server, String>> = OnceLock::new();

fn server() -> Result<&'static Server, String> {
    SERVER
        .get_or_init(|| {
            let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("couldn't serve project files: {e}"))?;
            let port = l.local_addr().map_err(|e| e.to_string())?.port();
            std::thread::Builder::new()
                .name("coool project files".into())
                .spawn(move || {
                    for s in l.incoming().flatten() {
                        let _ = std::thread::Builder::new().name("coool project file".into()).spawn(move || serve(s));
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(Server { port, roots: Mutex::new(HashMap::new()) })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Whether the agent's `url` names a local file rather than a page: an absolute path, `~/…`, a `file://` URL, or a
/// relative path that exists in `cwd`.
pub fn is_local(raw: &str, cwd: Option<&str>) -> bool {
    let t = raw.trim();
    t.starts_with('/') || t.starts_with("~/") || t.starts_with("file://") || cwd.is_some_and(|c| !t.is_empty() && !t.contains("://") && Path::new(c).join(t.split(['?', '#']).next().unwrap_or(t)).exists())
}

/// The local file `raw` names, resolved against `cwd` (a relative path, `~/`, `file://`).
fn local_path(raw: &str, cwd: &str) -> PathBuf {
    let t = raw.trim();
    let t = t.split(['?', '#']).next().unwrap_or(t);
    if let Some(rest) = t.strip_prefix("file://") {
        return PathBuf::from(decode(rest.strip_prefix("localhost").unwrap_or(rest)));
    }
    if let Some(rest) = t.strip_prefix("~/")
        && let Some(h) = dirs::home_dir()
    {
        return h.join(rest);
    }
    Path::new(cwd).join(t)
}

/// The http URL for local file `raw` of the chat whose project folder is `cwd`. Refused outside that folder.
pub fn url_for(raw: &str, cwd: &str) -> Result<String, String> {
    let root = Path::new(cwd).canonicalize().map_err(|e| format!("the chat's folder {cwd}: {e}"))?;
    let file = local_path(raw, cwd);
    let real = file.canonicalize().map_err(|_| format!("no such file: {}", file.display()))?;
    if !real.starts_with(&root) {
        return Err(format!("only files in this chat's project folder ({}) open in the panel, not {}", root.display(), real.display()));
    }
    let s = server()?;
    let token = {
        let mut roots = s.roots.lock().unwrap();
        match roots.iter().find(|(_, r)| **r == root) {
            Some((t, _)) => t.clone(),
            None => {
                let t = super::mcp::random_token();
                roots.insert(t.clone(), root.clone());
                t
            }
        }
    };
    let rel = real.strip_prefix(&root).unwrap_or(Path::new(""));
    let mut path: Vec<String> = rel.components().map(|c| encode(&c.as_os_str().to_string_lossy())).collect();
    if real.is_dir() {
        path.push(String::new());
    }
    Ok(format!("http://127.0.0.1:{}/{token}/{}", s.port, path.join("/")))
}

fn encode(seg: &str) -> String {
    seg.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The file a request path names (`/<token>/<rest>`), if it may be served.
fn resolve(target: &str, roots: &HashMap<String, PathBuf>) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next()?;
    let rest = path.strip_prefix('/')?;
    let (token, rel) = rest.split_once('/').unwrap_or((rest, ""));
    let root = roots.get(token)?;
    let rel = decode(rel);
    if rel.split('/').any(|s| s == "..") || rel.contains('\0') {
        return None;
    }
    let mut p = root.join(rel.trim_start_matches('/')).canonicalize().ok()?;
    if !p.starts_with(root) {
        return None;
    }
    if p.is_dir() {
        p = p.join("index.html").canonicalize().ok()?;
        if !p.starts_with(root) {
            return None;
        }
    }
    p.is_file().then_some(p)
}

fn serve(s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(c) = s.try_clone() else { return };
    let mut r = BufReader::new(c);
    let mut first = String::new();
    if r.read_line(&mut first).is_err() {
        return;
    }
    // The headers (ignored), up to 16 KB.
    let mut seen = 0;
    loop {
        let mut l = String::new();
        match r.read_line(&mut l) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                seen += n;
                if l == "\r\n" || l == "\n" || seen > 16 * 1024 {
                    break;
                }
            }
        }
    }
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut out = s;
    if method != "GET" && method != "HEAD" {
        let _ = out.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let file = server().ok().and_then(|srv| resolve(target, &srv.roots.lock().unwrap()));
    match file.and_then(|f| std::fs::read(&f).ok().map(|b| (f, b))) {
        Some((f, body)) => {
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", mime(&f), body.len());
            let _ = out.write_all(head.as_bytes());
            if method == "GET" {
                let _ = out.write_all(&body);
            }
        }
        None => {
            let _ = out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn get(url: &str) -> (String, String) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut b = String::new();
        s.read_to_string(&mut b).unwrap();
        let (h, body) = b.split_once("\r\n\r\n").unwrap();
        (h.lines().next().unwrap().to_string(), body.to_string())
    }

    #[test]
    fn serves_only_the_project_folder() {
        let tmp = std::env::temp_dir().join(format!("coool-files-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");
        std::fs::create_dir_all(proj.join("sub dir")).unwrap();
        std::fs::write(proj.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(proj.join("sub dir/a.css"), "h1{}").unwrap();
        std::fs::write(tmp.join("secret.txt"), "no").unwrap();
        std::os::unix::fs::symlink(tmp.join("secret.txt"), proj.join("link.txt")).unwrap();
        let cwd = proj.to_str().unwrap();

        assert!(is_local("index.html", Some(cwd)) && is_local("/x/y.html", None) && is_local("file:///x", None));
        assert!(!is_local("example.com", Some(cwd)) && !is_local("http://localhost:3000", Some(cwd)) && !is_local("missing.html", Some(cwd)));

        let u = url_for("index.html", cwd).unwrap();
        assert!(u.starts_with("http://127.0.0.1:") && u.ends_with("/index.html"), "{u}");
        let token = u.split('/').nth(3).unwrap().to_string();
        assert_eq!(token.len(), 32);
        assert_eq!(get(&u), ("HTTP/1.1 200 OK".into(), "<h1>hi</h1>".into()));
        // The same folder keeps its token; an absolute path and a file:// URL work too.
        assert_eq!(url_for(&format!("{cwd}/index.html"), cwd).unwrap(), u);
        assert_eq!(url_for(&format!("file://{cwd}/index.html"), cwd).unwrap(), u);
        // A folder serves its index.html; a relative link resolves under the token.
        assert_eq!(get(&url_for(".", cwd).unwrap()).1, "<h1>hi</h1>");
        assert_eq!(get(&u.replace("index.html", "sub%20dir/a.css")).1, "h1{}");
        // Outside the folder: refused when asked for, and 404 when tried by path or through a symlink.
        assert!(url_for(tmp.join("secret.txt").to_str().unwrap(), cwd).is_err());
        assert!(url_for("link.txt", cwd).is_err());
        for bad in ["../secret.txt", "%2e%2e/secret.txt", "link.txt", "sub%20dir/../../secret.txt"] {
            assert_eq!(get(&u.replace("index.html", bad)).0, "HTTP/1.1 404 Not Found", "{bad}");
        }
        // A wrong token finds nothing.
        assert_eq!(get(&u.replace(&token, "0123456789abcdef0123456789abcdef")).0, "HTTP/1.1 404 Not Found");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
