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

/// When to show a Windows notification. A limit of 0 turns that alert off.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct AlertSettings {
    pub enabled: bool,
    /// Processor busier than this for two minutes.
    pub cpu_percent: u8,
    /// Memory fuller than this for two minutes.
    pub memory_percent: u8,
    /// Hotter than this (°C) for half a minute.
    pub temperature: u8,
    /// A drive with less free space than this.
    pub disk_free_percent: u8,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self { enabled: true, cpu_percent: 90, memory_percent: 90, temperature: 90, disk_free_percent: 10 }
    }
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `None` until the user chooses; the app asks the first time the window is closed.
    pub close_action: Option<CloseAction>,
    pub alerts: AlertSettings,
    /// The always-on-top mini overlay with live stats.
    pub overlay: bool,
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

    pub fn alerts(&self) -> AlertSettings {
        self.0.lock().alerts.clone()
    }

    /// Changes and saves the settings; nothing changes if saving fails.
    pub fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut settings = self.0.lock();
        let mut next = settings.clone();
        f(&mut next);
        store::save(app, FILE, &next)?;
        *settings = next;
        Ok(())
    }

    pub fn set_close_action(&self, app: &AppHandle, action: Option<CloseAction>) -> Result<(), String> {
        self.update(app, |s| s.close_action = action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_files_get_default_alerts() {
        let s: Settings = serde_json::from_str(r#"{"closeAction":"tray"}"#).unwrap();
        assert_eq!(s.close_action, Some(CloseAction::Tray));
        assert_eq!(s.alerts, AlertSettings::default());
        assert!(!s.overlay);
    }
}
