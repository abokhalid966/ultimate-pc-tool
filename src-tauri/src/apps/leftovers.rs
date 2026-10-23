//! Leftovers of an uninstalled app: folders named after it in the usual places (Program Files,
//! ProgramData, AppData, the Start menu) and its settings in the registry. Folders go to the
//! Recycle Bin and registry keys are backed up first, so one Undo puts everything back.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::actions::{ActivityLog, Undo};

/// Never treated as an app's own folder or key: shared by Windows or by many apps.
const NEVER: &[&str] = &[
    "microsoft", "windows", "commonfiles", "windowsapps", "internetexplorer", "windowsdefender", "windowsnt", "windowsmail",
    "windowsmediaplayer", "windowsphotoviewer", "windowssidebar", "windowspowershell", "dotnet", "referenceassemblies",
    "modifiablewindowsapps", "packages", "temp", "programs", "packagecache", "classes", "policies", "clients",
    "registeredapplications", "wow6432node", "startmenu", "desktop", "documents", "crashdumps", "virtualstore", "optimo",
    "ultimatepctool", "nvidia", "nvidiacorporation", "intel", "amd", "google", "mozilla", "adobe", "apple", "oracle", "java",
    "steam", "valve", "app", "apps", "update", "setup", "installer", "data", "cache", "software", "system",
];

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RegHive {
    CurrentUser,
    LocalMachine,
}

#[derive(Clone, Debug)]
enum Target {
    Folder(PathBuf),
    Key(RegHive, String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub id: usize,
    /// "folder" or "registry"
    pub kind: &'static str,
    pub path: String,
    pub bytes: u64,
    /// What it is, in plain words.
    pub note: &'static str,
    pub needs_admin: bool,
}

/// Leftovers from the latest search; removing picks from these by id.
#[derive(Default)]
pub struct Leftovers(Mutex<Vec<Target>>);

/// "Notepad++ (64-bit x64) 8.6.2" -> "Notepad++"
fn clean_name(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in name.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let drop = |w: &str| {
        let l = w.to_lowercase();
        let version = l.trim_start_matches('v').starts_with(|c: char| c.is_ascii_digit()) && l.chars().all(|c| c.is_ascii_digit() || c == '.' || c == 'v');
        version || matches!(l.as_str(), "x64" | "x86" | "64-bit" | "32-bit" | "64bit" | "32bit" | "version" | "-" | "en-us")
    };
    out.split_whitespace().filter(|w| !drop(w)).collect::<Vec<_>>().join(" ").trim_matches([' ', '-', ',']).to_string()
}

/// "Valve Corporation" -> "Valve"
fn clean_publisher(publisher: &str) -> String {
    let drop = |w: &str| matches!(w.to_lowercase().trim_end_matches([',', '.']), "inc" | "llc" | "ltd" | "corporation" | "corp" | "co" | "gmbh" | "limited" | "s.a" | "ag" | "bv" | "plc");
    publisher.split_whitespace().filter(|w| !drop(w)).collect::<Vec<_>>().join(" ").trim_matches([' ', ',', '.']).to_string()
}

/// Letters, digits and `+` only, lower case: how folder names are compared.
fn key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || *c == '+').flat_map(char::to_lowercase).collect()
}

fn usable(name: &str) -> bool {
    let k = key(name);
    k.chars().count() >= 3 && !NEVER.contains(&k.as_str())
}

/// The names an app's folders and keys may have, best first.
fn names(name: &str, publisher: Option<&str>) -> (Vec<String>, Option<String>) {
    let full = clean_name(name);
    let publisher = publisher.map(clean_publisher).filter(|p| key(p).chars().count() >= 2);
    let mut list = vec![full.clone()];
    if let Some(p) = &publisher
        && let Some(rest) = full.strip_prefix(p.as_str())
    {
        // "Mozilla Firefox" by Mozilla is often just "Firefox".
        list.push(rest.trim().to_string());
    }
    list.retain(|n| usable(n));
    list.dedup_by(|a, b| key(a) == key(b));
    (list, publisher)
}

/// A child of `dir` whose name matches one of `names`.
fn child(dir: &Path, names: &[String]) -> Option<PathBuf> {
    let wanted: Vec<String> = names.iter().map(|n| key(n)).collect();
    std::fs::read_dir(dir).ok()?.flatten().find(|e| e.file_type().is_ok_and(|t| t.is_dir()) && wanted.contains(&key(&e.file_name().to_string_lossy()))).map(|e| e.path())
}

fn folder_size(dir: &Path) -> u64 {
    let (mut total, mut seen, mut stack) = (0u64, 0u32, vec![dir.to_path_buf()]);
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            seen += 1;
            if seen > 200_000 {
                return total;
            }
            let Ok(m) = e.metadata() else { continue };
            if m.file_type().is_symlink() {
                continue;
            }
            if m.is_dir() {
                stack.push(e.path());
            } else {
                total += m.len();
            }
        }
    }
    total
}

fn find_folders(name_list: &[String], publisher: &Option<String>, location: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let env = |v: &str| std::env::var_os(v).map(PathBuf::from);
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut push = |p: PathBuf, note: &'static str| {
        if !found.iter().any(|(q, _)| q == &p) {
            found.push((p, note));
        }
    };
    // The install folder, unless it's a shared one like "Common Files".
    let own_name = |p: &PathBuf| p.file_name().is_some_and(|n| usable(&n.to_string_lossy()));
    if let Some(loc) = location.map(|l| PathBuf::from(l.trim().trim_matches('"'))).filter(|p| p.is_dir() && own_name(p)) {
        push(loc, "Its install folder");
    }
    let start = r"Microsoft\Windows\Start Menu\Programs";
    let places: [(Option<PathBuf>, &'static str); 8] = [
        (env("ProgramFiles"), "Program files"),
        (env("ProgramFiles(x86)"), "Program files"),
        (env("LOCALAPPDATA").map(|d| d.join("Programs")), "Program files"),
        (env("ProgramData"), "Shared app data"),
        (env("APPDATA"), "Your settings for this app"),
        (env("LOCALAPPDATA"), "Your settings and cache for this app"),
        (env("APPDATA").map(|d| d.join(start)), "Start menu shortcuts"),
        (env("ProgramData").map(|d| d.join(start)), "Start menu shortcuts"),
    ];
    for (dir, note) in places {
        let Some(dir) = dir else { continue };
        if let Some(p) = child(&dir, name_list) {
            push(p, note);
        }
        if let Some(pubdir) = publisher.as_ref().and_then(|p| child(&dir, std::slice::from_ref(p))) {
            if let Some(p) = child(&pubdir, name_list) {
                push(p.clone(), note);
                // The publisher's folder too, when this app was all it held.
                let only = std::fs::read_dir(&pubdir).map(|r| r.flatten().all(|e| e.path() == p)).unwrap_or(false);
                if only && publisher.as_deref().is_some_and(usable) {
                    push(pubdir, note);
                }
            }
        }
    }
    // An outer folder already covers what's inside it.
    let all: Vec<PathBuf> = found.iter().map(|(p, _)| p.clone()).collect();
    found.retain(|(p, _)| !all.iter().any(|q| q != p && p.starts_with(q)));
    // Never Optimo's own folder.
    if let Some(own) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        found.retain(|(p, _)| !own.starts_with(p));
    }
    found
}

#[cfg(windows)]
mod reg {
    use std::path::Path;

    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

    use super::RegHive;

    fn root(h: RegHive) -> RegKey {
        RegKey::predef(match h {
            RegHive::CurrentUser => HKEY_CURRENT_USER,
            RegHive::LocalMachine => HKEY_LOCAL_MACHINE,
        })
    }

    pub fn full(h: RegHive, path: &str) -> String {
        format!("{}\\{path}", if h == RegHive::CurrentUser { "HKEY_CURRENT_USER" } else { "HKEY_LOCAL_MACHINE" })
    }

    /// The name of a subkey of `path` matching one of `names`.
    pub fn child(h: RegHive, path: &str, names: &[String]) -> Option<String> {
        let wanted: Vec<String> = names.iter().map(|n| super::key(n)).collect();
        let k = root(h).open_subkey_with_flags(path, KEY_READ).ok()?;
        k.enum_keys().flatten().find(|n| wanted.contains(&super::key(n)))
    }

    /// Subkeys and values directly in `path`.
    pub fn counts(h: RegHive, path: &str) -> (usize, usize) {
        root(h).open_subkey_with_flags(path, KEY_READ).map(|k| (k.enum_keys().count(), k.enum_values().count())).unwrap_or((usize::MAX, usize::MAX))
    }

    pub fn exists(h: RegHive, path: &str) -> bool {
        root(h).open_subkey_with_flags(path, KEY_READ).is_ok()
    }

    pub fn export(h: RegHive, path: &str, file: &Path) -> Result<(), String> {
        let out = super::hidden(std::process::Command::new(crate::os::windows_dir().join(r"System32\reg.exe")).arg("export").arg(full(h, path)).arg(file).arg("/y"))
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err("Couldn't back up the setting first, so it was left alone.".into()) }
    }

    pub fn delete(h: RegHive, path: &str) -> Result<(), String> {
        root(h).delete_subkey_all(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied { "Needs administrator rights.".to_string() } else { e.to_string() }
        })
    }

    pub fn import(file: &str) -> Result<(), String> {
        let out = super::hidden(std::process::Command::new(crate::os::windows_dir().join(r"System32\reg.exe")).arg("import").arg(file)).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err("Windows couldn't put some settings back. Restart as administrator and try Undo again.".into()) }
    }
}

#[cfg(windows)]
fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000)
}

#[cfg(windows)]
fn find_keys(name_list: &[String], publisher: &Option<String>) -> Vec<(RegHive, String)> {
    let bases = [(RegHive::CurrentUser, "Software"), (RegHive::LocalMachine, "SOFTWARE"), (RegHive::LocalMachine, r"SOFTWARE\WOW6432Node")];
    let mut found = Vec::new();
    for (h, base) in bases {
        if let Some(n) = reg::child(h, base, name_list) {
            found.push((h, format!(r"{base}\{n}")));
        }
        let Some(p) = publisher.as_ref().and_then(|p| reg::child(h, base, std::slice::from_ref(p))) else { continue };
        let pub_path = format!(r"{base}\{p}");
        if let Some(n) = reg::child(h, &pub_path, name_list) {
            // The whole publisher key when this app was all it held.
            if reg::counts(h, &pub_path) == (1, 0) && publisher.as_deref().is_some_and(usable) {
                found.push((h, pub_path));
            } else {
                found.push((h, format!(r"{pub_path}\{n}")));
            }
        }
    }
    found.dedup();
    found
}

#[cfg(not(windows))]
fn find_keys(_names: &[String], _publisher: &Option<String>) -> Vec<(RegHive, String)> {
    Vec::new()
}

#[tauri::command]
pub async fn find_app_leftovers(app: AppHandle, name: String, publisher: Option<String>, location: Option<String>) -> Result<Vec<Leftover>, String> {
    crate::blocking(move || {
        let (name_list, publisher) = names(&name, publisher.as_deref());
        if name_list.is_empty() {
            app.state::<Leftovers>().0.lock().clear();
            return Ok(Vec::new());
        }
        let elevated = crate::os::is_elevated();
        let mut targets = Vec::new();
        let mut list = Vec::new();
        for (path, note) in find_folders(&name_list, &publisher, location.as_deref()) {
            if crate::storage::check_leftover(&app, &path).is_err() {
                continue;
            }
            let shown = crate::storage::display(&path);
            let machine = ["ProgramFiles", "ProgramFiles(x86)", "ProgramData"].iter().filter_map(|v| std::env::var_os(v)).any(|d| path.starts_with(d));
            list.push(Leftover { id: targets.len(), kind: "folder", bytes: folder_size(&path), path: shown, note, needs_admin: machine && !elevated });
            targets.push(Target::Folder(path));
        }
        for (h, path) in find_keys(&name_list, &publisher) {
            #[cfg(windows)]
            let shown = reg::full(h, &path);
            #[cfg(not(windows))]
            let shown = path.clone();
            list.push(Leftover { id: targets.len(), kind: "registry", bytes: 0, path: shown, note: "Settings in the registry", needs_admin: h == RegHive::LocalMachine && !elevated });
            targets.push(Target::Key(h, path));
        }
        *app.state::<Leftovers>().0.lock() = targets;
        Ok(list)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverResult {
    pub removed: usize,
    pub bytes: u64,
    pub failed: Vec<LeftoverFailure>,
    pub activity_id: Option<String>,
}

#[derive(Serialize)]
pub struct LeftoverFailure {
    pub path: String,
    pub error: String,
}

#[tauri::command]
pub async fn remove_app_leftovers(app: AppHandle, ids: Vec<usize>, app_name: String) -> Result<LeftoverResult, String> {
    crate::blocking(move || {
        let state = app.state::<Leftovers>();
        let targets: Vec<Target> = {
            let all = state.0.lock();
            ids.iter().filter_map(|i| all.get(*i).cloned()).collect()
        };
        if targets.is_empty() {
            return Err("Nothing to remove. Look for leftovers again.".into());
        }
        let backups_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("leftover-backups");
        let deleted_at = chrono::Utc::now().timestamp();
        let (mut paths, mut backups, mut failed, mut bytes) = (Vec::new(), Vec::new(), Vec::new(), 0u64);
        for t in targets {
            match t {
                Target::Folder(p) => {
                    let shown = crate::storage::display(&p);
                    let size = folder_size(&p);
                    match crate::storage::check_leftover(&app, &p).and_then(|()| crate::storage::recycle_path(&app, &p)) {
                        Ok(()) if !p.exists() => {
                            bytes += size;
                            paths.push(shown);
                        }
                        Ok(()) => failed.push(LeftoverFailure { path: shown, error: "Some files are in use. Restart your PC and try again.".into() }),
                        Err(error) => failed.push(LeftoverFailure { path: shown, error }),
                    }
                }
                Target::Key(h, path) => {
                    #[cfg(windows)]
                    {
                        let shown = reg::full(h, &path);
                        if !reg::exists(h, &path) {
                            continue;
                        }
                        let _ = std::fs::create_dir_all(&backups_dir);
                        let file = backups_dir.join(format!("{}.reg", uuid::Uuid::new_v4()));
                        match reg::export(h, &path, &file).and_then(|()| reg::delete(h, &path)) {
                            Ok(()) => backups.push(file.to_string_lossy().into_owned()),
                            Err(error) => failed.push(LeftoverFailure { path: shown, error }),
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = (h, &backups_dir);
                        failed.push(LeftoverFailure { path, error: "Only on Windows".into() });
                    }
                }
            }
        }
        let removed = paths.len() + backups.len();
        let activity_id = if removed == 0 {
            None
        } else {
            let mut detail = paths.clone();
            detail.extend(backups.iter().map(|_| "A registry key (backed up)".to_string()));
            app.state::<ActivityLog>().record(
                &app,
                "Apps",
                format!("Removed {removed} {} left by {app_name} ({})", if removed == 1 { "leftover" } else { "leftovers" }, crate::storage::size_text(bytes)),
                Some(detail.join("\n")),
                Some(Undo::Leftovers { paths: paths.clone(), deleted_at, backups }),
            )
        };
        Ok(LeftoverResult { removed, bytes, failed, activity_id })
    })
    .await
}

/// Activity's Undo: files back from the Recycle Bin, registry keys back from their backups.
pub fn restore(paths: &[String], deleted_at: i64, backups: &[String]) -> Result<(), String> {
    if !paths.is_empty() {
        crate::storage::restore_from_recycle_bin(paths, deleted_at)?;
    }
    #[cfg(windows)]
    for file in backups {
        reg::import(file)?;
    }
    #[cfg(not(windows))]
    let _ = backups;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name("Notepad++ (64-bit x64)"), "Notepad++");
        assert_eq!(clean_name("Mozilla Firefox (x64 en-US)"), "Mozilla Firefox");
        assert_eq!(clean_name("7-Zip 24.08 (x64)"), "7-Zip");
        assert_eq!(clean_name("VLC media player"), "VLC media player");
        assert_eq!(clean_publisher("Valve Corporation"), "Valve");
        assert_eq!(clean_publisher("Spotify AB"), "Spotify AB");
    }

    #[test]
    fn picks_names_and_skips_shared_ones() {
        let (list, publisher) = names("Mozilla Firefox (x64 en-US)", Some("Mozilla"));
        assert_eq!(list, ["Mozilla Firefox", "Firefox"]);
        assert_eq!(publisher.as_deref(), Some("Mozilla"));
        assert!(names("Microsoft", Some("Microsoft Corporation")).0.is_empty());
        assert!(names("Go", None).0.is_empty());
    }

    #[test]
    fn finds_folders_by_name() {
        let base = std::env::temp_dir().join(format!("optimo-left-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Mozilla").join("Firefox")).unwrap();
        std::fs::create_dir_all(base.join("VideoLAN")).unwrap();
        assert_eq!(child(&base, &["videolan".into()]), Some(base.join("VideoLAN")));
        let moz = child(&base, &["Mozilla".into()]).unwrap();
        assert_eq!(child(&moz, &["Firefox".into()]), Some(base.join("Mozilla").join("Firefox")));
        assert_eq!(child(&base, &["Nothing".into()]), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
