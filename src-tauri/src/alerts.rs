//! Windows notifications when the PC stays busy, runs hot or gets low on space.
//! Fed by the metrics sampler, also while the window is hidden in the tray.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use sysinfo::Disks;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::settings::SettingsStore;

/// How long the processor or memory must stay over the limit: short spikes are normal.
const BUSY_FOR: Duration = Duration::from_secs(120);
const HOT_FOR: Duration = Duration::from_secs(30);
/// The same alert at most this often.
const COOLDOWN: Duration = Duration::from_secs(30 * 60);
const DISK_COOLDOWN: Duration = Duration::from_secs(12 * 60 * 60);
const DISK_EVERY: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct Watch {
    over_since: Option<Instant>,
    last_alert: Option<Instant>,
}

impl Watch {
    /// True once `over` has held for `hold`, unless this alert was shown within `cooldown`.
    fn trips(&mut self, over: bool, hold: Duration, cooldown: Duration, now: Instant) -> bool {
        if !over {
            self.over_since = None;
            return false;
        }
        let since = *self.over_since.get_or_insert(now);
        if now.duration_since(since) < hold || self.last_alert.is_some_and(|t| now.duration_since(t) < cooldown) {
            return false;
        }
        self.last_alert = Some(now);
        true
    }
}

#[derive(Default)]
struct Watches {
    cpu: Watch,
    memory: Watch,
    heat: Watch,
    disks: Vec<(String, Watch)>,
    last_disk_check: Option<Instant>,
}

static WATCHES: Mutex<Option<Watches>> = Mutex::new(None);

/// Called by the sampler with each reading. `temperature` is only passed when it looks real.
pub fn check(app: &AppHandle, cpu: f32, memory_pct: f64, temperature: Option<f32>) {
    let Some(store) = app.try_state::<SettingsStore>() else { return };
    let limits = store.alerts();
    if !limits.enabled {
        return;
    }
    let now = Instant::now();
    let mut guard = WATCHES.lock();
    let w = guard.get_or_insert_with(Watches::default);

    if limits.cpu_percent > 0 && w.cpu.trips(cpu >= f32::from(limits.cpu_percent), BUSY_FOR, COOLDOWN, now) {
        notify(
            app,
            "Your PC is very busy",
            &format!("The processor has been over {}% for two minutes. Open Optimo > Processes to see which app is using it.", limits.cpu_percent),
        );
    }
    if limits.memory_percent > 0 && w.memory.trips(memory_pct >= f64::from(limits.memory_percent), BUSY_FOR, COOLDOWN, now) {
        notify(
            app,
            "Memory is almost full",
            &format!("{memory_pct:.0}% of memory has been in use for two minutes. Closing apps you don't need will speed things up."),
        );
    }
    if let Some(t) = temperature
        && limits.temperature > 0
        && w.heat.trips(t >= f32::from(limits.temperature), HOT_FOR, COOLDOWN, now)
    {
        notify(app, "Your PC is running hot", &format!("It's {t:.0}°C. Make sure the air vents aren't blocked or dusty."));
    }

    if limits.disk_free_percent > 0 && w.last_disk_check.is_none_or(|t| now.duration_since(t) >= DISK_EVERY) {
        w.last_disk_check = Some(now);
        for disk in Disks::new_with_refreshed_list().list().iter().filter(|d| !d.is_removable() && d.total_space() > 0) {
            let mount = disk.mount_point().to_string_lossy().trim_end_matches('\\').to_string();
            let free_pct = disk.available_space() as f64 * 100.0 / disk.total_space() as f64;
            let index = match w.disks.iter().position(|(m, _)| *m == mount) {
                Some(i) => i,
                None => {
                    w.disks.push((mount.clone(), Watch::default()));
                    w.disks.len() - 1
                }
            };
            if w.disks[index].1.trips(free_pct < f64::from(limits.disk_free_percent), Duration::ZERO, DISK_COOLDOWN, now) {
                notify(
                    app,
                    &format!("Drive {mount} is almost full"),
                    &format!(
                        "Only {} ({free_pct:.0}%) is free. Open Optimo > Storage to free up space.",
                        crate::storage::size_text(disk.available_space())
                    ),
                );
            }
        }
    }
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_to_stay_over_and_respects_cooldown() {
        let mut w = Watch::default();
        let t0 = Instant::now();
        let hold = Duration::from_secs(10);
        let cool = Duration::from_secs(100);
        assert!(!w.trips(true, hold, cool, t0));
        assert!(!w.trips(true, hold, cool, t0 + Duration::from_secs(5)));
        assert!(w.trips(true, hold, cool, t0 + Duration::from_secs(11)));
        // Still over, but just alerted.
        assert!(!w.trips(true, hold, cool, t0 + Duration::from_secs(20)));
        // A dip resets the timer.
        assert!(!w.trips(false, hold, cool, t0 + Duration::from_secs(30)));
        assert!(!w.trips(true, hold, cool, t0 + Duration::from_secs(120)));
        assert!(w.trips(true, hold, cool, t0 + Duration::from_secs(131)));
    }
}
