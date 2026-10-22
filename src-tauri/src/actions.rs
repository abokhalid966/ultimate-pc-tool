//! Activity log of every change the app makes, with undo where possible.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::startup::{self, StartupSource};
use crate::store;

const FILE: &str = "activity.json";
const MAX_ENTRIES: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Undo {
    StartupToggle { source: StartupSource, name: String, enabled: bool },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    pub id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub category: String,
    pub description: String,
    pub undo: Option<Undo>,
    pub undone: bool,
}

#[derive(Default)]
pub struct ActivityLog(Mutex<Option<Vec<ActionRecord>>>);

impl ActivityLog {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<ActionRecord>) -> R) -> R {
        let mut guard = self.0.lock();
        let list = guard.get_or_insert_with(|| store::load(app, FILE).unwrap_or_default());
        f(list)
    }

    pub fn record(&self, app: &AppHandle, category: &str, description: String, undo: Option<Undo>) {
        self.with(app, |list| {
            list.insert(
                0,
                ActionRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    timestamp: chrono::Utc::now(),
                    category: category.into(),
                    description,
                    undo,
                    undone: false,
                },
            );
            list.truncate(MAX_ENTRIES);
            let _ = store::save(app, FILE, list);
        });
    }

    pub fn list(&self, app: &AppHandle) -> Vec<ActionRecord> {
        self.with(app, |list| list.clone())
    }

    pub fn undo(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let record = self.with(app, |list| list.iter().find(|r| r.id == id).cloned());
        let record = record.ok_or("Activity entry not found")?;
        if record.undone {
            return Err("Already undone".into());
        }
        match record.undo.as_ref().ok_or("This action can't be undone")? {
            Undo::StartupToggle { source, name, enabled } => startup::set_enabled(*source, name, *enabled)?,
        }
        self.with(app, |list| {
            if let Some(r) = list.iter_mut().find(|r| r.id == id) {
                r.undone = true;
            }
            let _ = store::save(app, FILE, list);
        });
        Ok(())
    }

    pub fn clear(&self, app: &AppHandle) -> Result<(), String> {
        self.with(app, |list| {
            list.clear();
            store::save(app, FILE, list)
        })
    }
}
