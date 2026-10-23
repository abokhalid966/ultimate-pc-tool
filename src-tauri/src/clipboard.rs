//! Clipboard history: remembers text you copy (while Optimo runs) and pastes it again, from the
//! Clipboard page or the quick picker (Ctrl+Shift+V). Pinned items are saved; the rest is kept
//! only in memory. Text that password managers mark as private is never recorded.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::settings::SettingsStore;
use crate::store;

const FILE: &str = "clipboard.json";
const MAX_ITEMS: usize = 300;
/// Longer text (a whole log file, say) isn't kept.
const MAX_CHARS: usize = 200_000;
pub const CHANGED_EVENT: &str = "clipboard://changed";
pub const PICKER: &str = "clip";
pub const SHORTCUT: &str = "CommandOrControl+Shift+V";
const PICKER_W: f64 = 440.0;
const PICKER_H: f64 = 480.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    pub text: String,
    /// Unix milliseconds of the latest copy.
    pub at: i64,
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct ClipboardSettings {
    /// Record what's copied.
    pub enabled: bool,
    /// Ctrl+Shift+V opens the quick picker.
    pub shortcut: bool,
}

impl Default for ClipboardSettings {
    fn default() -> Self {
        Self { enabled: true, shortcut: true }
    }
}

#[derive(Default)]
pub struct Clipboard {
    items: Mutex<Option<Vec<ClipItem>>>,
    /// The window that had focus before the picker opened; the paste goes there.
    previous: AtomicIsize,
}

impl Clipboard {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<ClipItem>) -> R) -> R {
        let mut guard = self.items.lock();
        let list = guard.get_or_insert_with(|| store::load::<Vec<ClipItem>>(app, FILE).ok().flatten().unwrap_or_default());
        f(list)
    }

    fn save_pinned(app: &AppHandle, list: &[ClipItem]) {
        let pinned: Vec<&ClipItem> = list.iter().filter(|i| i.pinned).collect();
        if let Err(e) = store::save(app, FILE, &pinned) {
            store::notice(app, format!("Pinned clipboard items couldn't be saved: {e}"));
        }
    }
}

/// Adds copied text to the top, or moves an identical item there.
fn add(list: &mut Vec<ClipItem>, text: String, now: i64) -> bool {
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        return false;
    }
    if let Some(pos) = list.iter().position(|i| i.text == text) {
        let mut item = list.remove(pos);
        item.at = now;
        list.insert(0, item);
    } else {
        list.insert(0, ClipItem { id: uuid::Uuid::new_v4().to_string(), text, at: now, pinned: false });
    }
    // Drop the oldest unpinned items beyond the limit.
    let mut unpinned = 0;
    list.retain(|i| {
        if i.pinned {
            return true;
        }
        unpinned += 1;
        unpinned <= MAX_ITEMS
    });
    true
}

/// Watches the clipboard for new text on a background thread.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            if !app.state::<SettingsStore>().get().clipboard.enabled {
                continue;
            }
            let seq = win::sequence();
            if seq == last {
                continue;
            }
            last = seq;
            if let Some(text) = win::read_text() {
                let changed = app.state::<Clipboard>().with(&app, |list| add(list, text, chrono::Utc::now().timestamp_millis()));
                if changed {
                    let _ = app.emit(CHANGED_EVENT, ());
                }
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardInfo {
    pub settings: ClipboardSettings,
    pub items: Vec<ClipItem>,
}

#[tauri::command]
pub fn clipboard_list(app: AppHandle, clip: State<Clipboard>, settings: State<SettingsStore>) -> ClipboardInfo {
    ClipboardInfo { settings: settings.get().clipboard, items: clip.with(&app, |l| l.clone()) }
}

fn text_of(app: &AppHandle, id: &str) -> Result<String, String> {
    app.state::<Clipboard>().with(app, |l| l.iter().find(|i| i.id == id).map(|i| i.text.clone())).ok_or_else(|| "That item is no longer in the history.".into())
}

/// Puts an item back on the clipboard, ready for Ctrl+V.
#[tauri::command(async)]
pub fn clipboard_copy(app: AppHandle, id: String) -> Result<(), String> {
    win::write_text(&text_of(&app, &id)?)
}

/// From the picker: copies the item, closes the picker and pastes into the app that was in front.
#[tauri::command(async)]
pub fn clipboard_paste(app: AppHandle, id: String) -> Result<(), String> {
    win::write_text(&text_of(&app, &id)?)?;
    hide_picker(&app);
    let previous = app.state::<Clipboard>().previous.load(Ordering::SeqCst);
    win::paste_into(previous);
    Ok(())
}

#[tauri::command]
pub fn clipboard_pin(app: AppHandle, clip: State<Clipboard>, id: String, pinned: bool) {
    clip.with(&app, |l| {
        if let Some(item) = l.iter_mut().find(|i| i.id == id) {
            item.pinned = pinned;
        }
        Clipboard::save_pinned(&app, l);
    });
    let _ = app.emit(CHANGED_EVENT, ());
}

#[tauri::command]
pub fn clipboard_delete(app: AppHandle, clip: State<Clipboard>, id: String) {
    clip.with(&app, |l| {
        let was_pinned = l.iter().any(|i| i.id == id && i.pinned);
        l.retain(|i| i.id != id);
        if was_pinned {
            Clipboard::save_pinned(&app, l);
        }
    });
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Clears everything except pinned items.
#[tauri::command]
pub fn clipboard_clear(app: AppHandle, clip: State<Clipboard>) {
    clip.with(&app, |l| l.retain(|i| i.pinned));
    let _ = app.emit(CHANGED_EVENT, ());
}

#[tauri::command]
pub fn set_clipboard_settings(app: AppHandle, settings: State<SettingsStore>, value: ClipboardSettings) -> Result<(), String> {
    let shortcut = value.shortcut;
    settings.update(&app, |s| s.clipboard = value)?;
    set_shortcut(&app, shortcut)
}

/// Registers or removes Ctrl+Shift+V.
pub fn set_shortcut(app: &AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let registered = gs.is_registered(SHORTCUT);
    if on && !registered {
        gs.register(SHORTCUT).map_err(|_| "Ctrl+Shift+V is already used by another app, so the quick picker can't use it.".to_string())?;
    } else if !on && registered {
        let _ = gs.unregister(SHORTCUT);
    }
    Ok(())
}

/// Opens the picker next to the mouse pointer, or closes it if it's open.
pub fn toggle_picker(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PICKER)
        && w.is_visible().unwrap_or(false)
    {
        hide_picker(app);
        return;
    }
    app.state::<Clipboard>().previous.store(win::foreground(), Ordering::SeqCst);
    let window = match app.get_webview_window(PICKER) {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(app, PICKER, WebviewUrl::App("index.html#clip".into()))
            .title("Optimo clipboard")
            .inner_size(PICKER_W, PICKER_H)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                store::notice(app, format!("Couldn't open the clipboard picker: {e}"));
                return;
            }
        },
    };
    if let (Some((x, y)), Ok(Some(monitor))) = (win::cursor(), window.current_monitor()) {
        // Near the pointer, kept inside the screen it's on.
        let scale = monitor.scale_factor();
        let (mx, my) = (monitor.position().x as f64 / scale, monitor.position().y as f64 / scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let (px, py) = (x as f64 / scale, y as f64 / scale);
        let left = (px + 12.0).min(mx + size.width - PICKER_W - 12.0).max(mx + 12.0);
        let top = (py + 12.0).min(my + size.height - PICKER_H - 48.0).max(my + 12.0);
        let _ = window.set_position(tauri::LogicalPosition::new(left, top));
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("clip://opened", ());
}

#[tauri::command]
pub fn clipboard_hide_picker(app: AppHandle) {
    hide_picker(&app);
}

pub fn hide_picker(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PICKER) {
        let _ = w.hide();
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, POINT};
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow, SetForegroundWindow};
    use windows::core::w;

    const CF_UNICODETEXT: u32 = 13;

    pub fn sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// Another app may hold the clipboard for a moment, so try a few times.
    fn open() -> bool {
        for _ in 0..10 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        false
    }

    /// Text on the clipboard, unless the app that copied it asked for it not to be recorded.
    pub fn read_text() -> Option<String> {
        unsafe {
            if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() || !open() {
                return None;
            }
            let text = (|| {
                let excluded = [w!("ExcludeClipboardContentFromMonitorProcessing"), w!("Clipboard Viewer Ignore")];
                if excluded.iter().any(|f| IsClipboardFormatAvailable(RegisterClipboardFormatW(*f)).is_ok()) {
                    return None;
                }
                for f in [w!("CanIncludeInClipboardHistory"), w!("CanUploadToCloudClipboard")] {
                    let format = RegisterClipboardFormatW(f);
                    if IsClipboardFormatAvailable(format).is_ok()
                        && let Ok(h) = GetClipboardData(format)
                    {
                        let p = GlobalLock(HGLOBAL(h.0)) as *const u32;
                        let allowed = p.is_null() || *p != 0;
                        let _ = GlobalUnlock(HGLOBAL(h.0));
                        if !allowed {
                            return None;
                        }
                    }
                }
                let h = GetClipboardData(CF_UNICODETEXT).ok()?;
                let mem = HGLOBAL(h.0);
                let p = GlobalLock(mem) as *const u16;
                if p.is_null() {
                    return None;
                }
                let max = GlobalSize(mem) / 2;
                let slice = std::slice::from_raw_parts(p, max);
                let len = slice.iter().position(|&c| c == 0).unwrap_or(max);
                let text = String::from_utf16_lossy(&slice[..len]);
                let _ = GlobalUnlock(mem);
                Some(text)
            })();
            let _ = CloseClipboard();
            text
        }
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain([0]).collect();
        unsafe {
            if !open() {
                return Err("Another app is using the clipboard. Try again.".into());
            }
            let result = (|| {
                EmptyClipboard().map_err(|e| e.to_string())?;
                let mem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
                let p = GlobalLock(mem) as *mut u16;
                if p.is_null() {
                    return Err("Out of memory".to_string());
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
                let _ = GlobalUnlock(mem);
                SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))).map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = CloseClipboard();
            result.map_err(|e| format!("Couldn't copy to the clipboard: {e}"))
        }
    }

    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow().0 as isize }
    }

    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
    }

    /// Brings back the window that was in front and presses Ctrl+V in it.
    pub fn paste_into(previous: isize) {
        unsafe {
            if previous != 0 {
                let _ = SetForegroundWindow(HWND(previous as *mut c_void));
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
            let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() } },
            };
            let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn sequence() -> u32 {
        0
    }
    pub fn read_text() -> Option<String> {
        None
    }
    pub fn write_text(_text: &str) -> Result<(), String> {
        Err("The clipboard is only supported on Windows".into())
    }
    pub fn foreground() -> isize {
        0
    }
    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn paste_into(_previous: isize) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_first_without_duplicates() {
        let mut list = Vec::new();
        assert!(add(&mut list, "a".into(), 1));
        assert!(add(&mut list, "b".into(), 2));
        assert!(add(&mut list, "a".into(), 3));
        assert!(!add(&mut list, "   ".into(), 4));
        assert_eq!(list.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(list[0].at, 3);
    }

    #[test]
    fn drops_oldest_unpinned_beyond_limit() {
        let mut list = Vec::new();
        add(&mut list, "keep".into(), 0);
        list[0].pinned = true;
        for i in 0..MAX_ITEMS + 5 {
            add(&mut list, format!("item {i}"), i as i64 + 1);
        }
        assert_eq!(list.len(), MAX_ITEMS + 1);
        assert!(list.iter().any(|i| i.text == "keep"));
        assert!(!list.iter().any(|i| i.text == "item 0"));
    }
}
