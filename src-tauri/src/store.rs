//! Tiny JSON-file persistence in the app's data folder (%APPDATA%\com.abokhalid.ultimatepctool).
//!
//! A file that can't be parsed is never overwritten silently: it is kept under a new name, the
//! last good copy (`<name>.bak`) is used if there is one, and the user is told what happened.

use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Emitter, Manager};

/// Tells the UI that new notices are waiting (it then calls `take_notices`).
pub const NOTICE_EVENT: &str = "app://notice";

static NOTICES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Queues a message for the user, shown as a toast.
pub fn notice(app: &AppHandle, text: String) {
    NOTICES.lock().push(text);
    let _ = app.emit(NOTICE_EVENT, ());
}

pub fn take_notices() -> Vec<String> {
    std::mem::take(&mut *NOTICES.lock())
}

fn path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

fn backup_path(target: &Path) -> PathBuf {
    target.with_extension("json.bak")
}

/// `Ok(None)` means the file doesn't exist yet (first run). Read errors (e.g. the file is locked by
/// antivirus) are returned as `Err` so the caller doesn't replace data it couldn't read.
pub fn load<T: DeserializeOwned>(app: &AppHandle, file: &str) -> Result<Option<T>, String> {
    let target = path(app, file)?;
    let text = match fs::read_to_string(&target) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Couldn't read {file}: {e}")),
    };
    let error = match serde_json::from_str(&text) {
        Ok(value) => return Ok(Some(value)),
        Err(e) => e,
    };

    // Keep the damaged file for the user (or for a later fix), then fall back to the last good copy.
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let kept = target.with_file_name(format!("{stem}.corrupt-{stamp}.json"));
    fs::rename(&target, &kept).map_err(|e| format!("{file} is damaged ({error}) and couldn't be set aside: {e}"))?;
    let kept_name = kept.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

    let restored = fs::read_to_string(backup_path(&target))
        .ok()
        .and_then(|text| serde_json::from_str::<T>(&text).ok());
    match restored {
        Some(value) => {
            notice(app, format!("{file} was damaged, so the last good copy was restored. The damaged file was kept as {kept_name}."));
            // Put the good copy back in place so the next start doesn't repeat this.
            let _ = fs::copy(backup_path(&target), &target);
            Ok(Some(value))
        }
        None => {
            notice(app, format!("{file} couldn't be read, so it was reset. A copy was kept as {kept_name}."));
            Ok(None)
        }
    }
}

pub fn save<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
    let target = path(app, file)?;
    let tmp = target.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Write and flush to disk, then rename, so a crash or power loss never leaves a half-written file.
    let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    // One previous generation always survives as `.bak`.
    if target.exists() {
        let _ = fs::copy(&target, backup_path(&target));
    }
    fs::rename(&tmp, &target).map_err(|e| format!("Couldn't save {file}: {e}"))
}
