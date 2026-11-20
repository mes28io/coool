//! Chat attachments (images and files in the composer, and their previews): the app's commands around
//! `coool_core::attach`.
//!
//! What may be read:
//! - `attach_paths` / `attach_bytes`: files the person dropped, picked or pasted (their choice).
//! - `attach_image`: an image by key, only from coool's own store, or from the transcript of the named session
//!   (found through the hub, never a path the page gives).
//! - `attach_preview`: a file the person clicked (a file chip, or an image path an agent mentioned). Text comes back as
//!   text, an image or a PDF as a `data:` URL; nothing is run, and the page shows it without loading anything else.
//!   `images_only` (paths taken from what an agent wrote) refuses anything but PNG / JPEG / GIF / WebP.
//! - `attach_reveal`: shows a file in Finder (`open -R`), never opens it.

use crate::{Core, Res, err};
use coool_core::attach::{self, Attachment, Preview};
use coool_core::model::Provider;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

fn store() -> Res<PathBuf> {
    attach::store_dir().ok_or_else(|| "no folder for attachments".to_string())
}

/// One dropped or picked path: the attachment, or why it can't be added.
#[derive(Serialize)]
pub struct Added {
    pub path: String,
    pub name: String,
    pub attachment: Option<Attachment>,
    pub error: Option<String>,
}

#[tauri::command(async)]
pub fn attach_paths(paths: Vec<String>) -> Res<Vec<Added>> {
    let dir = store()?;
    Ok(paths
        .into_iter()
        .take(attach::MAX_COUNT * 4)
        .map(|p| {
            let path = PathBuf::from(&p);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
            match attach::inspect_path(&dir, &path) {
                Ok(a) => Added { path: p, name, attachment: Some(a), error: None },
                Err(e) => Added { path: p, name, attachment: None, error: Some(format!("{e:#}")) },
            }
        })
        .collect())
}

/// Pasted content (base64): a clipboard image, or a file the page only got as bytes.
#[tauri::command(async)]
pub fn attach_bytes(name: String, data: String) -> Res<Attachment> {
    use base64::Engine;
    if data.len() as u64 > attach::MAX_STORED_BYTES / 3 * 4 + 16 {
        return Err(format!("too large: pasted files can be up to {} MB", attach::MAX_STORED_BYTES / 1024 / 1024));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "couldn't read the pasted data".to_string())?;
    attach::store_bytes(&store()?, &name, &bytes).map_err(|e| format!("{e:#}"))
}

/// An image by key as a `data:` URL: from coool's store, else from that session's transcript.
#[tauri::command(async)]
pub fn attach_image(core: State<'_, Arc<Core>>, key: String, provider: Option<Provider>, session: Option<String>) -> Res<String> {
    use base64::Engine;
    if !attach::valid_key(&key) {
        return Err("not an image key".into());
    }
    let dir = store()?;
    let found = attach::stored(&dir, &key).or_else(|| {
        let (p, s) = (provider?, session?);
        let t = core.hub.lock().unwrap().transcript_path(p, &s, None)?;
        attach::image_from_transcript(&dir, &t, &key)
    });
    let (p, mime) = found.ok_or("the image isn't available any more")?;
    let b = std::fs::read(p).map_err(err)?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(p),
    }
}

/// A preview of a file the person clicked (see the module comment).
#[tauri::command(async)]
pub fn attach_preview(path: String, images_only: Option<bool>) -> Res<Preview> {
    let p = expand(&path);
    if !p.is_absolute() {
        return Err("not a full path".into());
    }
    attach::preview(&p, images_only.unwrap_or(false)).map_err(|e| format!("{e:#}"))
}

/// Shows a file in Finder.
#[tauri::command(async)]
pub fn attach_reveal(path: String) -> Res<()> {
    let p = expand(&path);
    if !p.is_absolute() || !Path::new(&p).exists() {
        return Err("the file is gone (moved or deleted?)".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).status().map_err(err)?;
    Ok(())
}
