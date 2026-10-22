// Fake Tauri backend for running the UI in a plain browser (see dev/README.md).
// `window.__mock` exposes a few hooks for tests, e.g. `__mock.emit("app://close-requested")`.
window.__TAURI_INTERNALS__ = (() => {
  let cb = 0;
  const cbs = {};
  const listeners = {};
  const calls = [];
  const GB = 1024 ** 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const emit = (event, payload) => (listeners[event] || []).forEach((h) => cbs[h] && cbs[h]({ event, payload }));
  // Channels arrive as the real `Channel` object; messages go through its callback with an index.
  const send = (ch, message) => {
    if (!ch || !cbs[ch.id]) return;
    ch.__next = ch.__next ?? 0;
    cbs[ch.id]({ index: ch.__next++, message });
  };
  const fail = (msg) => {
    throw msg;
  };

  // ---- Processes ----
  const START = 1760000000;
  let nextPid = 2000;
  const proc = (name, extra = {}) => ({
    pid: extra.pid ?? nextPid++,
    parentPid: 900,
    name,
    cpu: Math.random() * 6,
    memory: Math.random() * 500e6,
    ioRead: Math.random() * 1e5,
    ioWrite: Math.random() * 2e4,
    exe: `C:\\Program Files\\${name.replace(".exe", "")}\\${name}`,
    startTime: START + Math.floor(Math.random() * 5000),
    protected: null,
    warning: null,
    isSelf: false,
    ...extra,
  });
  const core = (name) =>
    `${name} is a core part of Windows. Ending it could crash your PC, sign you out or break the desktop, so Ultimate PC Tool won't do it.`;
  const selfMsg = "That's part of Ultimate PC Tool. Use Quit in the tray menu to close it.";
  let procs = [
    proc("System", { pid: 4, parentPid: 0, exe: null, protected: core("System"), memory: 2e6 }),
    proc("csrss.exe", { pid: 600, exe: null, protected: core("csrss.exe") }),
    proc("winlogon.exe", { pid: 700, exe: "C:\\Windows\\System32\\winlogon.exe", protected: core("winlogon.exe") }),
    ...Array.from({ length: 6 }, () => proc("svchost.exe", { exe: "C:\\Windows\\System32\\svchost.exe", protected: core("svchost.exe") })),
    proc("explorer.exe", {
      exe: "C:\\Windows\\explorer.exe",
      warning: "Your taskbar, desktop and File Explorer windows will close. Windows usually starts them again within a few seconds.",
    }),
    proc("ultimate-pc-tool.exe", { pid: 5000, isSelf: true, protected: selfMsg, exe: "C:\\Users\\me\\AppData\\Local\\Ultimate PC Tool\\ultimate-pc-tool.exe" }),
    proc("msedgewebview2.exe", { pid: 5001, parentPid: 5000, isSelf: true, protected: selfMsg }),
    proc("msedgewebview2.exe", { pid: 5002, parentPid: 5001, isSelf: true, protected: selfMsg }),
    proc("msedgewebview2.exe", { warning: "Teams, Outlook, Widgets and other apps use this. They may stop working until you restart them." }),
    proc("chrome.exe", { pid: 3000 }),
    ...Array.from({ length: 7 }, () => proc("chrome.exe", { parentPid: 3000 })),
    proc("Code.exe"),
    proc("Code.exe"),
    proc("Discord.exe"),
    proc("steam.exe"),
    proc("notepad.exe"),
  ];
  const priorities = {};

  // ---- Commands ----
  const builtin = (id, name, description, command, admin, category, extra = {}) => ({
    id: `builtin.${id}`,
    name,
    description,
    command,
    shell: "powershell",
    admin,
    category,
    risk: "safe",
    warning: null,
    ...extra,
  });
  const defaults = () => [
    builtin("flush-dns", "Flush DNS", "Fixes websites that won't load or open the wrong page, by clearing saved web addresses.", "ipconfig /flushdns", false, "Network"),
    builtin("ping", "Ping a host", "Checks whether a website or device answers, and how fast.", "ping -n 4 {host}", false, "Network"),
    builtin("reset-network", "Reset network stack", "Fixes stubborn internet problems by resetting network settings. Restart afterwards.", "netsh winsock reset; netsh int ip reset", true, "Network", {
      risk: "danger",
      warning: "Resets all network settings, including any static IP address or DNS server you set, and can remove VPN network parts. Restart the PC afterwards.",
    }),
    builtin("restart-explorer", "Restart Explorer", "Fixes a frozen taskbar, Start menu or desktop.", "Stop-Process -Name explorer -Force; Start-Process explorer", false, "System", {
      risk: "caution",
      warning: "Closes every File Explorer window and briefly hides the taskbar and desktop. File copies in progress are cancelled.",
    }),
    builtin("sfc", "Check system files", "Finds and repairs damaged Windows files. Takes 10 to 20 minutes.", "sfc /scannow", true, "Repair"),
    builtin("drive-health", "Drive health", "Shows whether your drives report any health problems.", "Get-PhysicalDisk | Format-Table FriendlyName, MediaType, HealthStatus, Size -AutoSize", false, "System"),
    builtin("list-updates", "List app updates", "Shows which of your apps have updates waiting (slow in the mock).", "winget upgrade --accept-source-agreements", false, "Apps"),
  ];
  let commands = [
    ...defaults(),
    { id: "u1", name: "Endless ping", description: "Runs until stopped", command: "ping -t 8.8.8.8", shell: "cmd", admin: false, category: "My commands", risk: "safe", warning: null },
  ];
  const cancelled = new Set();

  // ---- Terminal ----
  const sessions = {};
  let nextTerm = 1;
  const prompt = (shell) => (shell === "cmd" ? "C:\\Users\\abokhalid>" : shell === "wsl" ? "me@pc:~$ " : "PS C:\\Users\\abokhalid> ");

  // ---- Activity ----
  let activity = [
    { id: "a1", timestamp: new Date().toISOString(), category: "Startup", description: 'Disabled startup app "Spotify"', detail: null, undo: { type: "startupToggle", source: "userRun", name: "Spotify", enabled: true }, undone: false },
    { id: "a2", timestamp: new Date().toISOString(), category: "Startup", description: 'Disabled startup app "SecurityHealth"', detail: null, undo: { type: "startupToggle", source: "machineRun", name: "SecurityHealth", enabled: true }, undone: false },
    { id: "a3", timestamp: new Date().toISOString(), category: "Commands", description: 'Ran "Flush DNS"', detail: "PowerShell: ipconfig /flushdns", undo: null, undone: false },
    { id: "a4", timestamp: new Date().toISOString(), category: "Services", description: 'Set service "Fax" to Manual (was Automatic)', detail: "Service name: Fax", undo: { type: "serviceStartup", name: "Fax", displayName: "Fax", startup: "automatic" }, undone: false },
  ];
  const record = (category, description, detail = null, undo = null) => {
    const id = `act-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activity.unshift({ id, timestamp: new Date().toISOString(), category, description, detail, undo, undone: false });
    return id;
  };

  const metrics = () => ({ timestampMs: Date.now(), cpuName: "AMD Ryzen 7 7800X3D", cpuTotal: 20 + Math.random() * 30, cpuPerCore: Array.from({ length: 16 }, () => Math.random() * 100), cpuFreqMhz: 4200, memUsed: 14.2 * GB, memTotal: 32 * GB, swapUsed: 1 * GB, swapTotal: 4 * GB, netRxBps: Math.random() * 3e6, netTxBps: Math.random() * 4e5, diskReadBps: Math.random() * 2e7, diskWriteBps: Math.random() * 5e6, disks: [{ name: "Samsung 990 Pro", mount: "C:\\", fileSystem: "NTFS", totalBytes: 1000 * GB, availableBytes: 380 * GB, removable: false }, { name: "Data", mount: "D:\\", fileSystem: "NTFS", totalBytes: 2000 * GB, availableBytes: 90 * GB, removable: false }], temps: [{ label: "CPU Package", celsius: 61 }, { label: "GPU", celsius: 54 }], processCount: procs.length, uptimeSecs: 93784 });
  const startup = [
    { name: "Discord", command: "C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe", source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "SecurityHealth", command: "%windir%\\system32\\SecurityHealthSystray.exe", source: "machineRun", location: "Registry (all users)", enabled: true, needsAdmin: true },
    { name: "Spotify", command: '"C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe" /minimized', source: "userRun", location: "Registry (current user)", enabled: false, needsAdmin: false },
    { name: "OneDrive", command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "Steam", command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "RtkAudUService", command: '"C:\\Windows\\System32\\DriverStore\\FileRepository\\realtekservice.inf_amd64\\RtkAudUService64.exe" -background', source: "machineRun", location: "Registry (all users)", enabled: true, needsAdmin: true },
    { name: "Notes.lnk", command: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Notes.lnk", source: "userFolder", location: "Startup folder (current user)", enabled: true, needsAdmin: false },
  ];
  const settings = { closeAction: null };

  // ---- Services ----
  // Mirrors src-tauri/src/services.rs: protected services can't be stopped or disabled, changes
  // need administrator rights (`__MOCK_ELEVATED__`), and stop/start take a moment.
  const SVC_ADMIN = "Changing services needs administrator rights. Use Restart as administrator, then try again.";
  const svchost = (group) => `C:\\Windows\\system32\\svchost.exe -k ${group} -p`;
  const sys32 = (file) => `C:\\Windows\\System32\\${file}`;
  const svcNeeded = (display) =>
    `Windows needs ${display} to work properly. Stopping or disabling it could crash your PC or stop it from starting, so Ultimate PC Tool won't do it.`;
  let svcPid = 1100;
  const svc = (name, displayName, o = {}) => {
    const status = o.status ?? "running";
    const shared = o.shared ?? !o.commandLine;
    const microsoft = o.publisher ? o.publisher === "microsoft" : true;
    return {
      name,
      displayName,
      description: o.description ?? null,
      summary: o.summary ?? null,
      status,
      startup: o.startup ?? "automatic",
      pid: status === "running" ? (o.pid ?? (svcPid += 12)) : null,
      program: o.program ?? (shared ? sys32(`${name.toLowerCase()}.dll`) : null),
      commandLine: o.commandLine ?? svchost(o.group ?? "netsvcs"),
      account: "account" in o ? o.account : "LocalSystem",
      publisher: o.publisher ?? "microsoft",
      company: o.company ?? (microsoft ? "Microsoft Corporation" : null),
      safety: o.safety ?? "normal",
      safetyNote: o.safetyNote ?? (o.safety === "protected" ? svcNeeded(displayName) : null),
      // Whether it accepts the stop command; `publicSvc` adds "and it's running".
      canStop: o.canStop !== false,
      sharedProcess: shared,
      dependencies: o.deps ?? [],
      template: o.template ?? null,
      // Mock-only behaviour, removed before the UI sees it.
      _slowStop: o.slowStop ?? false,
      _brokenStart: o.brokenStart ?? false,
      _stopsItself: o.stopsItself ?? false,
    };
  };
  const P = "protected";
  const I = "important";
  const third = (company, program, extra = {}) => ({ publisher: "thirdParty", company, program, commandLine: `"${program}"`, shared: false, ...extra });
  let services = [
    svc("RpcSs", "Remote Procedure Call (RPC)", { safety: P, canStop: false, group: "rpcss", deps: ["RpcEptMapper", "DcomLaunch"], account: "NT AUTHORITY\\NetworkService", summary: "Lets Windows programs talk to each other. Almost everything depends on it.", description: "The RPCSS service is the Service Control Manager for COM and DCOM servers. It performs object activations requests, object exporter resolutions and distributed garbage collection for COM and DCOM servers." }),
    svc("DcomLaunch", "DCOM Server Process Launcher", { safety: P, canStop: false, group: "DcomLaunch", summary: "Starts many Windows background components. Windows can't run without it.", description: "The DCOMLAUNCH service launches COM and DCOM servers in response to object activation requests." }),
    svc("RpcEptMapper", "RPC Endpoint Mapper", { safety: P, canStop: false, group: "RPCSS", account: "NT AUTHORITY\\NetworkService", summary: "Helps Windows programs find each other. Required by Windows.", description: "Resolves RPC interfaces identifiers to transport endpoints." }),
    svc("Winmgmt", "Windows Management Instrumentation", { safety: P, deps: ["RPCSS"], summary: "Lets Windows and apps read information about your PC and its settings.", description: "Provides a common interface and object model to access management information about operating system, devices, applications and services." }),
    svc("EventLog", "Windows Event Log", { safety: P, group: "LocalServiceNetworkRestricted", account: "NT AUTHORITY\\LocalService", summary: "Keeps the Windows logs that record errors and warnings.", description: "This service manages events and event logs. It supports logging events, querying events, subscribing to events, archiving event logs, and managing event metadata." }),
    svc("Dhcp", "DHCP Client", { safety: P, group: "LocalServiceNetworkRestricted", deps: ["NSI", "Afd", "Tdx"], account: "NT Authority\\LocalService", summary: "Gets an address from your router so you can go online.", description: "Registers and updates IP addresses and DNS records for this computer. If this service is stopped, this computer will not receive dynamic IP addresses and DNS updates." }),
    svc("Dnscache", "DNS Client", { safety: P, canStop: false, group: "NetworkService", deps: ["nsi"], account: "NT AUTHORITY\\NetworkService", summary: "Turns website names into addresses and remembers them.", description: "The DNS Client service (dnscache) caches Domain Name System (DNS) names and registers the full computer name for this computer." }),
    svc("nsi", "Network Store Interface Service", { safety: P, group: "LocalService", deps: ["rpcss", "nsiproxy"], account: "NT Authority\\LocalService", summary: "Keeps network settings available to Windows. Without it you lose internet.", description: "This service delivers network notifications (e.g. interface addition/deleting etc) to user mode clients." }),
    svc("BFE", "Base Filtering Engine", { safety: P, group: "LocalServiceNoNetworkFirewall", deps: ["RpcSs"], account: "NT AUTHORITY\\LocalService", summary: "The core of Windows Firewall and network security.", description: "The Base Filtering Engine (BFE) is a service that manages firewall and Internet Protocol security (IPsec) policies and implements user mode filtering." }),
    svc("mpssvc", "Windows Defender Firewall", { safety: P, canStop: false, group: "LocalServiceNoNetworkFirewall", deps: ["mpsdrv", "bfe"], account: "NT Authority\\LocalService", summary: "Windows Firewall: blocks unwanted network connections.", safetyNote: "Windows Firewall protects your PC from network attacks. Stopping or disabling it would leave your PC exposed, so Ultimate PC Tool won't do it.", description: "Windows Defender Firewall helps protect your computer by preventing unauthorized users from gaining access to your computer through the Internet or a network." }),
    svc("WinDefend", "Microsoft Defender Antivirus Service", { safety: P, canStop: false, shared: false, program: "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25080.5-0\\MsMpEng.exe", commandLine: '"C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25080.5-0\\MsMpEng.exe"', deps: ["RpcSs", "wscsvc"], summary: "Microsoft Defender Antivirus: protects your PC from viruses and malware.", safetyNote: "Microsoft Defender protects your PC from viruses and malware. Stopping or disabling it would leave your PC unprotected, so Ultimate PC Tool won't do it.", description: "Helps protect users from malware and other potentially unwanted software" }),
    svc("AudioEndpointBuilder", "Windows Audio Endpoint Builder", { safety: P, group: "LocalSystemNetworkRestricted", summary: "Manages your speakers, headphones and microphones.", description: "Manages audio devices for the Windows Audio service. If this service is stopped, audio devices and effects will not function properly." }),
    svc("Schedule", "Task Scheduler", { safety: P, canStop: false, deps: ["RPCSS", "SystemEventsBroker"], summary: "Task Scheduler: runs maintenance, updates and other scheduled tasks.", description: "Enables a user to configure and schedule automated tasks on this computer." }),
    svc("CryptSvc", "Cryptographic Services", { safety: P, group: "NetworkService", deps: ["RpcSs"], account: "NT Authority\\NetworkService", summary: "Checks digital signatures of updates and apps, and manages certificates.", description: "Provides three management services: Catalog Database Service, which confirms the signatures of Windows files and allows new programs to be installed; Protected Root Service; and Automatic Root Certificate Update Service." }),
    svc("ProfSvc", "User Profile Service", { safety: P, canStop: false, summary: "Loads your user profile when you sign in.", safetyNote: "Windows needs this service to load your account when you sign in. Stopping or disabling it could stop anyone from signing in, so Ultimate PC Tool won't do it.", description: "This service is responsible for loading and unloading user profiles." }),
    svc("Audiosrv", "Windows Audio", { safety: I, group: "LocalServiceNetworkRestricted", deps: ["AudioEndpointBuilder", "RpcSs"], account: "NT AUTHORITY\\LocalService", summary: "Plays sound from Windows and your apps.", safetyNote: "Sound stops on this PC until the service runs again.", description: "Manages audio for Windows-based programs. If this service is stopped, audio devices and effects will not function properly." }),
    svc("Spooler", "Print Spooler", { safety: I, shared: false, program: sys32("spoolsv.exe"), commandLine: sys32("spoolsv.exe"), deps: ["RPCSS", "http"], summary: "Sends documents to your printers.", safetyNote: "Printing stops until the service runs again. Restarting it often fixes stuck print jobs.", description: "This service spools print jobs and handles interaction with the printer. If you turn off this service, you won't be able to print or see your printers." }),
    svc("PrintNotify", "Printer Extensions and Notifications", { startup: "manual", deps: ["Spooler"], summary: "Shows printer notifications and settings.", description: "This service opens custom printer dialog boxes and handles notifications from a remote print server or a printer." }),
    svc("WlanSvc", "WLAN AutoConfig", { safety: I, group: "LocalSystemNetworkRestricted", deps: ["nativewifip", "RpcSs", "Ndisuio", "wcmsvc"], summary: "Connects to Wi-Fi networks.", safetyNote: "Wi-Fi disconnects and no Wi-Fi networks show up until the service runs again.", description: "The WLANSVC service provides the logic required to configure, discover, connect to, and disconnect from a wireless local area network (WLAN) as defined by IEEE 802.11 standards." }),
    svc("wuauserv", "Windows Update", { safety: I, startup: "manual", deps: ["rpcss"], summary: "Windows Update: downloads and installs updates.", safetyNote: "Your PC stops getting updates, including security fixes. Turn it back on soon.", description: "Enables the detection, download, and installation of updates for Windows and other programs." }),
    svc("BITS", "Background Intelligent Transfer Service", { safety: I, status: "stopped", startup: "manual", deps: ["RpcSs"], summary: "Downloads updates and files quietly in the background.", safetyNote: "Windows Update and some apps can't download in the background.", description: "Transfers files in the background using idle network bandwidth." }),
    svc("WSearch", "Windows Search", { safety: I, startup: "automaticDelayed", shared: false, slowStop: true, program: sys32("SearchIndexer.exe"), commandLine: `${sys32("SearchIndexer.exe")} /Embedding`, deps: ["RPCSS", "BrokerInfrastructure"], summary: "Indexes your files so search in Start and File Explorer is fast.", safetyNote: "Searching your files becomes slow and may miss results.", description: "Provides content indexing, property caching, and search results for files, e-mail, and other content." }),
    svc("bthserv", "Bluetooth Support Service", { safety: I, startup: "manual", group: "LocalService", deps: ["RpcSs"], account: "NT AUTHORITY\\LocalService", summary: "Connects Bluetooth devices like headphones, mice and keyboards.", safetyNote: "Bluetooth devices disconnect and new ones can't be paired.", description: "The Bluetooth service supports discovery and association of remote Bluetooth devices." }),
    svc("Themes", "Themes", { safety: I, summary: "Draws the Windows look: colors, transparency and window styles.", safetyNote: "Windows switches to a plain look until the service runs again.", description: "Provides user experience theme management." }),
    svc("W32Time", "Windows Time", { safety: I, status: "stopped", startup: "manual", group: "LocalService", account: "NT AUTHORITY\\LocalService", stopsItself: true, summary: "Keeps your clock in sync with internet time.", safetyNote: "Your clock may drift over time, which can cause sign-in and website errors.", description: "Maintains date and time synchronization on all clients and servers in the network." }),
    svc("LanmanWorkstation", "Workstation", { safety: I, group: "NetworkService", deps: ["Bowser", "MRxSmb20", "NSI"], account: "NT AUTHORITY\\NetworkService", summary: "Opens shared folders and network drives on other PCs.", safetyNote: "Shared folders and mapped network drives stop working.", description: "Creates and maintains client network connections to remote servers using the SMB protocol." }),
    svc("SessionEnv", "Remote Desktop Configuration", { startup: "manual", deps: ["RPCSS", "LanmanWorkstation"], summary: "Settings for Remote Desktop connections.", description: "Remote Desktop Configuration service (RDCS) is responsible for all Remote Desktop Services and Remote Desktop related configuration and session maintenance activities that require SYSTEM context." }),
    svc("SysMain", "SysMain", { group: "LocalSystemNetworkRestricted", summary: "Learns which apps you use and preloads them so they open faster.", description: "Maintains and improves system performance over time." }),
    svc("DiagTrack", "Connected User Experiences and Telemetry", { group: "utcsvc", deps: ["RpcSs"], summary: "Sends diagnostic and usage data to Microsoft.", description: "The Connected User Experiences and Telemetry service enables features that support in-application and connected user experiences." }),
    svc("MapsBroker", "Downloaded Maps Manager", { status: "stopped", startup: "automaticDelayed", group: "NetworkService", account: "NT AUTHORITY\\NetworkService", deps: ["rpcss"], summary: "Downloads maps for the Maps app.", description: "Windows service for application access to downloaded maps." }),
    svc("Fax", "Fax", { status: "stopped", startup: "manual", shared: false, program: sys32("fxssvc.exe"), commandLine: sys32("fxssvc.exe"), account: "NT AUTHORITY\\NetworkService", deps: ["TapiSrv", "RpcSs", "PlugPlay", "Spooler"], summary: "Sends and receives faxes. Only needed if you fax from this PC.", description: "Enables you to send and receive faxes, utilizing fax resources available on this computer or on the network." }),
    svc("RemoteRegistry", "Remote Registry", { status: "stopped", startup: "disabled", group: "localService", account: "NT AUTHORITY\\LocalService", deps: ["RPCSS"], summary: "Lets other PCs change this PC's settings over the network.", description: "Enables remote users to modify registry settings on this computer." }),
    svc("XblAuthManager", "Xbox Live Auth Manager", { status: "stopped", startup: "manual", summary: "Signs you in to Xbox games and apps.", description: "Provides authentication and authorization services for interacting with Xbox Live." }),
    svc("XblGameSave", "Xbox Live Game Save", { status: "stopped", startup: "manual", deps: ["UserManager", "XblAuthManager"], summary: "Syncs saved games for Xbox games.", description: "This service syncs save data for Xbox Live save enabled games." }),
    svc("lfsvc", "Geolocation Service", { startup: "manual", deps: ["RpcSs"], summary: "Gives apps your location when you allow it.", description: "This service monitors the current location of the system and manages geofences." }),
    svc("WerSvc", "Windows Error Reporting Service", { status: "stopped", startup: "manual", group: "WerSvcGroup", summary: "Reports app crashes and problems to Microsoft.", description: "Allows errors to be reported when programs stop working or responding and allows existing solutions to be delivered." }),
    svc("TermService", "Remote Desktop Services", { status: "stopped", startup: "manual", group: "NetworkService", account: "NT Authority\\NetworkService", deps: ["RPCSS"], summary: "Remote Desktop: lets people connect to this PC remotely.", description: "Allows users to connect interactively to a remote computer." }),
    svc("WpnService", "Windows Push Notifications System Service", { summary: "Shows notifications from apps and Windows.", description: "This service runs in session 0 and hosts the notification platform and connection provider which handles the connection between the device and WNS server." }),
    svc("CDPUserSvc_4f2a1", "Connected Devices Platform User Service_4f2a1", { group: "UnistackSvcGroup", template: "CDPUserSvc", account: null, summary: null, description: "This user service is used for Connected Devices Platform scenarios" }),
    svc("OneSyncSvc_4f2a1", "Sync Host_4f2a1", { startup: "automaticDelayed", group: "UnistackSvcGroup", template: "OneSyncSvc", account: null, summary: "Syncs mail, contacts and calendar.", description: "This service synchronizes mail, contacts, calendar and various other user data." }),
    svc("edgeupdate", "Microsoft Edge Update Service (edgeupdate)", { status: "stopped", startup: "automaticDelayed", shared: false, program: "C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe", commandLine: '"C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe" /svc', deps: ["RPCSS"], summary: "Keeps Microsoft Edge up to date.", description: "Keeps your Microsoft software up to date. If this service is disabled or stopped, your Microsoft software will not be kept up to date." }),
    svc("ClickToRunSvc", "Microsoft Office Click-to-Run Service", { shared: false, program: "C:\\Program Files\\Common Files\\Microsoft Shared\\ClickToRun\\OfficeClickToRun.exe", commandLine: '"C:\\Program Files\\Common Files\\Microsoft Shared\\ClickToRun\\OfficeClickToRun.exe" /service', deps: ["RPCSS"], summary: "Installs and updates Microsoft Office.", description: "Manages resource coordination, background streaming, and system integration of Microsoft Office products and their related updates." }),
    svc("wisvc", "Windows Insider Service", { status: "stopped", startup: "disabled", summary: "Windows Insider Program (preview builds of Windows).", description: "Provides infrastructure support for the Windows Insider Program." }),
    svc("ssh-agent", "OpenSSH Authentication Agent", { status: "stopped", startup: "disabled", shared: false, program: sys32("OpenSSH\\ssh-agent.exe"), commandLine: sys32("OpenSSH\\ssh-agent.exe"), description: "Agent to hold private keys used for public key authentication." }),
    svc("NVDisplay.ContainerLocalSystem", "NVIDIA Display Container LS", third("NVIDIA Corporation", "C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64_8e1c3f\\Display.NvContainer\\NVDisplay.Container.exe", { summary: "NVIDIA graphics driver helper (control panel and settings).", description: "Container service for NVIDIA root features" })),
    svc("RtkAudioUniversalService", "Realtek Audio Universal Service", third("Realtek Semiconductor Corp.", "C:\\Windows\\System32\\DriverStore\\FileRepository\\realtekservice.inf_amd64_2d9b\\RtkAudUService64.exe", { description: "Realtek Audio Universal Service" })),
    svc("Steam Client Service", "Steam Client Service", third("Valve Corporation", "C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe", { status: "stopped", startup: "manual", commandLine: '"C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe" /RunAsService', summary: "Lets Steam install and update games.", description: "Steam Client Service monitors and updates Steam content" })),
    svc("gupdate", "Google Update Service (gupdate)", third("Google LLC", "C:\\Program Files (x86)\\Google\\Update\\GoogleUpdate.exe", { status: "stopped", startup: "automaticDelayed", commandLine: '"C:\\Program Files (x86)\\Google\\Update\\GoogleUpdate.exe" /svc', summary: "Keeps Google apps like Chrome up to date.", description: "Keeps your Google software up to date. If this service is disabled or stopped, your Google software will not be kept up to date." })),
    svc("AdobeARMservice", "Adobe Acrobat Update Service", third("Adobe Inc.", "C:\\Program Files (x86)\\Common Files\\Adobe\\ARM\\1.0\\armsvc.exe", { description: "Adobe Acrobat Updater keeps your Adobe software up to date." })),
    svc("TeamViewer", "TeamViewer", third("TeamViewer Germany GmbH", "C:\\Program Files\\TeamViewer\\TeamViewer_Service.exe", { description: "TeamViewer Remote Software" })),
    svc("LGHUBUpdaterService", "LGHUB Updater Service", third("Logitech, Inc.", "C:\\Program Files\\LGHUB\\lghub_updater.exe", { startup: "manual", commandLine: '"C:\\Program Files\\LGHUB\\lghub_updater.exe" --run-as-service', description: "Logitech G HUB Updater Service" })),
    svc("MySQL80", "MySQL80", third("Oracle Corporation", "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe", { status: "stopped", startup: "manual", account: "NT AUTHORITY\\NetworkService", commandLine: '"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe" --defaults-file="C:\\ProgramData\\MySQL\\MySQL Server 8.0\\my.ini" MySQL80' })),
    svc("ContosoVpnHelper", "Contoso VPN Helper", third("Contoso Ltd.", "C:\\Program Files\\Contoso VPN\\vpnhelper.exe", { status: "stopped", startup: "manual", brokenStart: true, deps: ["RasMan"], description: "Helps Contoso VPN connect." })),
  ];
  const DRIVERS = { afd: "Ancillary Function Driver for Winsock", tdx: "NetIO Legacy TDI Support Driver", nsiproxy: "NSI Proxy Service Driver", mpsdrv: "Windows Defender Firewall Authorization Driver", http: "HTTP Service", nativewifip: "NativeWiFi Filter", ndisuio: "NDIS Usermode I/O Protocol", wcmsvc: "Windows Connection Manager", bowser: "Browser", mrxsmb20: "SMB 2.0 MiniRedirector", tapisrv: "Telephony", plugplay: "Plug and Play", usermanager: "User Manager", brokerinfrastructure: "Background Tasks Infrastructure Service", systemeventsbroker: "System Events Broker", wscsvc: "Security Center", rasman: "Remote Access Connection Manager" };
  const findSvc = (name) => services.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  const publicSvc = (s) => {
    const { _slowStop, _brokenStart, _stopsItself, ...rest } = s;
    return { ...rest, canStop: (rest.status === "running" || rest.status === "paused") && rest.canStop };
  };
  const getSvc = (name) => findSvc(name) ?? fail("This service no longer exists. It may have been uninstalled, so refresh the list.");
  const svcDependents = (s) => services.filter((o) => o.dependencies.some((d) => d.toLowerCase() === s.name.toLowerCase()));
  const svcLog = (category, description, name, parts = [], undo = null) => {
    let detail = `Service name: ${name}`;
    for (const [label, names] of parts) if (names.length) detail += `. ${label}: ${names.join(", ")}`;
    return record(category, description, detail, undo);
  };
  const startupLabel = { automatic: "Automatic", automaticDelayed: "Automatic (delayed)", manual: "Manual", disabled: "Disabled" };
  const startupRank = { automatic: 3, automaticDelayed: 2, manual: 1, disabled: 0 };
  const setStatus = (s, status) => {
    s.status = status;
    s.pid = status === "running" ? (s.pid ?? (svcPid += 12)) : status === "stopped" ? null : s.pid;
  };
  const checkStartupChange = (s, startup, restoring) => {
    if (s.template)
      fail(`Windows makes a copy of the "${s.template}" service for each person who signs in, and this copy follows its settings. Change "${s.template}" instead.`);
    if (s.safety === "protected" && (startup === "disabled" || (!restoring && startupRank[startup] < startupRank[s.startup]))) fail(s.safetyNote);
  };

  const handlers = {
    get_app_info: () => ({ elevated: !!window.__MOCK_ELEVATED__, version: "0.1.0" }),
    restart_as_admin: () => fail("You chose No on the administrator prompt, so the app keeps running as before."),
    take_notices: () => (window.__MOCK_NOTICES__ || []).splice(0),
    get_settings: () => ({ ...settings }),
    set_close_action: ({ action }) => {
      settings.closeAction = action;
    },
    close_main_window: ({ action, remember }) => {
      if (remember) settings.closeAction = action;
    },

    get_overview: () => ({ hostName: "ABOKHALID-PC", osName: "Windows", osVersion: "Windows 11 Pro 24H2", kernelVersion: "26100", cpuName: "AMD Ryzen 7 7800X3D", physicalCores: 8, logicalCores: 16, memTotal: 32 * GB }),
    get_metrics: metrics,

    list_processes: () => procs.map((p) => ({ ...p, cpu: Math.random() * 6 })),
    get_process_details: ({ pid, startTime }) => {
      const p = procs.find((x) => x.pid === pid && x.startTime === startTime);
      if (!p) fail("This process has ended.");
      return { exe: p.exe, cmd: p.exe ? `"${p.exe}" --type=renderer` : null, priority: priorities[pid] ?? "normal" };
    },
    kill_processes: async ({ name, targets }) => {
      await sleep(150);
      const summary = { ended: 0, alreadyGone: 0, failed: [] };
      for (const t of targets) {
        const p = procs.find((x) => x.pid === t.pid && x.startTime === t.startTime);
        if (!p) summary.alreadyGone++;
        else if (p.protected) summary.failed.push(p.protected);
        else {
          procs = procs.filter((x) => x !== p);
          summary.ended++;
        }
      }
      if (summary.ended) record("Processes", `Ended ${name}${summary.ended > 1 ? ` (${summary.ended} processes)` : ""}`);
      return summary;
    },
    set_process_priority: ({ pid, startTime, name, priority }) => {
      const p = procs.find((x) => x.pid === pid && x.startTime === startTime);
      if (!p) fail("That app already closed, so nothing was changed.");
      if (p.protected) fail(p.protected);
      if (priority === "realtime") fail("Realtime priority can freeze your PC, so Ultimate PC Tool doesn't offer it.");
      const previous = priorities[pid] ?? "normal";
      // Like Windows without admin rights: High is the most a normal user gets... in the mock, Low becomes Below normal.
      const applied = priority === "idle" && name === "notepad.exe" ? "belowNormal" : priority;
      priorities[pid] = applied;
      record("Processes", `Set ${name} (PID ${pid}) priority to ${applied}`, null, { type: "priority", pid, startTime, name, previous });
      return { previous, applied };
    },
    open_file_location: () => null,

    list_commands: () => commands,
    save_command: ({ command }) => {
      const saved = { ...command, id: command.id || `u${Date.now()}` };
      const i = commands.findIndex((c) => c.id === saved.id);
      if (i >= 0) commands[i] = saved;
      else commands.push(saved);
      return saved;
    },
    delete_command: ({ id }) => {
      const removed = commands.find((c) => c.id === id);
      if (!removed) fail("That command no longer exists");
      commands = commands.filter((c) => c.id !== id);
      return record("Commands", `Deleted command "${removed.name}"`, removed.command, { type: "restoreCommand", command: removed });
    },
    restore_builtin_commands: () => {
      const missing = defaults().filter((d) => !commands.some((c) => c.id === d.id));
      commands.push(...missing);
      return missing.length;
    },
    run_command: async ({ runId, command, shell, admin, label, onEvent }) => {
      calls.push({ cmd: "run_command", command, shell, admin, label });
      if (admin) {
        await sleep(600);
        record("Commands", `Ran "${label}" (as administrator)`, command);
        return { stdout: "Opened in an administrator window.", stderr: "", code: null, elevated: true, stopped: null, truncated: false };
      }
      const endless = /-t\b|winget/.test(command);
      const lines = endless ? 200 : 2;
      let stdout = "";
      for (let i = 0; i < lines; i++) {
        if (cancelled.has(runId)) {
          cancelled.delete(runId);
          return { stdout, stderr: "", code: null, elevated: false, stopped: "cancelled", truncated: false };
        }
        const line = endless ? `Reply from 8.8.8.8: bytes=32 time=${10 + i}ms TTL=117\n` : i === 0 ? "Windows IP Configuration\n" : "\nSuccessfully flushed the DNS Resolver Cache.\n";
        stdout += line;
        send(onEvent, { type: "output", stderr: false, data: line });
        await sleep(endless ? 300 : 100);
      }
      record("Commands", `Ran "${label}"`, `${shell === "cmd" ? "Command Prompt" : "PowerShell"}: ${command}`);
      return { stdout, stderr: "", code: 0, elevated: false, stopped: null, truncated: false };
    },
    cancel_command: ({ runId }) => {
      cancelled.add(runId);
    },
    clean_temp: async ({ dryRun }) => {
      await sleep(400);
      if (!dryRun) record("Cleanup", "Cleaned temp files: 1873 files, 1240 MB freed", "C:\\Users\\abokhalid\\AppData\\Local\\Temp");
      return { folder: "C:\\Users\\abokhalid\\AppData\\Local\\Temp", files: 1873, bytes: 1.3e9, skipped: dryRun ? 0 : 41 };
    },

    terminal_spawn: ({ shell, onEvent }) => {
      const id = nextTerm++;
      sessions[id] = { shell, onEvent, line: "" };
      // Sent before the id is returned, like a fast-starting shell: the channel must not lose it.
      send(onEvent, { type: "output", data: `${shell === "cmd" ? "Microsoft Windows [Version 10.0.26100]" : "Windows PowerShell"}\r\n\r\n${prompt(shell)}` });
      return id;
    },
    terminal_write: ({ id, data }) => {
      calls.push({ cmd: "terminal_write", id, data });
      const s = sessions[id];
      if (!s) fail("Terminal session has ended");
      for (const ch of data) {
        if (ch === "\r") {
          const line = s.line.trim();
          s.line = "";
          if (line === "exit") {
            send(s.onEvent, { type: "output", data: "\r\n" });
            send(s.onEvent, { type: "exit", code: 0 });
            delete sessions[id];
            return;
          }
          send(s.onEvent, { type: "output", data: `\r\n${line ? `(mock) ran: ${line}\r\n` : ""}${prompt(s.shell)}` });
        } else if (ch === "\x7f") {
          if (s.line) {
            s.line = s.line.slice(0, -1);
            send(s.onEvent, { type: "output", data: "\b \b" });
          }
        } else if (ch >= " ") {
          s.line += ch;
          send(s.onEvent, { type: "output", data: ch });
        }
      }
    },
    terminal_resize: () => null,
    terminal_close: ({ id }) => {
      calls.push({ cmd: "terminal_close", id });
      delete sessions[id];
    },

    list_startup_items: () => startup,
    set_startup_enabled: ({ source, name, enabled }) => {
      const item = startup.find((i) => i.source === source && i.name === name);
      if (item.needsAdmin && !window.__MOCK_ELEVATED__) fail("This entry applies to all users, so it needs administrator rights. Use Restart as administrator to change it.");
      item.enabled = enabled;
      record("Startup", `${enabled ? "Enabled" : "Disabled"} startup app "${name}"`, null, { type: "startupToggle", source, name, enabled: !enabled });
    },

    list_services: async () => {
      await sleep(350);
      return services.map(publicSvc);
    },
    get_service: ({ name }) => publicSvc(getSvc(name)),
    get_service_details: async ({ name }) => {
      await sleep(120);
      const s = getSvc(name);
      const link = (dep) => {
        if (dep.startsWith("+")) return { name: dep.slice(1), displayName: dep.slice(1), status: null, group: true };
        const other = findSvc(dep);
        if (other) return { name: dep, displayName: other.displayName, status: other.status, group: false };
        return { name: dep, displayName: DRIVERS[dep.toLowerCase()] ?? dep, status: "running", group: false };
      };
      return {
        dependencies: s.dependencies.map(link),
        dependents: svcDependents(s).map((o) => ({ name: o.name, displayName: o.displayName, status: o.status, group: false })),
      };
    },
    control_service: async ({ name, action }) => {
      const s = getSvc(name);
      const display = s.displayName;
      // Same checks as check_action in services.rs, before anything is attempted.
      if (action === "start" && s.startup === "disabled") fail(`${display} is disabled, so it can't start. Set its startup type to Manual or Automatic first.`);
      if (action !== "start") {
        if (s.safety === "protected") fail(s.safetyNote ?? `Windows needs ${display}, so Ultimate PC Tool won't stop it.`);
        if ((s.status === "running" || s.status === "paused") && !s.canStop) fail(`Windows doesn't let ${display} be stopped while it's running.`);
        if (action === "restart" && s.status === "stopped") fail(`${display} isn't running. Use Start instead.`);
        if (action === "restart" && s.startup === "disabled")
          fail(`${display} is disabled, so it couldn't start again after stopping. Set its startup type to Manual or Automatic first.`);
      }
      if (!window.__MOCK_ELEVATED__) {
        await sleep(150);
        fail(SVC_ADMIN);
      }
      const result = (extra = {}) => ({ service: publicSvc(s), timedOut: false, also: [], note: null, activityId: null, ...extra });
      const stop = async () => {
        const deps = svcDependents(s).filter((o) => o.status !== "stopped");
        const blocker = deps.find((o) => o.safety === "protected");
        if (blocker) fail(`Stopping ${display} would also stop ${blocker.displayName}, which Windows needs, so Ultimate PC Tool won't do it.`);
        for (const d of deps) {
          setStatus(d, "stopping");
          await sleep(400);
          setStatus(d, "stopped");
        }
        if (s.status === "stopped") return { changed: deps.length > 0, timedOut: false, deps };
        setStatus(s, "stopping");
        if (s._slowStop) {
          // The app stops waiting but Windows keeps going; the page polls until it settles.
          await sleep(2500);
          setTimeout(() => setStatus(s, "stopped"), 6000);
          return { changed: true, timedOut: true, deps };
        }
        await sleep(900);
        setStatus(s, "stopped");
        return { changed: true, timedOut: false, deps };
      };
      const start = async (target) => {
        if (target.status === "running") return { changed: false };
        setStatus(target, "starting");
        await sleep(1000);
        if (target._brokenStart) {
          setStatus(target, "stopped");
          fail(
            `${target.displayName} stopped right after it started. The program behind it may be damaged or missing something it needs. Windows says: The system cannot find the file specified.`,
          );
        }
        if (target._stopsItself) {
          setStatus(target, "stopped");
          return { changed: true, stoppedItself: true };
        }
        setStatus(target, "running");
        return { changed: true };
      };
      const itself = (o) => (o.stoppedItself ? `${display} started, then stopped again by itself. Some services do this when nothing needs them right now.` : null);

      if (action === "start") {
        const started = await start(s);
        if (started.changed) svcLog("Services", `Started service "${display}"`, s.name);
        return result({ note: itself(started) });
      }
      const stopped = await stop();
      const also = stopped.deps.map((d) => d.displayName);
      if (action === "stop") {
        if (stopped.changed) svcLog("Services", `${stopped.timedOut ? "Asked to stop" : "Stopped"} service "${display}"`, s.name, [["Also stopped", also]]);
        return result({ timedOut: stopped.timedOut, also });
      }
      if (stopped.timedOut) {
        svcLog("Services", `Asked to stop service "${display}"`, s.name, [["Also stopped", also]]);
        return result({ timedOut: true, also, note: `${display} is taking a long time to stop, so it wasn't started again. Start it once it has stopped.` });
      }
      let started;
      try {
        started = await start(s);
      } catch (e) {
        svcLog("Services", `Stopped service "${display}"`, s.name, [["Also stopped", also]]);
        fail(`${display} stopped, but couldn't start again. ${e}`);
      }
      const restarted = [];
      for (const d of [...stopped.deps].reverse()) {
        await start(d);
        restarted.push(d.displayName);
      }
      svcLog("Services", `Restarted service "${display}"`, s.name, [["Also restarted", restarted]]);
      return result({ also: restarted, note: itself(started) });
    },
    set_service_startup: async ({ name, startup }) => {
      const s = getSvc(name);
      checkStartupChange(s, startup, false);
      const result = (activityId = null) => ({ service: publicSvc(s), timedOut: false, also: [], note: null, activityId });
      if (s.startup === startup) return result();
      if (!window.__MOCK_ELEVATED__) {
        await sleep(120);
        fail(SVC_ADMIN);
      }
      await sleep(250);
      const previous = s.startup;
      s.startup = startup;
      const undo = { type: "serviceStartup", name: s.name, displayName: s.displayName, startup: previous };
      return result(svcLog("Services", `Set service "${s.displayName}" to ${startupLabel[startup]} (was ${startupLabel[previous]})`, s.name, [], undo));
    },

    list_activity: () => activity,
    undo_activity: ({ id }) => {
      const r = activity.find((a) => a.id === id);
      if (!r) fail("Activity entry not found");
      if (r.undo?.type === "restoreCommand") commands.push(r.undo.command);
      if (r.undo?.type === "serviceStartup") {
        const s = getSvc(r.undo.name);
        if (!window.__MOCK_ELEVATED__) fail(SVC_ADMIN);
        checkStartupChange(s, r.undo.startup, true);
        s.startup = r.undo.startup;
      }
      r.undone = true;
    },
    clear_activity: () => {
      activity = [];
    },

    "plugin:window|set_theme": () => null,
    "plugin:event|listen": (a) => {
      (listeners[a.event] ||= []).push(a.handler);
      return a.handler;
    },
    "plugin:event|unlisten": ({ event, eventId }) => {
      listeners[event] = (listeners[event] || []).filter((h) => h !== eventId);
    },
  };
  setInterval(() => emit("metrics://update", metrics()), 1000);
  window.__mock = { emit, calls, sessions };
  return {
    transformCallback: (f) => {
      cb++;
      cbs[cb] = f;
      return cb;
    },
    unregisterCallback: (id) => delete cbs[id],
    invoke: async (cmd, args) => {
      if (!handlers[cmd]) {
        console.warn(`mock-tauri: no handler for ${cmd}`);
        return null;
      }
      // Copies, like real IPC: the UI must never share objects with the mock's state.
      const result = await handlers[cmd](args || {});
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  };
})();
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
