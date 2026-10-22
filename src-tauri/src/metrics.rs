//! Background sampler: refreshes system metrics and the process table once per
//! second, caches the latest snapshot, and pushes it to the UI as an event.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde::Serialize;
use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use crate::processes::{self, ProcessInfo};

pub const METRICS_EVENT: &str = "metrics://update";
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

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
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    pub disks: Vec<DiskInfo>,
    pub temps: Vec<TempInfo>,
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

pub fn overview() -> SystemOverview {
    let mut sys = System::new();
    sys.refresh_cpu_all();
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

pub fn start_sampler(app: AppHandle, shared: SharedSnapshot) {
    thread::Builder::new()
        .name("metrics-sampler".into())
        .spawn(move || {
            let mut sys = System::new_all();
            let mut networks = Networks::new_with_refreshed_list();
            let mut disks = Disks::new_with_refreshed_list();
            let mut components = Components::new_with_refreshed_list();
            let mut last = Instant::now();
            let mut tick: u64 = 0;
            // CPU usage needs two samples to be meaningful.
            thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);

            loop {
                sys.refresh_cpu_all();
                sys.refresh_memory();
                sys.refresh_processes(ProcessesToUpdate::All, true);
                networks.refresh(true);
                // Disk space and sensors change slowly; refresh them less often.
                if tick % 5 == 0 {
                    disks.refresh(true);
                    components.refresh(true);
                }

                let elapsed = last.elapsed().as_secs_f64().max(0.001);
                last = Instant::now();
                let per_sec = |bytes: u64| (bytes as f64 / elapsed) as u64;

                let (rx, tx) = networks
                    .iter()
                    .fold((0u64, 0u64), |(rx, tx), (_, n)| (rx + n.received(), tx + n.transmitted()));

                let core_count = sys.cpus().len().max(1);
                let procs = processes::collect(&sys, core_count);
                let (disk_read, disk_write) = procs
                    .iter()
                    .fold((0u64, 0u64), |(r, w), p| (r + p.disk_read, w + p.disk_write));

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
                    net_rx_bps: per_sec(rx),
                    net_tx_bps: per_sec(tx),
                    disk_read_bps: per_sec(disk_read),
                    disk_write_bps: per_sec(disk_write),
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
                    temps: components
                        .iter()
                        .filter_map(|c| {
                            c.temperature().filter(|t| t.is_finite() && *t > 0.0).map(|t| TempInfo {
                                label: c.label().to_string(),
                                celsius: t,
                            })
                        })
                        .collect(),
                    process_count: procs.len(),
                    uptime_secs: System::uptime(),
                };

                crate::tray::update_tooltip(&app, &metrics);
                let _ = app.emit(METRICS_EVENT, &metrics);
                {
                    let mut snap = shared.write();
                    snap.metrics = metrics;
                    snap.processes = procs;
                }

                tick = tick.wrapping_add(1);
                thread::sleep(SAMPLE_INTERVAL);
            }
        })
        .expect("failed to start metrics sampler");
}
