//! Tiny JSON-file persistence in the app's data folder (%APPDATA%\com.abokhalid.ultimatepctool).

use std::fs;
use std::path::PathBuf;

use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

pub fn load<T: DeserializeOwned>(app: &AppHandle, file: &str) -> Option<T> {
    let text = fs::read_to_string(path(app, file).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
    let target = path(app, file)?;
    let tmp = target.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Write then rename so a crash never leaves a half-written file.
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}
