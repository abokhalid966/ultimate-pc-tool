//! System tray icon with live stats in its tooltip; closing the window hides to tray.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::metrics::Metrics;

const TRAY_ID: &str = "main";

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Ultimate PC Tool", true, None::<&str>)?;
    let palette = MenuItem::with_id(app, "palette", "Command palette", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &palette, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon missing"))
        .tooltip("Ultimate PC Tool")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "palette" => {
                show_main_window(app);
                let _ = app.emit("app://open-palette", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn update_tooltip(app: &AppHandle, m: &Metrics) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let mem_pct = if m.mem_total > 0 { m.mem_used as f64 / m.mem_total as f64 * 100.0 } else { 0.0 };
        let mut text = format!("CPU {:.0}%  ·  RAM {:.0}%", m.cpu_total, mem_pct);
        if let Some(hottest) = m.temps.iter().map(|t| t.celsius).reduce(f32::max) {
            text.push_str(&format!("  ·  {hottest:.0}°C"));
        }
        let _ = tray.set_tooltip(Some(text));
    }
}
