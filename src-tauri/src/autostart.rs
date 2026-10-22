//! "Start with Windows": a value in the current user's Run key that opens Optimo quietly in the tray.

/// Passed by the Run key so the app starts hidden in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";

#[cfg(windows)]
mod imp {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const VALUE: &str = "Optimo";

    pub fn enabled() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let present = hkcu
            .open_subkey_with_flags(RUN, KEY_READ)
            .and_then(|k| k.get_value::<String, _>(VALUE))
            .is_ok();
        // Turned off in Task Manager or Settings > Apps > Startup: an odd first byte.
        let approved = hkcu
            .open_subkey_with_flags(APPROVED, KEY_READ)
            .and_then(|k| k.get_raw_value(VALUE))
            .map(|v| v.bytes.first().is_none_or(|b| b & 1 == 0))
            .unwrap_or(true);
        present && approved
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu.create_subkey(RUN).map_err(|e| format!("Couldn't open the startup list: {e}"))?;
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = format!("\"{}\" {}", exe.display(), super::MINIMIZED_ARG);
            run.set_value(VALUE, &command).map_err(|e| format!("Couldn't add Optimo to startup: {e}"))?;
            // Clear an earlier "off" from Task Manager, which would otherwise win.
            if let Ok(approved) = hkcu.open_subkey_with_flags(APPROVED, KEY_SET_VALUE) {
                let _ = approved.delete_value(VALUE);
            }
        } else {
            match run.delete_value(VALUE) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("Couldn't remove Optimo from startup: {e}")),
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn enabled() -> bool {
        false
    }
    pub fn set(_enabled: bool) -> Result<(), String> {
        Err("Only available on Windows.".into())
    }
}

#[tauri::command]
pub fn get_autostart() -> bool {
    imp::enabled()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    imp::set(enabled)
}

/// True when Windows started the app at sign-in.
pub fn started_minimized() -> bool {
    std::env::args().any(|a| a == MINIMIZED_ARG)
}
