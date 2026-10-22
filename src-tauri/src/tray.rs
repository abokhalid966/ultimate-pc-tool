//! System tray icon with live stats in its tooltip; closing the window can hide it to the tray.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main";

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    crate::metrics::set_ui_visible(true);
}

pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    crate::metrics::set_ui_visible(false);
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Optimo", true, None::<&str>)?;
    let palette = MenuItem::with_id(app, "palette", "Command palette", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "Show or hide the mini overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &palette, &overlay, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon missing"))
        .tooltip("Optimo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "palette" => {
                show_main_window(app);
                let _ = app.emit("app://open-palette", ());
            }
            "overlay" => {
                let _ = crate::overlay::set_shown(app, !crate::overlay::is_shown(app));
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

/// `temperature` is only passed once readings look real (see metrics).
pub fn update_tooltip(app: &AppHandle, cpu: f32, mem_pct: f64, temperature: Option<f32>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let mut text = format!("CPU {cpu:.0}%  ·  RAM {mem_pct:.0}%");
        if let Some(t) = temperature {
            text.push_str(&format!("  ·  {t:.0}°C"));
        }
        let _ = tray.set_tooltip(Some(text));
    }
}
