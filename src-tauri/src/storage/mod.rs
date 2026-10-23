//! Storage page: cleanup categories and the Space finder (folder sizes, largest files, and
//! moving things to the Recycle Bin with undo).

mod cleaner;
pub mod dupes;
mod safety;
mod scan;
#[cfg(windows)]
mod win;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::actions::{ActivityLog, Undo};
use crate::blocking;
pub use cleaner::CleanupKind;
use cleaner::{CleanupCategory, CleanupResult, CleanupRunEvent};
use safety::{Rules, Scope, Verdict};
use scan::{FolderView, Tree};
pub use dupes::Dupes;

// ---- Cleanup ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSummary {
    pub results: Vec<CleanupResult>,
    pub bytes: u64,
    pub files: u64,
    pub skipped: u64,
}

/// Measures every cleanup category; each one is also sent on `on_event` as soon as it's measured.
#[tauri::command]
pub async fn storage_cleanup_scan(on_event: Channel<CleanupCategory>) -> Result<Vec<CleanupCategory>, String> {
    blocking(move || {
        Ok(cleaner::measure_all(|c| {
            let _ = on_event.send(c.clone());
        }))
    })
    .await
}

#[tauri::command]
pub async fn storage_cleanup_run(app: AppHandle, kinds: Vec<CleanupKind>, on_event: Channel<CleanupRunEvent>) -> Result<CleanupSummary, String> {
    blocking(move || {
        let summary = summarize(cleaner::clean(&kinds, |e| {
            let _ = on_event.send(e);
        }));
        let cleaned: Vec<&CleanupResult> = summary.results.iter().filter(|r| r.error.is_none() && r.files > 0).collect();
        if !cleaned.is_empty() {
            let names = join_names(&cleaned.iter().map(|r| r.label).collect::<Vec<_>>());
            let detail = cleaned
                .iter()
                .map(|r| {
                    let kept = if r.skipped > 0 { format!(", {} kept", r.skipped) } else { String::new() };
                    format!("{}: {} files, {}{kept}", r.label, r.files, size_text(r.bytes))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let description = format!("Freed {} ({names})", size_text(summary.bytes));
            app.state::<ActivityLog>().record(&app, "Cleanup", description, Some(detail), None);
        }
        Ok(summary)
    })
    .await
}

/// Cleans without reporting progress (for automations). Not logged: the caller does that.
pub fn clean(kinds: &[CleanupKind]) -> CleanupSummary {
    summarize(cleaner::clean(kinds, |_| {}))
}

fn summarize(results: Vec<CleanupResult>) -> CleanupSummary {
    CleanupSummary {
        bytes: results.iter().map(|r| r.bytes).sum(),
        files: results.iter().map(|r| r.files).sum(),
        skipped: results.iter().map(|r| r.skipped).sum(),
        results,
    }
}

/// "a, b and c"
pub fn join_names(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Sizes the way the page shows them: "1.21 GB", "350 MB", "0 B".
pub fn size_text(n: u64) -> String {
    const UNITS: [&str; 5] = ["KB", "MB", "GB", "TB", "PB"];
    if n < 1000 {
        return format!("{n} B");
    }
    let mut v = n as f64 / 1024.0;
    let mut unit = 0;
    while v >= 1000.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    let s = if v >= 100.0 { format!("{v:.0}") } else if v >= 10.0 { format!("{v:.1}") } else { format!("{v:.2}") };
    let s = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.') } else { &s };
    format!("{s} {}", UNITS[unit])
}

// ---- Space finder ----

/// Running scans (so they can be stopped) and the latest finished one, which the page browses.
#[derive(Default)]
pub struct Scans {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    latest: Mutex<Option<String>>,
    tree: Mutex<Option<(String, Tree)>>,
}

impl Scans {
    fn with<R>(&self, scan_id: &str, f: impl FnOnce(&mut Tree) -> R) -> Result<R, String> {
        let mut guard = self.tree.lock();
        match guard.as_mut() {
            Some((id, tree)) if id == scan_id => Ok(f(tree)),
            _ => Err("These results are out of date. Scan again to see the current sizes.".into()),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    Progress { files: u64, folders: u64, bytes: u64, denied: u64, current: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub scan_id: String,
    pub root: String,
    pub bytes: u64,
    pub files: u64,
    pub folders: u64,
    /// Folders Windows wouldn't open (their size isn't included).
    pub denied: u64,
    /// Links and junctions that were skipped rather than followed.
    pub links: u64,
    /// Stopped early: sizes only include what was read.
    pub cancelled: bool,
    pub elapsed_ms: u64,
    pub view: FolderView,
}

/// Scans a drive or folder on a background thread, streaming progress. Only the latest finished
/// scan is kept in memory.
#[tauri::command]
pub async fn storage_scan(app: AppHandle, scan_id: String, path: String, on_event: Channel<ScanEvent>) -> Result<ScanSummary, String> {
    blocking(move || {
        let root = PathBuf::from(&path);
        let meta = std::fs::symlink_metadata(&root).map_err(|_| "That folder no longer exists.".to_string())?;
        if meta.file_type().is_symlink() {
            return Err("That folder is a shortcut to another place, so it wasn't scanned. Choose the folder it points to instead.".into());
        }
        if !meta.is_dir() {
            return Err("Choose a folder or a drive to scan.".into());
        }

        let scans = app.state::<Scans>();
        let cancel = Arc::new(AtomicBool::new(false));
        scans.cancels.lock().insert(scan_id.clone(), cancel.clone());
        *scans.latest.lock() = Some(scan_id.clone());
        // Free the previous results before building new ones.
        *scans.tree.lock() = None;

        let result = scan::scan(&root, &cancel, |p| {
            let _ = on_event.send(ScanEvent::Progress { files: p.files, folders: p.folders, bytes: p.bytes, denied: p.denied, current: p.current });
        });
        scans.cancels.lock().remove(&scan_id);
        let tree = result?;
        let (bytes, files, folders) = tree.total();
        let summary = ScanSummary {
            scan_id: scan_id.clone(),
            root: tree.root_path(),
            bytes,
            files,
            folders,
            denied: tree.denied,
            links: tree.links,
            cancelled: tree.cancelled,
            elapsed_ms: tree.elapsed.as_millis() as u64,
            view: tree.view(0).ok_or("The scan found nothing to show.")?,
        };
        // A newer scan started meanwhile: its results win.
        if scans.latest.lock().as_deref() == Some(scan_id.as_str()) {
            *scans.tree.lock() = Some((scan_id, tree));
        }
        Ok(summary)
    })
    .await
}

#[tauri::command]
pub fn storage_cancel_scan(scans: State<Scans>, scan_id: String) {
    if let Some(flag) = scans.cancels.lock().get(&scan_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command(async)]
pub fn storage_folder(scans: State<Scans>, scan_id: String, node: u32) -> Result<FolderView, String> {
    scans.with(&scan_id, |tree| tree.view(node))?.ok_or_else(|| "That folder was moved to the Recycle Bin.".into())
}

/// Something from the scan results to delete: a folder, or a file from the largest-files list.
#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DeleteTarget {
    Folder { node: u32 },
    File { dir: u32, name: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCheck {
    pub path: String,
    pub name: String,
    pub is_folder: bool,
    pub bytes: u64,
    pub files: u64,
    /// Why it can't be deleted here.
    pub blocked: Option<String>,
    /// Allowed, but worth knowing before confirming.
    pub warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub path: String,
    pub bytes: u64,
    /// The activity entry, for an Undo button.
    pub activity_id: Option<String>,
}

/// Looks the target up in the scan, so the path always comes from the scan itself.
fn resolve(scans: &Scans, scan_id: &str, target: &DeleteTarget) -> Result<(PathBuf, u64, u64), String> {
    let found = scans.with(scan_id, |tree| match target {
        DeleteTarget::Folder { node } => {
            let (bytes, files) = tree.folder_size(*node)?;
            Some((tree.path_of(*node)?, bytes, files))
        }
        DeleteTarget::File { dir, name } => tree.file(*dir, name).map(|(path, bytes)| (path, bytes, 1)),
    })?;
    found.ok_or_else(|| "That item is no longer in the scan results. Scan again to see the current sizes.".into())
}

/// Every reason not to move `path` to the Recycle Bin, checked on the path as shown and on the real
/// path behind it (which resolves short names and folder links).
fn verdict(app: &AppHandle, path: &Path) -> Verdict {
    let rules = protection_rules(app);
    let shown = scan::display(path);
    let real = match std::fs::canonicalize(path) {
        Ok(real) => scan::display(&real),
        Err(_) => return Verdict::Blocked("It no longer exists. Scan again to see the current sizes.".into()),
    };
    let first = safety::check(&shown, &rules);
    if let Verdict::Blocked(_) = first {
        return first;
    }
    if let blocked @ Verdict::Blocked(_) = safety::check(&real, &rules) {
        return blocked;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Verdict::Blocked("It no longer exists. Scan again to see the current sizes.".into());
    };
    if meta.file_type().is_symlink() {
        return Verdict::Blocked("This is a link to another place, so it isn't deleted here.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if meta.file_attributes() & FILE_ATTRIBUTE_SYSTEM != 0 {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Verdict::Blocked(safety::system_file_reason(&name));
        }
        if !win::has_recycle_bin(Path::new(&real)) {
            return Verdict::Blocked(
                "This drive has no Recycle Bin (USB and network drives don't), so it would be deleted for good. Use File Explorer if you're sure.".into(),
            );
        }
    }
    first
}

#[tauri::command]
pub async fn storage_check_delete(app: AppHandle, scan_id: String, target: DeleteTarget) -> Result<DeleteCheck, String> {
    blocking(move || {
        let (path, bytes, files) = resolve(&app.state::<Scans>(), &scan_id, &target)?;
        let (blocked, warning) = match verdict(&app, &path) {
            Verdict::Blocked(why) => (Some(why), None),
            Verdict::Allowed { warning } => (None, warning),
        };
        Ok(DeleteCheck {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: scan::display(&path),
            is_folder: matches!(target, DeleteTarget::Folder { .. }),
            bytes,
            files,
            blocked,
            warning,
        })
    })
    .await
}

/// Moves a scanned folder or file to the Recycle Bin, updates the scan, and logs it with Undo.
#[tauri::command]
pub async fn storage_delete(app: AppHandle, scan_id: String, target: DeleteTarget) -> Result<DeleteResult, String> {
    // The main window owns Windows' own "delete for good?" question, if it has to ask one.
    #[cfg(windows)]
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    #[cfg(not(windows))]
    let owner = None;
    blocking(move || {
        let scans = app.state::<Scans>();
        let (path, bytes, _) = resolve(&scans, &scan_id, &target)?;
        if let Verdict::Blocked(why) = verdict(&app, &path) {
            return Err(why);
        }
        let shown = scan::display(&path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| shown.clone());
        let deleted_at = chrono::Utc::now().timestamp();
        recycle(Path::new(&shown), owner).map_err(|e| format!("Couldn't move \"{name}\" to the Recycle Bin. {e}"))?;
        if path.exists() {
            return Err(format!("Windows couldn't move all of \"{name}\" to the Recycle Bin. Some of it may be in use by an app."));
        }
        scans.with(&scan_id, |tree| match &target {
            DeleteTarget::Folder { node } => tree.remove_folder(*node),
            DeleteTarget::File { dir, name } => tree.remove_file(*dir, name),
        })?;
        let activity_id = app.state::<ActivityLog>().record(
            &app,
            "Storage",
            format!("Moved \"{name}\" to the Recycle Bin ({})", size_text(bytes)),
            Some(shown.clone()),
            Some(Undo::RestoreFromRecycleBin { paths: vec![shown.clone()], deleted_at }),
        );
        Ok(DeleteResult { path: shown, bytes, activity_id })
    })
    .await
}

#[cfg(windows)]
fn recycle(path: &Path, owner: Option<isize>) -> Result<(), String> {
    win::move_to_recycle_bin(path, owner)
}

#[cfg(not(windows))]
fn recycle(_path: &Path, _owner: Option<isize>) -> Result<(), String> {
    Err("Moving to the Recycle Bin is only supported on Windows".into())
}

/// For removing an uninstalled app's leftover folders: why `path` can't go, if it can't.
pub fn check_leftover(app: &AppHandle, path: &Path) -> Result<(), String> {
    let rules = protection_rules(app);
    let roots = leftover_roots();
    let real = std::fs::canonicalize(path).map_err(|_| "It no longer exists.".to_string())?;
    for p in [scan::display(path), scan::display(&real)] {
        if let Verdict::Blocked(why) = safety::check_leftover(&p, &rules, &roots) {
            return Err(why);
        }
    }
    if std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        return Err("This is a link to another place, so it isn't removed.".into());
    }
    #[cfg(windows)]
    if !win::has_recycle_bin(&real) {
        return Err("This drive has no Recycle Bin, so it would be deleted for good.".into());
    }
    Ok(())
}

/// A path as shown to people, without the `\\?\` prefix.
pub fn display(path: &Path) -> String {
    scan::display(path)
}

/// Where apps install themselves and their Start menu shortcuts.
pub fn leftover_roots() -> Vec<String> {
    let env = |v: &str| std::env::var_os(v).map(PathBuf::from);
    let start = PathBuf::from(r"Microsoft\Windows\Start Menu\Programs");
    [env("ProgramFiles"), env("ProgramFiles(x86)"), env("ProgramData"), env("ProgramData").map(|d| d.join(&start)), env("APPDATA").map(|d| d.join(&start))]
        .into_iter()
        .flatten()
        .map(|p| scan::display(&p))
        .collect()
}

/// Moves one path to the Recycle Bin, in front of the main window.
pub fn recycle_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    #[cfg(not(windows))]
    let owner = {
        let _ = app;
        None
    };
    recycle(path, owner)
}

/// Used by Activity's Undo.
#[cfg(windows)]
pub fn restore_from_recycle_bin(paths: &[String], deleted_at: i64) -> Result<(), String> {
    win::restore_from_recycle_bin(paths.to_vec(), deleted_at)
}

#[cfg(not(windows))]
pub fn restore_from_recycle_bin(_paths: &[String], _deleted_at: i64) -> Result<(), String> {
    Err("Restoring from the Recycle Bin is only supported on Windows".into())
}

/// Shows a file or folder selected in File Explorer.
#[tauri::command(async)]
pub fn storage_reveal(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("It no longer exists.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("Couldn't open File Explorer: {e}"))
}

/// Windows' folder picker. `None` when the user cancels.
#[tauri::command]
pub async fn storage_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose a folder to scan");
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        Ok(dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| scan::display(&p)))
    })
    .await
}

// ---- What may never be deleted ----

#[cfg(windows)]
fn protection_rules(app: &AppHandle) -> Rules {
    use windows::Win32::UI::Shell::*;

    let mut r = Rules::default();
    let mut add = |path: Option<PathBuf>, scope: Scope, name: &str, why: &str| {
        if let Some(path) = path {
            r.add(&scan::display(&path), scope, name, why);
        }
    };
    let known = |id: &windows::core::GUID| win::known_folder(id);
    const APPS: &str = "Apps are installed here. Uninstall apps you don't need from Windows Settings instead.";
    const NEEDED: &str = "Windows needs this folder. Delete the things inside it instead.";
    const APP_SETTINGS: &str = "Apps keep their settings here. Delete one app's folder inside it instead, or uninstall the app.";

    add(Some(crate::os::windows_dir().to_path_buf()), Scope::Inside, "your Windows folder", "Deleting anything in it could stop the PC from starting.");
    for id in [FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86] {
        add(known(&id), Scope::Inside, "the folder where apps are installed", APPS);
    }
    add(known(&FOLDERID_ProgramData), Scope::Inside, "the folder where apps keep shared data", "Deleting things in it can break apps or stop them from uninstalling.");

    let users = known(&FOLDERID_UserProfiles);
    add(users.clone(), Scope::Exact, "the folder of every user account", "Delete things inside your own user folder instead.");
    add(users, Scope::Children, "a user account's main folder", "Windows keeps that person's files and settings in it. Delete things inside it instead.");
    let profile = known(&FOLDERID_Profile);
    add(profile.clone(), Scope::Exact, "your user folder", "Windows keeps your files and settings in it. Delete things inside it instead.");
    for (id, name) in [
        (FOLDERID_Desktop, "your Desktop folder"),
        (FOLDERID_Documents, "your Documents folder"),
        (FOLDERID_Downloads, "your Downloads folder"),
        (FOLDERID_Pictures, "your Pictures folder"),
        (FOLDERID_Music, "your Music folder"),
        (FOLDERID_Videos, "your Videos folder"),
        (FOLDERID_Favorites, "your Favorites folder"),
        (FOLDERID_Contacts, "your Contacts folder"),
        (FOLDERID_Links, "your Links folder"),
        (FOLDERID_SavedGames, "your Saved Games folder"),
        (FOLDERID_SavedSearches, "your Searches folder"),
        (FOLDERID_Objects3D, "your 3D Objects folder"),
        (FOLDERID_StartMenu, "your Start menu"),
        (FOLDERID_Public, "the shared Public folder"),
    ] {
        add(known(&id), Scope::Exact, name, NEEDED);
    }

    let roaming = known(&FOLDERID_RoamingAppData);
    let local = known(&FOLDERID_LocalAppData);
    let low = known(&FOLDERID_LocalAppDataLow);
    add(profile.map(|p| p.join("AppData")), Scope::Exact, "your AppData folder", APP_SETTINGS);
    for dir in [&roaming, &local, &low] {
        add(dir.clone(), Scope::Exact, "an AppData folder", APP_SETTINGS);
        add(
            dir.clone(),
            Scope::WarnInside,
            "",
            "Apps keep their settings and data in AppData. Deleting this can reset an app or stop it from working. Uninstalling the app is usually safer.",
        );
    }
    for dir in [&roaming, &local] {
        add(dir.as_ref().map(|d| d.join("Microsoft")), Scope::Exact, "the folder where Windows keeps your settings", NEEDED);
    }
    let keys = "Windows keeps your saved passwords, keys and certificates here. Deleting it can lock you out of apps and websites.";
    for sub in [r"Microsoft\Protect", r"Microsoft\Credentials", r"Microsoft\Crypto", r"Microsoft\SystemCertificates", r"Microsoft\Windows"] {
        add(roaming.as_ref().map(|d| d.join(sub)), Scope::Inside, "your Windows settings", keys);
    }
    for sub in [r"Microsoft\Credentials", r"Microsoft\Windows", r"Microsoft\WindowsApps", "Packages"] {
        add(local.as_ref().map(|d| d.join(sub)), Scope::Inside, "your Windows and Store app settings", "Windows and Store apps need these files.");
    }
    let browser = "Your browser keeps your passwords, bookmarks and history here. Clean its cache on the Cleanup tab instead.";
    for sub in [r"Microsoft\Edge\User Data", r"Google\Chrome\User Data", r"BraveSoftware\Brave-Browser\User Data"] {
        add(local.as_ref().map(|d| d.join(sub)), Scope::Inside, "your browser profile", browser);
    }
    add(roaming.as_ref().map(|d| d.join(r"Mozilla\Firefox")), Scope::Inside, "your Firefox profile", browser);

    let onedrive = "This is in OneDrive, so it is also deleted from OneDrive online and from your other devices.";
    let mut onedrives = vec![known(&FOLDERID_SkyDrive)];
    onedrives.extend(["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map(|v| std::env::var_os(v).map(PathBuf::from)));
    for dir in onedrives {
        add(dir.clone(), Scope::Exact, "your OneDrive folder", NEEDED);
        add(dir, Scope::WarnInside, "", onedrive);
    }

    add(std::env::temp_dir().canonicalize().ok(), Scope::Exact, "the temporary files folder", "Empty it on the Cleanup tab instead, which keeps files apps still need.");
    add(std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)), Scope::Exact, "Ultimate PC Tool itself", "Uninstall it from Windows Settings instead.");
    add(app.path().app_data_dir().ok(), Scope::Exact, "Ultimate PC Tool's settings and history", "Uninstall the app to remove them.");
    r
}

#[cfg(not(windows))]
fn protection_rules(_app: &AppHandle) -> Rules {
    Rules::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_sizes_and_lists() {
        assert_eq!(size_text(0), "0 B");
        assert_eq!(size_text(999), "999 B");
        assert_eq!(size_text(1536), "1.5 KB");
        assert_eq!(size_text(1_300_000_000), "1.21 GB");
        assert_eq!(size_text(350 * 1024 * 1024), "350 MB");
        assert_eq!(join_names(&["a"]), "a");
        assert_eq!(join_names(&["a", "b", "c"]), "a, b and c");
    }
}
