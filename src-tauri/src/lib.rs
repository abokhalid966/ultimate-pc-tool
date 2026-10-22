mod actions;
mod commands;
mod metrics;
mod processes;
mod startup;
mod store;
mod terminal;
mod tray;

use std::sync::Arc;

use tauri::{AppHandle, Manager, State, WindowEvent};

use actions::{ActionRecord, ActivityLog, Undo};
use commands::{CommandLibrary, CommandOutput, SavedCommand, Shell};
use metrics::{Metrics, SharedSnapshot, SystemOverview};
use processes::{Priority, ProcessInfo};
use startup::{StartupItem, StartupSource};
use terminal::Terminals;

// ---- Monitor ----

#[tauri::command]
fn get_overview() -> SystemOverview {
    metrics::overview()
}

#[tauri::command]
fn get_metrics(snapshot: State<SharedSnapshot>) -> Metrics {
    snapshot.read().metrics.clone()
}

// ---- Processes ----

#[tauri::command]
fn list_processes(snapshot: State<SharedSnapshot>) -> Vec<ProcessInfo> {
    snapshot.read().processes.clone()
}

#[tauri::command]
fn kill_process(app: AppHandle, log: State<ActivityLog>, pid: u32, name: String) -> Result<(), String> {
    processes::kill(pid)?;
    log.record(&app, "Processes", format!("Ended {name} (PID {pid})"), None);
    Ok(())
}

#[tauri::command]
fn set_process_priority(
    app: AppHandle,
    log: State<ActivityLog>,
    pid: u32,
    name: String,
    priority: Priority,
) -> Result<(), String> {
    processes::set_priority(pid, priority)?;
    log.record(&app, "Processes", format!("Set {name} (PID {pid}) priority to {priority:?}"), None);
    Ok(())
}

#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    processes::open_file_location(&path)
}

// ---- Commands ----

#[tauri::command]
fn list_commands(app: AppHandle, lib: State<CommandLibrary>) -> Vec<SavedCommand> {
    lib.list(&app)
}

#[tauri::command]
fn save_command(app: AppHandle, lib: State<CommandLibrary>, command: SavedCommand) -> Result<SavedCommand, String> {
    lib.upsert(&app, command)
}

#[tauri::command]
fn delete_command(app: AppHandle, lib: State<CommandLibrary>, id: String) -> Result<(), String> {
    lib.delete(&app, &id)
}

#[tauri::command]
async fn run_command(app: AppHandle, command: String, shell: Shell, admin: bool, label: String) -> Result<CommandOutput, String> {
    let output = tauri::async_runtime::spawn_blocking(move || commands::run(&command, shell, admin))
        .await
        .map_err(|e| e.to_string())??;
    let suffix = if admin { " (as administrator)" } else { "" };
    app.state::<ActivityLog>().record(&app, "Commands", format!("Ran \"{label}\"{suffix}"), None);
    Ok(output)
}

// ---- Terminal ----

#[tauri::command]
fn terminal_spawn(app: AppHandle, terms: State<Terminals>, shell: String, rows: u16, cols: u16) -> Result<u32, String> {
    terms.spawn(app.clone(), &shell, rows, cols)
}

#[tauri::command]
fn terminal_write(terms: State<Terminals>, id: u32, data: String) -> Result<(), String> {
    terms.write(id, &data)
}

#[tauri::command]
fn terminal_resize(terms: State<Terminals>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    terms.resize(id, rows, cols)
}

#[tauri::command]
fn terminal_close(terms: State<Terminals>, id: u32) {
    terms.close(id)
}

// ---- Startup ----

#[tauri::command]
fn list_startup_items() -> Vec<StartupItem> {
    startup::list()
}

#[tauri::command]
fn set_startup_enabled(
    app: AppHandle,
    log: State<ActivityLog>,
    source: StartupSource,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    startup::set_enabled(source, &name, enabled)?;
    let verb = if enabled { "Enabled" } else { "Disabled" };
    log.record(
        &app,
        "Startup",
        format!("{verb} startup app \"{name}\""),
        Some(Undo::StartupToggle { source, name, enabled: !enabled }),
    );
    Ok(())
}

// ---- Activity ----

#[tauri::command]
fn list_activity(app: AppHandle, log: State<ActivityLog>) -> Vec<ActionRecord> {
    log.list(&app)
}

#[tauri::command]
fn undo_activity(app: AppHandle, log: State<ActivityLog>, id: String) -> Result<(), String> {
    log.undo(&app, &id)
}

#[tauri::command]
fn clear_activity(app: AppHandle, log: State<ActivityLog>) -> Result<(), String> {
    log.clear(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let snapshot: SharedSnapshot = Arc::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(snapshot.clone())
        .manage(CommandLibrary::default())
        .manage(ActivityLog::default())
        .manage(Terminals::default())
        .setup(move |app| {
            tray::setup(app.handle())?;
            metrics::start_sampler(app.handle().clone(), snapshot);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep running in the tray when the window is closed.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_overview,
            get_metrics,
            list_processes,
            kill_process,
            set_process_priority,
            open_file_location,
            list_commands,
            save_command,
            delete_command,
            run_command,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_close,
            list_startup_items,
            set_startup_enabled,
            list_activity,
            undo_activity,
            clear_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
