//! Saved command library and one-shot command execution.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::ipc::Channel;

use crate::os;
use crate::store;

const FILE: &str = "commands.json";
pub const BUILTIN_PREFIX: &str = "builtin.";
/// Commands that run longer than this are stopped.
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How much output is kept per stream (the newest part).
const OUTPUT_CAP: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    #[default]
    Powershell,
    Cmd,
}

impl Shell {
    pub fn label(self) -> &'static str {
        match self {
            Shell::Powershell => "PowerShell",
            Shell::Cmd => "Command Prompt",
        }
    }
}

/// How careful the user should be before running a command.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    #[default]
    Safe,
    Caution,
    Danger,
}

/// Every field has a default so files written by older or newer versions still load.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub description: String,
    /// May contain `{variable}` placeholders that the UI asks for before running.
    pub command: String,
    pub shell: Shell,
    pub admin: bool,
    pub category: String,
    pub risk: Risk,
    /// Plain-language note shown before running a risky command.
    pub warning: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Cancelled,
    TimedOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    /// True when the command was handed to an elevated window, so no output is captured.
    pub elevated: bool,
    /// Set when the run was stopped before it finished.
    pub stopped: Option<StopReason>,
    /// True when only the last part of a very long output was kept.
    pub truncated: bool,
}

/// Live output while a command runs. The final `CommandOutput` replaces it.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEvent {
    Output { stderr: bool, data: String },
}

#[derive(Default)]
pub struct CommandLibrary(Mutex<Option<Vec<SavedCommand>>>);

fn builtin(id: &str, name: &str, description: &str, command: &str, admin: bool, category: &str) -> SavedCommand {
    SavedCommand {
        id: format!("{BUILTIN_PREFIX}{id}"),
        name: name.into(),
        description: description.into(),
        command: command.into(),
        shell: Shell::Powershell,
        admin,
        category: category.into(),
        risk: Risk::Safe,
        warning: None,
    }
}

impl SavedCommand {
    fn risky(mut self, risk: Risk, warning: &str) -> Self {
        self.risk = risk;
        self.warning = Some(warning.into());
        self
    }
}

const BATTERY_REPORT: &str = "$d=[Environment]::GetFolderPath('Desktop'); powercfg /batteryreport /output \"$d\\battery-report.html\"; if ($LASTEXITCODE -eq 0) { Start-Process \"$d\\battery-report.html\"; \"Saved to $d\\battery-report.html\" }";

/// Exact texts of built-ins from v0.1 that have since been replaced.
const LEGACY_BATTERY_REPORT: &str = "powercfg /batteryreport /output \"$env:USERPROFILE\\Desktop\\battery-report.html\"";
const LEGACY_CLEAR_TEMP: &str = "Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; 'Temp folder cleaned'";

/// Built-in descriptions from v0.1, written for technical users. A built-in whose description is
/// still exactly this gets the new plain-language text; one the user edited is left alone.
const LEGACY_DESCRIPTIONS: &[(&str, &str)] = &[
    ("flush-dns", "Clear the DNS cache to fix sites that won't load"),
    ("ip-config", "IP addresses, gateway and DNS for every adapter"),
    ("ping", "Check if a website or device responds"),
    ("reset-network", "Reset Winsock and TCP/IP (restart afterwards)"),
    ("public-ip", "Show your internet-facing IP"),
    ("restart-explorer", "Fix a frozen taskbar or desktop"),
    ("sfc", "Scan and repair Windows system files (SFC)"),
    ("dism", "DISM health restore, run before SFC if it fails"),
    ("battery-report", "Generate a battery health report on your desktop"),
    ("battery-report", "Generate a battery health report on your desktop and open it"),
    ("drive-health", "Physical disk health status"),
    ("update-apps", "Upgrade every installed app with winget"),
    ("list-updates", "See which apps have updates available"),
];

pub fn defaults() -> Vec<SavedCommand> {
    vec![
        builtin("flush-dns", "Flush DNS", "Fixes websites that won't load or open the wrong page, by clearing saved web addresses.", "ipconfig /flushdns", false, "Network"),
        builtin("ip-config", "Show IP configuration", "Shows your network addresses, router and DNS details for every connection.", "ipconfig /all", false, "Network"),
        builtin("ping", "Ping a host", "Checks whether a website or device answers, and how fast.", "ping -n 4 {host}", false, "Network"),
        builtin("reset-network", "Reset network stack", "Fixes stubborn internet problems by resetting network settings. Restart afterwards.", "netsh winsock reset; netsh int ip reset", true, "Network")
            .risky(Risk::Danger, "Resets all network settings, including any static IP address or DNS server you set, and can remove VPN network parts. Restart the PC afterwards."),
        builtin("public-ip", "Public IP address", "Shows the address the internet sees for your connection.", "(Invoke-RestMethod -Uri 'https://api.ipify.org')", false, "Network"),
        builtin("restart-explorer", "Restart Explorer", "Fixes a frozen taskbar, Start menu or desktop.", "Stop-Process -Name explorer -Force; Start-Process explorer", false, "System")
            .risky(Risk::Caution, "Closes every File Explorer window and briefly hides the taskbar and desktop. File copies in progress are cancelled."),
        builtin("sfc", "Check system files", "Finds and repairs damaged Windows files. Takes 10 to 20 minutes.", "sfc /scannow", true, "Repair"),
        builtin("dism", "Repair Windows image", "Repairs Windows itself when Check system files can't. Takes 15 to 30 minutes.", "DISM /Online /Cleanup-Image /RestoreHealth", true, "Repair"),
        builtin("battery-report", "Battery report", "Saves a battery health report to your desktop and opens it.", BATTERY_REPORT, false, "System"),
        builtin("drive-health", "Drive health", "Shows whether your drives report any health problems.", "Get-PhysicalDisk | Format-Table FriendlyName, MediaType, HealthStatus, Size -AutoSize | Out-String -Width 200", false, "System"),
        builtin("update-apps", "Update all apps", "Installs all available updates for your apps.", "winget upgrade --all --accept-source-agreements --accept-package-agreements", true, "Apps")
            .risky(Risk::Caution, "Installs every available app update without asking and accepts their licenses. Apps being updated may close."),
        builtin("list-updates", "List app updates", "Shows which of your apps have updates waiting.", "winget upgrade --accept-source-agreements | Out-String -Width 200", false, "Apps"),
    ]
}

/// Upgrades a library saved by an older version: built-ins get stable ids (so they can be restored
/// and updated), replaced built-ins get their new text, and the old temp cleaner is dropped in
/// favour of the safe built-in one. Returns true when anything changed.
fn migrate(list: &mut Vec<SavedCommand>) -> bool {
    let before = list.len();
    list.retain(|c| c.command != LEGACY_CLEAR_TEMP);
    let mut changed = list.len() != before;

    let defaults = defaults();
    let mut taken: Vec<String> = list.iter().filter(|c| c.id.starts_with(BUILTIN_PREFIX)).map(|c| c.id.clone()).collect();
    for c in list.iter_mut().filter(|c| !c.id.starts_with(BUILTIN_PREFIX)) {
        let current = if c.command == LEGACY_BATTERY_REPORT { BATTERY_REPORT } else { c.command.as_str() };
        let Some(d) = defaults.iter().find(|d| d.command == current && !taken.contains(&d.id)) else {
            continue;
        };
        taken.push(d.id.clone());
        c.id = d.id.clone();
        c.command = d.command.clone();
        c.risk = d.risk;
        c.warning = d.warning.clone();
        changed = true;
    }

    for c in list.iter_mut() {
        let Some(key) = c.id.strip_prefix(BUILTIN_PREFIX) else { continue };
        let untouched = LEGACY_DESCRIPTIONS.iter().any(|(k, old)| *k == key && c.description == *old);
        if let (true, Some(d)) = (untouched, defaults.iter().find(|d| d.id == c.id)) {
            c.description = d.description.clone();
            changed = true;
        }
    }
    changed
}

impl CommandLibrary {
    /// Runs `f` on the loaded list. A file that exists but can't be read is reported, never replaced.
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<SavedCommand>) -> Result<R, String>) -> Result<R, String> {
        let mut guard = self.0.lock();
        if guard.is_none() {
            let list = match store::load::<Vec<SavedCommand>>(app, FILE)? {
                Some(mut list) => {
                    if migrate(&mut list) {
                        store::save(app, FILE, &list)?;
                    }
                    list
                }
                None => {
                    let seeded = defaults();
                    store::save(app, FILE, &seeded)?;
                    seeded
                }
            };
            *guard = Some(list);
        }
        f(guard.as_mut().expect("loaded above"))
    }

    /// Applies a change to a copy and keeps it only once it is saved, so memory and disk agree.
    fn change<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<SavedCommand>) -> R) -> Result<R, String> {
        self.with(app, |list| {
            let mut next = list.clone();
            let result = f(&mut next);
            store::save(app, FILE, &next)?;
            *list = next;
            Ok(result)
        })
    }

    pub fn list(&self, app: &AppHandle) -> Result<Vec<SavedCommand>, String> {
        self.with(app, |list| Ok(list.clone()))
    }

    pub fn upsert(&self, app: &AppHandle, mut cmd: SavedCommand) -> Result<SavedCommand, String> {
        if cmd.name.trim().is_empty() || cmd.command.trim().is_empty() {
            return Err("Name and command are required".into());
        }
        if cmd.id.is_empty() {
            cmd.id = uuid::Uuid::new_v4().to_string();
        }
        self.change(app, |list| {
            match list.iter_mut().find(|c| c.id == cmd.id) {
                Some(existing) => *existing = cmd.clone(),
                None => list.push(cmd.clone()),
            }
            cmd
        })
    }

    /// Removes a command and returns it, so the deletion can be undone.
    pub fn delete(&self, app: &AppHandle, id: &str) -> Result<SavedCommand, String> {
        self.change(app, |list| {
            let index = list.iter().position(|c| c.id == id)?;
            Some(list.remove(index))
        })?
        .ok_or_else(|| "That command no longer exists".into())
    }

    /// Adds back any built-in command the user deleted. Returns how many were added.
    pub fn restore_builtins(&self, app: &AppHandle) -> Result<usize, String> {
        self.change(app, |list| {
            let missing: Vec<SavedCommand> = defaults().into_iter().filter(|d| !list.iter().any(|c| c.id == d.id)).collect();
            let count = missing.len();
            list.extend(missing);
            count
        })
    }
}

#[cfg(windows)]
fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Runs that are still going, so the UI can stop them.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Runs {
    pub fn cancel(&self, run_id: &str) {
        if let Some(flag) = self.0.lock().get(run_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Runs a command to completion and captures its output, streaming it live through `events`.
/// Elevated commands open a separate administrator window (after the UAC prompt) that stays open.
pub fn run(runs: &Runs, run_id: &str, command: &str, shell: Shell, admin: bool, events: Channel<RunEvent>) -> Result<CommandOutput, String> {
    if admin {
        return run_elevated(command, shell);
    }

    let cmd = match shell {
        Shell::Powershell => {
            let mut c = Command::new(os::powershell_exe());
            // Force UTF-8 so non-English output isn't garbled.
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {command}"),
            ]);
            c
        }
        Shell::Cmd => cmd_command(command),
    };
    run_program(runs, run_id, cmd, shell.label(), RUN_TIMEOUT, events)
}

/// Runs a program directly (no shell) the same way: in a job object, with live output through
/// `events`, stoppable with `Runs::cancel(run_id)`, and stopped after `timeout`. `what` names the
/// program in the error shown when it can't start.
pub fn run_program(
    runs: &Runs,
    run_id: &str,
    mut cmd: Command,
    what: &str,
    timeout: Duration,
    events: Channel<RunEvent>,
) -> Result<CommandOutput, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let job = Job::new();
    let mut child = hidden(&mut cmd).spawn().map_err(|e| format!("Couldn't start {what}: {e}"))?;
    if let Some(job) = &job {
        job.assign(&child);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    runs.0.lock().insert(run_id.to_owned(), cancel.clone());
    let finished = Arc::new(AtomicBool::new(false));
    let stdout = Capture::start(child.stdout.take(), false, events.clone(), finished.clone());
    let stderr = Capture::start(child.stderr.take(), true, events, finished.clone());

    let started = Instant::now();
    let mut stopped = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => {
                stop(&job, &mut child);
                break child.wait().ok();
            }
        }
        if cancel.load(Ordering::SeqCst) {
            stopped = Some(StopReason::Cancelled);
        } else if started.elapsed() > timeout {
            stopped = Some(StopReason::TimedOut);
        }
        if stopped.is_some() {
            stop(&job, &mut child);
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(100));
    };
    runs.0.lock().remove(run_id);
    if let Some(job) = job
        && stopped.is_none()
    {
        // Programs the command opened (e.g. `Start-Process notepad`) keep running.
        job.release();
    }

    // A program the command started may hold the pipes open, so only wait briefly for them.
    let (out, out_cut) = stdout.finish(Duration::from_secs(1));
    let (err, err_cut) = stderr.finish(Duration::from_millis(200));
    finished.store(true, Ordering::SeqCst);
    let truncated = out_cut || err_cut;
    let mut stdout = os::decode_output(&out);
    if out_cut {
        stdout.insert_str(0, "[Output truncated: showing the last 1 MB]\n");
    }
    Ok(CommandOutput {
        stdout,
        stderr: os::decode_output(&err),
        code: if stopped.is_some() { None } else { status.and_then(|s| s.code()) },
        elevated: false,
        stopped,
        truncated,
    })
}

#[cfg(windows)]
fn cmd_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new(os::cmd_exe());
    // cmd doesn't understand the usual argument escaping, so pass the text unchanged: with /S it
    // strips exactly the outer quotes. /D skips AutoRun hooks, and chcp switches output to UTF-8.
    c.args(["/D", "/S", "/C"]).raw_arg(format!("\"chcp 65001>nul & {command}\""));
    c
}

#[cfg(not(windows))]
fn cmd_command(command: &str) -> Command {
    let mut c = Command::new("sh");
    c.args(["-c", command]);
    c
}

/// Opens an administrator window running the command, without passing it through another shell.
fn run_elevated(command: &str, shell: Shell) -> Result<CommandOutput, String> {
    let (program, params) = match shell {
        Shell::Powershell => (os::powershell_exe(), format!("-NoExit -NoProfile -EncodedCommand {}", encode_ps(command))),
        Shell::Cmd => (os::cmd_exe(), format!("/D /S /K \"{command}\"")),
    };
    match os::run_elevated(&program, &params) {
        Ok(()) => Ok(CommandOutput {
            stdout: "Opened in an administrator window.".into(),
            stderr: String::new(),
            code: None,
            elevated: true,
            stopped: None,
            truncated: false,
        }),
        Err(os::ElevateError::Cancelled) => Err("You chose No on the administrator prompt, so nothing was run.".into()),
        Err(os::ElevateError::Failed(e)) => Err(format!("Couldn't open an administrator window: {e}")),
    }
}

fn stop(job: &Option<Job>, child: &mut Child) {
    // Ending the job ends everything the command started, e.g. ping.exe under cmd.exe.
    if !job.as_ref().is_some_and(Job::terminate) {
        let _ = child.kill();
    }
}

/// Collects one output pipe on a background thread, keeping the newest `OUTPUT_CAP` bytes.
struct Capture {
    data: Mutex<(Vec<u8>, bool)>,
    done: AtomicBool,
}

impl Capture {
    fn start(pipe: Option<impl Read + Send + 'static>, stderr: bool, events: Channel<RunEvent>, finished: Arc<AtomicBool>) -> Arc<Self> {
        let capture = Arc::new(Capture { data: Mutex::new((Vec::new(), false)), done: AtomicBool::new(pipe.is_none()) });
        let Some(mut pipe) = pipe else { return capture };
        let shared = capture.clone();
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut pending = Vec::new();
            let mut live = String::new();
            let mut last_send = Instant::now();
            let mut streamed = 0usize;
            loop {
                let n = match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                {
                    let mut data = shared.data.lock();
                    data.0.extend_from_slice(&chunk[..n]);
                    if data.0.len() > OUTPUT_CAP * 2 {
                        let cut = data.0.len() - OUTPUT_CAP;
                        data.0.drain(..cut);
                        data.1 = true;
                    }
                }
                // Live view: batch small reads, and stop streaming after the cap (the final result has the rest).
                if streamed < OUTPUT_CAP && !finished.load(Ordering::SeqCst) {
                    pending.extend_from_slice(&chunk[..n]);
                    live.push_str(&crate::terminal::take_valid_utf8(&mut pending));
                    if last_send.elapsed() >= Duration::from_millis(100) || live.len() > 32 * 1024 {
                        streamed += live.len();
                        let _ = events.send(RunEvent::Output { stderr, data: std::mem::take(&mut live) });
                        last_send = Instant::now();
                    }
                }
            }
            if !live.is_empty() && !finished.load(Ordering::SeqCst) {
                let _ = events.send(RunEvent::Output { stderr, data: live });
            }
            shared.done.store(true, Ordering::SeqCst);
        });
        capture
    }

    /// Waits up to `grace` for the pipe to close, then returns what was captured and whether it was cut.
    fn finish(&self, grace: Duration) -> (Vec<u8>, bool) {
        let until = Instant::now() + grace;
        while !self.done.load(Ordering::SeqCst) && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let mut data = self.data.lock();
        let (bytes, mut cut) = std::mem::take(&mut *data);
        let mut bytes = bytes;
        if bytes.len() > OUTPUT_CAP {
            bytes.drain(..bytes.len() - OUTPUT_CAP);
            cut = true;
        }
        if cut {
            // Don't start in the middle of a UTF-8 character.
            let skip = bytes.iter().take(3).take_while(|b| (**b & 0xC0) == 0x80).count();
            bytes.drain(..skip);
        }
        (bytes, cut)
    }
}

/// A Windows job object holding a running command and everything it starts. If the app exits
/// while the command runs, Windows ends the whole tree.
#[cfg(windows)]
struct Job(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Job {
    fn new() -> Option<Job> {
        use windows::Win32::System::JobObjects::{CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        let job = Job(unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }.ok()?);
        job.set_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).then_some(job)
    }

    fn set_limits(&self, flags: windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT) -> bool {
        use windows::Win32::System::JobObjects::{JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject};
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = flags;
        unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_ok()
        }
    }

    fn assign(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        let _ = unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())) };
    }

    fn terminate(&self) -> bool {
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1).is_ok() }
    }

    /// Lets the processes in the job outlive it, then closes it.
    fn release(self) {
        self.set_limits(windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT(0));
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(windows))]
struct Job;

#[cfg(not(windows))]
impl Job {
    fn new() -> Option<Job> {
        None
    }
    fn assign(&self, _child: &Child) {}
    fn terminate(&self) -> bool {
        false
    }
    fn release(self) {}
}

/// Base64 of the UTF-16LE text, the format `powershell -EncodedCommand` expects.
fn encode_ps(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_powershell() {
        // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("dir"))
        assert_eq!(encode_ps("dir"), "ZABpAHIA");
        assert_eq!(encode_ps("ab"), "YQBiAA==");
    }

    #[test]
    fn refreshes_untouched_builtin_descriptions() {
        let mut list = defaults();
        list[0].description = "Clear the DNS cache to fix sites that won't load".into();
        list[1].description = "My own note".into();
        assert!(migrate(&mut list));
        assert_eq!(list[0].description, defaults()[0].description);
        assert_eq!(list[1].description, "My own note");
        assert!(!migrate(&mut list));
    }

    #[test]
    fn migrates_old_builtins() {
        let old = |command: &str| SavedCommand { id: "uuid".into(), command: command.into(), ..Default::default() };
        let mut list = vec![old("ipconfig /flushdns"), old(LEGACY_CLEAR_TEMP), old(LEGACY_BATTERY_REPORT), old("my own")];
        assert!(migrate(&mut list));
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, "builtin.flush-dns");
        assert_eq!(list[1].command, BATTERY_REPORT);
        assert_eq!(list[2].id, "uuid");
        assert!(!migrate(&mut list));
    }

    #[test]
    fn loads_old_files_without_new_fields() {
        let json = r#"[{"id":"1","name":"n","description":"","command":"c","shell":"cmd","admin":false,"category":"x"}]"#;
        let list: Vec<SavedCommand> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].risk, Risk::Safe);
        assert_eq!(list[0].shell, Shell::Cmd);
    }
}
