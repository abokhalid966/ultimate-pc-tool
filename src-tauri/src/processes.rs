//! Process table, end process, priority, details and "open file location".
//!
//! Every action checks that the PID still belongs to the same program (PIDs are reused quickly)
//! and refuses processes Windows needs to keep running, and this app's own processes.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    /// CPU usage normalised to 0-100 across all cores, like Task Manager.
    pub cpu: f32,
    pub memory: u64,
    /// Bytes per second of all I/O (disk, network, pipes): Windows doesn't split it per process.
    pub io_read: u64,
    pub io_write: u64,
    pub exe: Option<String>,
    pub start_time: u64,
    /// Why this process can't be ended or re-prioritised.
    pub protected: Option<String>,
    /// What breaks if this process is ended (allowed, but confirmed first).
    pub warning: Option<String>,
    /// Optimo itself or its WebView2 helper processes.
    pub is_self: bool,
}

/// Processes Windows needs. Only matched when the file is in the Windows folder (or unreadable),
/// so malware borrowing a name like svchost.exe from elsewhere can still be ended.
const CORE: &[&str] = &[
    "system",
    "secure system",
    "registry",
    "memory compression",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "sihost.exe",
    "ctfmon.exe",
    "msmpeng.exe",
    "nissrv.exe",
    "mpdefendercoreservice.exe",
    "securityhealthservice.exe",
    "sgrmbroker.exe",
];

/// Processes that may be ended, but only after telling the user what happens.
const RISKY: &[(&str, &str)] = &[
    ("explorer.exe", "Your taskbar, desktop and File Explorer windows will close. Windows usually starts them again within a few seconds."),
    ("audiodg.exe", "Sound will stop for a moment until Windows restarts it."),
    ("spoolsv.exe", "Printing will stop until the Print Spooler service is restarted."),
    ("msedgewebview2.exe", "Teams, Outlook, Widgets and other apps use this. They may stop working until you restart them."),
];

const SELF_MESSAGE: &str = "That's part of Optimo. Use Quit in the tray menu to close it.";
const WEBVIEW: &str = "msedgewebview2.exe";

fn core_message(name: &str) -> String {
    format!("{name} is a core part of Windows. Ending it could crash your PC, sign you out or break the desktop, so Optimo won't do it.")
}

fn is_core(name: &str, exe: Option<&str>) -> bool {
    let name = name.to_lowercase();
    if !CORE.contains(&name.as_str()) {
        return false;
    }
    match exe {
        None => true,
        Some(exe) => {
            let windir = crate::os::windows_dir().to_string_lossy().to_lowercase();
            exe.to_lowercase().starts_with(&format!("{}\\", windir.trim_end_matches('\\')))
        }
    }
}

/// Checks that need nothing but the PID: the idle and System pseudo-processes, and this app.
fn fixed_block(pid: u32, name: &str) -> Option<String> {
    if pid == std::process::id() {
        Some(SELF_MESSAGE.into())
    } else if pid == 0 || pid == 4 {
        Some(core_message(name))
    } else {
        None
    }
}

fn block_reason(pid: u32, name: &str, exe: Option<&str>, critical: bool) -> Option<String> {
    fixed_block(pid, name).or_else(|| (critical || is_core(name, exe)).then(|| core_message(name)))
}

fn risk_warning(name: &str) -> Option<String> {
    let name = name.to_lowercase();
    RISKY.iter().find(|(n, _)| *n == name).map(|(_, w)| (*w).to_string())
}

/// Remembers which processes Windows marks as critical, so each is only checked once.
#[derive(Default)]
pub struct ProtectionCache {
    critical: HashMap<(u32, u64), bool>,
}

/// This app's process and the WebView2 processes it started (its window).
fn own_tree(sys: &System) -> HashSet<Pid> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        let Some(parent) = p.parent().and_then(|pp| sys.process(pp)) else { continue };
        // A parent that started later than its child is a reused PID, not the real parent.
        if parent.start_time() <= p.start_time() && p.name().to_string_lossy().eq_ignore_ascii_case(WEBVIEW) {
            children.entry(parent.pid()).or_default().push(*pid);
        }
    }
    let own = Pid::from_u32(std::process::id());
    let mut tree = HashSet::from([own]);
    let mut stack = vec![own];
    while let Some(pid) = stack.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if tree.insert(*child) {
                stack.push(*child);
            }
        }
    }
    tree
}

pub fn collect(sys: &System, core_count: usize, cache: &mut ProtectionCache) -> Vec<ProcessInfo> {
    let own = own_tree(sys);
    let mut live = HashSet::new();
    let list = sys
        .processes()
        .values()
        // PID 0 is the idle pseudo-process ("[System Process]").
        .filter(|p| p.pid().as_u32() != 0 && !p.name().is_empty())
        .map(|p| {
            let pid = p.pid().as_u32();
            let name = p.name().to_string_lossy().into_owned();
            // sysinfo reports "" when it can't read the path of an elevated or service process.
            let exe = p.exe().filter(|e| !e.as_os_str().is_empty()).map(|e| e.to_string_lossy().into_owned());
            let key = (pid, p.start_time());
            live.insert(key);
            let critical = *cache.critical.entry(key).or_insert_with(|| is_critical(pid));
            let is_self = own.contains(&p.pid());
            let protected = if is_self { Some(SELF_MESSAGE.into()) } else { block_reason(pid, &name, exe.as_deref(), critical) };
            let disk = p.disk_usage();
            ProcessInfo {
                pid,
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                cpu: p.cpu_usage() / core_count as f32,
                memory: p.memory(),
                io_read: disk.read_bytes,
                io_write: disk.written_bytes,
                warning: if protected.is_none() { risk_warning(&name) } else { None },
                name,
                exe,
                start_time: p.start_time(),
                protected,
                is_self,
            }
        })
        .collect();
    cache.critical.retain(|k, _| live.contains(k));
    list
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Idle,
    BelowNormal,
    Normal,
    AboveNormal,
    High,
    Realtime,
}

impl Priority {
    pub fn label(self) -> &'static str {
        match self {
            Priority::Idle => "Low",
            Priority::BelowNormal => "Below normal",
            Priority::Normal => "Normal",
            Priority::AboveNormal => "Above normal",
            Priority::High => "High",
            Priority::Realtime => "Realtime",
        }
    }
}

/// A process as the UI saw it. `start_time` (0 = unknown) tells it apart from a later process
/// that got the same PID.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub pid: u32,
    pub start_time: u64,
}

pub enum KillOutcome {
    Ended,
    /// The process had already exited (or its PID now belongs to another program).
    AlreadyGone,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KillSummary {
    pub ended: u32,
    pub already_gone: u32,
    /// One message per process that couldn't be ended.
    pub failed: Vec<String>,
    /// `(pid, start_time)` of every target that is no longer running.
    #[serde(skip)]
    pub gone: Vec<(u32, u64)>,
}

/// Ends several processes of one app, parents first: their children often exit by themselves,
/// and those count as success rather than errors.
pub fn kill_many(targets: &[Target], name: &str, snapshot: &[ProcessInfo]) -> KillSummary {
    let in_set: HashSet<u32> = targets.iter().map(|t| t.pid).collect();
    let parent_of: HashMap<u32, u32> = snapshot.iter().filter_map(|p| Some((p.pid, p.parent_pid?))).collect();
    let depth = |pid: u32| {
        let mut depth = 0;
        let mut current = pid;
        while let Some(parent) = parent_of.get(&current).copied().filter(|p| in_set.contains(p) && *p != pid) {
            depth += 1;
            current = parent;
            if depth > 64 {
                break;
            }
        }
        depth
    };
    let mut ordered = targets.to_vec();
    ordered.sort_by_key(|t| depth(t.pid));

    let mut summary = KillSummary::default();
    for t in ordered {
        match kill(t, name, snapshot) {
            Ok(outcome) => {
                match outcome {
                    KillOutcome::Ended => summary.ended += 1,
                    KillOutcome::AlreadyGone => summary.already_gone += 1,
                }
                summary.gone.push((t.pid, t.start_time));
            }
            Err(e) => summary.failed.push(e),
        }
    }
    summary
}

/// Refuses processes the latest snapshot marks as protected (including this app's own tree).
fn check_snapshot(t: Target, snapshot: &[ProcessInfo]) -> Result<(), String> {
    let known = snapshot.iter().find(|p| p.pid == t.pid && (t.start_time == 0 || p.start_time == t.start_time));
    match known.and_then(|p| p.protected.clone()) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

fn denied(action: &str) -> String {
    if crate::os::is_elevated() {
        format!("Windows didn't allow {action}. It may be protected by Windows or your antivirus.")
    } else {
        format!(
            "Windows didn't allow {action}. It may be protected by Windows or your antivirus, or need administrator rights (use Restart as administrator)."
        )
    }
}

const GONE: &str = "That app already closed, so nothing was changed.";

/// Details fetched when a process is selected (too costly to read for every process every second).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub exe: Option<String>,
    pub cmd: Option<String>,
    pub priority: Option<Priority>,
}

pub fn details(t: Target) -> Result<ProcessDetails, String> {
    let pid = Pid::from_u32(t.pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always).with_exe(UpdateKind::Always),
    );
    let p = sys.process(pid).filter(|p| t.start_time == 0 || p.start_time() == t.start_time);
    let p = p.ok_or("This process has ended.")?;
    let cmd = p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" ");
    let exe = p.exe().filter(|e| !e.as_os_str().is_empty()).map(|e| e.to_string_lossy().into_owned());
    #[cfg(windows)]
    let (exe, priority) = match win::Process::open(t.pid, win::QUERY) {
        Ok(handle) => (exe.or_else(|| handle.image_path()), handle.priority()),
        Err(_) => (exe, None),
    };
    #[cfg(not(windows))]
    let priority = None;
    Ok(ProcessDetails { exe, cmd: (!cmd.trim().is_empty()).then_some(cmd), priority })
}

#[cfg(windows)]
fn is_critical(pid: u32) -> bool {
    win::Process::open(pid, win::QUERY).is_ok_and(|h| h.is_critical())
}

#[cfg(not(windows))]
fn is_critical(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        GetPriorityClass, GetProcessTimes, IsProcessCritical, OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForSingleObject,
    };
    use windows::core::{HRESULT, PWSTR};

    use super::Priority;

    pub const QUERY: PROCESS_ACCESS_RIGHTS = PROCESS_QUERY_LIMITED_INFORMATION;

    pub enum OpenError {
        /// No process has this PID any more.
        Gone,
        Denied,
        Other(String),
    }

    pub struct Process(pub HANDLE);

    impl Drop for Process {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    impl Process {
        pub fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<Process, OpenError> {
            match unsafe { OpenProcess(access, false, pid) } {
                Ok(handle) => Ok(Process(handle)),
                Err(e) if e.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => Err(OpenError::Gone),
                Err(e) if e.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0) => Err(OpenError::Denied),
                Err(e) => Err(OpenError::Other(e.message())),
            }
        }

        pub fn image_path(&self) -> Option<String> {
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            unsafe { QueryFullProcessImageNameW(self.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }

        /// Start time in Unix seconds, computed the same way sysinfo does.
        pub fn start_time(&self) -> Option<u64> {
            let (mut created, mut exited, mut kernel, mut user) =
                (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
            let ticks = (created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64;
            (ticks / 10_000_000).checked_sub(11_644_473_600)
        }

        pub fn is_critical(&self) -> bool {
            let mut critical = windows::core::BOOL(0);
            unsafe { IsProcessCritical(self.0, &mut critical) }.is_ok() && critical.as_bool()
        }

        pub fn has_exited(&self) -> bool {
            unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
        }

        pub fn priority(&self) -> Option<Priority> {
            match unsafe { GetPriorityClass(self.0) } {
                0x40 => Some(Priority::Idle),
                0x4000 => Some(Priority::BelowNormal),
                0x20 => Some(Priority::Normal),
                0x8000 => Some(Priority::AboveNormal),
                0x80 => Some(Priority::High),
                0x100 => Some(Priority::Realtime),
                _ => None,
            }
        }
    }

    /// Checks that `handle` is still the program the UI showed: same file name and start time.
    /// Returns the image path when it could be read.
    pub fn verify(handle: &Process, name: &str, start_time: u64) -> Result<Option<String>, ()> {
        let path = handle.image_path();
        if let Some(path) = &path {
            let file = path.rsplit('\\').next().unwrap_or(path);
            if !file.eq_ignore_ascii_case(name) {
                return Err(());
            }
        }
        if start_time != 0
            && let Some(actual) = handle.start_time()
            && actual.abs_diff(start_time) > 1
        {
            return Err(());
        }
        Ok(path)
    }
}

/// Ends one process after checking it is still the same program and not protected.
#[cfg(windows)]
pub fn kill(t: Target, name: &str, snapshot: &[ProcessInfo]) -> Result<KillOutcome, String> {
    use windows::Win32::System::Threading::{PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject};

    if let Some(reason) = fixed_block(t.pid, name) {
        return Err(reason);
    }
    check_snapshot(t, snapshot)?;
    let handle = match win::Process::open(t.pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | win::QUERY) {
        Ok(handle) => handle,
        Err(win::OpenError::Gone) => return Ok(KillOutcome::AlreadyGone),
        Err(win::OpenError::Denied) => {
            // Still tell the user why when it's protected, and stay quiet when it's a different app.
            if let Ok(query) = win::Process::open(t.pid, win::QUERY) {
                let Ok(path) = win::verify(&query, name, t.start_time) else { return Ok(KillOutcome::AlreadyGone) };
                if let Some(reason) = block_reason(t.pid, name, path.as_deref(), query.is_critical()) {
                    return Err(reason);
                }
            }
            return Err(denied("ending this process"));
        }
        Err(win::OpenError::Other(e)) => return Err(format!("Couldn't open {name}: {e}")),
    };
    let Ok(path) = win::verify(&handle, name, t.start_time) else { return Ok(KillOutcome::AlreadyGone) };
    if let Some(reason) = block_reason(t.pid, name, path.as_deref(), handle.is_critical()) {
        return Err(reason);
    }
    if handle.has_exited() {
        return Ok(KillOutcome::AlreadyGone);
    }
    if unsafe { TerminateProcess(handle.0, 1) }.is_err() {
        return if handle.has_exited() { Ok(KillOutcome::AlreadyGone) } else { Err(denied("ending this process")) };
    }
    // Ending is asynchronous; give it a moment so the next process list no longer shows it.
    unsafe { WaitForSingleObject(handle.0, 1000) };
    Ok(KillOutcome::Ended)
}

#[cfg(not(windows))]
pub fn kill(t: Target, name: &str, snapshot: &[ProcessInfo]) -> Result<KillOutcome, String> {
    if let Some(reason) = fixed_block(t.pid, name) {
        return Err(reason);
    }
    check_snapshot(t, snapshot)?;
    let mut sys = System::new();
    let pid = Pid::from_u32(t.pid);
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid).filter(|p| t.start_time == 0 || p.start_time() == t.start_time) {
        None => Ok(KillOutcome::AlreadyGone),
        Some(p) if p.kill() => Ok(KillOutcome::Ended),
        Some(_) => Err(denied("ending this process")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityChange {
    pub previous: Option<Priority>,
    /// What Windows actually applied (it silently lowers Realtime to High without admin rights).
    pub applied: Option<Priority>,
}

/// Changes a process's priority after the same identity and protection checks as `kill`.
#[cfg(windows)]
pub fn set_priority(t: Target, name: &str, priority: Priority, snapshot: &[ProcessInfo]) -> Result<PriorityChange, String> {
    use windows::Win32::System::Threading::{
        ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        PROCESS_SET_INFORMATION, REALTIME_PRIORITY_CLASS, SetPriorityClass,
    };

    if let Some(reason) = fixed_block(t.pid, name) {
        return Err(reason);
    }
    check_snapshot(t, snapshot)?;
    let class = match priority {
        Priority::Idle => IDLE_PRIORITY_CLASS,
        Priority::BelowNormal => BELOW_NORMAL_PRIORITY_CLASS,
        Priority::Normal => NORMAL_PRIORITY_CLASS,
        Priority::AboveNormal => ABOVE_NORMAL_PRIORITY_CLASS,
        Priority::High => HIGH_PRIORITY_CLASS,
        Priority::Realtime => REALTIME_PRIORITY_CLASS,
    };
    let handle = match win::Process::open(t.pid, PROCESS_SET_INFORMATION | win::QUERY) {
        Ok(handle) => handle,
        Err(win::OpenError::Gone) => return Err(GONE.into()),
        Err(win::OpenError::Denied) => return Err(denied("changing this process's priority")),
        Err(win::OpenError::Other(e)) => return Err(format!("Couldn't open {name}: {e}")),
    };
    let path = win::verify(&handle, name, t.start_time).map_err(|_| GONE.to_string())?;
    if let Some(reason) = block_reason(t.pid, name, path.as_deref(), handle.is_critical()) {
        return Err(reason);
    }
    let previous = handle.priority();
    unsafe { SetPriorityClass(handle.0, class) }.map_err(|e| format!("Couldn't change priority: {}", e.message()))?;
    Ok(PriorityChange { previous, applied: handle.priority() })
}

#[cfg(not(windows))]
pub fn set_priority(_t: Target, _name: &str, _priority: Priority, _snapshot: &[ProcessInfo]) -> Result<PriorityChange, String> {
    Err("Changing priority is only supported on Windows".into())
}

/// Shows the file selected in File Explorer (without building an explorer.exe command line).
pub fn open_file_location(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).is_file() {
        return Err("That file no longer exists.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| format!("Couldn't open the folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_core_processes_only_in_the_windows_folder() {
        let windir = crate::os::windows_dir().to_string_lossy().trim_end_matches('\\').to_string();
        assert!(is_core("svchost.exe", None));
        assert!(is_core("SvcHost.exe", Some(&format!("{windir}\\System32\\svchost.exe"))));
        assert!(!is_core("svchost.exe", Some(r"C:\Users\me\AppData\svchost.exe")));
        assert!(!is_core("chrome.exe", None));
        assert!(block_reason(4, "System", None, false).is_some());
        assert!(block_reason(1234, "notepad.exe", None, true).is_some());
        assert!(block_reason(std::process::id(), "x.exe", None, false).is_some());
        assert!(risk_warning("Explorer.EXE").is_some());
    }
}
