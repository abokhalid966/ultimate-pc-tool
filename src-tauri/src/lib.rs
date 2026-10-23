mod actions;
mod alerts;
mod apps;
mod automations;
mod autostart;
mod boost;
mod cleanup;
mod clipboard;
mod commands;
mod drivers;
mod gpu;
mod health;
mod metrics;
mod network;
mod os;
mod overlay;
mod privacy;
mod processes;
mod ps;
mod services;
mod settings;
mod specs;
mod startup;
mod storage;
mod store;
mod terminal;
mod tray;
mod winget;

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use actions::{ActionRecord, ActivityLog, Undo};
use cleanup::CleanReport;
use commands::{CommandLibrary, CommandOutput, RunEvent, Runs, SavedCommand, Shell};
use metrics::{Metrics, OverviewCache, SharedSnapshot, SystemOverview};
use processes::{KillSummary, Priority, PriorityChange, ProcessDetails, ProcessInfo, Target};
use settings::{CloseAction, Settings, SettingsStore};
use startup::{StartupItem, StartupSource};
use terminal::{TermEvent, Terminals};

/// Runs blocking work on the blocking thread pool, keeping the UI thread and async workers free.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---- App ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    elevated: bool,
    version: String,
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo { elevated: os::is_elevated(), version: app.package_info().version.to_string() }
}

/// Starts a new copy of the app as administrator, then quits this one.
#[tauri::command]
async fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    blocking(|| {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // The new copy waits for this one to exit, so the single-instance check lets it start.
        match os::run_elevated(&exe, &format!("{WAIT_FOR_PID_ARG}{}", std::process::id())) {
            Ok(()) => Ok(()),
            Err(os::ElevateError::Cancelled) => Err("You chose No on the administrator prompt, so the app keeps running as before.".into()),
            Err(os::ElevateError::Failed(e)) => Err(format!("Couldn't restart as administrator: {e}")),
        }
    })
    .await?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn take_notices() -> Vec<String> {
    store::take_notices()
}

#[tauri::command]
fn get_settings(settings: State<SettingsStore>) -> Settings {
    settings.get()
}

#[tauri::command(async)]
fn set_alerts(app: AppHandle, settings: State<SettingsStore>, alerts: settings::AlertSettings) -> Result<(), String> {
    settings.update(&app, |s| s.alerts = alerts)
}

#[tauri::command(async)]
fn set_close_action(app: AppHandle, settings: State<SettingsStore>, action: Option<CloseAction>) -> Result<(), String> {
    settings.set_close_action(&app, action)
}

/// Answer to the "close the window?" question shown the first time the window is closed.
#[tauri::command(async)]
fn close_main_window(app: AppHandle, settings: State<SettingsStore>, action: CloseAction, remember: bool) -> Result<(), String> {
    if remember {
        settings.set_close_action(&app, Some(action))?;
    }
    match action {
        CloseAction::Tray => tray::hide_main_window(&app),
        CloseAction::Quit => app.exit(0),
    }
    Ok(())
}

// ---- Monitor ----

#[tauri::command(async)]
fn get_overview(cache: State<OverviewCache>) -> SystemOverview {
    cache.get()
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

#[tauri::command(async)]
fn get_process_details(pid: u32, start_time: u64) -> Result<ProcessDetails, String> {
    processes::details(Target { pid, start_time })
}

/// Ends one or more processes of the same app and records one activity entry.
#[tauri::command]
async fn kill_processes(app: AppHandle, name: String, targets: Vec<Target>) -> Result<KillSummary, String> {
    let shared = app.state::<SharedSnapshot>().inner().clone();
    let snapshot = shared.read().processes.clone();
    let task_app = app.clone();
    let summary = blocking(move || {
        let summary = processes::kill_many(&targets, &name, &snapshot);
        if summary.ended > 0 {
            let what = if summary.ended == 1 { name } else { format!("{name} ({} processes)", summary.ended) };
            task_app.state::<ActivityLog>().record(&task_app, "Processes", format!("Ended {what}"), None, None);
        }
        Ok(summary)
    })
    .await?;
    // Drop ended processes from the cached list now rather than on the next sample.
    shared.write().processes.retain(|p| !summary.gone.contains(&(p.pid, p.start_time)));
    Ok(summary)
}

#[tauri::command(async)]
fn set_process_priority(
    app: AppHandle,
    snapshot: State<SharedSnapshot>,
    log: State<ActivityLog>,
    pid: u32,
    start_time: u64,
    name: String,
    priority: Priority,
) -> Result<PriorityChange, String> {
    if priority == Priority::Realtime {
        return Err("Realtime priority can freeze your PC, so Optimo doesn't offer it.".into());
    }
    let processes = snapshot.read().processes.clone();
    let change = processes::set_priority(Target { pid, start_time }, &name, priority, &processes)?;
    let applied = change.applied.unwrap_or(priority);
    let undo = change
        .previous
        .filter(|previous| *previous != applied)
        .map(|previous| Undo::Priority { pid, start_time, name: name.clone(), previous });
    log.record(&app, "Processes", format!("Set {name} (PID {pid}) priority to {}", applied.label()), None, undo);
    Ok(change)
}

#[tauri::command(async)]
fn open_file_location(path: String) -> Result<(), String> {
    processes::open_file_location(&path)
}

// ---- Commands ----

#[tauri::command(async)]
fn list_commands(app: AppHandle, lib: State<CommandLibrary>) -> Result<Vec<SavedCommand>, String> {
    lib.list(&app)
}

#[tauri::command(async)]
fn save_command(app: AppHandle, lib: State<CommandLibrary>, command: SavedCommand) -> Result<SavedCommand, String> {
    lib.upsert(&app, command)
}

/// Deletes a command and returns the activity entry id, so the UI can offer Undo.
#[tauri::command(async)]
fn delete_command(app: AppHandle, lib: State<CommandLibrary>, log: State<ActivityLog>, id: String) -> Result<Option<String>, String> {
    let removed = lib.delete(&app, &id)?;
    let description = format!("Deleted command \"{}\"", removed.name);
    Ok(log.record(&app, "Commands", description, Some(removed.command.clone()), Some(Undo::RestoreCommand { command: removed })))
}

#[tauri::command(async)]
fn restore_builtin_commands(app: AppHandle, lib: State<CommandLibrary>) -> Result<usize, String> {
    lib.restore_builtins(&app)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_command(
    app: AppHandle,
    run_id: String,
    command: String,
    shell: Shell,
    admin: bool,
    label: String,
    on_event: Channel<RunEvent>,
) -> Result<CommandOutput, String> {
    blocking(move || {
        let output = commands::run(&app.state::<Runs>(), &run_id, &command, shell, admin, on_event)?;
        // Logged with the exact text that ran, so the history shows what was actually done.
        let suffix = if admin { " (as administrator)" } else { "" };
        let detail = Some(format!("{}: {command}", shell.label()));
        app.state::<ActivityLog>().record(&app, "Commands", format!("Ran \"{label}\"{suffix}"), detail, None);
        Ok(output)
    })
    .await
}

#[tauri::command]
fn cancel_command(runs: State<Runs>, run_id: String) {
    runs.cancel(&run_id);
}

#[tauri::command]
async fn clean_temp(app: AppHandle, dry_run: bool) -> Result<CleanReport, String> {
    blocking(move || {
        let report = cleanup::clean_temp(dry_run)?;
        if !dry_run && report.files > 0 {
            let description = format!("Cleaned temp files: {} files, {} MB freed", report.files, report.bytes / (1024 * 1024));
            app.state::<ActivityLog>().record(&app, "Cleanup", description, Some(report.folder.clone()), None);
        }
        Ok(report)
    })
    .await
}

// ---- Terminal ----

#[tauri::command]
async fn terminal_spawn(app: AppHandle, shell: String, rows: u16, cols: u16, on_event: Channel<TermEvent>) -> Result<u32, String> {
    blocking(move || app.state::<Terminals>().spawn(app.clone(), &shell, rows, cols, on_event)).await
}

// Write and resize stay synchronous so keystrokes are delivered in order.
#[tauri::command]
fn terminal_write(terms: State<Terminals>, id: u32, data: String) -> Result<(), String> {
    terms.write(id, &data)
}

#[tauri::command]
fn terminal_resize(terms: State<Terminals>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    terms.resize(id, rows, cols)
}

#[tauri::command]
async fn terminal_close(app: AppHandle, id: u32) -> Result<(), String> {
    blocking(move || {
        app.state::<Terminals>().close(id);
        Ok(())
    })
    .await
}

// ---- Startup ----

#[tauri::command(async)]
fn list_startup_items() -> Vec<StartupItem> {
    startup::list()
}

#[tauri::command(async)]
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
        None,
        Some(Undo::StartupToggle { source, name, enabled: !enabled }),
    );
    Ok(())
}

// ---- Activity ----

#[tauri::command(async)]
fn list_activity(app: AppHandle, log: State<ActivityLog>) -> Result<Vec<ActionRecord>, String> {
    log.list(&app)
}

#[tauri::command(async)]
fn undo_activity(app: AppHandle, log: State<ActivityLog>, id: String) -> Result<(), String> {
    log.undo(&app, &id)
}

#[tauri::command(async)]
fn clear_activity(app: AppHandle, log: State<ActivityLog>) -> Result<(), String> {
    log.clear(&app)
}

/// Passed to the elevated copy started by "Restart as administrator".
const WAIT_FOR_PID_ARG: &str = "--wait-for-pid=";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started by "Restart as administrator": let the old copy exit first.
    if let Some(pid) = std::env::args().find_map(|a| a.strip_prefix(WAIT_FOR_PID_ARG).and_then(|p| p.parse().ok())) {
        os::wait_for_exit(pid, std::time::Duration::from_secs(20));
    }

    let snapshot: SharedSnapshot = Arc::default();

    tauri::Builder::default()
        // First, so a second launch just brings this window back instead of starting another copy.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| tray::show_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        clipboard::toggle_picker(app);
                    }
                })
                .build(),
        )
        // Remembers where the windows were. Showing or hiding stays with the app (tray, --minimized).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .manage(snapshot.clone())
        .manage(automations::Automations::default())
        .manage(boost::Boost::default())
        .manage(storage::Scans::default())
        .manage(storage::Dupes::default())
        .manage(clipboard::Clipboard::default())
        .manage(CommandLibrary::default())
        .manage(ActivityLog::default())
        .manage(Terminals::default())
        .manage(Runs::default())
        .manage(OverviewCache::default())
        .setup(move |app| {
            // Paint the window in the theme's base color until the page draws, instead of white.
            if let Some(window) = app.get_webview_window("main") {
                let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
                let base = if dark { tauri::window::Color(31, 31, 31, 255) } else { tauri::window::Color(240, 240, 240, 255) };
                let _ = window.set_background_color(Some(base));
            }
            app.manage(SettingsStore::load(app.handle()));
            tray::setup(app.handle())?;
            // Started by Windows at sign-in: stay in the tray.
            if autostart::started_minimized() {
                metrics::set_ui_visible(false);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            metrics::start_sampler(app.handle().clone(), snapshot);
            if app.state::<SettingsStore>().get().overlay
                && let Err(e) = overlay::apply(app.handle(), true)
            {
                store::notice(app.handle(), e);
            }
            automations::start_scheduler(app.handle().clone());
            clipboard::start(app.handle().clone());
            if app.state::<SettingsStore>().get().clipboard.shortcut
                && let Err(e) = clipboard::set_shortcut(app.handle(), true)
            {
                store::notice(app.handle(), e);
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                handle.state::<OverviewCache>().get();
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // A reload (F5) starts a fresh page that knows nothing about the old shells.
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                webview.app_handle().state::<Terminals>().close_all();
            }
        })
        .on_window_event(|window, event| {
            if window.label() == overlay::LABEL {
                if let WindowEvent::Destroyed = event {
                    metrics::set_overlay_visible(false);
                }
                return;
            }
            if window.label() == clipboard::PICKER {
                if let WindowEvent::Focused(false) = event {
                    clipboard::hide_picker(window.app_handle());
                }
                return;
            }
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    match app.state::<SettingsStore>().get().close_action {
                        Some(CloseAction::Quit) => app.exit(0),
                        Some(CloseAction::Tray) => {
                            api.prevent_close();
                            tray::hide_main_window(app);
                        }
                        None => {
                            // Ask once, explaining the tray, so the app never seems to vanish.
                            api.prevent_close();
                            let _ = window.emit("app://close-requested", ());
                        }
                    }
                }
                WindowEvent::Focused(true) => metrics::set_ui_visible(true),
                WindowEvent::Resized(_) => {
                    let minimized = window.is_minimized().unwrap_or(false);
                    metrics::set_ui_visible(!minimized && window.is_visible().unwrap_or(true));
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            restart_as_admin,
            take_notices,
            get_settings,
            set_close_action,
            set_alerts,
            specs::get_specs,
            privacy::list_privacy_tweaks,
            privacy::set_privacy_tweaks,
            privacy::list_bloat_apps,
            privacy::remove_bloat_apps,
            boost::get_boost,
            boost::set_boost_settings,
            boost::start_boost,
            boost::stop_boost,
            network::get_network_info,
            network::get_public_info,
            network::network_speed_test,
            network::network_cancel_speed_test,
            network::network_connections,
            network::network_set_dns,
            network::network_dns_benchmark,
            autostart::get_autostart,
            autostart::set_autostart,
            overlay::set_overlay,
            overlay::show_main,
            automations::list_automations,
            automations::save_automation,
            automations::set_automation_enabled,
            automations::delete_automation,
            automations::run_automation,
            close_main_window,
            get_overview,
            get_metrics,
            list_processes,
            get_process_details,
            kill_processes,
            set_process_priority,
            open_file_location,
            list_commands,
            save_command,
            delete_command,
            restore_builtin_commands,
            run_command,
            cancel_command,
            clean_temp,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_close,
            list_startup_items,
            set_startup_enabled,
            services::list_services,
            services::get_service,
            services::get_service_details,
            services::control_service,
            services::set_service_startup,
            list_activity,
            undo_activity,
            clear_activity,
            health::run_health_check,
            health::set_power_plan,
            health::restart_pc,
            health::open_windows_settings,
            apps::list_installed_apps,
            apps::uninstall_app,
            apps::app_still_installed,
            apps::open_app_folder,
            winget::winget_list_upgrades,
            winget::winget_list_installed,
            winget::winget_run,
            winget::open_app_installer_page,
            storage::storage_cleanup_scan,
            storage::storage_cleanup_run,
            storage::storage_scan,
            storage::storage_cancel_scan,
            storage::storage_folder,
            storage::storage_check_delete,
            storage::storage_delete,
            storage::storage_reveal,
            storage::storage_pick_folder,
            storage::dupes::storage_find_duplicates,
            storage::dupes::storage_cancel_duplicates,
            storage::dupes::storage_delete_duplicates,
            drivers::get_drivers,
            clipboard::clipboard_list,
            clipboard::clipboard_copy,
            clipboard::clipboard_paste,
            clipboard::clipboard_pin,
            clipboard::clipboard_delete,
            clipboard::clipboard_clear,
            clipboard::set_clipboard_settings,
            clipboard::clipboard_hide_picker,
            drivers::open_driver_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
