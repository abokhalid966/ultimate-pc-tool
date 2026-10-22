//! Windows services: list, start, stop, restart and change how they start, through the Service
//! Control Manager API (no PowerShell or sc.exe).
//!
//! Services Windows can't run without are refused outright, others that matter carry a warning,
//! and every change is written to the activity log. Startup type changes can be undone.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::actions::{ActivityLog, Undo};

/// How a service starts, as the Services console names it.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum StartupType {
    Automatic,
    AutomaticDelayed,
    Manual,
    Disabled,
}

impl StartupType {
    pub fn label(self) -> &'static str {
        match self {
            StartupType::Automatic => "Automatic",
            StartupType::AutomaticDelayed => "Automatic (delayed)",
            StartupType::Manual => "Manual",
            StartupType::Disabled => "Disabled",
        }
    }

    /// How readily it runs: lower means it runs less.
    fn rank(self) -> u8 {
        match self {
            StartupType::Automatic => 3,
            StartupType::AutomaticDelayed => 2,
            StartupType::Manual => 1,
            StartupType::Disabled => 0,
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStatus {
    Running,
    Stopped,
    Starting,
    Stopping,
    Paused,
    Pausing,
    Resuming,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Publisher {
    Microsoft,
    ThirdParty,
    /// Windows didn't let this app read where the service's program is.
    Unknown,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Safety {
    /// Windows needs it: it can't be stopped or disabled here.
    Protected,
    /// Allowed, but something noticeable breaks (sound, Wi-Fi, printing...), so the user is warned.
    Important,
    Normal,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    /// The service's key name, e.g. `Spooler`.
    pub name: String,
    pub display_name: String,
    /// The description Windows shows in the Services console.
    pub description: Option<String>,
    /// A plain-language summary for well-known services.
    pub summary: Option<String>,
    pub status: ServiceStatus,
    /// `None` when Windows doesn't let this app read the service's settings.
    pub startup: Option<StartupType>,
    pub pid: Option<u32>,
    /// The program file. For services hosted by svchost.exe, the DLL that holds the service.
    pub program: Option<String>,
    /// Exact command line Windows starts.
    pub command_line: Option<String>,
    /// Account the service runs as, e.g. `LocalSystem`.
    pub account: Option<String>,
    pub publisher: Publisher,
    /// Company name from the program file's version information.
    pub company: Option<String>,
    pub safety: Safety,
    /// Why it's protected, or what breaks when it stops.
    pub safety_note: Option<String>,
    /// It's running and accepts the stop command.
    pub can_stop: bool,
    /// It runs inside a shared Service Host (svchost.exe) process with other services.
    pub shared_process: bool,
    /// Services this one needs, by key name. Load-order groups start with `+`.
    pub dependencies: Vec<String>,
    /// For a per-user copy (e.g. `CDPUserSvc_4f2a1`), the service it was made from.
    pub template: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLink {
    pub name: String,
    pub display_name: String,
    pub status: Option<ServiceStatus>,
    /// A load-order group rather than a single service.
    pub group: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetails {
    /// Services this one needs to run.
    pub dependencies: Vec<ServiceLink>,
    /// Services that need this one (they stop when it stops).
    pub dependents: Vec<ServiceLink>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

/// What an action did, with the service as it is afterwards.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceActionResult {
    pub service: Option<ServiceInfo>,
    /// The service was still starting or stopping when the wait ran out. Windows keeps going.
    pub timed_out: bool,
    /// Display names of services that were stopped (and, for a restart, started again) with it.
    pub also: Vec<String>,
    /// Something worth telling the user, e.g. that the service stopped again by itself.
    pub note: Option<String>,
    /// Activity entry for an Undo button (startup type changes only).
    pub activity_id: Option<String>,
}

/// Result of a start or stop in the platform layer.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Default)]
struct Outcome {
    /// Something actually changed (e.g. starting a running service changes nothing).
    changed: bool,
    timed_out: bool,
    /// It started, then stopped again by itself without an error (nothing needed it).
    stopped_itself: bool,
    /// Display names of the services that were stopped first because they need this one.
    also: Vec<String>,
    /// Key names of those services, in the order they were stopped.
    stopped_dependents: Vec<String>,
}

/// Shown when a change fails because this app isn't running as administrator. The UI looks for
/// "Restart as administrator" in errors to offer the button.
#[cfg_attr(not(windows), allow(dead_code))]
const ADMIN_NEEDED: &str = "Changing services needs administrator rights. Use Restart as administrator, then try again.";

// ---- Curated knowledge about well-known services ----

/// Key name, safety level, plain-language summary, and the protection reason or warning.
type Known = (&'static str, Safety, &'static str, Option<&'static str>);

const P: Safety = Safety::Protected;
const I: Safety = Safety::Important;
const N: Safety = Safety::Normal;

const KNOWN: &[Known] = &[
    // Windows can't run (or can't be signed in to) without these.
    ("RpcSs", P, "Lets Windows programs talk to each other. Almost everything depends on it.", None),
    ("DcomLaunch", P, "Starts many Windows background components. Windows can't run without it.", None),
    ("RpcEptMapper", P, "Helps Windows programs find each other. Required by Windows.", None),
    ("LSM", P, "Manages sign-ins and user sessions.", None),
    ("SamSs", P, "Protects user accounts and passwords on this PC.", None),
    ("Winmgmt", P, "Lets Windows and apps read information about your PC and its settings.", None),
    ("EventLog", P, "Keeps the Windows logs that record errors and warnings.", None),
    ("PlugPlay", P, "Detects devices you plug in and sets them up.", None),
    ("Power", P, "Manages power plans, sleep and battery settings.", None),
    ("BFE", P, "The core of Windows Firewall and network security.", None),
    ("mpssvc", P, "Windows Firewall: blocks unwanted network connections.", Some("Windows Firewall protects your PC from network attacks. Stopping or disabling it would leave your PC exposed, so Ultimate PC Tool won't do it.")),
    ("WinDefend", P, "Microsoft Defender Antivirus: protects your PC from viruses and malware.", Some("Microsoft Defender protects your PC from viruses and malware. Stopping or disabling it would leave your PC unprotected, so Ultimate PC Tool won't do it.")),
    ("WdNisSvc", P, "Part of Microsoft Defender: blocks attacks coming over the network.", None),
    ("SecurityHealthService", P, "Windows Security: keeps track of your PC's protection.", None),
    ("wscsvc", P, "Security Center: watches your antivirus, firewall and update status.", None),
    ("Sense", P, "Microsoft Defender for Endpoint, used by organizations to protect their PCs.", None),
    ("SgrmBroker", P, "Checks that Windows started up securely.", None),
    ("CryptSvc", P, "Checks digital signatures of updates and apps, and manages certificates.", None),
    ("KeyIso", P, "Keeps encryption keys and saved secrets isolated and safe.", None),
    ("ProfSvc", P, "Loads your user profile when you sign in.", Some("Windows needs this service to load your account when you sign in. Stopping or disabling it could stop anyone from signing in, so Ultimate PC Tool won't do it.")),
    ("Schedule", P, "Task Scheduler: runs maintenance, updates and other scheduled tasks.", None),
    ("gpsvc", P, "Applies settings from your organization or local policies.", None),
    ("AudioEndpointBuilder", P, "Manages your speakers, headphones and microphones.", None),
    ("Dhcp", P, "Gets an address from your router so you can go online.", None),
    ("Dnscache", P, "Turns website names into addresses and remembers them.", None),
    ("nsi", P, "Keeps network settings available to Windows. Without it you lose internet.", None),
    ("BrokerInfrastructure", P, "Runs background tasks for Windows and apps.", None),
    ("SystemEventsBroker", P, "Tells apps about system events, like time and network changes.", None),
    ("CoreMessagingRegistrar", P, "Passes messages between parts of Windows. The desktop needs it.", None),
    ("StateRepository", P, "Stores app information for the Start menu and Store apps.", None),
    ("UserManager", P, "Manages user accounts when people sign in and out.", None),
    ("Appinfo", P, "Shows the administrator prompt when an app asks for more rights.", Some("Windows uses this service to show the administrator prompt. Without it, no app can run as administrator, so Ultimate PC Tool won't stop or disable it.")),
    ("TimeBrokerSvc", P, "Decides when apps may run tasks in the background.", None),
    ("WinHttpAutoProxySvc", P, "Finds proxy settings for internet connections.", None),
    ("NgcSvc", P, "Windows Hello PIN sign-in.", Some("Your PIN and Windows Hello sign-in depend on this service. Disabling it could stop you from signing in with your PIN, so Ultimate PC Tool won't do it.")),
    ("NgcCtnrSvc", P, "Stores the keys behind your Windows Hello PIN.", Some("Your PIN and Windows Hello sign-in depend on this service. Disabling it could stop you from signing in with your PIN, so Ultimate PC Tool won't do it.")),
    ("WaaSMedicSvc", P, "Repairs Windows Update when it stops working.", None),
    // Allowed, with a warning about what stops working.
    ("Audiosrv", I, "Plays sound from Windows and your apps.", Some("Sound stops on this PC until the service runs again.")),
    ("Spooler", I, "Sends documents to your printers.", Some("Printing stops until the service runs again. Restarting it often fixes stuck print jobs.")),
    ("WlanSvc", I, "Connects to Wi-Fi networks.", Some("Wi-Fi disconnects and no Wi-Fi networks show up until the service runs again.")),
    ("NlaSvc", I, "Works out which network you're on and whether it has internet.", Some("Windows may say there's no internet and use the wrong firewall settings for your network.")),
    ("netprofm", I, "Keeps the list of networks you've connected to.", Some("The network icon and network settings may stop working properly.")),
    ("Wcmsvc", I, "Chooses between Wi-Fi, Ethernet and mobile connections.", Some("Your PC may stop connecting to networks automatically.")),
    ("LanmanWorkstation", I, "Opens shared folders and network drives on other PCs.", Some("Shared folders and mapped network drives stop working.")),
    ("LanmanServer", I, "Shares this PC's folders and printers with others on your network.", Some("Other PCs can't open the folders and printers you share.")),
    ("EventSystem", I, "Delivers notifications between Windows components.", Some("Several Windows features that rely on it may stop working.")),
    ("SENS", I, "Tells apps when you sign in, go online or your PC wakes up.", Some("Some apps may not notice when you go online or sign in.")),
    ("W32Time", I, "Keeps your clock in sync with internet time.", Some("Your clock may drift over time, which can cause sign-in and website errors.")),
    ("Themes", I, "Draws the Windows look: colors, transparency and window styles.", Some("Windows switches to a plain look until the service runs again.")),
    ("WSearch", I, "Indexes your files so search in Start and File Explorer is fast.", Some("Searching your files becomes slow and may miss results.")),
    ("FontCache", I, "Speeds up apps by keeping fonts ready.", Some("Apps may start more slowly.")),
    ("wuauserv", I, "Windows Update: downloads and installs updates.", Some("Your PC stops getting updates, including security fixes. Turn it back on soon.")),
    ("UsoSvc", I, "Plans and installs Windows updates.", Some("Windows updates may stop installing, including security fixes.")),
    ("BITS", I, "Downloads updates and files quietly in the background.", Some("Windows Update and some apps can't download in the background.")),
    ("DoSvc", I, "Delivery Optimization: helps download Windows updates and Store apps.", Some("Windows updates and Store downloads may stop working.")),
    ("TrustedInstaller", I, "Installs Windows updates and optional features.", Some("Windows updates and optional features can't be installed.")),
    ("msiserver", I, "Installs, repairs and removes many desktop programs.", Some("Many programs can't be installed, repaired or removed.")),
    ("bthserv", I, "Connects Bluetooth devices like headphones, mice and keyboards.", Some("Bluetooth devices disconnect and new ones can't be paired.")),
    ("WbioSrvc", I, "Fingerprint and face sign-in (Windows Hello).", Some("Fingerprint and face sign-in stop working. Your password and PIN still work.")),
    ("TokenBroker", I, "Signs you in to Microsoft apps with your account.", Some("Signing in to Microsoft apps, like Outlook or the Store, may stop working.")),
    ("VaultSvc", I, "Keeps the passwords saved in Credential Manager.", Some("Apps can't use the passwords saved on this PC.")),
    ("camsvc", I, "Controls which apps may use your camera, microphone and location.", Some("Apps may lose access to the camera, microphone and location.")),
    ("AppXSvc", I, "Installs and updates Microsoft Store apps.", Some("Store apps can't be installed or updated.")),
    ("ClipSVC", I, "Checks licenses for Microsoft Store apps.", Some("Some Store apps may not open.")),
    ("DispBrokerDesktopSvc", I, "Manages display settings like resolution and scaling.", Some("Display settings may stop working.")),
    ("TabletInputService", I, "The touch keyboard, handwriting and pen input.", Some("The touch keyboard and pen input stop working.")),
    ("VSS", I, "Takes snapshots used by System Restore and backups.", Some("System Restore and backup apps may fail.")),
    ("Netlogon", I, "Signs in to your work or school network domain.", Some("Signing in with a work or school domain account may fail.")),
    ("DusmSvc", I, "Tracks data usage and limits on metered connections.", Some("Data usage limits and metered connection settings stop working.")),
    ("DPS", I, "Finds and fixes common problems on your PC.", Some("Windows troubleshooters and problem detection stop working.")),
    // Common services, with a plain-language summary.
    ("SysMain", N, "Learns which apps you use and preloads them so they open faster.", None),
    ("DiagTrack", N, "Sends diagnostic and usage data to Microsoft.", None),
    ("dmwappushservice", N, "Delivers device management and diagnostic messages.", None),
    ("MapsBroker", N, "Downloads maps for the Maps app.", None),
    ("RetailDemo", N, "Only used on demo PCs in stores.", None),
    ("Fax", N, "Sends and receives faxes. Only needed if you fax from this PC.", None),
    ("XblAuthManager", N, "Signs you in to Xbox games and apps.", None),
    ("XblGameSave", N, "Syncs saved games for Xbox games.", None),
    ("XboxGipSvc", N, "Supports Xbox accessories like controllers.", None),
    ("XboxNetApiSvc", N, "Network features for Xbox games.", None),
    ("lfsvc", N, "Gives apps your location when you allow it.", None),
    ("WerSvc", N, "Reports app crashes and problems to Microsoft.", None),
    ("RemoteRegistry", N, "Lets other PCs change this PC's settings over the network.", None),
    ("TermService", N, "Remote Desktop: lets people connect to this PC remotely.", None),
    ("SessionEnv", N, "Settings for Remote Desktop connections.", None),
    ("UmRdpService", N, "Shares printers and drives during Remote Desktop sessions.", None),
    ("SCardSvr", N, "Reads smart cards, used by some workplaces.", None),
    ("stisvc", N, "Scanners and cameras (Windows Image Acquisition).", None),
    ("PcaSvc", N, "Watches older programs for compatibility problems.", None),
    ("seclogon", N, "Lets you run a program as a different user.", None),
    ("WpnService", N, "Shows notifications from apps and Windows.", None),
    ("CDPSvc", N, "Connects your PC with your phone and other devices.", None),
    ("iphlpsvc", N, "Provides IPv6 connectivity over older networks.", None),
    ("WinRM", N, "Lets administrators manage this PC remotely.", None),
    ("wisvc", N, "Windows Insider Program (preview builds of Windows).", None),
    ("PrintNotify", N, "Shows printer notifications and settings.", None),
    ("PhoneSvc", N, "Manages phone calls made from this PC.", None),
    ("SharedAccess", N, "Internet Connection Sharing: shares this PC's internet with other devices.", None),
    ("icssvc", N, "Mobile hotspot: shares this PC's internet over Wi-Fi.", None),
    ("WMPNetworkSvc", N, "Shares Windows Media Player libraries on your network.", None),
    ("ShellHWDetection", N, "AutoPlay: reacts when you insert a USB drive, disc or memory card.", None),
    ("SSDPSRV", N, "Finds devices like smart TVs and media players on your network.", None),
    ("upnphost", N, "Lets this PC act as a device other devices can find.", None),
    ("fdPHost", N, "Finds other PCs and devices on your network.", None),
    ("FDResPub", N, "Lets other PCs on your network find this PC.", None),
    ("WpcMonSvc", N, "Parental controls for family accounts.", None),
    ("WdiServiceHost", N, "Helps Windows diagnose problems.", None),
    ("WwanSvc", N, "Mobile broadband (SIM card) connections.", None),
    ("hidserv", N, "Makes special keys on keyboards and remotes work.", None),
    ("OneSyncSvc", N, "Syncs mail, contacts and calendar.", None),
    ("edgeupdate", N, "Keeps Microsoft Edge up to date.", None),
    ("edgeupdatem", N, "Keeps Microsoft Edge up to date.", None),
    ("MicrosoftEdgeElevationService", N, "Helps Microsoft Edge with tasks that need extra rights.", None),
    ("ClickToRunSvc", N, "Installs and updates Microsoft Office.", None),
    ("gupdate", N, "Keeps Google apps like Chrome up to date.", None),
    ("gupdatem", N, "Keeps Google apps like Chrome up to date.", None),
    ("GoogleChromeElevationService", N, "Helps Google Chrome with tasks that need extra rights.", None),
    ("Steam Client Service", N, "Lets Steam install and update games.", None),
    ("NVDisplay.ContainerLocalSystem", N, "NVIDIA graphics driver helper (control panel and settings).", None),
];

fn known(name: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.0.eq_ignore_ascii_case(name))
}

/// Safety level and its note for a service (by key name, or its template's for a per-user copy).
fn safety_of(name: &str, display: &str) -> (Safety, Option<String>) {
    match known(name) {
        Some((_, Safety::Protected, _, note)) => (
            Safety::Protected,
            Some(note.map(String::from).unwrap_or_else(|| {
                format!("Windows needs {display} to work properly. Stopping or disabling it could crash your PC or stop it from starting, so Ultimate PC Tool won't do it.")
            })),
        ),
        Some((_, safety, _, note)) => (*safety, note.map(String::from)),
        None => (Safety::Normal, None),
    }
}

// ---- Parsing (platform independent, unit tested) ----

/// Windows adds this bit to the type of the per-user copies it makes of some services.
const SERVICE_USERSERVICE_INSTANCE: u32 = 0x80;

#[cfg_attr(not(windows), allow(dead_code))]
fn status_from(state: u32) -> ServiceStatus {
    match state {
        2 => ServiceStatus::Starting,
        3 => ServiceStatus::Stopping,
        4 => ServiceStatus::Running,
        5 => ServiceStatus::Resuming,
        6 => ServiceStatus::Pausing,
        7 => ServiceStatus::Paused,
        _ => ServiceStatus::Stopped,
    }
}

/// `start` is the SERVICE_*_START value; boot and system start only apply to drivers.
#[cfg_attr(not(windows), allow(dead_code))]
fn startup_from(start: u32, delayed: bool) -> Option<StartupType> {
    match start {
        0..=2 if delayed && start == 2 => Some(StartupType::AutomaticDelayed),
        0..=2 => Some(StartupType::Automatic),
        3 => Some(StartupType::Manual),
        4 => Some(StartupType::Disabled),
        _ => None,
    }
}

/// For a per-user copy like `CDPUserSvc_4f2a1`, the service it was made from (`CDPUserSvc`).
#[cfg_attr(not(windows), allow(dead_code))]
fn template_of(name: &str, service_type: u32) -> Option<String> {
    if service_type & SERVICE_USERSERVICE_INSTANCE == 0 {
        return None;
    }
    name.rsplit_once('_').map(|(template, _)| template.to_string()).filter(|t| !t.is_empty())
}

/// Replaces `%NAME%` with the variable's value. Unknown names are left as they are.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_env(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    s.get(..prefix.len()).filter(|p| p.eq_ignore_ascii_case(prefix)).map(|_| &s[prefix.len()..])
}

/// The program file in a service's command line: `"C:\Program Files\App\svc.exe" -run` and the
/// unquoted `C:\Program Files\App\svc.exe -run` both give `C:\Program Files\App\svc.exe`.
#[cfg_attr(not(windows), allow(dead_code))]
fn image_path(command: &str, windir: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let expanded = expand_env(command.trim(), lookup);
    let s = expanded.trim();
    let path = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next().unwrap_or(rest).trim().to_string()
    } else {
        // Unquoted paths may contain spaces: cut after the first ".exe" that ends a word.
        let lower = s.to_ascii_lowercase();
        let mut from = 0;
        let mut cut = None;
        while let Some(i) = lower[from..].find(".exe") {
            let end = from + i + 4;
            if end == s.len() || s[end..].starts_with(' ') {
                cut = Some(end);
                break;
            }
            from = end;
        }
        match cut {
            Some(end) => s[..end].to_string(),
            None => s.split(' ').next().unwrap_or(s).to_string(),
        }
    };
    let windir = windir.trim_end_matches('\\');
    let path = if let Some(rest) = strip_prefix_ci(&path, r"\SystemRoot\") {
        format!(r"{windir}\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\??\") {
        rest.to_string()
    } else if strip_prefix_ci(&path, r"system32\").is_some() {
        format!(r"{windir}\{path}")
    } else {
        path
    };
    (!path.is_empty()).then_some(path)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Microsoft when the file's company says so; without a company, when it lives in the Windows
/// folder (but not the driver store, where hardware makers' files live).
#[cfg_attr(not(windows), allow(dead_code))]
fn classify(program: Option<&str>, company: Option<&str>, windir: &str) -> Publisher {
    if let Some(company) = company {
        return if company.to_lowercase().contains("microsoft") { Publisher::Microsoft } else { Publisher::ThirdParty };
    }
    let Some(program) = program else { return Publisher::Unknown };
    let program = program.to_lowercase();
    let windir = format!("{}\\", windir.trim_end_matches('\\').to_lowercase());
    if program.starts_with(&windir) && !program.contains(r"\driverstore\") { Publisher::Microsoft } else { Publisher::ThirdParty }
}

/// Splits a double-NUL-terminated string list (as UTF-16 without the final NUL).
#[cfg_attr(not(windows), allow(dead_code))]
fn split_multi_sz(units: &[u16]) -> Vec<String> {
    units.split(|&u| u == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
}

/// Everything read from Windows about one service, before it's turned into a `ServiceInfo`.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Default)]
struct Raw {
    name: String,
    display_name: String,
    state: u32,
    controls_accepted: u32,
    pid: u32,
    service_type: u32,
    /// `None` when the configuration couldn't be read.
    start: Option<u32>,
    delayed: bool,
    command_line: Option<String>,
    account: Option<String>,
    dependencies: Vec<String>,
    description: Option<String>,
    program: Option<String>,
    company: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn assemble(raw: Raw, windir: &str) -> ServiceInfo {
    const SERVICE_ACCEPT_STOP: u32 = 1;
    const SERVICE_WIN32_SHARE_PROCESS: u32 = 0x20;
    let template = template_of(&raw.name, raw.service_type);
    let lookup_name = template.as_deref().unwrap_or(&raw.name);
    let (safety, safety_note) = safety_of(lookup_name, &raw.display_name);
    let status = status_from(raw.state);
    ServiceInfo {
        summary: known(lookup_name).map(|k| k.2.to_string()),
        status,
        startup: raw.start.and_then(|s| startup_from(s, raw.delayed)),
        pid: (raw.pid != 0).then_some(raw.pid),
        publisher: classify(raw.program.as_deref(), raw.company.as_deref(), windir),
        safety,
        safety_note,
        can_stop: status == ServiceStatus::Running && raw.controls_accepted & SERVICE_ACCEPT_STOP != 0,
        shared_process: raw.service_type & SERVICE_WIN32_SHARE_PROCESS != 0,
        template,
        name: raw.name,
        display_name: raw.display_name,
        description: raw.description,
        program: raw.program,
        command_line: raw.command_line,
        account: raw.account,
        company: raw.company,
        dependencies: raw.dependencies,
    }
}

// ---- Rules ----

/// Refuses actions on services Windows needs, before anything is attempted.
fn check_action(info: &ServiceInfo, action: ServiceAction) -> Result<(), String> {
    let name = &info.display_name;
    match action {
        ServiceAction::Start if info.startup == Some(StartupType::Disabled) => {
            Err(format!("{name} is disabled, so it can't start. Set its startup type to Manual or Automatic first."))
        }
        ServiceAction::Start => Ok(()),
        ServiceAction::Stop | ServiceAction::Restart => {
            if info.safety == Safety::Protected {
                return Err(info.safety_note.clone().unwrap_or_else(|| format!("Windows needs {name}, so Ultimate PC Tool won't stop it.")));
            }
            let running = matches!(info.status, ServiceStatus::Running | ServiceStatus::Paused);
            if running && !info.can_stop {
                return Err(format!("Windows doesn't let {name} be stopped while it's running."));
            }
            if action == ServiceAction::Restart && info.status == ServiceStatus::Stopped {
                return Err(format!("{name} isn't running. Use Start instead."));
            }
            Ok(())
        }
    }
}

/// Refuses startup type changes that could break Windows. `restoring` (an undo) may return a
/// protected service to how it was, but never disable it.
fn check_startup(info: &ServiceInfo, target: StartupType, restoring: bool) -> Result<(), String> {
    let name = &info.display_name;
    if let Some(template) = &info.template {
        return Err(format!(
            "Windows makes a copy of the \"{template}\" service for each person who signs in, and this copy follows its settings. Change \"{template}\" instead."
        ));
    }
    if info.safety == Safety::Protected {
        let lowered = info.startup.is_some_and(|current| target.rank() < current.rank());
        if target == StartupType::Disabled || (lowered && !restoring) {
            return Err(info.safety_note.clone().unwrap_or_else(|| format!("Windows needs {name}, so Ultimate PC Tool won't change how it starts.")));
        }
    }
    Ok(())
}

// ---- Tauri commands ----

#[tauri::command]
pub async fn list_services() -> Result<Vec<ServiceInfo>, String> {
    crate::blocking(imp::list).await
}

#[tauri::command]
pub async fn get_service(name: String) -> Result<ServiceInfo, String> {
    crate::blocking(move || imp::get(&name)).await
}

#[tauri::command]
pub async fn get_service_details(name: String) -> Result<ServiceDetails, String> {
    crate::blocking(move || imp::details(&name)).await
}

/// Starts, stops or restarts a service and waits (off the UI thread, with a time limit) until it
/// gets there. Services that need it are stopped first, and started again after a restart.
#[tauri::command]
pub async fn control_service(app: AppHandle, name: String, action: ServiceAction) -> Result<ServiceActionResult, String> {
    crate::blocking(move || {
        let before = imp::get(&name)?;
        check_action(&before, action)?;
        let display = before.display_name.clone();
        let log = |verb: &str, also: &[String], also_label: &str| {
            let mut detail = format!("Service name: {name}");
            if !also.is_empty() {
                detail.push_str(&format!(". {also_label}: {}", also.join(", ")));
            }
            app.state::<ActivityLog>().record(&app, "Services", format!("{verb} service \"{display}\""), Some(detail), None);
        };
        let finish = |outcome: Outcome, also: Vec<String>| {
            let note = outcome.stopped_itself.then(|| {
                format!("{display} started, then stopped again by itself. Some services do this when nothing needs them right now.")
            });
            Ok(ServiceActionResult { service: imp::get(&name).ok(), timed_out: outcome.timed_out, also, note, activity_id: None })
        };
        match action {
            ServiceAction::Start => {
                let started = imp::start(&name, &display)?;
                if started.changed {
                    log(if started.timed_out { "Asked to start" } else { "Started" }, &[], "");
                }
                finish(started, Vec::new())
            }
            ServiceAction::Stop => {
                let stopped = imp::stop(&name, &display)?;
                if stopped.changed {
                    log(if stopped.timed_out { "Asked to stop" } else { "Stopped" }, &stopped.also, "Also stopped");
                }
                let also = stopped.also.clone();
                finish(stopped, also)
            }
            ServiceAction::Restart => {
                let stopped = imp::stop(&name, &display)?;
                if stopped.timed_out {
                    log("Asked to stop", &stopped.also, "Also stopped");
                    let also = stopped.also.clone();
                    return finish(stopped, also);
                }
                let started = match imp::start(&name, &display) {
                    Ok(started) => started,
                    Err(e) => {
                        // It did stop, so that change is still recorded.
                        log("Stopped", &stopped.also, "Also stopped");
                        return Err(format!("{display} stopped, but couldn't start again. {e}"));
                    }
                };
                // Bring back what was stopped with it, the services it needs first (best effort).
                let mut also = Vec::new();
                for dep in stopped.stopped_dependents.iter().rev() {
                    if let Ok(info) = imp::get(dep)
                        && imp::start(dep, &info.display_name).is_ok()
                    {
                        also.push(info.display_name);
                    }
                }
                log(if started.timed_out { "Asked to restart" } else { "Restarted" }, &also, "Also restarted");
                finish(started, also)
            }
        }
    })
    .await
}

/// Changes how a service starts and records it in the activity log with an undo.
#[tauri::command]
pub async fn set_service_startup(app: AppHandle, name: String, startup: StartupType) -> Result<ServiceActionResult, String> {
    crate::blocking(move || {
        let before = imp::get(&name)?;
        check_startup(&before, startup, false)?;
        if before.startup == Some(startup) {
            return Ok(ServiceActionResult { service: Some(before), timed_out: false, also: Vec::new(), note: None, activity_id: None });
        }
        imp::set_startup(&name, &before.display_name, startup)?;
        let previous = before.startup;
        let was = previous.map(|p| format!(" (was {})", p.label())).unwrap_or_default();
        let undo = previous.map(|previous| Undo::ServiceStartup { name: name.clone(), display_name: before.display_name.clone(), startup: previous });
        let description = format!("Set service \"{}\" to {}{was}", before.display_name, startup.label());
        let activity_id = app.state::<ActivityLog>().record(&app, "Services", description, Some(format!("Service name: {name}")), undo);
        Ok(ServiceActionResult { service: imp::get(&name).ok(), timed_out: false, also: Vec::new(), note: None, activity_id })
    })
    .await
}

/// Undo of a startup type change, from the activity log.
pub fn restore_startup(name: &str, startup: StartupType) -> Result<(), String> {
    let info = imp::get(name)?;
    check_startup(&info, startup, true)?;
    if info.startup == Some(startup) {
        return Ok(());
    }
    imp::set_startup(name, &info.display_name, startup)
}

// ---- Windows implementation ----

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::LazyLock;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;
    use windows::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_DEPENDENT_SERVICES_RUNNING, ERROR_INVALID_SERVICE_CONTROL, ERROR_MORE_DATA, ERROR_SERVICE_ALREADY_RUNNING,
        ERROR_SERVICE_CANNOT_ACCEPT_CTRL, ERROR_SERVICE_DATABASE_LOCKED, ERROR_SERVICE_DEPENDENCY_DELETED, ERROR_SERVICE_DEPENDENCY_FAIL,
        ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_LOGON_FAILED, ERROR_SERVICE_MARKED_FOR_DELETE, ERROR_SERVICE_NOT_ACTIVE,
        ERROR_SERVICE_REQUEST_TIMEOUT, ERROR_SERVICE_SPECIFIC_ERROR, WIN32_ERROR,
    };
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows::Win32::System::Services::{
        ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, ControlService, ENUM_SERVICE_STATE, ENUM_SERVICE_STATUS_PROCESSW,
        ENUM_SERVICE_STATUSW, ENUM_SERVICE_TYPE, EnumDependentServicesW, EnumServicesStatusExW, OpenSCManagerW, OpenServiceW,
        QUERY_SERVICE_CONFIGW, QueryServiceConfig2W, QueryServiceConfigW, QueryServiceStatusEx, SC_ENUM_PROCESS_INFO, SC_HANDLE,
        SC_MANAGER_CONNECT, SC_MANAGER_ENUMERATE_SERVICE, SC_STATUS_PROCESS_INFO, SERVICE_ACTIVE, SERVICE_AUTO_START, SERVICE_CHANGE_CONFIG,
        SERVICE_CONFIG_DELAYED_AUTO_START_INFO, SERVICE_CONFIG_DESCRIPTION, SERVICE_CONTROL_STOP, SERVICE_DELAYED_AUTO_START_INFO,
        SERVICE_DEMAND_START, SERVICE_DESCRIPTIONW, SERVICE_DISABLED, SERVICE_ENUMERATE_DEPENDENTS, SERVICE_ERROR, SERVICE_NO_CHANGE,
        SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_STATE_ALL, SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE,
        SERVICE_STATUS_PROCESS, SERVICE_STOP, SERVICE_STOP_PENDING, SERVICE_STOPPED, SERVICE_WIN32, StartServiceW,
    };
    use windows::Win32::UI::Shell::SHLoadIndirectString;
    use windows::core::{BOOL, HRESULT, PCWSTR, PWSTR, w};
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    use super::{
        ADMIN_NEEDED, Outcome, Raw, ServiceDetails, ServiceInfo, ServiceLink, ServiceStatus, StartupType, assemble, file_name, image_path,
        split_multi_sz, status_from,
    };
    use crate::os;

    /// How long a start or stop may take before the app stops waiting (Windows keeps going).
    const WAIT_LIMIT: Duration = Duration::from_secs(30);

    struct Handle(SC_HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = unsafe { CloseServiceHandle(self.0) };
        }
    }

    /// Bytes with 8-byte alignment, for calls that fill a buffer with structs holding pointers.
    struct Buf(Vec<u64>);

    impl Buf {
        fn new(bytes: usize) -> Self {
            Buf(vec![0u64; bytes.div_ceil(8).max(1)])
        }

        fn len(&self) -> usize {
            self.0.len() * 8
        }

        fn bytes(&mut self) -> &mut [u8] {
            let len = self.len();
            unsafe { std::slice::from_raw_parts_mut(self.0.as_mut_ptr().cast::<u8>(), len) }
        }

        fn as_ptr<T>(&self) -> *const T {
            self.0.as_ptr().cast()
        }

        fn as_mut_ptr<T>(&mut self) -> *mut T {
            self.0.as_mut_ptr().cast()
        }
    }

    fn text(p: PWSTR) -> String {
        if p.is_null() { String::new() } else { String::from_utf16_lossy(unsafe { p.as_wide() }) }
    }

    /// Strings of a double-NUL-terminated list.
    fn multi_sz(p: PWSTR) -> Vec<String> {
        if p.is_null() {
            return Vec::new();
        }
        let mut len = 0;
        unsafe {
            while !(*p.0.add(len) == 0 && (len == 0 || *p.0.add(len - 1) == 0)) {
                len += 1;
            }
            split_multi_sz(std::slice::from_raw_parts(p.0, len))
        }
    }

    /// Resolves `@file.dll,-123` resource references to the text in the user's language.
    fn resolve(s: String) -> String {
        if !s.starts_with('@') {
            return s;
        }
        let source = os::wide(std::ffi::OsStr::new(&s));
        let mut out = vec![0u16; 1024];
        match unsafe { SHLoadIndirectString(PCWSTR(source.as_ptr()), &mut out, None) } {
            Ok(()) => {
                let len = out.iter().position(|&c| c == 0).unwrap_or(out.len());
                String::from_utf16_lossy(&out[..len])
            }
            Err(_) => s,
        }
    }

    fn win32_code(e: &windows::core::Error) -> WIN32_ERROR {
        let hr = e.code().0 as u32;
        WIN32_ERROR(if hr & 0xFFFF_0000 == 0x8007_0000 { hr & 0xFFFF } else { hr })
    }

    #[derive(Clone, Copy)]
    enum Op {
        Read,
        Start,
        Stop,
        Change,
    }

    /// A plain-language message for a failed service call.
    fn explain(display: &str, op: Op, e: &windows::core::Error) -> String {
        let (verb, done) = match op {
            Op::Read => ("read", "read"),
            Op::Start => ("start", "started"),
            Op::Stop => ("stop", "stopped"),
            Op::Change => ("change", "changed"),
        };
        match win32_code(e) {
            ERROR_ACCESS_DENIED if os::is_elevated() => format!("Windows protects {display}, so it can't be {done}, even as administrator."),
            ERROR_ACCESS_DENIED => ADMIN_NEEDED.into(),
            ERROR_SERVICE_DISABLED => format!("{display} is disabled, so it can't start. Set its startup type to Manual or Automatic first."),
            ERROR_SERVICE_DOES_NOT_EXIST => "This service no longer exists. It may have been uninstalled, so refresh the list.".into(),
            ERROR_SERVICE_MARKED_FOR_DELETE => format!("{display} is being removed. Restart your PC to finish removing it."),
            ERROR_SERVICE_CANNOT_ACCEPT_CTRL => format!("{display} is busy starting or stopping. Try again in a moment."),
            ERROR_INVALID_SERVICE_CONTROL => format!("Windows doesn't let {display} be {done} right now."),
            ERROR_DEPENDENT_SERVICES_RUNNING => format!("Other services that need {display} are still running. Stop them first."),
            ERROR_SERVICE_DEPENDENCY_FAIL | ERROR_SERVICE_DEPENDENCY_DELETED => {
                format!("{display} needs another service that couldn't start. Its details list the services it needs.")
            }
            ERROR_SERVICE_REQUEST_TIMEOUT => format!("{display} didn't respond in time. Restarting your PC usually fixes this."),
            ERROR_SERVICE_LOGON_FAILED => format!("{display} couldn't sign in with its account, so it can't start."),
            ERROR_SERVICE_DATABASE_LOCKED => "Windows is busy changing services. Try again in a moment.".into(),
            _ => format!("Couldn't {verb} {display}: {}", e.message().trim()),
        }
    }

    fn open_scm() -> Result<Handle, String> {
        unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT | SC_MANAGER_ENUMERATE_SERVICE) }
            .map(Handle)
            .map_err(|e| format!("Couldn't read the list of services: {}", e.message().trim()))
    }

    fn open_service(scm: &Handle, name: &str, access: u32) -> windows::core::Result<Handle> {
        let wide = os::wide(std::ffi::OsStr::new(name));
        unsafe { OpenServiceW(scm.0, PCWSTR(wide.as_ptr()), access) }.map(Handle)
    }

    fn query_status(svc: &Handle) -> windows::core::Result<SERVICE_STATUS_PROCESS> {
        let mut buf = Buf::new(size_of::<SERVICE_STATUS_PROCESS>());
        let mut needed = 0u32;
        unsafe { QueryServiceStatusEx(svc.0, SC_STATUS_PROCESS_INFO, Some(buf.bytes()), &mut needed) }?;
        Ok(unsafe { *buf.as_ptr::<SERVICE_STATUS_PROCESS>() })
    }

    struct Config {
        service_type: u32,
        start: u32,
        command_line: String,
        account: String,
        display_name: String,
        dependencies: Vec<String>,
    }

    fn query_config(svc: &Handle) -> windows::core::Result<Config> {
        let mut needed = 0u32;
        let _ = unsafe { QueryServiceConfigW(svc.0, None, 0, &mut needed) };
        let mut buf = Buf::new((needed as usize).max(size_of::<QUERY_SERVICE_CONFIGW>()));
        let len = buf.len() as u32;
        unsafe { QueryServiceConfigW(svc.0, Some(buf.as_mut_ptr()), len, &mut needed) }?;
        let c = unsafe { &*buf.as_ptr::<QUERY_SERVICE_CONFIGW>() };
        Ok(Config {
            service_type: c.dwServiceType.0,
            start: c.dwStartType.0,
            command_line: text(c.lpBinaryPathName),
            account: text(c.lpServiceStartName),
            display_name: resolve(text(c.lpDisplayName)),
            dependencies: multi_sz(c.lpDependencies),
        })
    }

    fn query_description(svc: &Handle) -> Option<String> {
        let mut needed = 0u32;
        let _ = unsafe { QueryServiceConfig2W(svc.0, SERVICE_CONFIG_DESCRIPTION, None, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buf = Buf::new(needed as usize);
        unsafe { QueryServiceConfig2W(svc.0, SERVICE_CONFIG_DESCRIPTION, Some(buf.bytes()), &mut needed) }.ok()?;
        let d = unsafe { &*buf.as_ptr::<SERVICE_DESCRIPTIONW>() };
        let s = resolve(text(d.lpDescription).trim().to_string());
        (!s.is_empty()).then_some(s)
    }

    fn query_delayed(svc: &Handle) -> bool {
        let mut buf = Buf::new(size_of::<SERVICE_DELAYED_AUTO_START_INFO>());
        let mut needed = 0u32;
        unsafe { QueryServiceConfig2W(svc.0, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, Some(buf.bytes()), &mut needed) }.is_ok()
            && unsafe { (*buf.as_ptr::<SERVICE_DELAYED_AUTO_START_INFO>()).fDelayedAutostart.as_bool() }
    }

    fn env(name: &str) -> Option<String> {
        if name.eq_ignore_ascii_case("SystemRoot") || name.eq_ignore_ascii_case("windir") {
            return Some(windir());
        }
        std::env::var(name).ok()
    }

    fn windir() -> String {
        os::windows_dir().to_string_lossy().into_owned()
    }

    /// The DLL a svchost.exe-hosted service lives in, from its registry settings.
    fn service_dll(name: &str) -> Option<String> {
        let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(format!(r"SYSTEM\CurrentControlSet\Services\{name}"), KEY_READ).ok()?;
        let raw: String = key
            .open_subkey_with_flags("Parameters", KEY_READ)
            .ok()
            .and_then(|p| p.get_value("ServiceDll").ok())
            .or_else(|| key.get_value("ServiceDll").ok())?;
        let path = super::expand_env(raw.trim(), &env);
        (!path.is_empty()).then_some(path)
    }

    /// Company names by file path, read once per session (version resources rarely change).
    static COMPANIES: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);

    fn company(path: &str) -> Option<String> {
        let key = path.to_lowercase();
        if let Some(known) = COMPANIES.lock().get(&key) {
            return known.clone();
        }
        let company = read_company(path);
        COMPANIES.lock().insert(key, company.clone());
        company
    }

    /// CompanyName from a file's version information, in its own language if it has several.
    fn read_company(path: &str) -> Option<String> {
        let wide = os::wide(std::ffi::OsStr::new(path));
        let file = PCWSTR(wide.as_ptr());
        let size = unsafe { GetFileVersionInfoSizeW(file, None) };
        if size == 0 {
            return None;
        }
        let mut data = Buf::new(size as usize);
        unsafe { GetFileVersionInfoW(file, None, size, data.as_mut_ptr::<c_void>()) }.ok()?;
        let block = data.as_ptr::<c_void>();
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let mut tables = Vec::new();
        if unsafe { VerQueryValueW(block, w!("\\VarFileInfo\\Translation"), &mut ptr, &mut len) }.as_bool() && !ptr.is_null() {
            let pairs = unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize / 2) };
            tables.extend(pairs.chunks_exact(2).map(|p| format!("{:04x}{:04x}", p[0], p[1])));
        }
        tables.extend(["040904b0", "040904e4", "04090000"].map(String::from));
        for table in tables {
            let query = os::wide(std::ffi::OsStr::new(&format!("\\StringFileInfo\\{table}\\CompanyName")));
            let found = unsafe { VerQueryValueW(block, PCWSTR(query.as_ptr()), &mut ptr, &mut len) }.as_bool();
            if found && !ptr.is_null() && len > 0 {
                let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize) });
                let value = value.trim_end_matches('\0').trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    /// Reads everything about one service. Parts Windows won't share are left empty.
    fn read(scm: &Handle, name: String, display_name: String, status: SERVICE_STATUS_PROCESS) -> ServiceInfo {
        let windir = windir();
        let mut raw = Raw {
            state: status.dwCurrentState.0,
            controls_accepted: status.dwControlsAccepted,
            pid: status.dwProcessId,
            service_type: status.dwServiceType.0,
            ..Default::default()
        };
        if let Ok(svc) = open_service(scm, &name, SERVICE_QUERY_CONFIG) {
            if let Ok(config) = query_config(&svc) {
                let image = image_path(&config.command_line, &windir, &env);
                let program = match &image {
                    Some(image) if file_name(image).eq_ignore_ascii_case("svchost.exe") => {
                        let template = super::template_of(&name, config.service_type);
                        service_dll(&name).or_else(|| template.as_deref().and_then(service_dll)).or_else(|| Some(image.clone()))
                    }
                    _ => image,
                };
                raw.company = program.as_deref().and_then(company);
                raw.program = program;
                raw.service_type = config.service_type;
                raw.start = Some(config.start);
                raw.delayed = config.start == SERVICE_AUTO_START.0 && query_delayed(&svc);
                raw.command_line = (!config.command_line.is_empty()).then_some(config.command_line);
                raw.account = (!config.account.is_empty()).then_some(config.account);
                raw.dependencies = config.dependencies;
            }
            raw.description = query_description(&svc);
        }
        raw.name = name;
        raw.display_name = if display_name.is_empty() { raw.name.clone() } else { resolve(display_name) };
        assemble(raw, &windir)
    }

    pub fn list() -> Result<Vec<ServiceInfo>, String> {
        let scm = open_scm()?;
        let mut found = Vec::new();
        let mut resume = 0u32;
        let mut buf = Buf::new(64 * 1024);
        // Each round returns what fits and resumes from there; the cap only guards against a loop.
        for _ in 0..64 {
            let (mut needed, mut returned) = (0u32, 0u32);
            let result = unsafe {
                EnumServicesStatusExW(
                    scm.0,
                    SC_ENUM_PROCESS_INFO,
                    SERVICE_WIN32,
                    SERVICE_STATE_ALL,
                    Some(buf.bytes()),
                    &mut needed,
                    &mut returned,
                    Some(&mut resume as *mut u32),
                    PCWSTR::null(),
                )
            };
            let entries = buf.as_ptr::<ENUM_SERVICE_STATUS_PROCESSW>();
            for i in 0..returned as usize {
                let e = unsafe { &*entries.add(i) };
                found.push((text(e.lpServiceName), text(e.lpDisplayName), e.ServiceStatusProcess));
            }
            match result {
                Ok(()) => return Ok(found.into_iter().map(|(name, display, status)| read(&scm, name, display, status)).collect()),
                Err(e) if win32_code(&e) == ERROR_MORE_DATA => {
                    if needed as usize > buf.len() {
                        buf = Buf::new(needed as usize);
                    }
                }
                Err(e) => return Err(format!("Couldn't read the list of services: {}", e.message().trim())),
            }
        }
        Err("Couldn't read the list of services: Windows kept changing it. Try again.".into())
    }

    pub fn get(name: &str) -> Result<ServiceInfo, String> {
        let scm = open_scm()?;
        let svc = open_service(&scm, name, SERVICE_QUERY_STATUS).map_err(|e| explain(name, Op::Read, &e))?;
        let status = query_status(&svc).map_err(|e| explain(name, Op::Read, &e))?;
        let display = open_service(&scm, name, SERVICE_QUERY_CONFIG)
            .ok()
            .and_then(|s| query_config(&s).ok())
            .map(|c| c.display_name)
            .unwrap_or_default();
        Ok(read(&scm, name.to_string(), display, status))
    }

    /// Services that depend on `svc`, in the order they should be stopped.
    fn dependents(svc: &Handle, state: ENUM_SERVICE_STATE) -> Vec<(String, String, ServiceStatus)> {
        let (mut needed, mut count) = (0u32, 0u32);
        if unsafe { EnumDependentServicesW(svc.0, state, None, 0, &mut needed, &mut count) }.is_ok() || needed == 0 {
            return Vec::new();
        }
        let mut buf = Buf::new(needed as usize);
        let len = buf.len() as u32;
        if unsafe { EnumDependentServicesW(svc.0, state, Some(buf.as_mut_ptr::<ENUM_SERVICE_STATUSW>()), len, &mut needed, &mut count) }.is_err() {
            return Vec::new();
        }
        let entries = buf.as_ptr::<ENUM_SERVICE_STATUSW>();
        (0..count as usize)
            .map(|i| {
                let e = unsafe { &*entries.add(i) };
                (text(e.lpServiceName), resolve(text(e.lpDisplayName)), status_from(e.ServiceStatus.dwCurrentState.0))
            })
            .collect()
    }

    pub fn details(name: &str) -> Result<ServiceDetails, String> {
        let scm = open_scm()?;
        let svc = open_service(&scm, name, SERVICE_QUERY_CONFIG | SERVICE_ENUMERATE_DEPENDENTS)
            .or_else(|_| open_service(&scm, name, SERVICE_QUERY_CONFIG))
            .map_err(|e| explain(name, Op::Read, &e))?;
        let config = query_config(&svc).map_err(|e| explain(name, Op::Read, &e))?;
        let dependencies = config
            .dependencies
            .into_iter()
            .map(|dep| match dep.strip_prefix('+') {
                Some(group) => ServiceLink { name: group.to_string(), display_name: group.to_string(), status: None, group: true },
                None => {
                    let other = open_service(&scm, &dep, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS).ok();
                    let status = other.as_ref().and_then(|s| query_status(s).ok()).map(|s| status_from(s.dwCurrentState.0));
                    let display = other.as_ref().and_then(|s| query_config(s).ok()).map(|c| c.display_name).filter(|d| !d.is_empty());
                    ServiceLink { display_name: display.unwrap_or_else(|| dep.clone()), name: dep, status, group: false }
                }
            })
            .collect();
        let dependents = dependents(&svc, SERVICE_STATE_ALL)
            .into_iter()
            .map(|(name, display_name, status)| ServiceLink { name, display_name, status: Some(status), group: false })
            .collect();
        Ok(ServiceDetails { dependencies, dependents })
    }

    enum WaitEnd {
        Reached,
        TimedOut,
        /// Asked to start, it stopped again without an error: nothing needed it right now.
        StoppedItself,
    }

    /// Polls until the service reaches `target` or the time limit runs out.
    fn wait_for(svc: &Handle, display: &str, target: SERVICE_STATUS_CURRENT_STATE) -> Result<WaitEnd, String> {
        let deadline = Instant::now() + WAIT_LIMIT;
        loop {
            let status = query_status(svc).map_err(|e| explain(display, Op::Read, &e))?;
            if status.dwCurrentState == target {
                return Ok(WaitEnd::Reached);
            }
            if target == SERVICE_RUNNING && status.dwCurrentState == SERVICE_STOPPED {
                return if status.dwWin32ExitCode == 0 { Ok(WaitEnd::StoppedItself) } else { Err(start_failure(display, &status)) };
            }
            if Instant::now() >= deadline {
                return Ok(WaitEnd::TimedOut);
            }
            // Windows suggests a tenth of the service's own wait hint, within reason.
            let pause = (status.dwWaitHint / 10).clamp(150, 1000);
            std::thread::sleep(Duration::from_millis(pause as u64));
        }
    }

    fn start_failure(display: &str, status: &SERVICE_STATUS_PROCESS) -> String {
        let code = status.dwWin32ExitCode;
        let reason = if code == ERROR_SERVICE_SPECIFIC_ERROR.0 {
            format!(" (The service reported error {}.)", status.dwServiceSpecificExitCode)
        } else {
            format!(" Windows says: {}", windows::core::Error::from_hresult(HRESULT::from_win32(code)).message().trim())
        };
        format!("{display} stopped right after it started. The program behind it may be damaged or missing something it needs.{reason}")
    }

    fn start_handle(svc: &Handle, display: &str) -> Result<Outcome, String> {
        match unsafe { StartServiceW(svc.0, None) } {
            Ok(()) => {}
            Err(e) if win32_code(&e) == ERROR_SERVICE_ALREADY_RUNNING => return Ok(Outcome::default()),
            Err(e) => return Err(explain(display, Op::Start, &e)),
        }
        let end = wait_for(svc, display, SERVICE_RUNNING)?;
        Ok(Outcome {
            changed: true,
            timed_out: matches!(end, WaitEnd::TimedOut),
            stopped_itself: matches!(end, WaitEnd::StoppedItself),
            ..Default::default()
        })
    }

    pub fn start(name: &str, display: &str) -> Result<Outcome, String> {
        let scm = open_scm()?;
        let svc = open_service(&scm, name, SERVICE_START | SERVICE_QUERY_STATUS).map_err(|e| explain(display, Op::Start, &e))?;
        start_handle(&svc, display)
    }

    fn stop_handle(svc: &Handle, display: &str) -> Result<Outcome, String> {
        let current = query_status(svc).map_err(|e| explain(display, Op::Read, &e))?.dwCurrentState;
        if current == SERVICE_STOPPED {
            return Ok(Outcome::default());
        }
        if current != SERVICE_STOP_PENDING {
            let mut status = SERVICE_STATUS::default();
            match unsafe { ControlService(svc.0, SERVICE_CONTROL_STOP, &mut status) } {
                Ok(()) => {}
                Err(e) if win32_code(&e) == ERROR_SERVICE_NOT_ACTIVE => return Ok(Outcome::default()),
                Err(e) => return Err(explain(display, Op::Stop, &e)),
            }
        }
        let end = wait_for(svc, display, SERVICE_STOPPED)?;
        Ok(Outcome { changed: true, timed_out: matches!(end, WaitEnd::TimedOut), ..Default::default() })
    }

    /// Stops a service after the running services that need it (Windows refuses otherwise).
    pub fn stop(name: &str, display: &str) -> Result<Outcome, String> {
        let scm = open_scm()?;
        let svc = open_service(&scm, name, SERVICE_STOP | SERVICE_QUERY_STATUS | SERVICE_ENUMERATE_DEPENDENTS)
            .map_err(|e| explain(display, Op::Stop, &e))?;
        // Listed in the order they have to stop.
        let running = dependents(&svc, SERVICE_ACTIVE);
        if let Some((_, dep_display, _)) = running.iter().find(|(dep, _, _)| super::known(dep).is_some_and(|k| k.1 == super::Safety::Protected)) {
            return Err(format!("Stopping {display} would also stop {dep_display}, which Windows needs, so Ultimate PC Tool won't do it."));
        }
        let mut stopped = Vec::new();
        let mut also = Vec::new();
        for (dep, dep_display, _) in &running {
            let other = open_service(&scm, dep, SERVICE_STOP | SERVICE_QUERY_STATUS).map_err(|e| explain(dep_display, Op::Stop, &e))?;
            if stop_handle(&other, dep_display)?.timed_out {
                return Err(format!("{dep_display} needs {display} and is taking too long to stop, so {display} was left running. Try again in a moment."));
            }
            stopped.push(dep.clone());
            also.push(dep_display.clone());
        }
        let mut outcome = stop_handle(&svc, display)?;
        outcome.changed |= !also.is_empty();
        outcome.also = also;
        outcome.stopped_dependents = stopped;
        Ok(outcome)
    }

    fn set_delayed(svc: &Handle, delayed: bool) -> windows::core::Result<()> {
        let info = SERVICE_DELAYED_AUTO_START_INFO { fDelayedAutostart: BOOL::from(delayed) };
        unsafe { ChangeServiceConfig2W(svc.0, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, Some((&info as *const SERVICE_DELAYED_AUTO_START_INFO).cast())) }
    }

    pub fn set_startup(name: &str, display: &str, startup: StartupType) -> Result<(), String> {
        let scm = open_scm()?;
        let svc = open_service(&scm, name, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_CONFIG).map_err(|e| explain(display, Op::Change, &e))?;
        let (start, delayed) = match startup {
            StartupType::Automatic => (SERVICE_AUTO_START, false),
            StartupType::AutomaticDelayed => (SERVICE_AUTO_START, true),
            StartupType::Manual => (SERVICE_DEMAND_START, false),
            StartupType::Disabled => (SERVICE_DISABLED, false),
        };
        // Cleared while the service is still automatic: only automatic services accept the flag.
        if !delayed {
            let _ = set_delayed(&svc, false);
        }
        unsafe {
            ChangeServiceConfigW(
                svc.0,
                ENUM_SERVICE_TYPE(SERVICE_NO_CHANGE),
                start,
                SERVICE_ERROR(SERVICE_NO_CHANGE),
                PCWSTR::null(),
                PCWSTR::null(),
                None,
                PCWSTR::null(),
                PCWSTR::null(),
                PCWSTR::null(),
                PCWSTR::null(),
            )
        }
        .map_err(|e| explain(display, Op::Change, &e))?;
        if delayed {
            set_delayed(&svc, true).map_err(|e| explain(display, Op::Change, &e))?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Outcome, ServiceDetails, ServiceInfo, StartupType};

    const ONLY_WINDOWS: &str = "Services can only be managed on Windows";

    pub fn list() -> Result<Vec<ServiceInfo>, String> {
        Ok(Vec::new())
    }

    pub fn get(_name: &str) -> Result<ServiceInfo, String> {
        Err(ONLY_WINDOWS.into())
    }

    pub fn details(_name: &str) -> Result<ServiceDetails, String> {
        Err(ONLY_WINDOWS.into())
    }

    pub fn start(_name: &str, _display: &str) -> Result<Outcome, String> {
        Err(ONLY_WINDOWS.into())
    }

    pub fn stop(_name: &str, _display: &str) -> Result<Outcome, String> {
        Err(ONLY_WINDOWS.into())
    }

    pub fn set_startup(_name: &str, _display: &str, _startup: StartupType) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDIR: &str = r"C:\Windows";

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_lowercase().as_str() {
            "systemroot" | "windir" => Some(WINDIR.into()),
            "programfiles" => Some(r"C:\Program Files".into()),
            _ => None,
        }
    }

    fn image(command: &str) -> Option<String> {
        image_path(command, WINDIR, &env)
    }

    #[test]
    fn finds_the_program_in_service_command_lines() {
        assert_eq!(image(r#""C:\Program Files\App\svc.exe" -run"#).as_deref(), Some(r"C:\Program Files\App\svc.exe"));
        assert_eq!(image(r"C:\Program Files\App Folder\svc.exe -run --flag").as_deref(), Some(r"C:\Program Files\App Folder\svc.exe"));
        assert_eq!(image(r"%SystemRoot%\System32\svchost.exe -k netsvcs -p").as_deref(), Some(r"C:\Windows\System32\svchost.exe"));
        assert_eq!(image(r"%ProgramFiles%\Tool\tool.exe").as_deref(), Some(r"C:\Program Files\Tool\tool.exe"));
        assert_eq!(image(r"\SystemRoot\System32\drivers\x.sys").as_deref(), Some(r"C:\Windows\System32\drivers\x.sys"));
        assert_eq!(image(r"system32\drivers\y.sys").as_deref(), Some(r"C:\Windows\system32\drivers\y.sys"));
        assert_eq!(image(r"\??\C:\Tools\z.exe").as_deref(), Some(r"C:\Tools\z.exe"));
        // ".exe" in the middle of a folder name doesn't end the path.
        assert_eq!(image(r"C:\a.exe.d\b.exe /s").as_deref(), Some(r"C:\a.exe.d\b.exe"));
        assert_eq!(image(r"C:\Tools\run.bat arg").as_deref(), Some(r"C:\Tools\run.bat"));
        assert_eq!(image("   "), None);
    }

    #[test]
    fn expands_known_variables_only() {
        assert_eq!(expand_env(r"%windir%\x", &env), r"C:\Windows\x");
        assert_eq!(expand_env(r"%NOPE%\x", &env), r"%NOPE%\x");
        assert_eq!(expand_env("100% sure", &env), "100% sure");
        assert_eq!(expand_env("%%", &env), "%%");
    }

    #[test]
    fn splits_dependency_lists() {
        let units: Vec<u16> = "RpcSs\0+TDI\0nsi".encode_utf16().collect();
        assert_eq!(split_multi_sz(&units), ["RpcSs", "+TDI", "nsi"]);
        assert!(split_multi_sz(&[]).is_empty());
    }

    #[test]
    fn maps_status_and_startup_values() {
        assert_eq!(status_from(4), ServiceStatus::Running);
        assert_eq!(status_from(1), ServiceStatus::Stopped);
        assert_eq!(status_from(3), ServiceStatus::Stopping);
        assert_eq!(startup_from(2, false), Some(StartupType::Automatic));
        assert_eq!(startup_from(2, true), Some(StartupType::AutomaticDelayed));
        assert_eq!(startup_from(3, true), Some(StartupType::Manual));
        assert_eq!(startup_from(4, false), Some(StartupType::Disabled));
        assert_eq!(startup_from(9, false), None);
    }

    #[test]
    fn recognises_per_user_copies() {
        assert_eq!(template_of("CDPUserSvc_4f2a1", 0xE0).as_deref(), Some("CDPUserSvc"));
        assert_eq!(template_of("CDPUserSvc", 0x60), None);
        assert_eq!(template_of("Spooler", 0x10), None);
    }

    #[test]
    fn tells_microsoft_from_other_companies() {
        assert_eq!(classify(Some(r"C:\Windows\System32\svchost.exe"), None, WINDIR), Publisher::Microsoft);
        assert_eq!(classify(Some(r"C:\Windows\System32\DriverStore\FileRepository\x\svc.exe"), None, WINDIR), Publisher::ThirdParty);
        assert_eq!(classify(Some(r"C:\Program Files\Vendor\svc.exe"), None, WINDIR), Publisher::ThirdParty);
        assert_eq!(classify(Some(r"C:\Program Files\Vendor\svc.exe"), Some("Microsoft Corporation"), WINDIR), Publisher::Microsoft);
        assert_eq!(classify(Some(r"C:\Windows\System32\amdsvc.exe"), Some("Advanced Micro Devices, Inc."), WINDIR), Publisher::ThirdParty);
        assert_eq!(classify(None, None, WINDIR), Publisher::Unknown);
    }

    fn service(name: &str, state: u32, start: u32) -> ServiceInfo {
        assemble(
            Raw {
                name: name.into(),
                display_name: format!("{name} display"),
                state,
                controls_accepted: 1,
                service_type: 0x20,
                start: Some(start),
                ..Default::default()
            },
            WINDIR,
        )
    }

    #[test]
    fn protects_critical_services() {
        let rpc = service("rpcss", 4, 2);
        assert_eq!(rpc.safety, Safety::Protected);
        assert!(rpc.summary.is_some());
        assert!(check_action(&rpc, ServiceAction::Stop).is_err());
        assert!(check_action(&rpc, ServiceAction::Restart).is_err());
        assert!(check_startup(&rpc, StartupType::Disabled, false).is_err());
        assert!(check_startup(&rpc, StartupType::Manual, false).is_err());
        assert!(check_startup(&rpc, StartupType::Disabled, true).is_err());
        // Undo may put it back the way it was, just never disable it.
        assert!(check_startup(&rpc, StartupType::Manual, true).is_ok());

        let manual = service("PlugPlay", 4, 3);
        assert!(check_startup(&manual, StartupType::Automatic, false).is_ok());

        let spooler = service("Spooler", 4, 2);
        assert_eq!(spooler.safety, Safety::Important);
        assert!(spooler.safety_note.is_some());
        assert!(check_action(&spooler, ServiceAction::Stop).is_ok());
        assert!(check_startup(&spooler, StartupType::Disabled, false).is_ok());
    }

    #[test]
    fn checks_state_before_acting() {
        let disabled = service("Fax", 1, 4);
        assert!(check_action(&disabled, ServiceAction::Start).is_err());
        assert!(check_action(&disabled, ServiceAction::Restart).is_err());
        let mut stuck = service("Fax", 4, 3);
        stuck.can_stop = false;
        assert!(check_action(&stuck, ServiceAction::Stop).is_err());
        let copy = assemble(Raw { name: "CDPUserSvc_4f2a1".into(), display_name: "x".into(), service_type: 0xE0, start: Some(2), ..Default::default() }, WINDIR);
        assert_eq!(copy.template.as_deref(), Some("CDPUserSvc"));
        assert!(check_startup(&copy, StartupType::Manual, false).is_err());
    }

    #[test]
    fn known_service_names_are_unique() {
        let mut names: Vec<String> = KNOWN.iter().map(|k| k.0.to_lowercase()).collect();
        names.sort();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count);
    }
}
