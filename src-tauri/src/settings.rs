//! App preferences, saved as settings.json.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::store;

const FILE: &str = "settings.json";

/// What the window's close button does.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CloseAction {
    /// Hide the window and keep running in the system tray.
    Tray,
    Quit,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `None` until the user chooses; the app asks the first time the window is closed.
    pub close_action: Option<CloseAction>,
}

#[derive(Default)]
pub struct SettingsStore(Mutex<Settings>);

impl SettingsStore {
    pub fn load(app: &AppHandle) -> Self {
        let settings = store::load(app, FILE).unwrap_or_else(|e| {
            store::notice(app, e);
            None
        });
        Self(Mutex::new(settings.unwrap_or_default()))
    }

    pub fn get(&self) -> Settings {
        self.0.lock().clone()
    }

    pub fn set_close_action(&self, app: &AppHandle, action: Option<CloseAction>) -> Result<(), String> {
        let mut settings = self.0.lock();
        let mut next = settings.clone();
        next.close_action = action;
        store::save(app, FILE, &next)?;
        *settings = next;
        Ok(())
    }
}
