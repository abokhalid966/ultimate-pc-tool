//! Automations: routine jobs that run on their own on a schedule, such as cleaning temporary
//! files every week or checking for app updates every day. Saved as automations.json.
//!
//! A scheduler thread looks every half minute for jobs that are due. A job missed because the
//! PC was off runs the next time Optimo is open. Jobs that need administrator rights only run
//! when Optimo itself runs as administrator, so a UAC prompt never pops up out of nowhere.

use std::collections::HashSet;
use std::thread;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::actions::ActivityLog;
use crate::commands::{CommandLibrary, Runs};
use crate::storage::CleanupKind;
use crate::store;

const FILE: &str = "automations.json";
pub const CHANGED_EVENT: &str = "automations://changed";
const TICK: Duration = Duration::from_secs(30);
/// Let Windows finish starting before "when Optimo starts" jobs run.
const START_DELAY: Duration = Duration::from_secs(20);
/// Cleanups that free less than this don't need a notification.
const NOTIFY_FREED: u64 = 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Task {
    /// Storage cleanup categories.
    Cleanup { kinds: Vec<CleanupKind> },
    /// A command from the command library.
    Command { command_id: String },
    /// Ask winget which apps have updates.
    CheckUpdates,
    /// The "Why is my PC slow?" check.
    HealthCheck,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Schedule {
    /// Each time Optimo starts (at sign-in when "Start with Windows" is on).
    AppStart,
    /// `minute` is minutes after midnight, local time.
    Daily { minute: u16 },
    /// `day`: 0 = Sunday … 6 = Saturday.
    Weekly { day: u8, minute: u16 },
    Hours { every: u16 },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub at: i64,
    pub ok: bool,
    pub summary: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub task: Task,
    pub schedule: Schedule,
    pub enabled: bool,
    /// One of the suggestions Optimo ships with: can be changed and turned off, not deleted.
    #[serde(default)]
    pub builtin: bool,
    /// When it was turned on or rescheduled (ms). Runs owed from before then are skipped.
    #[serde(default)]
    pub armed_at: i64,
    #[serde(default)]
    pub last_run: Option<LastRun>,
}

/// What the page shows: the automation plus live state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInfo {
    #[serde(flatten)]
    pub automation: Automation,
    pub running: bool,
    /// Next planned run (ms), for scheduled ones that are on.
    pub next_run: Option<i64>,
}

fn suggestions() -> Vec<Automation> {
    let make = |id: &str, name: &str, task: Task, schedule: Schedule| Automation {
        id: id.into(),
        name: name.into(),
        task,
        schedule,
        enabled: false,
        builtin: true,
        armed_at: 0,
        last_run: None,
    };
    vec![
        make(
            "clean-temp",
            "Clean temporary files",
            Task::Cleanup { kinds: vec![CleanupKind::UserTemp, CleanupKind::Thumbnails, CleanupKind::ErrorReports] },
            Schedule::Weekly { day: 0, minute: 12 * 60 },
        ),
        make(
            "clean-browsers",
            "Clear browser caches",
            Task::Cleanup { kinds: vec![CleanupKind::Edge, CleanupKind::Chrome, CleanupKind::Brave, CleanupKind::Firefox] },
            Schedule::Weekly { day: 0, minute: 12 * 60 + 5 },
        ),
        make("check-updates", "Check for app updates", Task::CheckUpdates, Schedule::Daily { minute: 10 * 60 }),
        make("health-check", "Check why the PC is slow", Task::HealthCheck, Schedule::Weekly { day: 1, minute: 11 * 60 }),
        make(
            "flush-dns",
            "Flush DNS",
            Task::Command { command_id: format!("{}flush-dns", crate::commands::BUILTIN_PREFIX) },
            Schedule::AppStart,
        ),
        make("clean-windows", "Clean Windows Update leftovers", Task::Cleanup { kinds: vec![CleanupKind::WindowsUpdate, CleanupKind::DeliveryOptimization, CleanupKind::WindowsTemp] }, Schedule::Weekly { day: 0, minute: 12 * 60 + 10 }),
    ]
}

#[derive(Default)]
pub struct Automations {
    list: Mutex<Option<Vec<Automation>>>,
    running: Mutex<HashSet<String>>,
}

impl Automations {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<Automation>) -> R) -> Result<R, String> {
        let mut guard = self.list.lock();
        if guard.is_none() {
            let mut list: Vec<Automation> = store::load(app, FILE)?.unwrap_or_default();
            // Suggestions added in later versions appear without touching the user's own.
            for s in suggestions() {
                if !list.iter().any(|a| a.id == s.id) {
                    list.push(s);
                }
            }
            *guard = Some(list);
        }
        Ok(f(guard.as_mut().expect("loaded above")))
    }

    fn change<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<Automation>) -> Result<R, String>) -> Result<R, String> {
        let result = self.with(app, |list| {
            let mut next = list.clone();
            let result = f(&mut next)?;
            store::save(app, FILE, &next)?;
            *list = next;
            Ok(result)
        })?;
        let _ = app.emit(CHANGED_EVENT, ());
        result
    }

    fn snapshot(&self, app: &AppHandle) -> Result<Vec<Automation>, String> {
        self.with(app, |list| list.clone())
    }
}

// ---- Schedule maths ----

fn at_minute(date: NaiveDate, minute: u16) -> Option<DateTime<Local>> {
    let time = date.and_hms_opt(u32::from(minute / 60), u32::from(minute % 60), 0)?;
    // A time skipped by a daylight saving change has no local equivalent: use the hour after.
    Local.from_local_datetime(&time).earliest().or_else(|| Local.from_local_datetime(&(time + chrono::Duration::hours(1))).earliest())
}

/// The most recent planned moment at or before `now`.
fn last_slot(schedule: &Schedule, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let today = now.date_naive();
    match *schedule {
        Schedule::Daily { minute } => {
            let slot = at_minute(today, minute)?;
            if slot <= now { Some(slot) } else { at_minute(today.pred_opt()?, minute) }
        }
        Schedule::Weekly { day, minute } => {
            let back = (i64::from(now.weekday().num_days_from_sunday()) + 7 - i64::from(day % 7)) % 7;
            let date = today - chrono::Duration::days(back);
            let slot = at_minute(date, minute)?;
            if slot <= now { Some(slot) } else { at_minute(date - chrono::Duration::days(7), minute) }
        }
        Schedule::AppStart | Schedule::Hours { .. } => None,
    }
}

/// When the automation last counted as done or started fresh (ms).
fn since(a: &Automation) -> i64 {
    a.armed_at.max(a.last_run.as_ref().map_or(0, |r| r.at))
}

fn is_due(a: &Automation, now: DateTime<Local>) -> bool {
    if !a.enabled {
        return false;
    }
    match a.schedule {
        Schedule::AppStart => false,
        Schedule::Hours { every } => now.timestamp_millis() - since(a) >= i64::from(every.max(1)) * 3_600_000,
        _ => last_slot(&a.schedule, now).is_some_and(|slot| slot.timestamp_millis() > since(a)),
    }
}

fn next_run(a: &Automation, now: DateTime<Local>) -> Option<i64> {
    if !a.enabled {
        return None;
    }
    let now_ms = now.timestamp_millis();
    let period = match a.schedule {
        Schedule::AppStart => return None,
        Schedule::Hours { every } => return Some((since(a) + i64::from(every.max(1)) * 3_600_000).max(now_ms)),
        Schedule::Daily { .. } => chrono::Duration::days(1),
        Schedule::Weekly { .. } => chrono::Duration::days(7),
    };
    let slot = last_slot(&a.schedule, now)?;
    if slot.timestamp_millis() > since(a) {
        // Owed: runs at the next tick.
        return Some(now_ms);
    }
    let next = slot + period;
    // Re-anchor on the wall clock so daylight saving doesn't shift the time.
    let minute = match a.schedule {
        Schedule::Daily { minute } | Schedule::Weekly { minute, .. } => minute,
        _ => unreachable!(),
    };
    at_minute(next.date_naive(), minute).map(|t| t.timestamp_millis())
}

// ---- Running ----

struct Outcome {
    summary: String,
    /// Worth a Windows notification when it ran on its own.
    notify: bool,
}

fn run_task(app: &AppHandle, task: &Task) -> Result<Outcome, String> {
    let elevated = crate::os::is_elevated();
    match task {
        Task::Cleanup { kinds } => {
            let (allowed, needs_admin): (Vec<CleanupKind>, Vec<CleanupKind>) = kinds.iter().partition(|k| elevated || !k.needs_admin());
            if allowed.is_empty() {
                return Err("Needs administrator rights. Start Optimo as administrator to let this run.".into());
            }
            let summary = crate::storage::clean(&allowed);
            let mut text = if summary.files > 0 {
                format!("Freed {} ({} files)", crate::storage::size_text(summary.bytes), summary.files)
            } else {
                "Nothing needed cleaning".to_string()
            };
            let blocked: Vec<&str> = summary.results.iter().filter_map(|r| r.error.as_ref().map(|_| r.label)).collect();
            if !blocked.is_empty() {
                text.push_str(&format!(". Skipped {}", crate::storage::join_names(&blocked)));
            }
            if !needs_admin.is_empty() {
                text.push_str(". Some parts need administrator rights");
            }
            Ok(Outcome { summary: text, notify: summary.bytes >= NOTIFY_FREED })
        }
        Task::Command { command_id } => {
            let cmd = app
                .state::<CommandLibrary>()
                .list(app)?
                .into_iter()
                .find(|c| c.id == *command_id)
                .ok_or("That command was deleted from the Commands page.")?;
            if has_placeholder(&cmd.command) {
                return Err(format!("\"{}\" asks for a value each time, so it can't run on its own.", cmd.name));
            }
            if cmd.admin && !elevated {
                return Err("Needs administrator rights. Start Optimo as administrator to let this run.".into());
            }
            let run_id = format!("auto-{}", uuid::Uuid::new_v4());
            let output = crate::commands::run(&app.state::<Runs>(), &run_id, &cmd.command, cmd.shell, false, Channel::new(|_| Ok(())))?;
            let last_line = |s: &str| s.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(|l| l.chars().take(160).collect::<String>());
            match output.code {
                Some(0) => Ok(Outcome { summary: last_line(&output.stdout).unwrap_or_else(|| "Finished".into()), notify: false }),
                Some(code) => Err(last_line(&output.stderr).or_else(|| last_line(&output.stdout)).unwrap_or_else(|| format!("Stopped with code {code}"))),
                None => Err("Took too long and was stopped.".into()),
            }
        }
        Task::CheckUpdates => {
            let list = crate::winget::list_upgrades()?;
            if list.winget_missing {
                return Err("Windows Package Manager (winget) isn't installed. Get \"App Installer\" from the Microsoft Store.".into());
            }
            let names: Vec<&str> = list.upgrades.iter().map(|u| u.name.as_str()).collect();
            Ok(match names.len() {
                0 => Outcome { summary: "All apps are up to date".into(), notify: false },
                n => {
                    let shown: Vec<&str> = names.iter().take(3).copied().collect();
                    let more = if n > 3 { format!(" and {} more", n - 3) } else { String::new() };
                    Outcome {
                        summary: format!("{n} {} available: {}{more}", if n == 1 { "update" } else { "updates" }, shown.join(", ")),
                        notify: true,
                    }
                }
            })
        }
        Task::HealthCheck => {
            let report = crate::health::run(&Channel::new(|_| Ok(())))?;
            Ok(match report.issues.first() {
                None => Outcome { summary: format!("Score {}/100. Nothing to fix", report.score), notify: false },
                Some(first) => Outcome {
                    summary: format!(
                        "Score {}/100. {} to look at, like: {}",
                        report.score,
                        if report.issues.len() == 1 { "1 thing".to_string() } else { format!("{} things", report.issues.len()) },
                        first.title
                    ),
                    notify: true,
                },
            })
        }
    }
}

/// `{name}` placeholders are filled in by the Commands page before a run.
fn has_placeholder(command: &str) -> bool {
    command.split('{').skip(1).any(|rest| rest.find('}').is_some_and(|end| end > 0 && rest[..end].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')))
}

/// Runs one automation on a background thread. `by_user` is a "Run now" click.
fn start(app: &AppHandle, id: &str, by_user: bool) -> Result<(), String> {
    let state = app.state::<Automations>();
    let automation = state.snapshot(app)?.into_iter().find(|a| a.id == id).ok_or("That automation no longer exists.")?;
    if !state.running.lock().insert(id.to_string()) {
        return Err("It's already running.".into());
    }
    let _ = app.emit(CHANGED_EVENT, ());
    let app = app.clone();
    thread::spawn(move || {
        let result = run_task(&app, &automation.task);
        let (ok, summary, notify) = match result {
            Ok(o) => (true, o.summary, o.notify),
            Err(e) => (false, e, true),
        };
        let at = chrono::Utc::now().timestamp_millis();
        let state = app.state::<Automations>();
        let saved = state.change(&app, |list| {
            if let Some(a) = list.iter_mut().find(|a| a.id == automation.id) {
                a.last_run = Some(LastRun { at, ok, summary: summary.clone() });
            }
            Ok(())
        });
        state.running.lock().remove(&automation.id);
        let _ = app.emit(CHANGED_EVENT, ());
        if let Err(e) = saved {
            store::notice(&app, format!("The automations couldn't be saved: {e}"));
        }
        let how = if by_user { "Run by you" } else { "Ran on its schedule" };
        let description = format!("{}: {}", automation.name, if ok { summary.clone() } else { format!("didn't finish. {summary}") });
        app.state::<ActivityLog>().record(&app, "Automations", description, Some(how.into()), None);
        if notify && !by_user {
            let title = if ok { automation.name.clone() } else { format!("{} didn't finish", automation.name) };
            crate::alerts::notify(&app, &title, &summary);
        }
    });
    Ok(())
}

/// Starts the scheduler: "when Optimo starts" jobs shortly after launch, the rest when due.
pub fn start_scheduler(app: AppHandle) {
    thread::Builder::new()
        .name("automations".into())
        .spawn(move || {
            thread::sleep(START_DELAY);
            if let Ok(list) = app.state::<Automations>().snapshot(&app) {
                for a in list.iter().filter(|a| a.enabled && a.schedule == Schedule::AppStart) {
                    let _ = start(&app, &a.id, false);
                }
            }
            loop {
                let now = Local::now();
                if let Ok(list) = app.state::<Automations>().snapshot(&app) {
                    for a in list.iter().filter(|a| is_due(a, now)) {
                        // Already running is fine: it will be stamped when it finishes.
                        let _ = start(&app, &a.id, false);
                    }
                }
                thread::sleep(TICK);
            }
        })
        .expect("failed to start the automations scheduler");
}

// ---- Commands ----

#[tauri::command(async)]
pub fn list_automations(app: AppHandle, state: State<Automations>) -> Result<Vec<AutomationInfo>, String> {
    let now = Local::now();
    let running = state.running.lock().clone();
    Ok(state
        .snapshot(&app)?
        .into_iter()
        .map(|a| AutomationInfo { running: running.contains(&a.id), next_run: next_run(&a, now), automation: a })
        .collect())
}

/// Adds or changes an automation. Turning it on or changing when it runs starts it fresh.
#[tauri::command(async)]
pub fn save_automation(app: AppHandle, state: State<Automations>, mut automation: Automation) -> Result<(), String> {
    automation.name = automation.name.trim().to_string();
    if automation.name.is_empty() {
        return Err("Give it a name.".into());
    }
    if let Task::Cleanup { kinds } = &automation.task
        && kinds.is_empty()
    {
        return Err("Choose at least one thing to clean.".into());
    }
    match automation.schedule {
        Schedule::Daily { minute } | Schedule::Weekly { minute, .. } if minute >= 24 * 60 => return Err("Choose a time of day.".into()),
        Schedule::Weekly { day, .. } if day > 6 => return Err("Choose a day of the week.".into()),
        Schedule::Hours { every } if every == 0 || every > 24 * 7 => return Err("Choose between 1 and 168 hours.".into()),
        _ => {}
    }
    let now = chrono::Utc::now().timestamp_millis();
    state.change(&app, |list| {
        match list.iter_mut().find(|a| a.id == automation.id) {
            Some(existing) => {
                let rearm = automation.enabled && (!existing.enabled || existing.schedule != automation.schedule);
                automation.builtin = existing.builtin;
                automation.last_run = existing.last_run.clone();
                automation.armed_at = if rearm { now } else { existing.armed_at };
                *existing = automation;
            }
            None => {
                automation.id = uuid::Uuid::new_v4().to_string();
                automation.builtin = false;
                automation.armed_at = now;
                automation.last_run = None;
                list.push(automation);
            }
        }
        Ok(())
    })
}

#[tauri::command(async)]
pub fn set_automation_enabled(app: AppHandle, state: State<Automations>, id: String, enabled: bool) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    state.change(&app, |list| {
        let a = list.iter_mut().find(|a| a.id == id).ok_or("That automation no longer exists.")?;
        if enabled && !a.enabled {
            a.armed_at = now;
        }
        a.enabled = enabled;
        Ok(())
    })
}

#[tauri::command(async)]
pub fn delete_automation(app: AppHandle, state: State<Automations>, id: String) -> Result<(), String> {
    state.change(&app, |list| {
        let i = list.iter().position(|a| a.id == id).ok_or("That automation no longer exists.")?;
        if list[i].builtin {
            return Err("Suggested automations can be turned off but not deleted.".into());
        }
        list.remove(i);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn run_automation(app: AppHandle, id: String) -> Result<(), String> {
    start(&app, &id, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap()
    }

    fn auto(schedule: Schedule, armed: DateTime<Local>) -> Automation {
        Automation {
            id: "a".into(),
            name: "a".into(),
            task: Task::CheckUpdates,
            schedule,
            enabled: true,
            builtin: false,
            armed_at: armed.timestamp_millis(),
            last_run: None,
        }
    }

    #[test]
    fn daily_runs_after_its_time_and_catches_up() {
        // Turned on at 15:00 for a 10:00 job: nothing owed today.
        let a = auto(Schedule::Daily { minute: 600 }, local(2026, 3, 10, 15, 0));
        assert!(!is_due(&a, local(2026, 3, 10, 16, 0)));
        assert!(!is_due(&a, local(2026, 3, 11, 9, 59)));
        assert!(is_due(&a, local(2026, 3, 11, 10, 0)));
        // PC was off at 10:00: runs when Optimo is next open.
        assert!(is_due(&a, local(2026, 3, 11, 18, 30)));
        assert_eq!(next_run(&a, local(2026, 3, 10, 16, 0)), Some(local(2026, 3, 11, 10, 0).timestamp_millis()));
    }

    #[test]
    fn weekly_waits_for_its_day() {
        // 2026-03-10 is a Tuesday; the job is Sundays at 12:00.
        let mut a = auto(Schedule::Weekly { day: 0, minute: 720 }, local(2026, 3, 10, 9, 0));
        assert!(!is_due(&a, local(2026, 3, 14, 23, 0)));
        assert!(is_due(&a, local(2026, 3, 15, 12, 1)));
        a.last_run = Some(LastRun { at: local(2026, 3, 15, 12, 1).timestamp_millis(), ok: true, summary: String::new() });
        assert!(!is_due(&a, local(2026, 3, 20, 12, 0)));
        assert_eq!(next_run(&a, local(2026, 3, 16, 8, 0)), Some(local(2026, 3, 22, 12, 0).timestamp_millis()));
    }

    #[test]
    fn hours_and_off() {
        let mut a = auto(Schedule::Hours { every: 6 }, local(2026, 3, 10, 9, 0));
        assert!(!is_due(&a, local(2026, 3, 10, 14, 59)));
        assert!(is_due(&a, local(2026, 3, 10, 15, 0)));
        a.enabled = false;
        assert!(!is_due(&a, local(2026, 3, 11, 15, 0)));
        assert_eq!(next_run(&a, local(2026, 3, 11, 15, 0)), None);
    }

    #[test]
    fn suggested_commands_exist() {
        let builtins = crate::commands::defaults();
        for a in suggestions() {
            if let Task::Command { command_id } = &a.task {
                let cmd = builtins.iter().find(|c| c.id == *command_id).expect("suggestion points at a built-in command");
                assert!(!cmd.admin && !has_placeholder(&cmd.command));
            }
        }
    }

    #[test]
    fn placeholders() {
        assert!(has_placeholder("ping -n 4 {host}"));
        assert!(!has_placeholder("ipconfig /flushdns"));
        assert!(!has_placeholder("Get-Process | ForEach-Object { $_.Name }"));
    }

    #[test]
    fn reads_saved_file() {
        let json = r#"[{"id":"x","name":"Ping","task":{"type":"command","commandId":"flush-dns"},"schedule":{"type":"weekly","day":3,"minute":90},"enabled":true}]"#;
        let list: Vec<Automation> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].task, Task::Command { command_id: "flush-dns".into() });
        assert_eq!(list[0].schedule, Schedule::Weekly { day: 3, minute: 90 });
    }
}
