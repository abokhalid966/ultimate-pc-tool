//! The mini overlay: a small always-on-top window with live CPU, memory, network and temperature.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::settings::SettingsStore;

pub const LABEL: &str = "overlay";
const WIDTH: f64 = 232.0;
const HEIGHT: f64 = 148.0;

pub fn is_shown(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some_and(|w| w.is_visible().unwrap_or(false))
}

/// Shows or closes the overlay and remembers the choice for next time.
pub fn set_shown(app: &AppHandle, show: bool) -> Result<(), String> {
    app.state::<SettingsStore>().update(app, |s| s.overlay = show)?;
    apply(app, show)
}

/// Shows or closes the overlay without saving the choice (used at start-up).
pub fn apply(app: &AppHandle, show: bool) -> Result<(), String> {
    if !show {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.close();
        }
        crate::metrics::set_overlay_visible(false);
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        crate::metrics::set_overlay_visible(true);
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#overlay".into()))
        .title("Optimo overlay")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("Couldn't open the overlay: {e}"))?;
    // Top-right corner of the main screen, unless it was moved somewhere before.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let pos = monitor.position().to_logical::<f64>(scale);
        let _ = window.set_position(tauri::LogicalPosition::new(pos.x + size.width - WIDTH - 24.0, pos.y + 24.0));
    }
    let _ = window.restore_state(StateFlags::POSITION);
    let _ = window.show();
    crate::metrics::set_overlay_visible(true);
    Ok(())
}

#[tauri::command(async)]
pub fn set_overlay(app: AppHandle, show: bool) -> Result<(), String> {
    set_shown(&app, show)
}

#[tauri::command]
pub fn show_main(app: AppHandle) {
    crate::tray::show_main_window(&app);
}
