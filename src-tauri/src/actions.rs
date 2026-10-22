//! Activity log of every change the app makes, with undo where possible.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::{CommandLibrary, SavedCommand};
use crate::processes::{self, Priority, Target};
use crate::startup::{self, StartupSource};
use crate::store;

const FILE: &str = "activity.json";
const MAX_ENTRIES: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Undo {
    #[serde(rename_all = "camelCase")]
    StartupToggle { source: StartupSource, name: String, enabled: bool },
    #[serde(rename_all = "camelCase")]
    Priority { pid: u32, start_time: u64, name: String, previous: Priority },
    #[serde(rename_all = "camelCase")]
    RestoreCommand { command: SavedCommand },
    /// Switch back to the power plan that was active before (PC health).
    #[serde(rename_all = "camelCase")]
    PowerPlan { guid: String, name: String },
    /// An entry written by a newer version; kept, but it can't be undone here.
    #[serde(other)]
    Unknown,
}

/// Every field has a default so files written by older or newer versions still load.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ActionRecord {
    pub id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub category: String,
    pub description: String,
    /// Exact command text or other specifics, shown under the description.
    pub detail: Option<String>,
    pub undo: Option<Undo>,
    pub undone: bool,
}

#[derive(Default)]
pub struct ActivityLog(Mutex<Option<Vec<ActionRecord>>>);

impl ActivityLog {
    /// Runs `f` on the loaded log. A file that exists but can't be read is reported, never replaced.
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<ActionRecord>) -> R) -> Result<R, String> {
        let mut guard = self.0.lock();
        if guard.is_none() {
            *guard = Some(store::load(app, FILE)?.unwrap_or_default());
        }
        Ok(f(guard.as_mut().expect("loaded above")))
    }

    /// Adds an entry and returns its id (for an "Undo" button right after the action).
    pub fn record(&self, app: &AppHandle, category: &str, description: String, detail: Option<String>, undo: Option<Undo>) -> Option<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let record = ActionRecord {
            id: id.clone(),
            timestamp: chrono::Utc::now(),
            category: category.into(),
            description,
            detail,
            undo,
            undone: false,
        };
        let saved = self.with(app, |list| {
            list.insert(0, record);
            list.truncate(MAX_ENTRIES);
            store::save(app, FILE, list)
        });
        match saved {
            Ok(Ok(())) => Some(id),
            Ok(Err(e)) | Err(e) => {
                store::notice(app, format!("The activity history couldn't be saved: {e}"));
                None
            }
        }
    }

    pub fn list(&self, app: &AppHandle) -> Result<Vec<ActionRecord>, String> {
        self.with(app, |list| list.clone())
    }

    pub fn undo(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let record = self.with(app, |list| list.iter().find(|r| r.id == id).cloned())?;
        let record = record.ok_or("Activity entry not found")?;
        if record.undone {
            return Err("Already undone".into());
        }
        match record.undo.as_ref().ok_or("This action can't be undone")? {
            Undo::StartupToggle { source, name, enabled } => startup::set_enabled(*source, name, *enabled)?,
            Undo::Priority { pid, start_time, name, previous } => {
                let snapshot = app.state::<crate::metrics::SharedSnapshot>().read().processes.clone();
                let target = Target { pid: *pid, start_time: *start_time };
                processes::set_priority(target, name, *previous, &snapshot)?;
            }
            Undo::RestoreCommand { command } => {
                app.state::<CommandLibrary>().upsert(app, command.clone())?;
            }
            Undo::PowerPlan { guid, .. } => crate::health::set_active_power_plan(guid)?,
            Undo::Unknown => return Err("This action can't be undone".into()),
        }
        self.with(app, |list| {
            if let Some(r) = list.iter_mut().find(|r| r.id == id) {
                r.undone = true;
            }
            store::save(app, FILE, list)
        })?
    }

    pub fn clear(&self, app: &AppHandle) -> Result<(), String> {
        self.with(app, |list| {
            store::save(app, FILE, &Vec::<ActionRecord>::new())?;
            list.clear();
            Ok(())
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerates_unknown_undo_entries_and_missing_fields() {
        let json = r#"[{"id":"1","timestamp":"2025-01-01T00:00:00Z","category":"X","description":"d","undo":{"type":"somethingNew","x":1},"undone":false},
                       {"id":"2","category":"Y","description":"old","undo":null}]"#;
        let list: Vec<ActionRecord> = serde_json::from_str(json).unwrap();
        assert!(matches!(list[0].undo, Some(Undo::Unknown)));
        assert_eq!(list[1].detail, None);
    }

    #[test]
    fn reads_v1_startup_undo() {
        let json = r#"{"type":"startupToggle","source":"userRun","name":"Spotify","enabled":true}"#;
        assert!(matches!(serde_json::from_str::<Undo>(json).unwrap(), Undo::StartupToggle { .. }));
    }
}
