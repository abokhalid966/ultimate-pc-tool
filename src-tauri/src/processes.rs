//! Process table, kill, priority and "open file location".

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    /// CPU usage normalised to 0-100 across all cores, like Task Manager.
    pub cpu: f32,
    pub memory: u64,
    pub disk_read: u64,
    pub disk_write: u64,
    pub exe: Option<String>,
    pub cmd: String,
    pub status: String,
    pub start_time: u64,
}

pub fn collect(sys: &System, core_count: usize) -> Vec<ProcessInfo> {
    sys.processes()
        .values()
        // Skip kernel pseudo-processes with no name (e.g. PID 0).
        .filter(|p| !p.name().is_empty())
        .map(|p| {
            let disk = p.disk_usage();
            ProcessInfo {
                pid: p.pid().as_u32(),
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                cpu: p.cpu_usage() / core_count as f32,
                memory: p.memory(),
                disk_read: disk.read_bytes,
                disk_write: disk.written_bytes,
                exe: p.exe().map(|e| e.to_string_lossy().into_owned()),
                cmd: p
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
                status: p.status().to_string(),
                start_time: p.start_time(),
            }
        })
        .collect()
}

pub fn kill(pid: u32) -> Result<(), String> {
    let mut sys = System::new();
    let pid = Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let process = sys.process(pid).ok_or("Process not found (it may have already exited)")?;
    if process.kill() {
        Ok(())
    } else {
        Err("Windows refused to end this process. Try running the app as administrator.".into())
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Idle,
    BelowNormal,
    Normal,
    AboveNormal,
    High,
    Realtime,
}

#[cfg(windows)]
pub fn set_priority(pid: u32, priority: Priority) -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
        IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, OpenProcess, PROCESS_SET_INFORMATION,
        REALTIME_PRIORITY_CLASS, SetPriorityClass,
    };

    let class = match priority {
        Priority::Idle => IDLE_PRIORITY_CLASS,
        Priority::BelowNormal => BELOW_NORMAL_PRIORITY_CLASS,
        Priority::Normal => NORMAL_PRIORITY_CLASS,
        Priority::AboveNormal => ABOVE_NORMAL_PRIORITY_CLASS,
        Priority::High => HIGH_PRIORITY_CLASS,
        Priority::Realtime => REALTIME_PRIORITY_CLASS,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, false, pid)
            .map_err(|e| format!("Could not open process: {}", e.message()))?;
        let result = SetPriorityClass(handle, class);
        let _ = CloseHandle(handle);
        result.map_err(|e| format!("Could not change priority: {}", e.message()))
    }
}

#[cfg(not(windows))]
pub fn set_priority(_pid: u32, _priority: Priority) -> Result<(), String> {
    Err("Changing priority is only supported on Windows".into())
}

pub fn open_file_location(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{path}"))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let dir = std::path::Path::new(path).parent().ok_or("No parent folder")?;
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
