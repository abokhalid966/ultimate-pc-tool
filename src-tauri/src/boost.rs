//! Boost (game mode): for a game or a heavy job, switch to the High performance power plan, close
//! chosen background apps and pause Windows Search indexing and SysMain. Ending Boost puts it all
//! back. The state is saved, so Boost can still be ended after a crash or a restart.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::actions::ActivityLog;
use crate::health::{self, HIGH_PERFORMANCE};
use crate::processes::{self, ProcessInfo, ProtectionCache, Target};
use crate::{os, services, store};

const FILE: &str = "boost.json";
pub const CHANGED_EVENT: &str = "boost://changed";
/// Background services that compete with games for the disk and memory. Both restart on their own.
const SERVICES: [(&str, &str); 2] = [("WSearch", "Windows Search indexing"), ("SysMain", "SysMain")];
/// Never offered for closing.
const KEEP: [&str; 6] = ["explorer.exe", "optimo.exe", "ultimate-pc-tool.exe", "dwm.exe", "steam.exe", "discord.exe"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct BoostSettings {
    pub power_plan: bool,
    /// Process names, like "OneDrive.exe".
    pub close_apps: Vec<String>,
    pub reopen_apps: bool,
    pub pause_services: bool,
}

impl Default for BoostSettings {
    fn default() -> Self {
        Self { power_plan: true, close_apps: Vec::new(), reopen_apps: true, pause_services: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClosedApp {
    pub name: String,
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct BoostState {
    pub active: bool,
    pub started_at: i64,
    /// The plan to go back to, when Boost changed it.
    pub previous_plan: Option<String>,
    pub closed: Vec<ClosedApp>,
    pub paused_services: Vec<String>,
    /// What Boost did, for the page.
    pub done: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Saved {
    settings: BoostSettings,
    state: BoostState,
}

#[derive(Default)]
pub struct Boost(Mutex<Option<Saved>>);

impl Boost {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Saved) -> R) -> Result<R, String> {
        let mut guard = self.0.lock();
        if guard.is_none() {
            *guard = Some(store::load(app, FILE)?.unwrap_or_default());
        }
        Ok(f(guard.as_mut().expect("loaded above")))
    }

    fn save(&self, app: &AppHandle, f: impl FnOnce(&mut Saved)) -> Result<(), String> {
        self.with(app, |saved| {
            let mut next = saved.clone();
            f(&mut next);
            store::save(app, FILE, &next)?;
            *saved = next;
            Ok(())
        })?
    }

    pub fn is_active(&self, app: &AppHandle) -> bool {
        self.with(app, |s| s.state.active).unwrap_or(false)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub name: String,
    pub memory: u64,
    pub count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostInfo {
    pub settings: BoostSettings,
    pub state: BoostState,
    /// Apps that could be closed while boosting, biggest first.
    pub running_apps: Vec<RunningApp>,
    pub elevated: bool,
    /// The PC has a High performance power plan.
    pub high_performance: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostResult {
    pub done: Vec<String>,
    pub problems: Vec<String>,
}

/// A fresh process list, so Boost works from the tray too (the sampler pauses it there).
fn fresh_processes() -> Vec<ProcessInfo> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory().with_exe(UpdateKind::OnlyIfNotSet));
    processes::collect(&sys, 1, &mut ProtectionCache::default())
}

/// User apps, not Windows itself.
fn closable(p: &ProcessInfo) -> bool {
    let windows = os::windows_dir().to_string_lossy().to_lowercase();
    p.protected.is_none()
        && p.exe.as_ref().is_some_and(|e| !e.to_lowercase().starts_with(&windows))
        && !KEEP.iter().any(|k| p.name.eq_ignore_ascii_case(k))
}

fn join(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[tauri::command]
pub async fn get_boost(app: AppHandle) -> Result<BoostInfo, String> {
    crate::blocking(move || {
        let (settings, state) = app.state::<Boost>().with(&app, |s| (s.settings.clone(), s.state.clone()))?;
        let mut apps: Vec<RunningApp> = Vec::new();
        for p in fresh_processes().iter().filter(|p| closable(p)) {
            match apps.iter_mut().find(|a| a.name.eq_ignore_ascii_case(&p.name)) {
                Some(a) => {
                    a.memory += p.memory;
                    a.count += 1;
                }
                None => apps.push(RunningApp { name: p.name.clone(), memory: p.memory, count: 1 }),
            }
        }
        apps.sort_by(|a, b| b.memory.cmp(&a.memory));
        apps.truncate(40);
        let high_performance = health::power_plans().is_ok_and(|plans| plans.iter().any(|p| p.guid == HIGH_PERFORMANCE));
        Ok(BoostInfo { settings, state, running_apps: apps, elevated: os::is_elevated(), high_performance })
    })
    .await
}

#[tauri::command(async)]
pub fn set_boost_settings(app: AppHandle, boost: State<Boost>, settings: BoostSettings) -> Result<(), String> {
    boost.save(&app, |s| s.settings = settings)
}

pub fn start(app: &AppHandle) -> Result<BoostResult, String> {
    let boost = app.state::<Boost>();
    let (settings, active) = boost.with(app, |s| (s.settings.clone(), s.state.active))?;
    if active {
        return Err("Boost is already on.".into());
    }
    let mut state = BoostState { active: true, started_at: chrono::Utc::now().timestamp_millis(), ..Default::default() };
    let (mut done, mut problems) = (Vec::new(), Vec::new());

    if settings.power_plan {
        match health::power_plans() {
            Ok(plans) if plans.iter().any(|p| p.guid == HIGH_PERFORMANCE) => {
                let current = plans.iter().find(|p| p.active);
                if current.is_some_and(|p| p.guid == HIGH_PERFORMANCE) {
                    done.push("High performance was already on".to_string());
                } else {
                    match health::set_active_power_plan(HIGH_PERFORMANCE) {
                        Ok(()) => {
                            state.previous_plan = current.map(|p| p.guid.clone());
                            done.push("Switched to the High performance power plan".to_string());
                        }
                        Err(e) => problems.push(e),
                    }
                }
            }
            Ok(_) => problems.push("This PC has no High performance power plan. You can set Power mode to Best performance in Windows Settings > Power.".into()),
            Err(e) => problems.push(e),
        }
    }

    if !settings.close_apps.is_empty() {
        let procs = fresh_processes();
        for name in &settings.close_apps {
            let matching: Vec<&ProcessInfo> = procs.iter().filter(|p| p.name.eq_ignore_ascii_case(name) && closable(p)).collect();
            if matching.is_empty() {
                continue;
            }
            let path = matching.iter().find_map(|p| p.exe.clone());
            let targets: Vec<Target> = matching.iter().map(|p| Target { pid: p.pid, start_time: p.start_time }).collect();
            let summary = processes::kill_many(&targets, name, &procs);
            if summary.ended > 0 {
                state.closed.push(ClosedApp { name: name.clone(), path });
            }
            problems.extend(summary.failed);
        }
        if !state.closed.is_empty() {
            done.push(format!("Closed {}", join(&state.closed.iter().map(|c| c.name.clone()).collect::<Vec<_>>())));
        }
    }

    if settings.pause_services {
        if os::is_elevated() {
            let mut paused = Vec::new();
            for (name, label) in SERVICES {
                if services::is_running(name) {
                    match services::pause(name, label) {
                        Ok(()) => {
                            state.paused_services.push(name.to_string());
                            paused.push(label.to_string());
                        }
                        Err(e) => problems.push(e),
                    }
                }
            }
            if !paused.is_empty() {
                done.push(format!("Paused {}", join(&paused)));
            }
        } else {
            problems.push("Pausing Windows Search and SysMain needs administrator rights, so they were left running.".into());
        }
    }

    state.done = done.clone();
    boost.save(app, |s| s.state = state)?;
    let detail = if problems.is_empty() { None } else { Some(problems.join("\n")) };
    app.state::<ActivityLog>().record(app, "Boost", format!("Boost on: {}", if done.is_empty() { "nothing to change".into() } else { join(&done).to_lowercase() }), detail, None);
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(BoostResult { done, problems })
}

pub fn stop(app: &AppHandle) -> Result<BoostResult, String> {
    let boost = app.state::<Boost>();
    let (settings, state) = boost.with(app, |s| (s.settings.clone(), s.state.clone()))?;
    if !state.active {
        return Err("Boost is already off.".into());
    }
    let (mut done, mut problems) = (Vec::new(), Vec::new());

    if let Some(previous) = &state.previous_plan {
        // Leave it alone if the plan was changed by hand meanwhile.
        let still_high = health::power_plans().is_ok_and(|plans| plans.iter().any(|p| p.active && p.guid == HIGH_PERFORMANCE));
        if still_high {
            match health::set_active_power_plan(previous) {
                Ok(()) => done.push("Put the power plan back".to_string()),
                Err(e) => problems.push(e),
            }
        }
    }
    let mut resumed = Vec::new();
    for name in &state.paused_services {
        let label = SERVICES.iter().find(|(n, _)| n == name).map_or(name.as_str(), |(_, l)| l);
        match services::resume(name, label) {
            Ok(()) => resumed.push(label.to_string()),
            Err(e) => problems.push(e),
        }
    }
    if !resumed.is_empty() {
        done.push(format!("Started {} again", join(&resumed)));
    }
    if settings.reopen_apps && !state.closed.is_empty() {
        let running = fresh_processes();
        let mut reopened = Vec::new();
        for c in &state.closed {
            if running.iter().any(|p| p.name.eq_ignore_ascii_case(&c.name)) {
                continue;
            }
            // Through Explorer, so the app opens as the signed-in user even when Optimo runs as administrator.
            if let Some(path) = &c.path
                && std::process::Command::new(os::windows_dir().join("explorer.exe")).arg(path).spawn().is_ok()
            {
                reopened.push(c.name.clone());
            }
        }
        if !reopened.is_empty() {
            done.push(format!("Reopened {}", join(&reopened)));
        }
    }

    boost.save(app, |s| s.state = BoostState::default())?;
    let detail = if problems.is_empty() { None } else { Some(problems.join("\n")) };
    let text = if done.is_empty() { "Boost off".to_string() } else { format!("Boost off: {}", join(&done).to_lowercase()) };
    app.state::<ActivityLog>().record(app, "Boost", text, detail, None);
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(BoostResult { done, problems })
}

#[tauri::command]
pub async fn start_boost(app: AppHandle) -> Result<BoostResult, String> {
    crate::blocking(move || start(&app)).await
}

#[tauri::command]
pub async fn stop_boost(app: AppHandle) -> Result<BoostResult, String> {
    crate::blocking(move || stop(&app)).await
}

/// Tray menu: turns Boost on or off and says so in a notification.
pub fn toggle_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let on = app.state::<Boost>().is_active(&app);
        let result = if on { stop(&app) } else { start(&app) };
        match result {
            Ok(r) => {
                let title = if on { "Boost is off" } else { "Boost is on" };
                let body = if r.done.is_empty() { "Nothing needed changing.".to_string() } else { format!("{}.", join(&r.done)) };
                crate::alerts::notify(&app, title, &body);
            }
            Err(e) => crate::alerts::notify(&app, "Boost", &e),
        }
    });
}
