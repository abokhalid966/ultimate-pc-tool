//! App updates and installs through Windows Package Manager (winget), run directly (no shell) with
//! the same job-object runner as commands, so output streams live and a run can be stopped.

mod table;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::actions::ActivityLog;
use crate::commands::{self, RunEvent, Runs, StopReason};
pub use table::{Action, AppUpgrade, ListedPackage};
use table::Meaning;

/// Listing reads the package catalog, which can take a while the first time.
const LIST_TIMEOUT: Duration = Duration::from_secs(150);
/// Large apps (Visual Studio, games) can take long to download and install.
const RUN_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// App Installer, which contains winget, in the Microsoft Store.
const APP_INSTALLER_URL: &str = "ms-windows-store://pdp/?productid=9NBLGGH4NNS1";
const MISSING: &str = "Windows Package Manager (winget) isn't installed. Get the free App Installer from the Microsoft Store, then try again.";

/// winget.exe: on PATH, or the App Installer alias in the user's WindowsApps folder (which some
/// PATH changes drop). Checked without following the alias, which plain metadata can't read.
fn winget_exe() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).map(|dir| dir.join("winget.exe"));
    let alias = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\WindowsApps\winget.exe"));
    on_path.chain(alias).find(|p| std::fs::symlink_metadata(p).is_ok())
}

/// Runs winget to completion without live output (for the lists).
fn capture(exe: PathBuf, args: &[&str]) -> Result<(String, Option<i32>), String> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    let quiet = Channel::new(|_| Ok(()));
    let out = commands::run_program(&Runs::default(), "winget-list", cmd, "winget", LIST_TIMEOUT, quiet)?;
    if out.stopped.is_some() {
        return Err("winget took too long to answer. Check your internet connection, then try again.".into());
    }
    Ok((out.stdout, out.code))
}

/// A list command found nothing to show: no table, but nothing went wrong either.
fn empty_or_error(output: &str, code: Option<i32>, what: &str) -> Result<(), String> {
    match code.map(|c| c as u32) {
        Some(0 | table::NO_APPLICATIONS_FOUND | table::UPDATE_NOT_APPLICABLE) => Ok(()),
        code => {
            let reason = table::last_message(&table::clean_output(output)).unwrap_or_else(|| "it gave no reason".into());
            let code = code.map(|c| format!(" (code {})", table::code_label(c as i32))).unwrap_or_default();
            Err(format!("Couldn't check {what}{code}: {reason}"))
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeList {
    pub winget_missing: bool,
    pub upgrades: Vec<AppUpgrade>,
}

#[tauri::command]
pub async fn winget_list_upgrades() -> Result<UpgradeList, String> {
    crate::blocking(list_upgrades).await
}

pub fn list_upgrades() -> Result<UpgradeList, String> {
    let Some(exe) = winget_exe() else {
        return Ok(UpgradeList { winget_missing: true, upgrades: Vec::new() });
    };
    let (output, code) = capture(exe, &["upgrade", "--accept-source-agreements", "--disable-interactivity"])?;
    let upgrades = table::parse_upgrades(&output);
    if upgrades.is_empty() {
        empty_or_error(&output, code, "for app updates")?;
    }
    Ok(UpgradeList { winget_missing: false, upgrades })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackages {
    pub winget_missing: bool,
    pub packages: Vec<ListedPackage>,
}

/// Everything winget sees as installed, to mark the toolkit's apps that are already there.
#[tauri::command]
pub async fn winget_list_installed() -> Result<InstalledPackages, String> {
    crate::blocking(|| {
        let Some(exe) = winget_exe() else {
            return Ok(InstalledPackages { winget_missing: true, packages: Vec::new() });
        };
        let (output, code) = capture(exe, &["list", "--accept-source-agreements", "--disable-interactivity"])?;
        let packages = table::parse_listed(&output);
        if packages.is_empty() {
            empty_or_error(&output, code, "your installed apps")?;
        }
        Ok(InstalledPackages { winget_missing: false, packages })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    id: String,
    name: String,
    #[serde(default)]
    source: Option<String>,
    /// winget shortened the id in its table, so it is matched as a prefix.
    #[serde(default)]
    partial_id: bool,
    /// The version being installed, for the activity log.
    #[serde(default)]
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WingetOutcome {
    pub ok: bool,
    /// Nothing changed: already installed or already up to date.
    pub unchanged: bool,
    pub restart_needed: bool,
    pub stopped: Option<StopReason>,
    /// One plain-language sentence.
    pub message: String,
    /// winget's result code as its documentation writes it, for the details.
    pub code: Option<String>,
    /// winget's output without spinners and progress bars.
    pub output: String,
}

/// Installs or updates one app, streaming winget's output through `on_event`. Stopped with
/// `cancel_command(run_id)`.
#[tauri::command]
pub async fn winget_run(app: AppHandle, run_id: String, action: Action, pkg: Package, on_event: Channel<RunEvent>) -> Result<WingetOutcome, String> {
    crate::blocking(move || {
        let exe = winget_exe().ok_or(MISSING)?;
        let args = table::run_args(action, &pkg.id, pkg.partial_id, pkg.source.as_deref())?;
        let mut cmd = Command::new(exe);
        cmd.args(&args);
        let out = commands::run_program(&app.state::<Runs>(), &run_id, cmd, "winget", RUN_TIMEOUT, on_event)?;
        let output = table::clean_output(&[out.stdout.as_str(), out.stderr.as_str()].join("\n"));
        let outcome = outcome(action, out.code, out.stopped, output);

        if outcome.ok && !outcome.unchanged {
            let description = match (action, pkg.version.as_deref()) {
                (Action::Install, _) => format!("Installed \"{}\"", pkg.name),
                (Action::Upgrade, Some(v)) => format!("Updated \"{}\" to version {v}", pkg.name),
                (Action::Upgrade, None) => format!("Updated \"{}\"", pkg.name),
            };
            let detail = Some(format!("winget {}", args.join(" ")));
            app.state::<ActivityLog>().record(&app, "Apps", description, detail, None);
        }
        Ok(outcome)
    })
    .await
}

fn outcome(action: Action, code: Option<i32>, stopped: Option<StopReason>, output: String) -> WingetOutcome {
    let done = match action {
        Action::Install => "Installed.",
        Action::Upgrade => "Updated.",
    };
    let base = WingetOutcome { ok: false, unchanged: false, restart_needed: false, stopped, message: String::new(), code: code.map(table::code_label), output };
    if let Some(reason) = stopped {
        let message = match reason {
            StopReason::Cancelled => "Stopped before it finished.",
            StopReason::TimedOut => "Stopped because it took longer than 45 minutes.",
        };
        return WingetOutcome { message: message.into(), ..base };
    }
    let Some(code) = code else {
        return WingetOutcome { message: "winget stopped unexpectedly.".into(), ..base };
    };
    match table::meaning(code) {
        Meaning::Success => WingetOutcome { ok: true, message: done.into(), ..base },
        Meaning::Restart => WingetOutcome { ok: true, restart_needed: true, message: format!("{done} Restart your PC to finish."), ..base },
        Meaning::Unchanged(text) => {
            let message = if action == Action::Install { "Already installed." } else { text };
            WingetOutcome { ok: true, unchanged: true, message: message.into(), ..base }
        }
        Meaning::Failure(text) => WingetOutcome { message: text.into(), ..base },
        Meaning::Unknown => {
            let said = table::last_message(&base.output).map(|l| format!(" winget said: {l}")).unwrap_or_default();
            WingetOutcome { message: format!("Something went wrong (code {}).{said}", table::code_label(code)), ..base }
        }
    }
}

/// Opens App Installer in the Microsoft Store, for PCs without winget.
#[tauri::command(async)]
pub fn open_app_installer_page() -> Result<(), String> {
    tauri_plugin_opener::open_url(APP_INSTALLER_URL, None::<&str>).map_err(|e| format!("Couldn't open the Microsoft Store: {e}"))
}
