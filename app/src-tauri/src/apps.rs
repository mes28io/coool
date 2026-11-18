//! Settings > General > "Open files and folders in": the editors installed on this Mac, and opening a path with the
//! chosen one (the palette's "Open … in …", Connections' "Open file"). "System default" is plain `open`: Finder for
//! a folder, the file's default app for a file.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Apps coool knows how to hand a path to: (id, name, bundle id, the .app's usual names).
const KNOWN: &[(&str, &str, &str, &[&str])] = &[
    ("vscode", "VS Code", "com.microsoft.VSCode", &["Visual Studio Code.app"]),
    ("cursor", "Cursor", "com.todesktop.230313mzl4w4u92", &["Cursor.app"]),
    ("windsurf", "Windsurf", "com.exafunction.windsurf", &["Windsurf.app"]),
    ("zed", "Zed", "dev.zed.Zed", &["Zed.app"]),
    ("xcode", "Xcode", "com.apple.dt.Xcode", &["Xcode.app", "Xcode-beta.app"]),
    ("sublime", "Sublime Text", "com.sublimetext.4", &["Sublime Text.app"]),
    ("nova", "Nova", "com.panic.Nova", &["Nova.app"]),
    ("intellij", "IntelliJ IDEA", "com.jetbrains.intellij", &["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"]),
    ("webstorm", "WebStorm", "com.jetbrains.WebStorm", &["WebStorm.app"]),
    ("fleet", "Fleet", "com.jetbrains.fleet", &["Fleet.app"]),
    ("terminal", "Terminal", "com.apple.Terminal", &["Utilities/Terminal.app"]),
    ("iterm", "iTerm", "com.googlecode.iterm2", &["iTerm.app"]),
    ("ghostty", "Ghostty", "com.mitchellh.ghostty", &["Ghostty.app"]),
    ("warp", "Warp", "dev.warp.Warp-Stable", &["Warp.app"]),
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct App {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Where apps are installed: /Applications, /System/Applications and ~/Applications.
fn roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/Applications"), PathBuf::from("/System/Applications")];
    if let Some(h) = home {
        v.push(h.join("Applications"));
    }
    v
}

/// The known apps found under `roots`, in [`KNOWN`] order.
pub fn find_in(roots: &[PathBuf]) -> Vec<App> {
    KNOWN
        .iter()
        .filter_map(|(id, name, _, files)| {
            let path = roots.iter().flat_map(|r| files.iter().map(move |f| r.join(f))).find(|p| p.join("Contents/Info.plist").is_file())?;
            Some(App { id: id.to_string(), name: name.to_string(), path: path.to_string_lossy().into_owned() })
        })
        .collect()
}

pub fn installed() -> Vec<App> {
    find_in(&roots(dirs::home_dir().as_deref()))
}

/// The `open` arguments for `path` with app `id` ("system" or unknown/uninstalled: the system default).
pub fn open_args(id: &str, path: &str, apps: &[App]) -> Vec<String> {
    match apps.iter().find(|a| a.id == id) {
        Some(a) => vec!["-a".into(), a.path.clone(), path.into()],
        None => vec![path.into()],
    }
}

/// Opens `path` (which must exist) with app `id`.
pub fn open(id: &str, path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("{path} doesn't exist"));
    }
    let st = std::process::Command::new("open").args(open_args(id, path, &installed())).status().map_err(|e| e.to_string())?;
    if st.success() { Ok(()) } else { Err(format!("macOS couldn't open {path}")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_real_bundles() {
        let d = std::env::temp_dir().join(format!("coool-apps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Cursor.app/Contents")).unwrap();
        std::fs::write(d.join("Cursor.app/Contents/Info.plist"), "<plist/>").unwrap();
        // A folder named like an app but with no Info.plist is not an app.
        std::fs::create_dir_all(d.join("Zed.app")).unwrap();
        std::fs::create_dir_all(d.join("Xcode-beta.app/Contents")).unwrap();
        std::fs::write(d.join("Xcode-beta.app/Contents/Info.plist"), "<plist/>").unwrap();
        let found = find_in(std::slice::from_ref(&d));
        assert_eq!(found.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["cursor", "xcode"]);
        assert_eq!(found[1].name, "Xcode");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn open_arguments() {
        let apps = vec![App { id: "vscode".into(), name: "VS Code".into(), path: "/Applications/Visual Studio Code.app".into() }];
        assert_eq!(open_args("vscode", "/p", &apps), ["-a", "/Applications/Visual Studio Code.app", "/p"]);
        assert_eq!(open_args("system", "/p", &apps), ["/p"]);
        // Chosen once, uninstalled since: the system default.
        assert_eq!(open_args("cursor", "/p", &apps), ["/p"]);
    }
}
