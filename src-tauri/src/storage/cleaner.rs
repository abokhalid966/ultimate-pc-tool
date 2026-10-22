//! Cleanup categories for the Storage page: what each one covers, how much it would free, and
//! the cleaning itself. Everything goes through the safe temp cleaner's rules: links are never
//! followed, files in use are skipped (nothing is stopped to unlock them), and temp-style folders
//! keep anything changed in the last day.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

use crate::cleanup::{self, CleanReport};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CleanupKind {
    UserTemp,
    WindowsTemp,
    Thumbnails,
    RecycleBin,
    Edge,
    Chrome,
    Brave,
    Firefox,
    ErrorReports,
    SystemErrorReports,
    DeliveryOptimization,
    WindowsUpdate,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Browser {
    Edge,
    Chrome,
    Brave,
    Firefox,
}

impl Browser {
    fn name(self) -> &'static str {
        match self {
            Browser::Edge => "Microsoft Edge",
            Browser::Chrome => "Google Chrome",
            Browser::Brave => "Brave",
            Browser::Firefox => "Firefox",
        }
    }

    fn process(self) -> &'static str {
        match self {
            Browser::Edge => "msedge.exe",
            Browser::Chrome => "chrome.exe",
            Browser::Brave => "brave.exe",
            Browser::Firefox => "firefox.exe",
        }
    }

    /// The folder that holds the browser's profiles (and their caches) on this PC.
    fn data_dir(self) -> Option<PathBuf> {
        let local = local_app_data()?;
        Some(match self {
            Browser::Edge => local.join(r"Microsoft\Edge\User Data"),
            Browser::Chrome => local.join(r"Google\Chrome\User Data"),
            Browser::Brave => local.join(r"BraveSoftware\Brave-Browser\User Data"),
            // Firefox keeps only caches under Local; the profiles themselves live in Roaming.
            Browser::Firefox => local.join(r"Mozilla\Firefox\Profiles"),
        })
    }

    /// Cache folders only: never the profile folders themselves, where passwords, cookies,
    /// history and bookmarks are kept.
    fn cache_dirs(self) -> Vec<PathBuf> {
        let Some(data) = self.data_dir() else { return Vec::new() };
        let profiles = subfolders(&data);
        let mut dirs = Vec::new();
        if self == Browser::Firefox {
            for profile in profiles {
                dirs.extend(["cache2", "startupCache"].iter().map(|d| profile.join(d)));
            }
        } else {
            // A Chromium profile folder ("Default", "Profile 1"...) has a Preferences file.
            for profile in profiles.into_iter().filter(|p| p.join("Preferences").is_file()) {
                dirs.extend(CHROMIUM_PROFILE_CACHES.iter().map(|d| profile.join(d)));
            }
            dirs.extend(CHROMIUM_SHARED_CACHES.iter().map(|d| data.join(d)));
        }
        dirs.retain(|d| d.is_dir());
        dirs
    }
}

const CHROMIUM_PROFILE_CACHES: &[&str] = &["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const CHROMIUM_SHARED_CACHES: &[&str] = &["ShaderCache", "GrShaderCache", "GraphiteDawnCache"];

impl CleanupKind {
    pub const ALL: [CleanupKind; 12] = [
        CleanupKind::UserTemp,
        CleanupKind::WindowsTemp,
        CleanupKind::Thumbnails,
        CleanupKind::RecycleBin,
        CleanupKind::Edge,
        CleanupKind::Chrome,
        CleanupKind::Brave,
        CleanupKind::Firefox,
        CleanupKind::ErrorReports,
        CleanupKind::SystemErrorReports,
        CleanupKind::DeliveryOptimization,
        CleanupKind::WindowsUpdate,
    ];

    pub fn label(self) -> &'static str {
        match self {
            CleanupKind::UserTemp => "Temporary files",
            CleanupKind::WindowsTemp => "Windows temporary files",
            CleanupKind::Thumbnails => "Thumbnail previews",
            CleanupKind::RecycleBin => "Recycle Bin",
            CleanupKind::Edge => "Microsoft Edge cache",
            CleanupKind::Chrome => "Google Chrome cache",
            CleanupKind::Brave => "Brave cache",
            CleanupKind::Firefox => "Firefox cache",
            CleanupKind::ErrorReports => "Error reports",
            CleanupKind::SystemErrorReports => "Windows error reports and crash dumps",
            CleanupKind::DeliveryOptimization => "Delivery Optimization files",
            CleanupKind::WindowsUpdate => "Windows Update downloads",
        }
    }

    fn description(self) -> &'static str {
        match self {
            CleanupKind::UserTemp => "Leftovers from installers and apps. Anything used in the last day is kept.",
            CleanupKind::WindowsTemp => "Temporary files left by Windows and its services. Anything used in the last day is kept.",
            CleanupKind::Thumbnails => "Small previews of your pictures and videos. Windows makes new ones when it needs them.",
            CleanupKind::RecycleBin => "Files you deleted earlier. Once it's emptied, they can't be brought back.",
            CleanupKind::Edge | CleanupKind::Chrome | CleanupKind::Brave | CleanupKind::Firefox => {
                "Saved copies of websites that make pages open faster. Your passwords, history, bookmarks and sign-ins stay."
            }
            CleanupKind::ErrorReports => "Reports and crash files saved when an app stopped working. Only support technicians use them.",
            CleanupKind::SystemErrorReports => "Reports and memory dumps from Windows crashes. Only needed to investigate a crash.",
            CleanupKind::DeliveryOptimization => "Update pieces Windows keeps to share with other PCs. They're downloaded again if needed.",
            CleanupKind::WindowsUpdate => "Updates that were already downloaded. Windows downloads one again if it still needs it.",
        }
    }

    fn group(self) -> &'static str {
        match self {
            CleanupKind::UserTemp | CleanupKind::WindowsTemp | CleanupKind::Thumbnails | CleanupKind::RecycleBin => "files",
            CleanupKind::Edge | CleanupKind::Chrome | CleanupKind::Brave | CleanupKind::Firefox => "browsers",
            _ => "windows",
        }
    }

    pub fn needs_admin(self) -> bool {
        matches!(
            self,
            CleanupKind::WindowsTemp | CleanupKind::SystemErrorReports | CleanupKind::DeliveryOptimization | CleanupKind::WindowsUpdate
        )
    }

    /// Off by default: emptying the Recycle Bin can't be undone.
    fn suggested(self) -> bool {
        self != CleanupKind::RecycleBin
    }

    fn browser(self) -> Option<Browser> {
        match self {
            CleanupKind::Edge => Some(Browser::Edge),
            CleanupKind::Chrome => Some(Browser::Chrome),
            CleanupKind::Brave => Some(Browser::Brave),
            CleanupKind::Firefox => Some(Browser::Firefox),
            _ => None,
        }
    }

    fn targets(self) -> Vec<Target> {
        let windows = crate::os::windows_dir();
        let local = local_app_data();
        let program_data = std::env::var_os("ProgramData").map(PathBuf::from);
        let all = |dirs: Vec<Option<PathBuf>>, keep_recent: bool| -> Vec<Target> {
            dirs.into_iter().flatten().filter(|d| d.is_dir()).map(|path| Target::Dir { path, keep_recent }).collect()
        };
        match self {
            // Measured and cleaned by the temp cleaner itself, with its own checks.
            CleanupKind::UserTemp | CleanupKind::RecycleBin => Vec::new(),
            CleanupKind::WindowsTemp => all(vec![Some(windows.join("Temp"))], true),
            CleanupKind::Thumbnails => local
                .map(|l| l.join(r"Microsoft\Windows\Explorer"))
                .filter(|d| d.is_dir())
                .map(|dir| vec![Target::Files { dir, prefix: "thumbcache_", suffix: ".db" }])
                .unwrap_or_default(),
            CleanupKind::Edge | CleanupKind::Chrome | CleanupKind::Brave | CleanupKind::Firefox => {
                self.browser().map(Browser::cache_dirs).unwrap_or_default().into_iter().map(|path| Target::Dir { path, keep_recent: false }).collect()
            }
            CleanupKind::ErrorReports => {
                let wer = local.as_ref().map(|l| l.join(r"Microsoft\Windows\WER"));
                all(
                    vec![wer.as_ref().map(|w| w.join("ReportArchive")), wer.as_ref().map(|w| w.join("ReportQueue")), local.map(|l| l.join("CrashDumps"))],
                    false,
                )
            }
            CleanupKind::SystemErrorReports => {
                let wer = program_data.map(|p| p.join(r"Microsoft\Windows\WER"));
                let mut targets = all(
                    vec![
                        wer.as_ref().map(|w| w.join("ReportArchive")),
                        wer.as_ref().map(|w| w.join("ReportQueue")),
                        wer.as_ref().map(|w| w.join("Temp")),
                        Some(windows.join("Minidump")),
                        Some(windows.join("LiveKernelReports")),
                    ],
                    false,
                );
                let dump = windows.join("MEMORY.DMP");
                if dump.is_file() {
                    targets.push(Target::File(dump));
                }
                targets
            }
            CleanupKind::DeliveryOptimization => all(
                vec![
                    Some(windows.join(r"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache")),
                    Some(windows.join(r"SoftwareDistribution\DeliveryOptimization")),
                ],
                true,
            ),
            CleanupKind::WindowsUpdate => all(vec![Some(windows.join(r"SoftwareDistribution\Download"))], true),
        }
    }
}

enum Target {
    /// Everything inside a folder (the folder itself stays).
    Dir { path: PathBuf, keep_recent: bool },
    /// Files directly in a folder whose names match, e.g. `thumbcache_*.db`.
    Files { dir: PathBuf, prefix: &'static str, suffix: &'static str },
    File(PathBuf),
}

impl Target {
    fn location(&self) -> String {
        match self {
            Target::Dir { path, .. } | Target::File(path) => cleanup::display(path),
            Target::Files { dir, prefix, suffix } => format!("{}\\{prefix}*{suffix}", cleanup::display(dir)),
        }
    }

    /// Adds what was (or, for a dry run, would be) removed to `report`. Returns false when the
    /// folder couldn't be looked into at all.
    fn clean(&self, dry_run: bool, report: &mut CleanReport) -> bool {
        match self {
            Target::Dir { path, keep_recent } => {
                if fs::read_dir(path).is_err() {
                    return false;
                }
                let cutoff = if *keep_recent {
                    SystemTime::now().checked_sub(cleanup::MIN_AGE).unwrap_or(SystemTime::UNIX_EPOCH)
                } else {
                    // Caches and reports: everything counts, whatever its age.
                    SystemTime::now() + Duration::from_secs(24 * 60 * 60)
                };
                cleanup::clean_dir(path, cutoff, dry_run, report);
                true
            }
            Target::Files { dir, prefix, suffix } => {
                let Ok(entries) = fs::read_dir(dir) else { return false };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with(prefix) && name.ends_with(suffix) {
                        remove(&entry.path(), dry_run, report);
                    }
                }
                true
            }
            Target::File(path) => {
                remove(path, dry_run, report);
                true
            }
        }
    }
}

fn remove(path: &Path, dry_run: bool, report: &mut CleanReport) {
    let Ok(meta) = fs::symlink_metadata(path) else { return };
    if !meta.is_file() || cleanup::is_link(&meta) {
        return;
    }
    if dry_run || cleanup::remove_file(path, &meta) {
        report.files += 1;
        report.bytes += meta.len();
    } else {
        // In use (e.g. Explorer holds the current thumbnail cache open): left alone.
        report.skipped += 1;
    }
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute())
}

fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
        .map(|e| e.path())
        .collect()
}

/// Browsers with at least one window or background process running.
fn running_browsers() -> HashSet<&'static str> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let names: HashSet<String> = sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).collect();
    [Browser::Edge, Browser::Chrome, Browser::Brave, Browser::Firefox]
        .into_iter()
        .filter(|b| names.contains(b.process()))
        .map(Browser::process)
        .collect()
}

fn running_message(browser: Browser) -> String {
    format!(
        "{} is open. Close it to clean its cache. If it keeps running in the background, turn off its \"keep running\" or \"startup boost\" option.",
        browser.name()
    )
}

const ADMIN_MESSAGE: &str = "Needs administrator rights. Use Restart as administrator to clean this.";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCategory {
    pub kind: CleanupKind,
    pub label: &'static str,
    pub description: &'static str,
    /// "files", "browsers" or "windows", for grouping on the page.
    pub group: &'static str,
    pub needs_admin: bool,
    /// Ticked when the page opens.
    pub suggested: bool,
    /// The folders or files it covers.
    pub locations: Vec<String>,
    /// False when it doesn't apply to this PC (e.g. a browser that isn't installed).
    pub present: bool,
    pub bytes: u64,
    pub files: u64,
    /// Why it can't be cleaned right now (a browser is open, administrator rights needed).
    pub blocked: Option<String>,
    /// The size couldn't be measured (some folders only open for administrators).
    pub unmeasured: bool,
}

/// Measures one category without changing anything.
pub fn measure(kind: CleanupKind, running: &HashSet<&'static str>, elevated: bool) -> CleanupCategory {
    let mut c = CleanupCategory {
        kind,
        label: kind.label(),
        description: kind.description(),
        group: kind.group(),
        needs_admin: kind.needs_admin(),
        suggested: kind.suggested(),
        locations: Vec::new(),
        present: true,
        bytes: 0,
        files: 0,
        blocked: (kind.needs_admin() && !elevated).then(|| ADMIN_MESSAGE.to_string()),
        unmeasured: false,
    };
    match kind {
        CleanupKind::UserTemp => match cleanup::clean_temp(true) {
            Ok(r) => {
                c.locations.push(r.folder);
                (c.bytes, c.files) = (r.bytes, r.files);
            }
            Err(e) => {
                c.blocked = Some(e);
                c.unmeasured = true;
            }
        },
        #[cfg(windows)]
        CleanupKind::RecycleBin => {
            c.locations.push("All drives".into());
            match super::win::recycle_bin_size() {
                Ok((bytes, items)) => (c.bytes, c.files) = (bytes, items),
                Err(_) => c.unmeasured = true,
            }
        }
        _ => {
            if let Some(browser) = kind.browser() {
                c.present = browser.data_dir().is_some_and(|d| d.is_dir());
                if running.contains(browser.process()) {
                    c.blocked = Some(running_message(browser));
                }
            }
            let mut report = CleanReport::default();
            for target in kind.targets() {
                c.locations.push(target.location());
                if !target.clean(true, &mut report) {
                    c.unmeasured = true;
                }
            }
            (c.bytes, c.files) = (report.bytes, report.files);
        }
    }
    c
}

/// Measures every category in parallel, calling `on_measured` as each one finishes.
pub fn measure_all(on_measured: impl Fn(&CleanupCategory) + Sync) -> Vec<CleanupCategory> {
    let running = running_browsers();
    let elevated = crate::os::is_elevated();
    let mut list: Vec<CleanupCategory> = std::thread::scope(|s| {
        let handles: Vec<_> = CleanupKind::ALL
            .into_iter()
            .map(|kind| {
                let (running, on_measured) = (&running, &on_measured);
                s.spawn(move || {
                    let c = measure(kind, running, elevated);
                    on_measured(&c);
                    c
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    list.retain(|c| c.present);
    list
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub kind: CleanupKind,
    pub label: &'static str,
    pub files: u64,
    pub bytes: u64,
    /// Files left alone because they are new or in use.
    pub skipped: u64,
    /// Why nothing was cleaned.
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CleanupRunEvent {
    Started { kind: CleanupKind },
    Finished { result: CleanupResult },
}

/// Cleans the chosen categories one after another.
pub fn clean(kinds: &[CleanupKind], on_event: impl Fn(CleanupRunEvent)) -> Vec<CleanupResult> {
    let elevated = crate::os::is_elevated();
    let running = if kinds.iter().any(|k| k.browser().is_some()) { running_browsers() } else { HashSet::new() };
    let mut results = Vec::new();
    for kind in CleanupKind::ALL.into_iter().filter(|k| kinds.contains(k)) {
        on_event(CleanupRunEvent::Started { kind });
        let mut result = CleanupResult { kind, label: kind.label(), files: 0, bytes: 0, skipped: 0, error: None };
        if kind.needs_admin() && !elevated {
            result.error = Some(ADMIN_MESSAGE.into());
        } else if let Some(browser) = kind.browser().filter(|b| running.contains(b.process())) {
            result.error = Some(running_message(browser));
        } else {
            match kind {
                CleanupKind::UserTemp => match cleanup::clean_temp(false) {
                    Ok(r) => (result.files, result.bytes, result.skipped) = (r.files, r.bytes, r.skipped),
                    Err(e) => result.error = Some(e),
                },
                #[cfg(windows)]
                CleanupKind::RecycleBin => match super::win::recycle_bin_size() {
                    Ok((0, 0)) => {}
                    Ok((bytes, items)) => match super::win::empty_recycle_bin() {
                        Ok(()) => (result.files, result.bytes) = (items, bytes),
                        Err(e) => result.error = Some(e),
                    },
                    Err(e) => result.error = Some(format!("Couldn't read the Recycle Bin: {e}")),
                },
                _ => {
                    let mut report = CleanReport::default();
                    for target in kind.targets() {
                        target.clean(false, &mut report);
                    }
                    (result.files, result.bytes, result.skipped) = (report.files, report.bytes, report.skipped);
                }
            }
        }
        on_event(CleanupRunEvent::Finished { result: result.clone() });
        results.push(result);
    }
    results
}
