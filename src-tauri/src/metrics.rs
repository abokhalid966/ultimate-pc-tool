//! Background sampler: refreshes system metrics and the process table once per
//! second while the window is visible, caches the latest snapshot, and pushes it
//! to the UI as an event. While the app sits hidden in the tray it only samples
//! CPU and memory, for the tray tooltip and alerts. The mini overlay needs the
//! system numbers but not the process table.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde::Serialize;
use sysinfo::{
    Components, CpuRefreshKind, DiskRefreshKind, Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};
use tauri::{AppHandle, Emitter};

use crate::processes::{self, ProcessInfo, ProtectionCache};

pub const METRICS_EVENT: &str = "metrics://update";
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const HIDDEN_INTERVAL: Duration = Duration::from_secs(3);
const STORAGE_INTERVAL: Duration = Duration::from_secs(5);
const TEMPERATURE_INTERVAL: Duration = Duration::from_secs(15);

static UI_VISIBLE: AtomicBool = AtomicBool::new(true);
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);
static SAMPLER: OnceLock<thread::Thread> = OnceLock::new();
static TEMPS: RwLock<Temps> = RwLock::new(Temps { list: Vec::new(), plausible: false });

/// Tells the sampler whether the window can be seen. Showing it wakes the sampler at once.
pub fn set_ui_visible(visible: bool) {
    wake_if_shown(&UI_VISIBLE, visible);
}

/// Same for the mini overlay.
pub fn set_overlay_visible(visible: bool) {
    wake_if_shown(&OVERLAY_VISIBLE, visible);
}

fn wake_if_shown(flag: &AtomicBool, visible: bool) {
    let was = flag.swap(visible, Ordering::SeqCst);
    if visible
        && !was
        && let Some(sampler) = SAMPLER.get()
    {
        sampler.unpark();
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub name: String,
    pub mount: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TempInfo {
    pub label: String,
    pub celsius: f32,
}

struct Temps {
    list: Vec<TempInfo>,
    /// False while every reading has been identical: many PCs report a fixed fake ACPI value.
    plausible: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub timestamp_ms: i64,
    pub cpu_name: String,
    pub cpu_total: f32,
    pub cpu_per_core: Vec<f32>,
    pub cpu_freq_mhz: u64,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    /// Real disk traffic, summed over all drives.
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    pub disks: Vec<DiskInfo>,
    pub temps: Vec<TempInfo>,
    /// The main graphics card, when Windows reports it.
    pub gpu: Option<crate::gpu::GpuStats>,
    pub process_count: usize,
    pub uptime_secs: u64,
}

#[derive(Default)]
pub struct Snapshot {
    pub metrics: Metrics,
    pub processes: Vec<ProcessInfo>,
}

pub type SharedSnapshot = Arc<RwLock<Snapshot>>;

/// Static machine details shown on the dashboard header.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub host_name: String,
    pub os_name: String,
    pub os_version: String,
    pub kernel_version: String,
    pub cpu_name: String,
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub mem_total: u64,
}

/// Computed once (on a background thread at startup) and then served from memory.
#[derive(Default)]
pub struct OverviewCache(OnceLock<SystemOverview>);

impl OverviewCache {
    pub fn get(&self) -> SystemOverview {
        self.0.get_or_init(overview).clone()
    }
}

fn overview() -> SystemOverview {
    let mut sys = System::new();
    // Names and counts only: CPU usage would start the slow performance-counter query.
    sys.refresh_cpu_specifics(CpuRefreshKind::nothing());
    sys.refresh_memory();
    SystemOverview {
        host_name: System::host_name().unwrap_or_default(),
        os_name: System::name().unwrap_or_else(|| "Windows".into()),
        os_version: System::long_os_version().unwrap_or_default(),
        kernel_version: System::kernel_version().unwrap_or_default(),
        cpu_name: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        physical_cores: System::physical_core_count().unwrap_or(0),
        logical_cores: sys.cpus().len(),
        mem_total: sys.total_memory(),
    }
}

fn mem_percent(sys: &System) -> f64 {
    let total = sys.total_memory();
    if total > 0 { sys.used_memory() as f64 / total as f64 * 100.0 } else { 0.0 }
}

/// The latest temperature readings, once they look real (see `Temps::plausible`).
pub fn current_temperatures() -> Option<Vec<TempInfo>> {
    let temps = TEMPS.read();
    temps.plausible.then(|| temps.list.clone())
}

/// The temperature for the tray tooltip, only once readings look real.
fn tray_temperature() -> Option<f32> {
    let temps = TEMPS.read();
    if !temps.plausible {
        return None;
    }
    temps.list.iter().map(|t| t.celsius).reduce(f32::max)
}

pub fn start_sampler(app: AppHandle, shared: SharedSnapshot) {
    start_temperature_thread();
    let handle = thread::Builder::new()
        .name("metrics-sampler".into())
        .spawn(move || {
            let process_kind = ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu()
                .with_disk_usage()
                .with_exe(UpdateKind::OnlyIfNotSet);
            let io_kind = DiskRefreshKind::nothing().with_io_usage();

            let mut sys = System::new();
            sys.refresh_cpu_all();
            sys.refresh_memory();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind);
            let mut networks = Networks::new_with_refreshed_list();
            let mut disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage().with_io_usage());
            // Drives whose I/O counters have a starting point; a drive's first reading is its lifetime total.
            let mut io_baseline: HashSet<PathBuf> = disks.list().iter().map(|d| d.mount_point().to_path_buf()).collect();
            let mut protection = ProtectionCache::default();
            let mut gpu = crate::gpu::Sampler::new();
            let mut last_net = Instant::now();
            let mut last_disk = Instant::now();
            let mut last_storage = Instant::now();
            // CPU usage needs two samples to be meaningful.
            thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);

            loop {
                let window_shown = UI_VISIBLE.load(Ordering::SeqCst);
                if !window_shown && !OVERLAY_VISIBLE.load(Ordering::SeqCst) {
                    // Hidden in the tray: just enough for the tooltip and alerts.
                    sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage());
                    sys.refresh_memory();
                    crate::tray::update_tooltip(&app, sys.global_cpu_usage(), mem_percent(&sys), tray_temperature());
                    crate::alerts::check(&app, sys.global_cpu_usage(), mem_percent(&sys), tray_temperature());
                    thread::park_timeout(HIDDEN_INTERVAL);
                    continue;
                }

                sys.refresh_cpu_all();
                sys.refresh_memory();
                if window_shown {
                    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind);
                }

                // Each rate uses the time between its own refreshes, so slow work elsewhere can't skew it.
                networks.refresh(true);
                let now = Instant::now();
                let net_secs = (now - last_net).as_secs_f64().max(0.001);
                last_net = now;
                let (rx, tx) = networks
                    .iter()
                    .fold((0u64, 0u64), |(rx, tx), (_, n)| (rx + n.received(), tx + n.transmitted()));

                for disk in disks.list_mut() {
                    disk.refresh_specifics(io_kind);
                }
                let now = Instant::now();
                let disk_secs = (now - last_disk).as_secs_f64().max(0.001);
                last_disk = now;
                let (mut disk_read, mut disk_write) = (0u64, 0u64);
                for disk in disks.list() {
                    if io_baseline.insert(disk.mount_point().to_path_buf()) {
                        continue;
                    }
                    let usage = disk.usage();
                    disk_read += usage.read_bytes;
                    disk_write += usage.written_bytes;
                }
                // The drive list and free space change slowly. Storage only, so the I/O baseline stays intact.
                if last_storage.elapsed() >= STORAGE_INTERVAL {
                    disks.refresh_specifics(true, DiskRefreshKind::nothing().with_storage());
                    io_baseline.retain(|m| disks.list().iter().any(|d| d.mount_point() == m));
                    last_storage = Instant::now();
                }

                let core_count = sys.cpus().len().max(1);
                // Only the main window shows processes; the overlay alone keeps the last list.
                let procs = window_shown.then(|| processes::collect(&sys, core_count, &mut protection));
                let per_sec = |bytes: u64, secs: f64| (bytes as f64 / secs) as u64;

                let metrics = Metrics {
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    cpu_name: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
                    cpu_total: sys.global_cpu_usage(),
                    cpu_per_core: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
                    cpu_freq_mhz: sys.cpus().first().map(|c| c.frequency()).unwrap_or(0),
                    mem_used: sys.used_memory(),
                    mem_total: sys.total_memory(),
                    swap_used: sys.used_swap(),
                    swap_total: sys.total_swap(),
                    net_rx_bps: per_sec(rx, net_secs),
                    net_tx_bps: per_sec(tx, net_secs),
                    disk_read_bps: per_sec(disk_read, disk_secs),
                    disk_write_bps: per_sec(disk_write, disk_secs),
                    disks: disks
                        .iter()
                        .map(|d| DiskInfo {
                            name: d.name().to_string_lossy().into_owned(),
                            mount: d.mount_point().to_string_lossy().into_owned(),
                            file_system: d.file_system().to_string_lossy().into_owned(),
                            total_bytes: d.total_space(),
                            available_bytes: d.available_space(),
                            removable: d.is_removable(),
                        })
                        .collect(),
                    temps: TEMPS.read().list.clone(),
                    gpu: gpu.sample(),
                    process_count: procs.as_ref().map_or_else(|| shared.read().processes.len(), Vec::len),
                    uptime_secs: System::uptime(),
                };

                crate::tray::update_tooltip(&app, metrics.cpu_total, mem_percent(&sys), tray_temperature());
                crate::alerts::check(&app, metrics.cpu_total, mem_percent(&sys), tray_temperature());
                let _ = app.emit(METRICS_EVENT, &metrics);
                {
                    let mut snap = shared.write();
                    snap.metrics = metrics;
                    if let Some(procs) = procs {
                        snap.processes = procs;
                    }
                }

                thread::park_timeout(SAMPLE_INTERVAL);
            }
        })
        .expect("failed to start metrics sampler");
    let _ = SAMPLER.set(handle.thread().clone());
}

/// Temperatures come from a WMI query that can be slow or hang, so they live on their own
/// low-priority thread. Machines without a sensor (the usual case) are asked only once.
fn start_temperature_thread() {
    let _ = thread::Builder::new().name("temperature-sampler".into()).spawn(|| {
        crate::os::lower_thread_priority();
        let mut components = Components::new_with_refreshed_list();
        if components.list().is_empty() {
            return;
        }
        let mut first: Option<Vec<f32>> = None;
        loop {
            let list: Vec<TempInfo> = components
                .iter()
                .filter_map(|c| {
                    let celsius = c.temperature().filter(|t| t.is_finite() && *t > 0.0)?;
                    // On Windows this is the ACPI thermal zone, not the CPU.
                    let label = if cfg!(windows) && c.label() == "Computer" { "System (ACPI)".into() } else { c.label().to_string() };
                    Some(TempInfo { label, celsius })
                })
                .collect();
            let values: Vec<f32> = list.iter().map(|t| t.celsius).collect();
            let changed = first.get_or_insert_with(|| values.clone()) != &values;
            {
                let mut temps = TEMPS.write();
                temps.plausible |= changed;
                temps.list = list;
            }
            thread::sleep(TEMPERATURE_INTERVAL);
            components.refresh(false);
        }
    });
}
