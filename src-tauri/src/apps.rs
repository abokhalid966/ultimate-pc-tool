//! Installed programs, read from the same Uninstall registry keys Windows Settings uses (all
//! users 64-bit and 32-bit, and the current user), and uninstalling them with each program's own
//! uninstaller. The command that runs always comes from the registry, never from the UI.

mod entry;

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::actions::ActivityLog;
#[cfg_attr(not(windows), allow(unused_imports))]
use entry::{Entry, Exit, Plan};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// Installed for everyone: uninstalling needs administrator rights.
    Machine,
    User,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// Where the entry lives, e.g. `HKLM64\{GUID}`. Uninstalling looks the command up again from it.
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub version: Option<String>,
    /// The installer's own estimate, in bytes.
    pub size_bytes: Option<u64>,
    /// `YYYY-MM-DD`
    pub install_date: Option<String>,
    pub location: Option<String>,
    pub scope: Scope,
    pub can_uninstall: bool,
    pub can_quiet: bool,
    /// Ultimate PC Tool itself, removed from Windows Settings instead.
    pub is_self: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    /// The app is gone from the list.
    pub removed: bool,
    /// The uninstaller may still be open: it handed over to another window or is still working.
    pub pending: bool,
    pub cancelled: bool,
    pub restart_needed: bool,
    /// Why it didn't finish, in plain language.
    pub message: Option<String>,
}

/// Uninstallers are waited for this long before the UI takes over watching for the app to go.
#[cfg_attr(not(windows), allow(dead_code))]
const WAIT_LIMIT: Duration = Duration::from_secs(30 * 60);

#[cfg_attr(not(windows), allow(dead_code))]
fn is_self(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("Ultimate PC Tool")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn to_app(id: String, scope: Scope, e: &Entry) -> InstalledApp {
    let own = is_self(&e.name);
    // Some installers write nonsense sizes; anything over 4 TB is left out.
    let size_bytes = e.size_kb.map(|kb| kb as u64 * 1024).filter(|b| *b > 0 && *b < 4 << 40);
    InstalledApp {
        id,
        name: e.name.trim().to_string(),
        publisher: e.publisher.clone(),
        version: e.version.clone(),
        size_bytes,
        install_date: e.install_date.clone(),
        location: e.location.clone(),
        scope,
        can_uninstall: !own && !e.no_remove && (e.uninstall.is_some() || entry::msi_product_code(e).is_some()),
        can_quiet: !own && !e.no_remove && entry::can_quiet(e),
        is_self: own,
    }
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use std::time::{Duration, Instant};

    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

    use super::entry::{self, Entry};
    use super::{InstalledApp, Scope};
    use crate::os::{self, ElevateError};

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    #[derive(Clone, Copy, PartialEq, Eq)]
    pub enum Hive {
        Machine64,
        Machine32,
        User,
    }

    impl Hive {
        const ALL: [Hive; 3] = [Hive::Machine64, Hive::Machine32, Hive::User];

        fn tag(self) -> &'static str {
            match self {
                Hive::Machine64 => "HKLM64",
                Hive::Machine32 => "HKLM32",
                Hive::User => "HKCU",
            }
        }

        pub fn scope(self) -> Scope {
            if self == Hive::User { Scope::User } else { Scope::Machine }
        }

        fn open(self) -> std::io::Result<RegKey> {
            let (root, flags) = match self {
                Hive::Machine64 => (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_64KEY),
                Hive::Machine32 => (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
                Hive::User => (HKEY_CURRENT_USER, KEY_READ),
            };
            RegKey::predef(root).open_subkey_with_flags(UNINSTALL, flags)
        }
    }

    /// `HKLM64\{key}` back to the hive and key name. Key names never contain a backslash.
    pub fn parse_id(id: &str) -> Option<(Hive, &str)> {
        let (tag, key) = id.split_once('\\')?;
        let hive = Hive::ALL.into_iter().find(|h| h.tag() == tag)?;
        (!key.is_empty() && !key.contains('\\')).then_some((hive, key))
    }

    fn text(key: &RegKey, name: &str) -> Option<String> {
        let value: String = key.get_value(name).ok()?;
        let value = value.trim_matches(char::from(0)).trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    fn number(key: &RegKey, name: &str) -> Option<u32> {
        key.get_value::<u32, _>(name).ok().or_else(|| text(key, name)?.parse().ok())
    }

    fn flag(key: &RegKey, name: &str) -> bool {
        number(key, name) == Some(1)
    }

    fn read(name: &str, key: &RegKey) -> Entry {
        // Without an InstallDate, the time the entry was last written is what Windows shows too.
        let install_date = text(key, "InstallDate").and_then(|d| entry::parse_install_date(&d)).or_else(|| {
            let t = key.query_info().ok()?.get_last_write_time_system();
            (t.wYear >= 1990).then(|| format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay))
        });
        Entry {
            key: name.to_string(),
            name: text(key, "DisplayName").unwrap_or_default(),
            version: text(key, "DisplayVersion"),
            publisher: text(key, "Publisher"),
            size_kb: number(key, "EstimatedSize"),
            install_date,
            location: text(key, "InstallLocation").map(|l| l.trim_matches('"').to_string()),
            uninstall: text(key, "UninstallString"),
            quiet_uninstall: text(key, "QuietUninstallString"),
            system_component: flag(key, "SystemComponent"),
            parent_key: text(key, "ParentKeyName"),
            release_type: text(key, "ReleaseType"),
            windows_installer: flag(key, "WindowsInstaller"),
            no_remove: flag(key, "NoRemove"),
        }
    }

    pub fn list() -> Vec<InstalledApp> {
        let mut seen = std::collections::HashSet::new();
        let mut apps = Vec::new();
        for hive in Hive::ALL {
            let Ok(root) = hive.open() else { continue };
            for name in root.enum_keys().flatten() {
                let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ) else { continue };
                let e = read(&name, &key);
                // The same app can be registered twice (both views, or for everyone and for you).
                if entry::is_app(&e) && seen.insert((e.name.trim().to_lowercase(), e.version.clone())) {
                    apps.push(super::to_app(format!("{}\\{name}", hive.tag()), hive.scope(), &e));
                }
            }
        }
        apps
    }

    pub fn find(hive: Hive, key: &str) -> Option<Entry> {
        let root = hive.open().ok()?;
        let sub = root.open_subkey_with_flags(key, KEY_READ).ok()?;
        Some(read(key, &sub))
    }

    /// Whether the entry is still there and still names the app (an uninstaller may remove the
    /// values before the key).
    pub fn still_installed(hive: Hive, key: &str) -> bool {
        find(hive, key).is_some_and(|e| !e.name.is_empty())
    }

    /// A started process, waited on through its handle.
    pub struct Process(windows::Win32::Foundation::HANDLE);

    impl Process {
        /// Waits up to `limit`; the exit code once it has exited.
        pub fn wait(&self, limit: Duration) -> Option<u32> {
            use windows::Win32::Foundation::WAIT_OBJECT_0;
            use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
            let ms = limit.as_millis().min(u32::MAX as u128 - 1) as u32;
            unsafe {
                if WaitForSingleObject(self.0, ms) != WAIT_OBJECT_0 {
                    return None;
                }
                let mut code = 0u32;
                GetExitCodeProcess(self.0, &mut code).ok().map(|_| code)
            }
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
        }
    }

    /// Starts an uninstaller in its own window, through the shell so its manifest's own
    /// administrator request works. `elevate` asks for administrator rights up front (one prompt,
    /// and it lets quiet uninstalls of apps for all users work). Blocks until the prompt is answered.
    pub fn launch(plan: &super::Plan, elevate: bool) -> Result<Option<Process>, ElevateError> {
        use windows::Win32::Foundation::ERROR_CANCELLED;
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize};
        use windows::Win32::UI::Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::{HRESULT, PCWSTR, w};

        let file = os::wide(std::ffi::OsStr::new(&plan.program));
        let params = os::wide(std::ffi::OsStr::new(&plan.args));
        // Some uninstallers expect to start in their own folder.
        let dir = Path::new(&plan.program).parent().filter(|d| d.is_absolute() && d.is_dir()).map(|d| os::wide(d.as_os_str()));
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let mut info = SHELLEXECUTEINFOW {
                cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS,
                lpVerb: if elevate { w!("runas") } else { PCWSTR::null() },
                lpFile: PCWSTR(file.as_ptr()),
                lpParameters: PCWSTR(params.as_ptr()),
                lpDirectory: dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            let result = ShellExecuteExW(&mut info);
            if com.is_ok() {
                CoUninitialize();
            }
            match result {
                Ok(()) => Ok((!info.hProcess.is_invalid()).then_some(Process(info.hProcess))),
                Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Err(ElevateError::Cancelled),
                Err(e) => Err(ElevateError::Failed(e.message())),
            }
        }
    }

    /// Waits up to `limit` for the entry to disappear (uninstallers remove it last).
    pub fn wait_until_gone(hive: Hive, key: &str, limit: Duration) -> bool {
        let until = Instant::now() + limit;
        loop {
            if !still_installed(hive, key) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

pub fn list() -> Vec<InstalledApp> {
    #[cfg(windows)]
    {
        let mut apps = imp::list();
        apps.sort_by_cached_key(|a| a.name.to_lowercase());
        apps
    }
    #[cfg(not(windows))]
    Vec::new()
}

#[cfg(windows)]
fn uninstall(app: &AppHandle, id: &str, quiet: bool) -> Result<UninstallOutcome, String> {
    use std::path::Path;

    let (hive, key) = imp::parse_id(id).ok_or("That app's entry looks wrong. Refresh the list and try again.")?;
    let Some(e) = imp::find(hive, key).filter(|e| !e.name.is_empty()) else {
        return Ok(UninstallOutcome { removed: true, ..Default::default() });
    };
    let name = e.name.trim().to_string();
    if is_self(&name) {
        return Err("To remove Ultimate PC Tool, use Settings > Apps > Installed apps in Windows.".into());
    }
    if e.no_remove {
        return Err(format!("{name} can't be uninstalled: its installer doesn't allow it."));
    }
    let msiexec = crate::os::windows_dir().join(r"System32\msiexec.exe");
    let plan = entry::plan(&e, quiet, &msiexec.to_string_lossy(), |p| Path::new(p).is_file(), |v| std::env::var(v).ok())?;
    let program = Path::new(&plan.program);
    if program.is_absolute() && !program.is_file() {
        return Err(format!(
            "{name}'s uninstaller is missing, so the app may already be partly removed. Settings > Apps in Windows may still be able to remove it.\n{}",
            plan.program
        ));
    }

    let elevate = hive.scope() == Scope::Machine && !crate::os::is_elevated();
    let process = imp::launch(&plan, elevate).map_err(|e| match e {
        crate::os::ElevateError::Cancelled => format!("You chose No on the administrator prompt, so {name} wasn't uninstalled."),
        crate::os::ElevateError::Failed(e) => format!("Couldn't start {name}'s uninstaller: {e}"),
    })?;
    let exit = process.and_then(|p| p.wait(WAIT_LIMIT));
    // Uninstallers often remove the entry a moment after they close.
    let removed = imp::wait_until_gone(hive, key, Duration::from_secs(if exit.is_some() { 3 } else { 0 }));

    let mut outcome = UninstallOutcome { removed, ..Default::default() };
    match exit.map(entry::describe_exit) {
        _ if removed => {}
        Some(Exit::Cancelled) => outcome.cancelled = true,
        Some(Exit::Restart) => outcome.restart_needed = true,
        Some(Exit::Failed(reason)) => outcome.message = Some(reason),
        // Finished, still listed: many uninstallers hand over to a copy of themselves and exit.
        Some(Exit::Finished) | None => outcome.pending = true,
    }
    if removed && exit == Some(3010) {
        outcome.restart_needed = true;
    }

    if !outcome.cancelled {
        let description = if removed { format!("Uninstalled \"{name}\"") } else { format!("Opened the uninstaller for \"{name}\"") };
        let version = e.version.as_deref().map(|v| format!("Version {v} · ")).unwrap_or_default();
        let detail = Some(format!("{version}{} {}", plan.program, plan.args).trim_end().to_string());
        app.state::<ActivityLog>().record(app, "Apps", description, detail, None);
    }
    Ok(outcome)
}

#[cfg(not(windows))]
fn uninstall(_app: &AppHandle, _id: &str, _quiet: bool) -> Result<UninstallOutcome, String> {
    Err("Uninstalling apps is only supported on Windows".into())
}

fn still_installed(id: &str) -> bool {
    #[cfg(windows)]
    {
        imp::parse_id(id).is_some_and(|(hive, key)| imp::still_installed(hive, key))
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        false
    }
}

// ---- Commands ----

#[tauri::command]
pub async fn list_installed_apps() -> Result<Vec<InstalledApp>, String> {
    crate::blocking(|| Ok(list())).await
}

/// Starts the app's uninstaller (after the administrator prompt for apps installed for everyone)
/// and waits for it to close.
#[tauri::command]
pub async fn uninstall_app(app: AppHandle, id: String, quiet: bool) -> Result<UninstallOutcome, String> {
    crate::blocking(move || uninstall(&app, &id, quiet)).await
}

/// For watching an uninstaller that handed over to another window.
#[tauri::command]
pub async fn app_still_installed(id: String) -> Result<bool, String> {
    crate::blocking(move || Ok(still_installed(&id))).await
}

/// Opens an app's install folder in File Explorer.
#[tauri::command(async)]
pub fn open_app_folder(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("That folder no longer exists.".into());
    }
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| format!("Couldn't open the folder: {e}"))
}
