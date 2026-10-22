//! Privacy page: switch off Windows ads, suggestions and tracking (registry settings, each one
//! undoable), and remove preinstalled apps most people never use.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::actions::{ActivityLog, Undo};
use crate::ps;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// One registry number: `on` is the private setting, `off` is Windows' default (`None` = no value).
struct Value {
    hive: Hive,
    path: &'static str,
    name: &'static str,
    on: u32,
    off: Option<u32>,
}

struct Tweak {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    group: &'static str,
    recommended: bool,
    /// Shows after File Explorer restarts (or after signing out).
    explorer: bool,
    values: &'static [Value],
}

const CDM: &str = r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";
const ADVANCED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const ADS: &str = "Ads and suggestions";
const PRIVACY: &str = "Privacy";
const SEARCH: &str = "Search and taskbar";

const fn cu(path: &'static str, name: &'static str, on: u32, off: Option<u32>) -> Value {
    Value { hive: Hive::CurrentUser, path, name, on, off }
}

const fn lm(path: &'static str, name: &'static str, on: u32) -> Value {
    Value { hive: Hive::LocalMachine, path, name, on, off: None }
}

const TWEAKS: &[Tweak] = &[
    Tweak {
        id: "ad-id",
        title: "Turn off the advertising ID",
        description: "Stops apps from using an ID that follows you around to show personalised ads.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[cu(r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo", "Enabled", 0, Some(1))],
    },
    Tweak {
        id: "start-suggestions",
        title: "No app suggestions in Start",
        description: "Removes the \"suggested\" apps Microsoft advertises in the Start menu.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[cu(CDM, "SystemPaneSuggestionsEnabled", 0, Some(1)), cu(CDM, "SubscribedContent-338388Enabled", 0, Some(1))],
    },
    Tweak {
        id: "tips",
        title: "No tips and tricks pop-ups",
        description: "Stops notifications with tips, tricks and suggestions while you use Windows.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[cu(CDM, "SubscribedContent-338389Enabled", 0, Some(1)), cu(CDM, "SoftLandingEnabled", 0, Some(1))],
    },
    Tweak {
        id: "lock-screen",
        title: "No ads or fun facts on the lock screen",
        description: "Keeps the lock screen picture but drops the promotions and trivia on top of it.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[cu(CDM, "RotatingLockScreenOverlayEnabled", 0, Some(1)), cu(CDM, "SubscribedContent-338387Enabled", 0, Some(1))],
    },
    Tweak {
        id: "settings-suggestions",
        title: "No suggestions in Settings",
        description: "Hides the suggested content and offers in the Windows Settings app.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[
            cu(CDM, "SubscribedContent-338393Enabled", 0, Some(1)),
            cu(CDM, "SubscribedContent-353694Enabled", 0, Some(1)),
            cu(CDM, "SubscribedContent-353696Enabled", 0, Some(1)),
        ],
    },
    Tweak {
        id: "silent-installs",
        title: "Stop Windows installing suggested apps",
        description: "Prevents games and apps like Candy Crush from appearing on their own after updates.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[
            cu(CDM, "SilentInstalledAppsEnabled", 0, Some(1)),
            cu(CDM, "PreInstalledAppsEnabled", 0, Some(1)),
            cu(CDM, "OemPreInstalledAppsEnabled", 0, Some(1)),
        ],
    },
    Tweak {
        id: "welcome",
        title: "No welcome screens after updates",
        description: "Skips the \"Let's finish setting up your device\" and what's-new screens.",
        group: ADS,
        recommended: true,
        explorer: false,
        values: &[
            cu(CDM, "SubscribedContent-310093Enabled", 0, Some(1)),
            cu(r"Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement", "ScoobeSystemSettingEnabled", 0, Some(1)),
        ],
    },
    Tweak {
        id: "explorer-ads",
        title: "No OneDrive and Microsoft 365 ads in File Explorer",
        description: "Hides the sync provider promotions shown at the top of File Explorer.",
        group: ADS,
        recommended: true,
        explorer: true,
        values: &[cu(ADVANCED, "ShowSyncProviderNotifications", 0, Some(1))],
    },
    Tweak {
        id: "tailored",
        title: "No tailored experiences",
        description: "Stops Microsoft using your diagnostic data to personalise tips, ads and recommendations.",
        group: PRIVACY,
        recommended: true,
        explorer: false,
        values: &[cu(r"Software\Microsoft\Windows\CurrentVersion\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", 0, Some(1))],
    },
    Tweak {
        id: "language-list",
        title: "Don't share your language list with websites",
        description: "Websites see one language instead of your full list, which makes you harder to fingerprint.",
        group: PRIVACY,
        recommended: true,
        explorer: false,
        values: &[cu(r"Control Panel\International\User Profile", "HttpAcceptLanguageOptOut", 1, None)],
    },
    Tweak {
        id: "feedback",
        title: "Never ask for feedback",
        description: "Stops the \"How likely are you to recommend Windows?\" questions.",
        group: PRIVACY,
        recommended: true,
        explorer: false,
        values: &[cu(r"Software\Microsoft\Siuf\Rules", "NumberOfSIUFInPeriod", 0, None)],
    },
    Tweak {
        id: "app-tracking",
        title: "Don't track which apps you open",
        description: "Windows stops recording app launches. The \"Most used\" list in Start goes away too.",
        group: PRIVACY,
        recommended: false,
        explorer: true,
        values: &[cu(ADVANCED, "Start_TrackProgs", 0, Some(1))],
    },
    Tweak {
        id: "telemetry",
        title: "Send only required diagnostic data",
        description: "Limits what Windows reports to Microsoft. Settings will then say some options are managed by your organization; that's expected.",
        group: PRIVACY,
        recommended: false,
        explorer: false,
        values: &[lm(r"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "AllowTelemetry", 1)],
    },
    Tweak {
        id: "activity-history",
        title: "Turn off activity history",
        description: "Stops Windows keeping and uploading a history of the apps, files and sites you used.",
        group: PRIVACY,
        recommended: false,
        explorer: false,
        values: &[
            lm(r"SOFTWARE\Policies\Microsoft\Windows\System", "PublishUserActivities", 0),
            lm(r"SOFTWARE\Policies\Microsoft\Windows\System", "UploadUserActivities", 0),
        ],
    },
    Tweak {
        id: "web-search",
        title: "No Bing web results in Start search",
        description: "Searching from Start only finds your apps, files and settings. Faster, and nothing typed goes to Bing.",
        group: SEARCH,
        recommended: true,
        explorer: true,
        values: &[
            cu(r"Software\Policies\Microsoft\Windows\Explorer", "DisableSearchBoxSuggestions", 1, None),
            cu(r"Software\Microsoft\Windows\CurrentVersion\Search", "BingSearchEnabled", 0, None),
        ],
    },
    Tweak {
        id: "search-highlights",
        title: "No search highlights",
        description: "Removes the doodles and trending searches from the search box and Start search.",
        group: SEARCH,
        recommended: true,
        explorer: false,
        values: &[cu(r"Software\Microsoft\Windows\CurrentVersion\SearchSettings", "IsDynamicSearchBoxEnabled", 0, Some(1))],
    },
    Tweak {
        id: "copilot-button",
        title: "Hide the Copilot button",
        description: "Takes the Copilot button off the taskbar. Copilot itself still works from Start.",
        group: SEARCH,
        recommended: false,
        explorer: true,
        values: &[cu(ADVANCED, "ShowCopilotButton", 0, Some(1))],
    },
];

/// A registry number as it was before a change; `previous: None` means there was no value.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegValue {
    pub hive: Hive,
    pub path: String,
    pub name: String,
    pub previous: Option<u32>,
}

#[cfg(windows)]
mod reg {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_SET_VALUE};

    use super::Hive;

    fn root(hive: Hive) -> RegKey {
        RegKey::predef(match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        })
    }

    pub fn read(hive: Hive, path: &str, name: &str) -> Option<u32> {
        root(hive).open_subkey(path).ok()?.get_value::<u32, _>(name).ok()
    }

    pub fn write(hive: Hive, path: &str, name: &str, value: Option<u32>) -> Result<(), String> {
        let failed = |e: std::io::Error| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                "Windows refused the change. Some settings need Restart as administrator.".to_string()
            } else {
                format!("Couldn't change the setting: {e}")
            }
        };
        match value {
            Some(v) => {
                let (key, _) = root(hive).create_subkey(path).map_err(failed)?;
                key.set_value(name, &v).map_err(failed)
            }
            None => match root(hive).open_subkey_with_flags(path, KEY_SET_VALUE) {
                Ok(key) => match key.delete_value(name) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(failed(e)),
                    _ => Ok(()),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(failed(e)),
            },
        }
    }
}

#[cfg(not(windows))]
mod reg {
    use super::Hive;
    pub fn read(_hive: Hive, _path: &str, _name: &str) -> Option<u32> {
        None
    }
    pub fn write(_hive: Hive, _path: &str, _name: &str, _value: Option<u32>) -> Result<(), String> {
        Err("Only available on Windows.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TweakInfo {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub group: &'static str,
    pub recommended: bool,
    pub admin: bool,
    pub explorer: bool,
    /// Every value is set the private way.
    pub applied: bool,
}

fn needs_admin(t: &Tweak) -> bool {
    t.values.iter().any(|v| v.hive == Hive::LocalMachine)
}

#[tauri::command]
pub fn list_privacy_tweaks() -> Vec<TweakInfo> {
    TWEAKS
        .iter()
        .map(|t| TweakInfo {
            id: t.id,
            title: t.title,
            description: t.description,
            group: t.group,
            recommended: t.recommended,
            admin: needs_admin(t),
            explorer: t.explorer,
            applied: t.values.iter().all(|v| reg::read(v.hive, v.path, v.name) == Some(v.on)),
        })
        .collect()
}

/// Turns the given settings to private (`on`) or back to Windows' defaults. Returns the activity id.
#[tauri::command(async)]
pub fn set_privacy_tweaks(app: AppHandle, ids: Vec<String>, on: bool) -> Result<Option<String>, String> {
    let chosen: Vec<&Tweak> = TWEAKS.iter().filter(|t| ids.iter().any(|id| id == t.id)).collect();
    if chosen.is_empty() {
        return Err("Nothing to change.".into());
    }
    if !crate::os::is_elevated() && chosen.iter().any(|t| needs_admin(t)) {
        return Err("Some of these need administrator rights. Use Restart as administrator first.".into());
    }
    let mut previous = Vec::new();
    for t in &chosen {
        for v in t.values {
            let before = reg::read(v.hive, v.path, v.name);
            let target = if on { Some(v.on) } else { v.off };
            if before == target {
                continue;
            }
            if let Err(e) = reg::write(v.hive, v.path, v.name, target) {
                // Leave nothing half done.
                let _ = restore(&previous);
                return Err(e);
            }
            previous.push(RegValue { hive: v.hive, path: v.path.into(), name: v.name.into(), previous: before });
        }
    }
    if previous.is_empty() {
        return Ok(None);
    }
    let names: Vec<&str> = chosen.iter().map(|t| t.title).collect();
    let description = if on {
        format!("Privacy: {} {}", names.len(), if names.len() == 1 { "setting turned on" } else { "settings turned on" })
    } else {
        format!("Privacy: {} {} back to Windows' default", names.len(), if names.len() == 1 { "setting" } else { "settings" })
    };
    Ok(app.state::<ActivityLog>().record(&app, "Privacy", description, Some(names.join("\n")), Some(Undo::Registry { values: previous })))
}

/// Puts registry values back as they were (activity undo).
pub fn restore(values: &[RegValue]) -> Result<(), String> {
    for v in values.iter().rev() {
        reg::write(v.hive, &v.path, &v.name, v.previous)?;
    }
    Ok(())
}

// ---- Preinstalled apps ----

/// Store package names, what people call them, and whether most people can do without them.
const BLOAT: &[(&str, &str, bool)] = &[
    ("king.com.CandyCrushSaga", "Candy Crush Saga", true),
    ("king.com.CandyCrushSodaSaga", "Candy Crush Soda Saga", true),
    ("king.com.BubbleWitch3Saga", "Bubble Witch 3 Saga", true),
    ("Microsoft.BingNews", "Microsoft News", true),
    ("Microsoft.BingWeather", "Weather", false),
    ("Microsoft.BingFinance", "Money", true),
    ("Microsoft.BingSports", "Sports", true),
    ("Microsoft.BingSearch", "Bing Search", true),
    ("Microsoft.GetHelp", "Get Help", false),
    ("Microsoft.Getstarted", "Tips", true),
    ("Microsoft.MicrosoftOfficeHub", "Microsoft 365 (Office) launcher", true),
    ("Microsoft.MicrosoftSolitaireCollection", "Solitaire Collection", false),
    ("Microsoft.People", "People", true),
    ("Microsoft.WindowsFeedbackHub", "Feedback Hub", true),
    ("Microsoft.WindowsMaps", "Maps", false),
    ("Microsoft.ZuneVideo", "Movies & TV", false),
    ("Microsoft.MixedReality.Portal", "Mixed Reality Portal", true),
    ("Microsoft.Microsoft3DViewer", "3D Viewer", true),
    ("Microsoft.MSPaint", "Paint 3D", true),
    ("Microsoft.Print3D", "Print 3D", true),
    ("Microsoft.SkypeApp", "Skype", true),
    ("Microsoft.Todos", "Microsoft To Do", false),
    ("Microsoft.PowerAutomateDesktop", "Power Automate", true),
    ("Microsoft.549981C3F5F10", "Cortana", true),
    ("Microsoft.Messaging", "Messaging", true),
    ("Microsoft.OneConnect", "Mobile Plans", true),
    ("Microsoft.Wallet", "Microsoft Pay", true),
    ("Microsoft.Windows.DevHome", "Dev Home", true),
    ("Microsoft.OutlookForWindows", "Outlook (new)", false),
    ("Microsoft.Copilot", "Copilot", false),
    ("Microsoft.YourPhone", "Phone Link", false),
    ("Microsoft.MicrosoftJournal", "Journal", false),
    ("MicrosoftTeams", "Teams (personal chat)", true),
    ("Clipchamp.Clipchamp", "Clipchamp", true),
    ("SpotifyAB.SpotifyMusic", "Spotify", false),
    ("Disney.37853FC22B2CE", "Disney+", true),
    ("BytedancePte.Ltd.TikTok", "TikTok", true),
    ("Facebook.Facebook", "Facebook", true),
    ("Facebook.Instagram", "Instagram", true),
    ("FACEBOOK.317180B0BB486", "Messenger", true),
    ("5319275A.WhatsAppDesktop", "WhatsApp", false),
    ("4DF9E0F8.Netflix", "Netflix", false),
    ("AmazonVideo.PrimeVideo", "Prime Video", false),
    ("7EE7776C.LinkedInforWindows", "LinkedIn", true),
    ("AdobeSystemsIncorporated.AdobePhotoshopExpress", "Photoshop Express", true),
];

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "PascalCase")]
struct Package {
    name: String,
    package_full_name: String,
    #[serde(default)]
    package_family_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BloatApp {
    pub label: String,
    pub package: String,
    pub full_name: String,
    pub family: String,
    pub recommended: bool,
}

#[tauri::command]
pub async fn list_bloat_apps() -> Result<Vec<BloatApp>, String> {
    crate::blocking(|| {
        let script = "ConvertTo-Json -Compress -InputObject @(Get-AppxPackage | Where-Object { -not $_.NonRemovable -and -not $_.IsFramework } | Select-Object Name, PackageFullName, PackageFamilyName)";
        let value = ps::json(script, Duration::from_secs(40))?;
        let packages: Vec<Package> = serde_json::from_value(value).map_err(|e| format!("Couldn't read the app list: {e}"))?;
        let mut apps: Vec<BloatApp> = Vec::new();
        for p in packages {
            if let Some((_, label, recommended)) = BLOAT.iter().find(|(name, _, _)| name.eq_ignore_ascii_case(&p.name))
                && !apps.iter().any(|a| a.package.eq_ignore_ascii_case(&p.name))
            {
                apps.push(BloatApp { label: label.to_string(), package: p.name, full_name: p.package_full_name, family: p.package_family_name, recommended: *recommended });
            }
        }
        apps.sort_by(|a, b| b.recommended.cmp(&a.recommended).then_with(|| a.label.cmp(&b.label)));
        Ok(apps)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTarget {
    pub full_name: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub label: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn remove_bloat_apps(app: AppHandle, targets: Vec<RemoveTarget>) -> Result<Vec<RemoveResult>, String> {
    crate::blocking(move || {
        let mut results = Vec::new();
        for t in &targets {
            // Only packages from our own list, never an arbitrary name.
            if !BLOAT.iter().any(|(name, _, _)| t.full_name.to_lowercase().starts_with(&format!("{}_", name.to_lowercase()))) {
                results.push(RemoveResult { label: t.label.clone(), error: Some("Not on the list of removable apps.".into()) });
                continue;
            }
            let script = format!(
                "try {{ Remove-AppxPackage -Package {} -ErrorAction Stop; 'ok' }} catch {{ $_.Exception.Message }}",
                ps::quote(&t.full_name)
            );
            let error = match ps::run(&script, Duration::from_secs(120)) {
                Ok((out, _)) if out.trim() == "ok" => None,
                Ok((out, err)) => Some(if out.trim().is_empty() { err.trim().to_string() } else { out.trim().to_string() }),
                Err(e) => Some(e),
            };
            results.push(RemoveResult { label: t.label.clone(), error });
        }
        let removed: Vec<&str> = results.iter().filter(|r| r.error.is_none()).map(|r| r.label.as_str()).collect();
        if !removed.is_empty() {
            app.state::<ActivityLog>().record(
                &app,
                "Privacy",
                format!("Removed {} preinstalled {}", removed.len(), if removed.len() == 1 { "app" } else { "apps" }),
                Some(format!("{}\nTo get one back, install it again from the Microsoft Store.", removed.join(", "))),
                None,
            );
        }
        Ok(results)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tweak_ids_are_unique_and_admin_is_detected() {
        let mut ids: Vec<&str> = TWEAKS.iter().map(|t| t.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), TWEAKS.len());
        assert!(needs_admin(TWEAKS.iter().find(|t| t.id == "telemetry").unwrap()));
        assert!(!needs_admin(TWEAKS.iter().find(|t| t.id == "ad-id").unwrap()));
    }

    #[test]
    fn reads_appx_json() {
        let json = r#"[{"Name":"Microsoft.BingNews","PackageFullName":"Microsoft.BingNews_4.1_x64__8wekyb3d8bbwe","PackageFamilyName":"Microsoft.BingNews_8wekyb3d8bbwe"}]"#;
        let list: Vec<Package> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].name, "Microsoft.BingNews");
    }
}
