//! PC health: the "Why is my PC slow?" speed check.
//!
//! `run` watches the PC for about four seconds (which apps keep the processor busy, how full
//! memory is) while slower checks run on their own threads: free space, startup apps, pending
//! restarts, temp files, the power plan, and whether Windows is on a busy hard disk. The result is
//! a 0-100 score and a ranked list of issues, each with a suggested one-click fix.
//!
//! Every check is best effort. Data that can't be read (no sensors, a key the user can't open, a
//! performance counter that hangs) skips that check instead of failing the report, and a slow
//! check that misses the deadline is left out.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{CpuRefreshKind, DiskKind, DiskRefreshKind, Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::actions::{ActivityLog, Undo};
use crate::cleanup::{self, CleanReport};
use crate::metrics::{self, TempInfo};
use crate::processes::{self, ProcessInfo, ProtectionCache};
use crate::startup::{self, StartupItem};
use crate::os;

/// Activity log category for changes made from this page.
const CATEGORY: &str = "PC health";
/// One-second samples after the first reading, so the check takes about four seconds.
const SAMPLES: usize = 4;
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// Slow checks that haven't answered this long after the start are left out.
const DEADLINE: Duration = Duration::from_secs(9);
/// powercfg and shutdown normally answer at once.
const TOOL_TIMEOUT: Duration = Duration::from_secs(8);
const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;

/// Progress shown before each sample: percent done and what is being looked at.
const STEPS: [(u8, &str); SAMPLES] = [
    (6, "Watching which apps use your processor…"),
    (26, "Measuring how full your memory is…"),
    (46, "Checking free space on your drives…"),
    (66, "Looking for updates waiting on a restart…"),
];

// ---- Report types ----

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Clearly slowing the PC down, or about to make apps fail.
    Critical,
    Warning,
    /// Worth knowing, with a small effect.
    Tip,
}

impl Severity {
    /// Score points an issue of this severity costs.
    fn points(self) -> u8 {
        match self {
            Severity::Critical => 20,
            Severity::Warning => 10,
            Severity::Tip => 3,
        }
    }
}

/// A process as the check saw it, for ending it through the Processes page's safe path.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcTarget {
    pub pid: u32,
    pub start_time: u64,
}

/// What a fix button does. Serialized as `{ "kind": ..., "payload": {...} }`.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ActionKind {
    /// End every process of one app, with the same confirmation and protection checks as Processes.
    EndProcess { name: String, targets: Vec<ProcTarget> },
    /// Open a page of this app; `sort` and `query` apply to Processes.
    OpenPage { page: &'static str, sort: Option<&'static str>, query: Option<String> },
    /// Clean the temp folder with the safe cleaner; `bytes` is what the dry run found.
    CleanTemp { bytes: u64 },
    SetPowerPlan { guid: String, name: String },
    /// Restart Windows. The UI asks first.
    Restart,
    /// Open a page of Windows Settings by its key (see `settings_uri`).
    OpenSettings { page: &'static str },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FixAction {
    pub label: String,
    /// Changes nothing that can't be undone or that anyone would miss, so "Fix all safe items" may run it.
    pub safe: bool,
    #[serde(flatten)]
    pub kind: ActionKind,
}

impl FixAction {
    fn new(label: impl Into<String>, kind: ActionKind) -> Self {
        let safe = matches!(kind, ActionKind::CleanTemp { .. } | ActionKind::SetPowerPlan { .. });
        FixAction { label: label.into(), safe, kind }
    }

    fn processes(label: &str, sort: &'static str, query: Option<&str>) -> Self {
        Self::new(label, ActionKind::OpenPage { page: "processes", sort: Some(sort), query: query.map(str::to_string) })
    }

    fn settings(label: &str, page: &'static str) -> Self {
        Self::new(label, ActionKind::OpenSettings { page })
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    pub id: String,
    pub severity: Severity,
    /// Plain-language headline.
    pub title: String,
    /// Why it matters and what to do, in plain language.
    pub explanation: String,
    /// Numbers and names for people who want them.
    pub detail: String,
    /// Score points this issue costs; fixing it gives them back.
    pub points: u8,
    /// The suggested fix.
    pub action: Option<FixAction>,
    pub alternatives: Vec<FixAction>,
    /// Order within a severity: higher comes first.
    #[serde(skip)]
    rank: u32,
}

impl HealthIssue {
    fn new(id: impl Into<String>, severity: Severity, rank: u32, title: impl Into<String>, explanation: impl Into<String>, detail: impl Into<String>) -> Self {
        HealthIssue {
            id: id.into(),
            severity,
            title: title.into(),
            explanation: explanation.into(),
            detail: detail.into(),
            points: severity.points(),
            action: None,
            alternatives: Vec::new(),
            rank,
        }
    }

    fn fix(mut self, action: FixAction) -> Self {
        self.action = Some(action);
        self
    }

    fn or(mut self, action: FixAction) -> Self {
        self.alternatives.push(action);
        self
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Ok,
    Issue,
    /// The information wasn't available on this PC.
    Skipped,
}

/// One line of "What we checked".
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    pub summary: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub score: u8,
    /// Most important first.
    pub issues: Vec<HealthIssue>,
    pub checks: Vec<HealthCheck>,
    pub checked_at: i64,
    pub duration_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HealthEvent {
    Progress { percent: u8, step: String },
}

#[derive(Default)]
struct Findings {
    issues: Vec<HealthIssue>,
    checks: Vec<HealthCheck>,
}

impl Findings {
    fn check(&mut self, id: &'static str, label: &'static str, status: CheckStatus, summary: impl Into<String>) {
        self.checks.push(HealthCheck { id, label, status, summary: summary.into() });
    }

    fn skipped(&mut self, id: &'static str, label: &'static str, summary: impl Into<String>) {
        self.check(id, label, CheckStatus::Skipped, summary);
    }

    /// Adds `found` and records the check as Issue when there are any, else as Ok with `ok`.
    fn result(&mut self, id: &'static str, label: &'static str, found: Vec<HealthIssue>, issue_summary: impl Into<String>, ok: impl Into<String>) {
        if found.is_empty() {
            self.check(id, label, CheckStatus::Ok, ok);
        } else {
            self.check(id, label, CheckStatus::Issue, issue_summary);
            self.issues.extend(found);
        }
    }
}

/// 100 minus the points of every issue.
fn score(issues: &[HealthIssue]) -> u8 {
    100u32.saturating_sub(issues.iter().map(|i| i.points as u32).sum()) as u8
}

fn rank(issues: &mut [HealthIssue]) {
    issues.sort_by(|a, b| a.severity.cmp(&b.severity).then(b.rank.cmp(&a.rank)));
}

// ---- The check ----

static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunGuard;

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// A slow check running on its own thread.
struct Pending<T>(mpsc::Receiver<T>);

fn spawn<T: Send + 'static>(name: &str, f: impl FnOnce() -> T + Send + 'static) -> Pending<T> {
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new().name(format!("health-{name}")).spawn(move || {
        let _ = tx.send(f());
    });
    Pending(rx)
}

impl<T> Pending<T> {
    /// The result, or None when the check failed to start or missed `deadline`.
    fn wait(self, deadline: Instant) -> Option<T> {
        self.0.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()
    }
}

#[tauri::command]
pub async fn run_health_check(on_event: Channel<HealthEvent>) -> Result<HealthReport, String> {
    crate::blocking(move || run(&on_event)).await
}

pub fn run(events: &Channel<HealthEvent>) -> Result<HealthReport, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A speed check is already running. It takes about five seconds.".into());
    }
    let _guard = RunGuard;
    let started = Instant::now();
    let deadline = started + DEADLINE;
    let progress = |percent: u8, step: &str| {
        let _ = events.send(HealthEvent::Progress { percent, step: step.into() });
    };
    progress(2, "Getting ready…");

    let system = system_drive();
    let disks = spawn("disks", {
        let system = system.clone();
        move || disk_state(&system)
    });
    let reboot = spawn("reboot", reboot_state);
    let temp = spawn("temp", || cleanup::clean_temp(true));
    let startup_items = spawn("startup", startup::list);
    let power = spawn("power", power_state);

    let mut sampler = Sampler::new();
    for (index, (percent, step)) in STEPS.into_iter().enumerate() {
        progress(percent, step);
        thread::sleep(SAMPLE_INTERVAL);
        sampler.sample(index);
    }
    progress(86, "Checking startup apps, temp files and power settings…");

    let mut out = Findings::default();
    let memory = sampler.memory();
    analyze_apps(&sampler.apps(), &sampler.cpu_total, memory.as_ref(), display_name, &mut out);
    analyze_memory(memory.as_ref(), &mut out);

    let disks = disks.wait(deadline);
    let drives = disks.as_ref().map(|d| d.drives.as_slice());
    let system_low = analyze_drives(drives, &system, &mut out);
    analyze_startup(startup_items.wait(deadline).as_deref(), &mut out);
    analyze_restart(System::uptime(), reboot.wait(deadline).flatten(), &mut out);
    analyze_temp(temp.wait(deadline), system_low, &mut out);
    analyze_power(power.wait(deadline).flatten().as_ref(), &mut out);
    analyze_temperatures(metrics::current_temperatures().as_deref(), &mut out);
    analyze_system_disk(disks.and_then(|d| d.system), &system, &mut out);

    rank(&mut out.issues);
    progress(100, "Done");
    Ok(HealthReport {
        score: score(&out.issues),
        issues: out.issues,
        checks: out.checks,
        checked_at: chrono::Utc::now().timestamp_millis(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// ---- Processor and memory ----

/// One app (all processes with the same file name) across the samples.
#[derive(Default, Clone, Debug)]
struct AppStats {
    name: String,
    exe: Option<String>,
    /// Percent of the whole processor, per sample (0 while not running).
    cpu: [f32; SAMPLES],
    memory: [u64; SAMPLES],
    /// Its processes in the latest sample it appeared in.
    targets: Vec<ProcTarget>,
    seen: Option<usize>,
    /// Any of its processes is part of Windows (or otherwise can't be ended).
    protected: bool,
}

impl AppStats {
    fn avg_cpu(&self) -> f32 {
        self.cpu.iter().sum::<f32>() / SAMPLES as f32
    }

    fn avg_memory(&self) -> u64 {
        self.memory.iter().sum::<u64>() / SAMPLES as u64
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MemoryStatus {
    /// Percent of physical memory in use.
    load: f32,
    total: u64,
    available: u64,
    /// Commit charge and commit limit (memory apps were promised, RAM plus page file).
    commit: Option<(u64, u64)>,
}

struct Sampler {
    sys: System,
    protection: ProtectionCache,
    apps: HashMap<String, AppStats>,
    cpu_total: Vec<f32>,
    memory: Vec<MemoryStatus>,
}

fn process_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing().with_memory().with_cpu().with_exe(UpdateKind::OnlyIfNotSet)
}

impl Sampler {
    fn new() -> Self {
        let mut sys = System::new();
        // The first reading: CPU usage is measured from here.
        sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage());
        sys.refresh_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind());
        Sampler { sys, protection: ProtectionCache::default(), apps: HashMap::new(), cpu_total: Vec::new(), memory: Vec::new() }
    }

    fn sample(&mut self, index: usize) {
        self.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage());
        self.sys.refresh_memory();
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind());
        self.cpu_total.push(self.sys.global_cpu_usage());
        self.memory.push(memory_status(&self.sys));
        let cores = self.sys.cpus().len().max(1);
        for p in processes::collect(&self.sys, cores, &mut self.protection) {
            self.add(index, p);
        }
    }

    fn add(&mut self, index: usize, p: ProcessInfo) {
        if p.is_self {
            return;
        }
        let stats = self.apps.entry(p.name.to_lowercase()).or_default();
        if stats.name.is_empty() {
            stats.name = p.name.clone();
        }
        if stats.seen != Some(index) {
            stats.seen = Some(index);
            stats.targets.clear();
        }
        stats.cpu[index] += p.cpu;
        // The working set counts DLLs shared with other processes once per process, so an app with
        // many processes looks far bigger than it is. Its private memory (commit) caps that: the
        // smaller of the two is close to Task Manager's "private working set".
        let private = self.sys.process(Pid::from_u32(p.pid)).map(|sp| sp.virtual_memory()).filter(|v| *v > 0);
        stats.memory[index] += private.map_or(p.memory, |v| v.min(p.memory));
        stats.targets.push(ProcTarget { pid: p.pid, start_time: p.start_time });
        stats.protected |= p.protected.is_some();
        if stats.exe.is_none() {
            stats.exe = p.exe;
        }
    }

    fn apps(&self) -> Vec<AppStats> {
        self.apps.values().cloned().collect()
    }

    /// Average load over the samples, with the latest absolute numbers.
    fn memory(&self) -> Option<MemoryStatus> {
        let last = *self.memory.last()?;
        let load = self.memory.iter().map(|m| m.load).sum::<f32>() / self.memory.len() as f32;
        (last.total > 0).then_some(MemoryStatus { load, ..last })
    }
}

#[cfg(windows)]
fn memory_status(sys: &System) -> MemoryStatus {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() && status.ullTotalPhys > 0 {
        let commit = (status.ullTotalPageFile > 0).then(|| (status.ullTotalPageFile.saturating_sub(status.ullAvailPageFile), status.ullTotalPageFile));
        return MemoryStatus { load: status.dwMemoryLoad as f32, total: status.ullTotalPhys, available: status.ullAvailPhys, commit };
    }
    memory_from_sysinfo(sys)
}

#[cfg(not(windows))]
fn memory_status(sys: &System) -> MemoryStatus {
    memory_from_sysinfo(sys)
}

fn memory_from_sysinfo(sys: &System) -> MemoryStatus {
    let total = sys.total_memory();
    let load = if total > 0 { sys.used_memory() as f32 / total as f32 * 100.0 } else { 0.0 };
    MemoryStatus { load, total, available: sys.available_memory(), commit: None }
}

/// An app averaging at least this share of the whole processor...
const HOG_CPU_AVG: f32 = 20.0;
/// ...and above this in all but one sample is a sustained hog.
const HOG_CPU_FLOOR: f32 = 8.0;
const HOG_CPU_CRITICAL: f32 = 50.0;
/// Total processor use that counts as maxed out.
const BUSY_CPU_AVG: f32 = 85.0;

fn sustained_cpu(app: &AppStats) -> Option<f32> {
    let avg = app.avg_cpu();
    let steady = app.cpu.iter().filter(|v| **v >= HOG_CPU_FLOOR).count() >= SAMPLES - 1;
    (avg >= HOG_CPU_AVG && steady).then_some(avg)
}

/// An app holding a big share of memory while memory is tight. One using lots of memory on a PC
/// with plenty free isn't slowing anything down.
fn is_memory_hog(app: &AppStats, memory: &MemoryStatus) -> bool {
    let avg = app.avg_memory();
    let share = avg as f64 / memory.total.max(1) as f64;
    !app.protected && avg >= GB && share >= 0.2 && memory.load >= 70.0
}

fn samples_text(values: &[f32]) -> String {
    values.iter().map(|v| format!("{v:.0}%")).collect::<Vec<_>>().join(", ")
}

fn processes_word(n: usize) -> String {
    if n == 1 { "1 process".into() } else { format!("{n} processes") }
}

/// Sustained processor and memory hogs, plus a maxed-out processor no single app explains.
fn analyze_apps(apps: &[AppStats], cpu_total: &[f32], memory: Option<&MemoryStatus>, display: impl Fn(&AppStats) -> String, out: &mut Findings) {
    let mut cpu_hogs: Vec<(&AppStats, f32)> = apps.iter().filter_map(|a| Some((a, sustained_cpu(a)?))).collect();
    cpu_hogs.sort_by(|a, b| b.1.total_cmp(&a.1));
    cpu_hogs.truncate(3);

    let mut found = Vec::new();
    for &(app, avg) in &cpu_hogs {
        let name = display(app);
        let count = app.targets.len();
        let severity = match (app.protected, avg >= HOG_CPU_CRITICAL) {
            (false, true) => Severity::Critical,
            (false, false) | (true, true) => Severity::Warning,
            (true, false) => Severity::Tip,
        };
        let mut detail = format!(
            "{}: {}, average {avg:.1}% of the processor over {SAMPLES} seconds (samples: {}).",
            app.name,
            processes_word(count),
            samples_text(&app.cpu)
        );
        if let Some(m) = memory.filter(|m| is_memory_hog(app, m)) {
            detail.push_str(&format!(" It also uses {} of memory ({:.0}%).", fmt_bytes(app.avg_memory()), app.avg_memory() as f64 / m.total as f64 * 100.0));
        }
        if let Some(exe) = &app.exe {
            detail.push_str(&format!(" File: {exe}"));
        }
        let see = FixAction::processes("See in Processes", "cpu", Some(&app.name));
        let issue = if app.protected {
            HealthIssue::new(
                format!("cpu-{}", app.name.to_lowercase()),
                severity,
                80 + avg as u32,
                format!("{name} is keeping your processor busy"),
                format!(
                    "It used about {avg:.0}% of your processor the whole time we watched. It's part of Windows, so it can't be ended here. It usually settles down by itself within a few minutes; if it doesn't, a restart helps."
                ),
                detail,
            )
            .fix(see)
        } else {
            HealthIssue::new(
                format!("cpu-{}", app.name.to_lowercase()),
                severity,
                80 + avg as u32,
                format!("{name} is keeping your processor busy"),
                format!(
                    "It used about {avg:.0}% of your processor the whole time we watched, which leaves less for everything else. If you aren't using it, ending it frees that up right away. Save your work in it first."
                ),
                detail,
            )
            .fix(FixAction::new(format!("End {name}"), ActionKind::EndProcess { name: app.name.clone(), targets: app.targets.clone() }))
            .or(see)
        };
        found.push(issue);
    }

    let avg_total = if cpu_total.is_empty() { None } else { Some(cpu_total.iter().sum::<f32>() / cpu_total.len() as f32) };
    let explained: f32 = cpu_hogs.iter().map(|(_, avg)| avg).sum();
    if let Some(avg) = avg_total.filter(|avg| *avg >= BUSY_CPU_AVG && explained < avg * 0.5) {
        let mut busiest: Vec<&AppStats> = apps.iter().collect();
        busiest.sort_by(|a, b| b.avg_cpu().total_cmp(&a.avg_cpu()));
        let top = busiest.iter().take(3).map(|a| format!("{} {:.1}%", a.name, a.avg_cpu())).collect::<Vec<_>>().join(", ");
        found.push(
            HealthIssue::new(
                "cpu-busy",
                Severity::Warning,
                85,
                "Your processor is maxed out",
                format!("It was {avg:.0}% busy during the whole check, spread across many apps. Closing apps you aren't using will make your PC respond faster."),
                format!("Average total processor use {avg:.1}% over {SAMPLES} seconds (samples: {}). Busiest apps: {top}.", samples_text(cpu_total)),
            )
            .fix(FixAction::processes("See what's using it", "cpu", None)),
        );
    }

    let cpu_summary = match (found.first(), avg_total) {
        (Some(issue), _) => issue.title.clone(),
        (None, Some(avg)) => format!("No app is hogging it. It averaged {avg:.0}% during the check."),
        (None, None) => "No app is hogging it.".into(),
    };
    if found.is_empty() {
        out.check("processor", "Processor", CheckStatus::Ok, cpu_summary);
    } else {
        out.check("processor", "Processor", CheckStatus::Issue, cpu_summary);
        out.issues.extend(found);
    }

    // Memory hogs (apps already reported for the processor mention their memory there).
    let Some(memory) = memory else { return };
    let mut mem_hogs: Vec<&AppStats> = apps
        .iter()
        .filter(|a| is_memory_hog(a, memory) && !cpu_hogs.iter().any(|(c, _)| c.name.eq_ignore_ascii_case(&a.name)))
        .collect();
    mem_hogs.sort_by_key(|a| std::cmp::Reverse(a.avg_memory()));
    for app in mem_hogs.into_iter().take(2) {
        let name = display(app);
        let used = app.avg_memory();
        let share = used as f64 / memory.total as f64 * 100.0;
        let severity = if share >= 40.0 && memory.load >= 90.0 { Severity::Critical } else { Severity::Warning };
        let mut detail = format!("{}: {}, using {} on average ({share:.0}% of {}).", app.name, processes_word(app.targets.len()), fmt_bytes(used), fmt_bytes(memory.total));
        if let Some(exe) = &app.exe {
            detail.push_str(&format!(" File: {exe}"));
        }
        out.issues.push(
            HealthIssue::new(
                format!("memory-{}", app.name.to_lowercase()),
                severity,
                70 + share as u32,
                format!("{name} is using a lot of memory"),
                format!(
                    "It's using {} ({share:.0}% of your memory). If you aren't using it, ending it gives that memory back to your other apps. Save your work in it first.",
                    fmt_bytes(used)
                ),
                detail,
            )
            .fix(FixAction::new(format!("End {name}"), ActionKind::EndProcess { name: app.name.clone(), targets: app.targets.clone() }))
            .or(FixAction::processes("See in Processes", "memory", Some(&app.name))),
        );
    }
}

/// High memory load or commit charge.
fn analyze_memory(memory: Option<&MemoryStatus>, out: &mut Findings) {
    const LABEL: &str = "Memory";
    let Some(m) = memory else {
        out.skipped("memory", LABEL, "Couldn't read memory use.");
        return;
    };
    let used = m.total.saturating_sub(m.available);
    let commit_pct = m.commit.filter(|(_, limit)| *limit > 0).map(|(charge, limit)| charge as f32 / limit as f32 * 100.0);
    let severity = if m.load >= 92.0 || commit_pct.is_some_and(|c| c >= 92.0) {
        Some(Severity::Critical)
    } else if m.load >= 82.0 || commit_pct.is_some_and(|c| c >= 85.0) {
        Some(Severity::Warning)
    } else {
        None
    };
    let mut found = Vec::new();
    if let Some(severity) = severity {
        // The commit limit runs out first when the page file is small: apps then fail rather than slow down.
        let commit_driven = m.load < 82.0;
        let explanation = if commit_driven {
            let (charge, limit) = m.commit.unwrap_or_default();
            format!(
                "Apps have asked Windows for almost all the memory it can give them ({} of {}). When it runs out, apps can freeze, crash or refuse to open. Close apps you aren't using, especially browsers with many tabs.",
                fmt_bytes(charge),
                fmt_bytes(limit)
            )
        } else {
            format!(
                "{} of your {} is in use. When memory is this full, Windows moves data to the much slower disk, so switching between apps and opening new ones gets slow. Close apps you aren't using, especially browsers with many tabs.",
                fmt_bytes(used),
                fmt_bytes(m.total)
            )
        };
        let mut detail = format!(
            "Physical memory: {:.0}% in use on average ({} of {}, {} available).",
            m.load,
            fmt_bytes(used),
            fmt_bytes(m.total),
            fmt_bytes(m.available)
        );
        if let (Some((charge, limit)), Some(pct)) = (m.commit, commit_pct) {
            detail.push_str(&format!(" Commit charge: {} of a {} limit ({pct:.0}%).", fmt_bytes(charge), fmt_bytes(limit)));
        }
        let title = if severity == Severity::Critical { "Your PC is running out of memory" } else { "Memory is getting full" };
        found.push(
            HealthIssue::new("memory-pressure", severity, 90, title, explanation, detail)
                .fix(FixAction::processes("See what's using memory", "memory", None)),
        );
    }
    let summary = format!("{:.0}% in use ({} of {}).", m.load, fmt_bytes(used), fmt_bytes(m.total));
    out.result("memory", LABEL, found, summary.clone(), summary);
}

// ---- Drives ----

#[derive(Clone, Debug)]
struct DriveSpace {
    /// "C:"
    mount: String,
    label: String,
    total: u64,
    available: u64,
}

#[derive(Clone, Copy, Debug)]
struct SystemDisk {
    hdd: bool,
    /// Percent of the check the drive was busy (only measured for hard disks).
    active: Option<f32>,
}

struct DiskState {
    drives: Vec<DriveSpace>,
    system: Option<SystemDisk>,
}

/// "C:" for the drive Windows is on.
fn system_drive() -> String {
    let dir = os::windows_dir().to_string_lossy().to_string();
    match dir.get(..2) {
        Some(prefix) if prefix.ends_with(':') => prefix.to_uppercase(),
        _ => dir,
    }
}

fn mount_label(mount: &str) -> String {
    let trimmed = mount.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() { mount.to_string() } else { trimmed.to_uppercase() }
}

/// Fixed drives with their free space, and what kind of drive Windows is on. For a hard disk this
/// also measures how busy it is, which takes as long as the sampling window.
fn disk_state(system: &str) -> DiskState {
    let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage().with_kind());
    let mut drives = Vec::new();
    let mut system_kind = None;
    for d in disks.list() {
        // sysinfo lists only fixed and removable drives on Windows.
        if d.is_removable() || d.total_space() == 0 {
            continue;
        }
        let mount = mount_label(&d.mount_point().to_string_lossy());
        if mount.eq_ignore_ascii_case(system) {
            system_kind = Some(d.kind());
        }
        let name = d.name().to_string_lossy().trim().to_string();
        drives.push(DriveSpace {
            label: if name.is_empty() { "Local Disk".into() } else { name },
            mount,
            total: d.total_space(),
            available: d.available_space(),
        });
    }
    drives.sort_by(|a, b| a.mount.cmp(&b.mount));
    let system = match system_kind {
        Some(DiskKind::HDD) => Some(SystemDisk { hdd: true, active: disk_active_time(system) }),
        Some(DiskKind::SSD) => Some(SystemDisk { hdd: false, active: None }),
        _ => None,
    };
    DiskState { drives, system }
}

/// Small volumes with a drive letter (an OEM recovery partition, a tool's boot partition) are
/// full by design and nothing to act on.
fn is_utility_volume(d: &DriveSpace) -> bool {
    d.total < 4 * GB || d.label.to_lowercase().contains("recovery")
}

fn drive_issue(d: &DriveSpace, is_system: bool) -> Option<HealthIssue> {
    if !is_system && is_utility_volume(d) {
        return None;
    }
    let free_pct = d.available as f64 / d.total.max(1) as f64 * 100.0;
    let severity = if is_system {
        if d.available < 5 * GB || free_pct < 5.0 {
            Severity::Critical
        } else if d.available < 15 * GB || free_pct < 10.0 {
            Severity::Warning
        } else {
            return None;
        }
    } else if d.available < 2 * GB || free_pct < 5.0 {
        Severity::Warning
    } else if free_pct < 10.0 && d.available < 50 * GB {
        Severity::Tip
    } else {
        return None;
    };
    let free = fmt_bytes(d.available);
    let total = fmt_bytes(d.total);
    let (title, explanation) = if is_system {
        (
            format!("Your Windows drive ({}) is almost full", d.mount),
            format!(
                "Only {free} of {total} is free. Windows needs free space for updates, temporary files and memory it moves to disk; when it runs short, the whole PC slows down and updates can fail. Cleaning up temp files and old downloads is a quick win."
            ),
        )
    } else {
        (
            format!("Drive {} is almost full", d.mount),
            format!("Only {free} of {total} is free, so apps may fail to save files there. Move or delete files you don't need."),
        )
    };
    Some(
        HealthIssue::new(
            format!("drive-{}", d.mount.trim_end_matches(':').to_lowercase()),
            severity,
            if is_system { 75 } else { 45 },
            title,
            explanation,
            format!("{} ({}): {free} free of {total} ({free_pct:.1}% free).", d.label, d.mount),
        )
        .fix(FixAction::settings("Open Storage settings", "storagesense")),
    )
}

/// Returns whether the Windows drive is short on space.
fn analyze_drives(drives: Option<&[DriveSpace]>, system: &str, out: &mut Findings) -> bool {
    const LABEL: &str = "Free space";
    let Some(drives) = drives.filter(|d| !d.is_empty()) else {
        out.skipped("drives", LABEL, "Couldn't read your drives.");
        return false;
    };
    let mut found = Vec::new();
    let mut system_low = false;
    for d in drives {
        let is_system = d.mount.eq_ignore_ascii_case(system);
        if let Some(issue) = drive_issue(d, is_system) {
            system_low |= is_system;
            found.push(issue);
        }
    }
    let ok = match drives.iter().find(|d| d.mount.eq_ignore_ascii_case(system)) {
        Some(d) => format!("Every drive has room. {} has {} free.", d.mount, fmt_bytes(d.available)),
        None => "Every drive has room.".into(),
    };
    let issue = if found.len() == 1 { found[0].title.clone() } else { format!("{} drives are almost full", found.len()) };
    out.result("drives", LABEL, found, issue, ok);
    system_low
}

// ---- Startup apps ----

fn analyze_startup(items: Option<&[StartupItem]>, out: &mut Findings) {
    const LABEL: &str = "Startup apps";
    let Some(items) = items else {
        out.skipped("startup", LABEL, "Couldn't read the startup list.");
        return;
    };
    let enabled: Vec<&str> = items.iter().filter(|i| i.enabled).map(|i| i.name.as_str()).collect();
    let n = enabled.len();
    let severity = if n >= 10 {
        Some(Severity::Warning)
    } else if n >= 6 {
        Some(Severity::Tip)
    } else {
        None
    };
    let summary = match n {
        0 => "Nothing starts with Windows.".to_string(),
        1 => "1 app starts with Windows.".to_string(),
        n => format!("{n} apps start with Windows."),
    };
    let mut found = Vec::new();
    if let Some(severity) = severity {
        let shown = enabled.iter().take(8).copied().collect::<Vec<_>>().join(", ");
        let more = if n > 8 { format!(" (+{} more)", n - 8) } else { String::new() };
        let off = items.len() - n;
        found.push(
            HealthIssue::new(
                "startup",
                severity,
                35,
                format!("{n} apps start with Windows"),
                "Every app that starts with Windows makes signing in slower and keeps running in the background, using memory and processor. Turn off the ones you don't need right away. You can still open them yourself, and turning one off never deletes it.",
                format!("Turned on: {shown}{more}. Already turned off: {off}."),
            )
            .fix(FixAction::new("Choose startup apps", ActionKind::OpenPage { page: "startup", sort: None, query: None })),
        );
    }
    out.result("startup", LABEL, found, summary.clone(), summary);
}

// ---- Restart and updates ----

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct RebootState {
    /// Windows Update's RebootRequired key.
    windows_update: bool,
    /// Component Based Servicing's RebootPending key (updates and Windows features).
    servicing: bool,
    /// Files waiting to be replaced or deleted at the next restart (PendingFileRenameOperations).
    file_operations: usize,
}

/// PendingFileRenameOperations holds (source, destination) pairs; an empty destination deletes.
fn count_file_operations(values: &[String]) -> usize {
    values.iter().step_by(2).filter(|s| !s.trim().is_empty()).count()
}

#[cfg(windows)]
fn reboot_state() -> Option<RebootState> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    // A key the user may not open still exists.
    let exists = |path: &str| match hklm.open_subkey_with_flags(path, KEY_READ) {
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied,
    };
    let file_operations = hklm
        .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\Session Manager", KEY_READ)
        .and_then(|k| k.get_value::<Vec<String>, _>("PendingFileRenameOperations"))
        .map(|v| count_file_operations(&v))
        .unwrap_or(0);
    Some(RebootState {
        windows_update: exists(r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"),
        servicing: exists(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"),
        file_operations,
    })
}

#[cfg(not(windows))]
fn reboot_state() -> Option<RebootState> {
    None
}

const WEEK_SECS: u64 = 7 * 86400;

fn analyze_restart(uptime_secs: u64, reboot: Option<RebootState>, out: &mut Findings) {
    let state = reboot.unwrap_or_default();
    let updates = state.windows_update || state.servicing;
    let long = long_duration(uptime_secs);
    let days = uptime_secs / 86400;

    let mut pending = Vec::new();
    if state.windows_update {
        pending.push("Windows Update RebootRequired".to_string());
    }
    if state.servicing {
        pending.push("Component Based Servicing RebootPending".to_string());
    }
    if state.file_operations > 0 {
        pending.push(format!("{} PendingFileRenameOperations", state.file_operations));
    }
    let detail = if pending.is_empty() {
        format!("Running for {long} since the last restart.")
    } else {
        format!("Running for {long} since the last restart. Waiting for a restart: {}.", pending.join(", "))
    };
    let restart = || FixAction::new("Restart now…", ActionKind::Restart);

    let mut restart_found = Vec::new();
    let mut update_found = Vec::new();
    if updates {
        let mut explanation = "Windows has installed updates that only take effect after a restart. Until then, update work can keep running in the background and slow your PC down.".to_string();
        if uptime_secs > WEEK_SECS {
            explanation.push_str(&format!(" Your PC has also been running for {long} without a restart."));
        }
        update_found.push(
            HealthIssue::new("updates-restart", Severity::Warning, 70, "Restart to finish installing updates", explanation, detail)
                .fix(restart())
                .or(FixAction::settings("Open Windows Update", "windowsupdate")),
        );
    } else if uptime_secs > WEEK_SECS {
        let mut explanation = "Restarting clears out memory that apps didn't give back and background tasks that got stuck. Choose Restart rather than Shut down: with Fast Startup on, shutting down doesn't fully reset Windows.".to_string();
        if state.file_operations > 0 {
            explanation.push_str(" An app you installed or updated is also waiting for a restart to finish.");
        }
        restart_found.push(HealthIssue::new("uptime", Severity::Warning, 60, format!("Your PC hasn't restarted in {days} days"), explanation, detail).fix(restart()));
    } else if state.file_operations > 0 {
        restart_found.push(
            HealthIssue::new(
                "pending-restart",
                Severity::Tip,
                20,
                "An app is waiting for a restart",
                "Something you installed, updated or removed needs a restart to finish. It isn't urgent: restart when it suits you.",
                detail,
            )
            .fix(restart()),
        );
    }

    let restart_summary = if uptime_secs > WEEK_SECS { format!("Running for {long} without a restart.") } else { format!("Last restarted {long} ago.") };
    let restart_issue = restart_found.first().map(|i| i.title.clone()).unwrap_or_else(|| restart_summary.clone());
    out.result("restart", "Restart", restart_found, restart_issue, restart_summary);
    if reboot.is_none() {
        out.skipped("updates", "Windows Update", "Couldn't check for updates waiting on a restart.");
    } else {
        out.result("updates", "Windows Update", update_found, "Updates are waiting for a restart.", "No updates are waiting for a restart.");
    }
}

// ---- Temp files ----

fn analyze_temp(report: Option<Result<CleanReport, String>>, system_low: bool, out: &mut Findings) {
    const LABEL: &str = "Temp files";
    let report = match report {
        Some(Ok(report)) => report,
        Some(Err(_)) => {
            // The cleaner's message is worded for cleaning ("nothing was cleaned"), so it isn't shown here.
            out.skipped("temp", LABEL, "Couldn't measure the temp folder.");
            return;
        }
        None => {
            out.skipped("temp", LABEL, "Measuring the temp folder took too long.");
            return;
        }
    };
    let size = fmt_bytes(report.bytes);
    let severity = if report.bytes >= GB || (system_low && report.bytes >= 100 * MB) {
        Some(Severity::Warning)
    } else if report.bytes >= 300 * MB {
        Some(Severity::Tip)
    } else {
        None
    };
    let mut found = Vec::new();
    if let Some(severity) = severity {
        found.push(
            HealthIssue::new(
                "temp-files",
                severity,
                40,
                format!("{size} of temporary files can be cleaned up"),
                "Apps and installers leave temporary files behind. Cleaning them frees space on your Windows drive. Files used in the last 24 hours and files that are in use are always kept, and nothing outside the temp folder is touched.",
                format!("{} files older than 24 hours in {} ({size}).", report.files, report.folder),
            )
            .fix(FixAction::new(format!("Free {size}"), ActionKind::CleanTemp { bytes: report.bytes })),
        );
    }
    let ok = if report.files == 0 { "Already clean.".to_string() } else { format!("{size} found. Nothing worth cleaning yet.") };
    out.result("temp", LABEL, found, format!("{size} can be freed."), ok);
}

// ---- Power ----

const BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";
const HIGH_PERFORMANCE: &str = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
const POWER_SAVER: &str = "a1841308-3541-4fab-bc81-f71556f20b4a";
/// Windows 11's "Best power efficiency" power mode (an overlay on the Balanced plan).
const BEST_EFFICIENCY_MODE: &str = "961cc777-2547-4f9d-8174-7d86181b8a7a";

#[derive(Clone, Debug, PartialEq)]
struct PowerPlan {
    guid: String,
    /// As Windows names it, in the user's language.
    name: String,
    active: bool,
}

impl PowerPlan {
    fn label(&self) -> String {
        if !self.name.is_empty() {
            return self.name.clone();
        }
        match self.guid.as_str() {
            BALANCED => "Balanced".into(),
            HIGH_PERFORMANCE => "High performance".into(),
            POWER_SAVER => "Power saver".into(),
            other => other.into(),
        }
    }
}

#[derive(Clone, Debug)]
struct PowerState {
    plans: Vec<PowerPlan>,
    on_battery: Option<bool>,
    battery_saver: bool,
    /// The power mode slider (Settings > Power) is on "Best power efficiency" for the current
    /// power source. Many laptops have no Power saver plan, only this.
    efficiency_mode: bool,
}

fn is_guid(s: &str) -> bool {
    s.len() == 36 && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// Parses `powercfg /list`. Lines look like `Power Scheme GUID: <guid>  (Balanced) *` in any
/// language; the star marks the active plan.
fn parse_power_plans(output: &str) -> Vec<PowerPlan> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let guid = line.split_whitespace().find(|t| is_guid(t))?;
            let rest = &line[line.find(guid)? + guid.len()..];
            let name = match (rest.find('('), rest.rfind(')')) {
                (Some(open), Some(close)) if close > open => rest[open + 1..close].trim().to_string(),
                _ => String::new(),
            };
            Some(PowerPlan { guid: guid.to_ascii_lowercase(), name, active: rest.trim_end().ends_with('*') })
        })
        .collect()
}

fn system32(program: &str) -> PathBuf {
    let path = os::windows_dir().join("System32").join(program);
    if path.is_file() { path } else { program.into() }
}

fn power_plans() -> Result<Vec<PowerPlan>, String> {
    if !cfg!(windows) {
        return Err("Power plans are only available on Windows.".into());
    }
    let out = run_tool(&system32("powercfg.exe"), &["/list"])?;
    let plans = parse_power_plans(&out.text);
    if !out.ok || plans.is_empty() {
        return Err(format!("Couldn't read the power plans. {}", out.text.trim()));
    }
    Ok(plans)
}

#[cfg(windows)]
fn battery_status() -> (Option<bool>, bool) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (None, false);
    }
    // 128 = no system battery; AC line 0 = on battery, 255 = unknown.
    let has_battery = status.BatteryFlag != 128 && status.BatteryFlag != 255;
    let on_battery = match status.ACLineStatus {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    };
    (on_battery.filter(|_| has_battery), status.SystemStatusFlag == 1)
}

#[cfg(not(windows))]
fn battery_status() -> (Option<bool>, bool) {
    (None, false)
}

/// The power mode overlay Windows applies for the current power source (read only).
#[cfg(windows)]
fn power_mode_overlay(on_battery: bool) -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes", KEY_READ)
        .ok()?;
    let value = if on_battery { "ActiveOverlayDcPowerScheme" } else { "ActiveOverlayAcPowerScheme" };
    key.get_value::<String, _>(value).ok().map(|guid| guid.trim().to_ascii_lowercase())
}

#[cfg(not(windows))]
fn power_mode_overlay(_on_battery: bool) -> Option<String> {
    None
}

fn power_state() -> Option<PowerState> {
    let plans = power_plans().ok()?;
    let (on_battery, battery_saver) = battery_status();
    let efficiency_mode = power_mode_overlay(on_battery == Some(true)).is_some_and(|guid| guid == BEST_EFFICIENCY_MODE);
    Some(PowerState { plans, on_battery, battery_saver, efficiency_mode })
}

fn analyze_power(state: Option<&PowerState>, out: &mut Findings) {
    const LABEL: &str = "Power plan";
    let Some(state) = state else {
        out.skipped("power", LABEL, "Couldn't read the power plan.");
        return;
    };
    let Some(active) = state.plans.iter().find(|p| p.active) else {
        out.skipped("power", LABEL, "Couldn't tell which power plan is active.");
        return;
    };
    let on_battery = state.on_battery == Some(true);
    let mut found = Vec::new();
    if active.guid == POWER_SAVER {
        let plan = |guid: &str| state.plans.iter().find(|p| p.guid == guid);
        let switch = |p: &PowerPlan, label: String| FixAction::new(label, ActionKind::SetPowerPlan { guid: p.guid.clone(), name: p.label() });
        let mut explanation = "Power saver makes your processor run slower to save energy, so everything takes longer. Balanced is just as frugal while your PC is idle, and runs at full speed when you need it.".to_string();
        if on_battery {
            explanation.push_str(" You're on battery right now, so Power saver does help the battery last longer.");
        }
        let available = state.plans.iter().map(|p| p.label()).collect::<Vec<_>>().join(", ");
        let mut issue = HealthIssue::new(
            "power-plan",
            if on_battery { Severity::Tip } else { Severity::Warning },
            65,
            "Your PC is set to Power saver",
            explanation,
            format!("Active power plan: {} ({}). Plans on this PC: {available}.", active.label(), active.guid),
        );
        match (plan(BALANCED), plan(HIGH_PERFORMANCE)) {
            (Some(balanced), high) => {
                issue = issue.fix(switch(balanced, format!("Switch to {}", balanced.label())));
                if let Some(high) = high {
                    issue = issue.or(switch(high, format!("Use {}", high.label())));
                }
            }
            (None, Some(high)) => issue = issue.fix(switch(high, format!("Switch to {}", high.label()))),
            (None, None) => issue = issue.fix(FixAction::settings("Open power settings", "powersleep")),
        }
        found.push(issue);
    } else if state.efficiency_mode {
        let mut explanation = "This power mode tells Windows to slow your processor down to save energy, so everything takes longer. In Windows Settings, under Power mode, choose Balanced, or Best performance when you need full speed.".to_string();
        if on_battery {
            explanation.push_str(" You're on battery right now, so it does help the battery last longer.");
        }
        found.push(
            HealthIssue::new(
                "power-mode",
                if on_battery { Severity::Tip } else { Severity::Warning },
                60,
                "Your PC is set to Best power efficiency",
                explanation,
                format!(
                    "Power mode overlay {BEST_EFFICIENCY_MODE} is active {}. Power plan: {} ({}).",
                    if on_battery { "on battery" } else { "while plugged in" },
                    active.label(),
                    active.guid
                ),
            )
            .fix(FixAction::settings("Open power settings", "powersleep")),
        );
    } else if state.battery_saver {
        found.push(
            HealthIssue::new(
                "battery-saver",
                Severity::Tip,
                30,
                "Battery saver is on",
                "Battery saver limits background activity and can lower performance so the battery lasts longer. Plug in your charger or turn it off in Windows Settings when you need full speed.",
                format!("Energy saver is on. Active power plan: {} ({}).", active.label(), active.guid),
            )
            .fix(FixAction::settings("Open battery settings", "batterysaver")),
        );
    }
    let summary = if on_battery { format!("{} (on battery).", active.label()) } else { format!("{}.", active.label()) };
    let issue_summary = found.first().map(|i| i.title.clone()).unwrap_or_default();
    out.result("power", LABEL, found, issue_summary, summary);
}

/// Switches the active power plan with powercfg, then checks that Windows took it.
pub fn set_active_power_plan(guid: &str) -> Result<(), String> {
    if !is_guid(guid) {
        return Err("That isn't a valid power plan.".into());
    }
    let out = run_tool(&system32("powercfg.exe"), &["/setactive", guid])?;
    let hint = if os::is_elevated() {
        "It may be managed by your organization."
    } else {
        "It may be managed by your organization, or need administrator rights (use Restart as administrator)."
    };
    if !out.ok {
        return Err(format!("Windows didn't switch the power plan. {hint} ({})", out.text.trim()));
    }
    let now_active = power_plans()?.into_iter().find(|p| p.active);
    if now_active.is_none_or(|p| !p.guid.eq_ignore_ascii_case(guid)) {
        return Err(format!("Windows didn't switch the power plan. {hint}"));
    }
    Ok(())
}

/// Switches to another power plan and records it in Activity with an undo. Returns the activity
/// entry id (for an Undo button), or None when that plan was already active.
#[tauri::command]
pub async fn set_power_plan(app: AppHandle, guid: String) -> Result<Option<String>, String> {
    crate::blocking(move || {
        let plans = power_plans()?;
        let target = plans
            .iter()
            .find(|p| p.guid.eq_ignore_ascii_case(&guid))
            .cloned()
            .ok_or("That power plan isn't on this PC any more. Run the check again.")?;
        let previous = plans.into_iter().find(|p| p.active);
        if previous.as_ref().is_some_and(|p| p.guid == target.guid) {
            return Ok(None);
        }
        set_active_power_plan(&target.guid)?;
        let detail = previous.as_ref().map(|p| format!("Was {} ({})", p.label(), p.guid));
        let undo = previous.map(|p| Undo::PowerPlan { name: p.label(), guid: p.guid });
        Ok(app.state::<ActivityLog>().record(&app, CATEGORY, format!("Switched power plan to {}", target.label()), detail, undo))
    })
    .await
}

// ---- Temperatures ----

fn analyze_temperatures(temps: Option<&[TempInfo]>, out: &mut Findings) {
    const LABEL: &str = "Temperature";
    let Some(hottest) = temps.and_then(|t| t.iter().max_by(|a, b| a.celsius.total_cmp(&b.celsius))) else {
        out.skipped("temperature", LABEL, "This PC doesn't share temperature readings with Windows.");
        return;
    };
    let c = hottest.celsius;
    let severity = if c >= 90.0 {
        Some(Severity::Critical)
    } else if c >= 80.0 {
        Some(Severity::Warning)
    } else {
        None
    };
    let mut found = Vec::new();
    if let Some(severity) = severity {
        let readings = temps.unwrap_or_default().iter().map(|t| format!("{} {:.0}°C", t.label, t.celsius)).collect::<Vec<_>>().join(", ");
        found.push(
            HealthIssue::new(
                "temperature",
                severity,
                78,
                "Your PC is running hot",
                format!(
                    "{} is at {c:.0}°C. When it gets this hot, the processor slows itself down to cool off, which makes everything slower. Make sure the air vents aren't blocked, keep laptops on a hard surface, and clean out dust.",
                    hottest.label
                ),
                format!("Readings from Windows sensors: {readings}."),
            )
            .fix(FixAction::processes("See what's working hard", "cpu", None)),
        );
    }
    let summary = format!("{} at {c:.0}°C.", hottest.label);
    out.result("temperature", LABEL, found, summary.clone(), summary);
}

// ---- Hard disk ----

/// Busy percentage of the Windows drive over the sampling window (100 minus "% Idle Time").
#[cfg(windows)]
fn disk_active_time(drive: &str) -> Option<f32> {
    use windows::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
        PdhGetFormattedCounterValue, PdhOpenQueryW,
    };
    use windows::core::PCWSTR;

    // "English" counter names work whatever the Windows display language is.
    let path = os::wide(std::ffi::OsStr::new(&format!(r"\LogicalDisk({drive})\% Idle Time")));
    let mut query = PDH_HQUERY(std::ptr::null_mut());
    if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
        return None;
    }
    let mut counter = PDH_HCOUNTER(std::ptr::null_mut());
    let mut idle = Vec::new();
    if unsafe { PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) } == 0 {
        unsafe { PdhCollectQueryData(query) };
        for _ in 0..SAMPLES {
            thread::sleep(SAMPLE_INTERVAL);
            if unsafe { PdhCollectQueryData(query) } != 0 {
                continue;
            }
            let mut value = PDH_FMT_COUNTERVALUE::default();
            // CStatus 0 = valid data, 1 = new data.
            if unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) } == 0 && value.CStatus <= 1 {
                idle.push(unsafe { value.Anonymous.doubleValue });
            }
        }
    }
    unsafe { PdhCloseQuery(query) };
    if idle.is_empty() {
        return None;
    }
    let avg_idle = idle.iter().sum::<f64>() / idle.len() as f64;
    Some((100.0 - avg_idle).clamp(0.0, 100.0) as f32)
}

#[cfg(not(windows))]
fn disk_active_time(_drive: &str) -> Option<f32> {
    None
}

const BUSY_DISK: f32 = 50.0;

fn analyze_system_disk(disk: Option<SystemDisk>, system: &str, out: &mut Findings) {
    const LABEL: &str = "Windows drive";
    let Some(disk) = disk else {
        out.skipped("systemDrive", LABEL, "Couldn't tell what kind of drive Windows is on.");
        return;
    };
    if !disk.hdd {
        out.check("systemDrive", LABEL, CheckStatus::Ok, format!("{system} is a fast solid-state drive (SSD)."));
        return;
    }
    let mut found = Vec::new();
    if let Some(active) = disk.active.filter(|a| *a >= BUSY_DISK) {
        found.push(
            HealthIssue::new(
                "hdd-busy",
                Severity::Tip,
                30,
                "Windows is on a busy hard disk",
                format!(
                    "Your Windows drive ({system}) is a hard disk (HDD), and it was busy {active:.0}% of the time during the check. Hard disks are many times slower than SSDs, so apps open slowly while it's busy. Moving Windows to an SSD is the biggest speed upgrade for this PC."
                ),
                format!("{system} reports a seek penalty (spinning disk). Average active time {active:.1}% over {SAMPLES} seconds (100 − % Idle Time)."),
            )
            .fix(FixAction::processes("See what's using the disk", "io", None)),
        );
    }
    let ok = match disk.active {
        Some(active) => format!("{system} is a hard disk (HDD). It was {active:.0}% busy during the check."),
        None => format!("{system} is a hard disk (HDD)."),
    };
    out.result("systemDrive", LABEL, found, format!("{system} is a hard disk (HDD) and was very busy."), ok);
}

// ---- Friendly app names ----

/// Names for common Windows parts whose file can't be read without administrator rights.
const KNOWN_NAMES: &[(&str, &str)] = &[
    ("msmpeng.exe", "Microsoft Defender Antivirus"),
    ("mpdefendercoreservice.exe", "Microsoft Defender Core Service"),
    ("searchindexer.exe", "Windows Search indexing"),
    ("tiworker.exe", "Windows Update installer"),
    ("trustedinstaller.exe", "Windows Modules Installer"),
    ("svchost.exe", "Windows service host"),
    ("dwm.exe", "Desktop Window Manager"),
    ("explorer.exe", "File Explorer"),
    ("system", "System"),
    ("memory compression", "Memory Compression"),
    ("compattelrunner.exe", "Microsoft Compatibility Telemetry"),
    ("wmiprvse.exe", "WMI Provider Host"),
    ("audiodg.exe", "Windows Audio"),
];

/// "Google Chrome" for chrome.exe: the file's own description, else a known name, else the file name.
fn display_name(app: &AppStats) -> String {
    if let Some(desc) = app.exe.as_deref().and_then(file_description) {
        let plain = desc.trim();
        if !plain.is_empty() && plain.chars().count() <= 48 && !plain.eq_ignore_ascii_case(&app.name) {
            return plain.to_string();
        }
    }
    let lower = app.name.to_lowercase();
    KNOWN_NAMES.iter().find(|(n, _)| *n == lower).map(|(_, d)| (*d).to_string()).unwrap_or_else(|| app.name.clone())
}

/// The FileDescription from a program's version information.
#[cfg(windows)]
fn file_description(path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows::core::{PCWSTR, w};

    let file = os::wide(std::ffi::OsStr::new(path));
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(file.as_ptr()), None, size, data.as_mut_ptr().cast()).ok()?;
        let block = data.as_ptr().cast();

        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        let mut languages: Vec<(u16, u16)> = Vec::new();
        if VerQueryValueW(block, w!(r"\VarFileInfo\Translation"), &mut ptr, &mut len).as_bool() && !ptr.is_null() {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len as usize / 2) & !1);
            languages.extend(pairs.chunks_exact(2).map(|p| (p[0], p[1])));
        }
        // US English in Unicode and Windows-1252, the usual fallbacks.
        languages.extend([(0x0409, 0x04B0), (0x0409, 0x04E4)]);
        for (lang, codepage) in languages {
            let key = os::wide(std::ffi::OsStr::new(&format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\FileDescription")));
            if VerQueryValueW(block, PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() && len > 0 {
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, len as usize));
                let text = text.trim_end_matches('\0').trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
        None
    }
}

#[cfg(not(windows))]
fn file_description(_path: &str) -> Option<String> {
    None
}

// ---- Restart, Windows Settings ----

/// Restarts Windows. Running apps get the usual chance to ask about unsaved work.
#[tauri::command]
pub async fn restart_pc(app: AppHandle) -> Result<(), String> {
    crate::blocking(move || {
        if !cfg!(windows) {
            return Err("Restarting is only supported on Windows.".into());
        }
        // No timeout: a delay would make shutdown.exe force apps closed and lose unsaved work.
        let out = run_tool(&system32("shutdown.exe"), &["/r", "/t", "0"])?;
        if !out.ok {
            return Err(format!("Windows didn't start the restart. {}", out.text.trim()));
        }
        app.state::<ActivityLog>().record(&app, CATEGORY, "Restarted the PC".into(), None, None);
        Ok(())
    })
    .await
}

/// The Windows Settings pages the fixes link to.
fn settings_uri(page: &str) -> Option<&'static str> {
    match page {
        "windowsupdate" => Some("ms-settings:windowsupdate"),
        "storagesense" => Some("ms-settings:storagesense"),
        "powersleep" => Some("ms-settings:powersleep"),
        "batterysaver" => Some("ms-settings:batterysaver"),
        _ => None,
    }
}

#[tauri::command]
pub async fn open_windows_settings(page: String) -> Result<(), String> {
    let uri = settings_uri(&page).ok_or("Unknown Windows Settings page.")?;
    crate::blocking(move || tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| format!("Couldn't open Windows Settings: {e}"))).await
}

// ---- Helpers ----

struct ToolOutput {
    ok: bool,
    /// Output and error text together.
    text: String,
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// Runs a Windows tool without a console window, stopping it if it doesn't finish in time.
fn run_tool(program: &Path, args: &[&str]) -> Result<ToolOutput, String> {
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {name}: {e}"))?;
    // Read both pipes on their own threads so a full pipe can't stall the tool.
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < TOOL_TIMEOUT => thread::sleep(Duration::from_millis(30)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} didn't answer in time."));
            }
            Err(e) => return Err(format!("Couldn't run {name}: {e}")),
        }
    };
    let mut text = os::decode_output(&stdout.join().unwrap_or_default());
    let err = os::decode_output(&stderr.join().unwrap_or_default());
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    Ok(ToolOutput { ok: status.success(), text })
}

/// Sizes like the UI shows them ("1.3 GB", "380 GB", "512 MB").
fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        return format!("{n} B");
    }
    let text = if value >= 100.0 {
        format!("{value:.0}")
    } else if value >= 10.0 {
        format!("{value:.1}")
    } else {
        format!("{value:.2}")
    };
    let text = if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text };
    format!("{text} {}", UNITS[unit])
}

/// "3 days, 4 hours" for sentences.
fn long_duration(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60);
    let part = |v: u64, unit: &str| format!("{v} {unit}{}", if v == 1 { "" } else { "s" });
    match (d, h, m) {
        (0, 0, m) => part(m.max(1), "minute"),
        (0, h, 0) => part(h, "hour"),
        (0, h, m) => format!("{}, {}", part(h, "hour"), part(m, "minute")),
        (d, 0, _) => part(d, "day"),
        (d, h, _) => format!("{}, {}", part(d, "day"), part(h, "hour")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, cpu: [f32; SAMPLES], memory: u64, protected: bool) -> AppStats {
        AppStats {
            name: name.into(),
            cpu,
            memory: [memory; SAMPLES],
            targets: vec![ProcTarget { pid: 42, start_time: 7 }],
            protected,
            ..Default::default()
        }
    }

    fn mem(load: f32, total: u64) -> MemoryStatus {
        MemoryStatus { load, total, available: total - (total as f64 * load as f64 / 100.0) as u64, commit: None }
    }

    #[test]
    fn parses_powercfg_list_in_any_language() {
        let english = "\r\nExisting Power Schemes (* Active)\r\n-----------------------------------\r\n\
            Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\r\n\
            Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)\r\n\
            Power Scheme GUID: A1841308-3541-4fab-bc81-f71556f20b4a  (Power saver) *\r\n";
        let plans = parse_power_plans(english);
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[2], PowerPlan { guid: POWER_SAVER.into(), name: "Power saver".into(), active: true });
        assert!(!plans[0].active);

        let german = "GUID des Energieschemas: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert) *\n\
            GUID des Energieschemas: 11111111-2222-3333-4444-555555555555  (Mein Plan (leise))";
        let plans = parse_power_plans(german);
        assert_eq!(plans[0].name, "Ausbalanciert");
        assert!(plans[0].active);
        assert_eq!(plans[1].name, "Mein Plan (leise)");
        assert!(parse_power_plans("Zugriff verweigert").is_empty());
        assert!(!is_guid("381b4222-f694-41f0-9685-ff5bb260df2e; calc"));
    }

    #[test]
    fn counts_pending_file_operations() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(count_file_operations(&v(&[r"\??\C:\a.tmp", "", r"\??\C:\b.new", r"!\??\C:\b.dll"])), 2);
        assert_eq!(count_file_operations(&[]), 0);
    }

    #[test]
    fn formats_like_the_ui() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(1_300_000_000), "1.21 GB");
        assert_eq!(fmt_bytes(380 * GB), "380 GB");
        assert_eq!(fmt_bytes(1000 * MB), "0.98 GB");
        assert_eq!(fmt_bytes(15 * GB + GB / 2), "15.5 GB");
        assert_eq!(fmt_bytes(2 * GB), "2 GB");
        assert_eq!(long_duration(93_784), "1 day, 2 hours");
        assert_eq!(long_duration(12 * 86400), "12 days");
        assert_eq!(long_duration(30), "1 minute");
    }

    #[test]
    fn finds_sustained_hogs_but_not_spikes() {
        let total = 16 * GB;
        let apps = vec![
            app("chrome.exe", [62.0, 55.0, 70.0, 58.0], 3 * GB, false),
            app("spiky.exe", [95.0, 1.0, 0.0, 2.0], 100 * MB, false),
            app("MsMpEng.exe", [22.0, 25.0, 30.0, 21.0], 200 * MB, true),
            app("teams.exe", [1.0, 1.0, 1.0, 1.0], 7 * GB, false),
        ];
        let mut out = Findings::default();
        analyze_apps(&apps, &[90.0, 88.0, 95.0, 91.0], Some(&mem(80.0, total)), |a| a.name.clone(), &mut out);
        let ids: Vec<&str> = out.issues.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["cpu-chrome.exe", "cpu-msmpeng.exe", "memory-teams.exe"]);
        assert_eq!(out.issues[0].severity, Severity::Critical);
        assert!(matches!(out.issues[0].action.as_ref().unwrap().kind, ActionKind::EndProcess { .. }));
        // Windows parts are never offered for ending.
        assert_eq!(out.issues[1].severity, Severity::Tip);
        assert!(matches!(out.issues[1].action.as_ref().unwrap().kind, ActionKind::OpenPage { page: "processes", .. }));
        assert_eq!(out.checks[0].status, CheckStatus::Issue);

        let mut calm = Findings::default();
        analyze_apps(&apps[1..2], &[30.0, 10.0, 8.0, 9.0], Some(&mem(40.0, total)), |a| a.name.clone(), &mut calm);
        assert!(calm.issues.is_empty());
        assert_eq!(calm.checks[0].status, CheckStatus::Ok);
    }

    #[test]
    fn busy_processor_without_a_single_culprit() {
        let apps: Vec<AppStats> = (0..10).map(|i| app(&format!("app{i}.exe"), [9.0; SAMPLES], 100 * MB, false)).collect();
        let mut out = Findings::default();
        analyze_apps(&apps, &[92.0, 95.0, 90.0, 93.0], None, |a| a.name.clone(), &mut out);
        assert_eq!(out.issues.len(), 1);
        assert_eq!(out.issues[0].id, "cpu-busy");
    }

    #[test]
    fn memory_pressure_from_load_or_commit() {
        let mut out = Findings::default();
        analyze_memory(Some(&mem(95.0, 8 * GB)), &mut out);
        assert_eq!(out.issues[0].severity, Severity::Critical);

        let mut out = Findings::default();
        let commit = MemoryStatus { commit: Some((19 * GB, 20 * GB)), ..mem(60.0, 16 * GB) };
        analyze_memory(Some(&commit), &mut out);
        assert_eq!(out.issues[0].severity, Severity::Critical);
        assert!(out.issues[0].explanation.contains("crash"));

        let mut out = Findings::default();
        analyze_memory(Some(&mem(50.0, 16 * GB)), &mut out);
        assert!(out.issues.is_empty());
        assert_eq!(out.checks[0].status, CheckStatus::Ok);
    }

    #[test]
    fn low_space_is_judged_by_drive_role() {
        let drive = |mount: &str, total: u64, available: u64| DriveSpace { mount: mount.into(), label: "Disk".into(), total, available };
        assert_eq!(drive_issue(&drive("C:", 500 * GB, 4 * GB), true).unwrap().severity, Severity::Critical);
        assert_eq!(drive_issue(&drive("C:", 500 * GB, 40 * GB), true).unwrap().severity, Severity::Warning);
        assert!(drive_issue(&drive("C:", 500 * GB, 120 * GB), true).is_none());
        // A big data drive with plenty of room left isn't flagged at 8% free.
        assert!(drive_issue(&drive("D:", 4000 * GB, 320 * GB), false).is_none());
        assert_eq!(drive_issue(&drive("D:", 1000 * GB, 30 * GB), false).unwrap().severity, Severity::Warning);
        // Recovery and other small utility partitions are full by design.
        assert!(drive_issue(&drive("E:", 2 * GB, 100 * MB), false).is_none());
        let recovery = DriveSpace { label: "RECOVERY".into(), ..drive("R:", 20 * GB, GB) };
        assert!(drive_issue(&recovery, false).is_none());

        let mut out = Findings::default();
        assert!(analyze_drives(Some(&[drive("C:", 500 * GB, 4 * GB), drive("D:", 1000 * GB, 500 * GB)]), "C:", &mut out));
        assert_eq!(out.issues.len(), 1);
        assert_eq!(out.issues[0].id, "drive-c");
    }

    #[test]
    fn restart_advice() {
        let mut out = Findings::default();
        analyze_restart(3 * 86400, Some(RebootState { windows_update: true, ..Default::default() }), &mut out);
        assert_eq!(out.issues[0].id, "updates-restart");
        assert_eq!(out.checks[0].status, CheckStatus::Ok);
        assert_eq!(out.checks[1].status, CheckStatus::Issue);

        let mut out = Findings::default();
        analyze_restart(12 * 86400, Some(RebootState { file_operations: 2, ..Default::default() }), &mut out);
        assert_eq!(out.issues.len(), 1);
        assert_eq!(out.issues[0].id, "uptime");
        assert!(out.issues[0].title.contains("12 days"));

        let mut out = Findings::default();
        analyze_restart(3600, None, &mut out);
        assert!(out.issues.is_empty());
        assert_eq!(out.checks[1].status, CheckStatus::Skipped);
    }

    #[test]
    fn power_saver_offers_balanced_first() {
        let plan = |guid: &str, active: bool| PowerPlan { guid: guid.into(), name: String::new(), active };
        let state = PowerState {
            plans: vec![plan(BALANCED, false), plan(HIGH_PERFORMANCE, false), plan(POWER_SAVER, true)],
            on_battery: Some(false),
            battery_saver: false,
            efficiency_mode: false,
        };
        let mut out = Findings::default();
        analyze_power(Some(&state), &mut out);
        let issue = &out.issues[0];
        assert_eq!(issue.severity, Severity::Warning);
        let action = issue.action.as_ref().unwrap();
        assert!(action.safe);
        assert_eq!(action.kind, ActionKind::SetPowerPlan { guid: BALANCED.into(), name: "Balanced".into() });
        assert_eq!(issue.alternatives.len(), 1);

        let on_battery = PowerState { on_battery: Some(true), ..state.clone() };
        let mut out = Findings::default();
        analyze_power(Some(&on_battery), &mut out);
        assert_eq!(out.issues[0].severity, Severity::Tip);

        let balanced = PowerState { plans: vec![plan(BALANCED, true)], ..state };
        let mut out = Findings::default();
        analyze_power(Some(&balanced), &mut out);
        assert!(out.issues.is_empty());
        assert_eq!(out.checks[0].summary, "Balanced.");

        // Laptops without a Power saver plan slow down through the power mode instead.
        let efficient = PowerState { efficiency_mode: true, ..balanced };
        let mut out = Findings::default();
        analyze_power(Some(&efficient), &mut out);
        assert_eq!(out.issues[0].id, "power-mode");
        assert_eq!(out.issues[0].severity, Severity::Warning);
        assert!(matches!(out.issues[0].action.as_ref().unwrap().kind, ActionKind::OpenSettings { page: "powersleep" }));
    }

    #[test]
    fn temp_and_startup_thresholds() {
        let report = |bytes: u64| Some(Ok(CleanReport { folder: "T".into(), files: 10, bytes, skipped: 0 }));
        let mut out = Findings::default();
        analyze_temp(report(2 * GB), false, &mut out);
        assert_eq!(out.issues[0].severity, Severity::Warning);
        assert!(out.issues[0].action.as_ref().unwrap().safe);
        let mut out = Findings::default();
        analyze_temp(report(200 * MB), true, &mut out);
        assert_eq!(out.issues[0].severity, Severity::Warning);
        let mut out = Findings::default();
        analyze_temp(report(200 * MB), false, &mut out);
        assert!(out.issues.is_empty());

        let item = |name: &str, enabled: bool| StartupItem {
            name: name.into(),
            command: String::new(),
            source: startup::StartupSource::UserRun,
            location: String::new(),
            enabled,
            needs_admin: false,
        };
        let items: Vec<StartupItem> = (0..11).map(|i| item(&format!("App {i}"), i != 0)).collect();
        let mut out = Findings::default();
        analyze_startup(Some(&items), &mut out);
        assert_eq!(out.issues[0].severity, Severity::Warning);
        assert!(out.issues[0].detail.contains("(+2 more)"));
    }

    #[test]
    fn hot_pc_and_busy_hard_disk() {
        let temps = [TempInfo { label: "CPU".into(), celsius: 93.0 }, TempInfo { label: "GPU".into(), celsius: 60.0 }];
        let mut out = Findings::default();
        analyze_temperatures(Some(&temps), &mut out);
        assert_eq!(out.issues[0].severity, Severity::Critical);
        let mut out = Findings::default();
        analyze_temperatures(None, &mut out);
        assert_eq!(out.checks[0].status, CheckStatus::Skipped);

        let mut out = Findings::default();
        analyze_system_disk(Some(SystemDisk { hdd: true, active: Some(87.0) }), "C:", &mut out);
        assert_eq!(out.issues[0].severity, Severity::Tip);
        let mut out = Findings::default();
        analyze_system_disk(Some(SystemDisk { hdd: false, active: None }), "C:", &mut out);
        assert!(out.issues.is_empty());
    }

    #[test]
    fn scores_and_ranks_issues() {
        let issue = |id: &str, severity, rank| HealthIssue::new(id, severity, rank, "", "", "");
        let mut issues = vec![issue("tip", Severity::Tip, 99), issue("warn", Severity::Warning, 10), issue("crit", Severity::Critical, 1), issue("warn2", Severity::Warning, 50)];
        rank(&mut issues);
        let ids: Vec<&str> = issues.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["crit", "warn2", "warn", "tip"]);
        assert_eq!(score(&issues), 100 - 20 - 10 - 10 - 3);
        assert_eq!(score(&[]), 100);
        let many: Vec<HealthIssue> = (0..6).map(|i| issue(&i.to_string(), Severity::Critical, 0)).collect();
        assert_eq!(score(&many), 0);
    }

    #[test]
    fn serializes_actions_as_kind_and_payload() {
        let end = FixAction::new("End Chrome", ActionKind::EndProcess { name: "chrome.exe".into(), targets: vec![ProcTarget { pid: 1, start_time: 2 }] });
        let json = serde_json::to_value(&end).unwrap();
        assert_eq!(json["kind"], "endProcess");
        assert_eq!(json["safe"], false);
        assert_eq!(json["payload"]["targets"][0]["startTime"], 2);
        let restart = serde_json::to_value(FixAction::new("Restart", ActionKind::Restart)).unwrap();
        assert_eq!(restart, serde_json::json!({ "label": "Restart", "safe": false, "kind": "restart" }));
        let issue = serde_json::to_value(HealthIssue::new("x", Severity::Tip, 0, "t", "e", "d")).unwrap();
        assert_eq!(issue["severity"], "tip");
        assert!(issue.get("rank").is_none());
    }

    #[test]
    fn settings_pages_are_allow_listed() {
        assert_eq!(settings_uri("windowsupdate"), Some("ms-settings:windowsupdate"));
        assert_eq!(settings_uri("ms-settings:../../calc"), None);
    }
}
