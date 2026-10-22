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

  // ---- PC health ----
  // Matches the rest of the mock: Chrome is busy, D: is nearly full (see metrics), six startup
  // apps are on. Ending Chrome, cleaning temp files or switching the power plan clears that issue
  // on the next check. `window.__MOCK_HEALTH__ = "clear"` (set before load) reports no issues,
  // and "restart" adds updates waiting on a restart.
  const PLANS = {
    "381b4222-f694-41f0-9685-ff5bb260df2e": "Balanced",
    "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": "High performance",
    "a1841308-3541-4fab-bc81-f71556f20b4a": "Power saver",
  };
  const [BALANCED, HIGH_PERF, POWER_SAVER] = Object.keys(PLANS);
  let powerPlan = POWER_SAVER;
  let tempCleaned = false;
  let healthRunning = false;
  const fix = (label, kind, payload, safe = false) => ({ label, safe, kind, ...(payload ? { payload } : {}) });
  const issue = (id, severity, title, explanation, detail, action, alternatives = []) => ({
    id,
    severity,
    title,
    explanation,
    detail,
    points: { critical: 20, warning: 10, tip: 3 }[severity],
    action,
    alternatives,
  });
  const healthReport = () => {
    const clear = window.__MOCK_HEALTH__ === "clear";
    if (clear) powerPlan = BALANCED;
    const issues = [];
    const checks = [];
    const check = (id, label, found, issueSummary, ok) => checks.push({ id, label, status: found ? "issue" : "ok", summary: found ? issueSummary : ok });

    const chrome = clear ? [] : procs.filter((p) => p.name === "chrome.exe");
    if (chrome.length) {
      issues.push(
        issue(
          "cpu-chrome.exe",
          "critical",
          "Google Chrome is keeping your processor busy",
          "It used about 54% of your processor the whole time we watched, which leaves less for everything else. If you aren't using it, ending it frees that up right away. Save your work in it first.",
          `chrome.exe: ${chrome.length} processes, average 54.3% of the processor over 4 seconds (samples: 51%, 58%, 55%, 53%). File: ${chrome[0].exe}`,
          fix("End Google Chrome", "endProcess", { name: "chrome.exe", targets: chrome.map(({ pid, startTime }) => ({ pid, startTime })) }),
          [fix("See in Processes", "openPage", { page: "processes", sort: "cpu", query: "chrome.exe" })],
        ),
      );
    }
    check("processor", "Processor", chrome.length, "Google Chrome is keeping your processor busy", "No app is hogging it. It averaged 23% during the check.");
    check("memory", "Memory", false, "", "44% in use (14.2 GB of 32 GB).");

    if (!clear) {
      issues.push(
        issue(
          "drive-d",
          "warning",
          "Drive D: is almost full",
          "Only 90 GB of 1.95 TB is free, so apps may fail to save files there. Move or delete files you don't need.",
          "Data (D:): 90 GB free of 1.95 TB (4.5% free).",
          fix("Open Storage settings", "openSettings", { page: "storagesense" }),
        ),
      );
    }
    check("drives", "Free space", !clear, "Drive D: is almost full", "Every drive has room. C: has 380 GB free.");

    const on = startup.filter((i) => i.enabled);
    if (!clear && on.length >= 6) {
      issues.push(
        issue(
          "startup",
          on.length >= 10 ? "warning" : "tip",
          `${on.length} apps start with Windows`,
          "Every app that starts with Windows makes signing in slower and keeps running in the background, using memory and processor. Turn off the ones you don't need right away. You can still open them yourself, and turning one off never deletes it.",
          `Turned on: ${on.map((i) => i.name).join(", ")}. Already turned off: ${startup.length - on.length}.`,
          fix("Choose startup apps", "openPage", { page: "startup", sort: null, query: null }),
        ),
      );
    }
    check("startup", "Startup apps", !clear && on.length >= 6, `${on.length} apps start with Windows.`, `${on.length} apps start with Windows.`);
    const updates = window.__MOCK_HEALTH__ === "restart";
    if (updates) {
      issues.push(
        issue(
          "updates-restart",
          "warning",
          "Restart to finish installing updates",
          "Windows has installed updates that only take effect after a restart. Until then, update work can keep running in the background and slow your PC down.",
          "Running for 1 day, 2 hours since the last restart. Waiting for a restart: Windows Update RebootRequired, 3 PendingFileRenameOperations.",
          fix("Restart now…", "restart"),
          [fix("Open Windows Update", "openSettings", { page: "windowsupdate" })],
        ),
      );
    }
    check("restart", "Restart", false, "", "Last restarted 1 day, 2 hours ago.");
    check("updates", "Windows Update", updates, "Updates are waiting for a restart.", "No updates are waiting for a restart.");

    const temp = !clear && !tempCleaned;
    if (temp) {
      issues.push(
        issue(
          "temp-files",
          "warning",
          "1.21 GB of temporary files can be cleaned up",
          "Apps and installers leave temporary files behind. Cleaning them frees space on your Windows drive. Files used in the last 24 hours and files that are in use are always kept, and nothing outside the temp folder is touched.",
          "1873 files older than 24 hours in C:\\Users\\abokhalid\\AppData\\Local\\Temp (1.21 GB).",
          fix("Free 1.21 GB", "cleanTemp", { bytes: 1.3e9 }, true),
        ),
      );
    }
    check("temp", "Temp files", temp, "1.21 GB can be freed.", "Already clean.");

    const saver = !clear && powerPlan === POWER_SAVER;
    if (saver) {
      issues.push(
        issue(
          "power-plan",
          "warning",
          "Your PC is set to Power saver",
          "Power saver makes your processor run slower to save energy, so everything takes longer. Balanced is just as frugal while your PC is idle, and runs at full speed when you need it.",
          `Active power plan: Power saver (${POWER_SAVER}). Plans on this PC: Balanced, High performance, Power saver.`,
          fix("Switch to Balanced", "setPowerPlan", { guid: BALANCED, name: "Balanced" }, true),
          [fix("Use High performance", "setPowerPlan", { guid: HIGH_PERF, name: "High performance" }, true)],
        ),
      );
    }
    check("power", "Power plan", saver, "Your PC is set to Power saver", `${PLANS[powerPlan]}.`);
    check("temperature", "Temperature", false, "", "CPU Package at 61°C.");
    check("systemDrive", "Windows drive", false, "", "C: is a fast solid-state drive (SSD).");

    const rank = { critical: 0, warning: 1, tip: 2 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const score = Math.max(0, 100 - issues.reduce((sum, i) => sum + i.points, 0));
    return { score, issues, checks, checkedAt: Date.now(), durationMs: 4630 };
  };

  // ---- Apps (installed programs, winget) ----
  // `window.__MOCK_NO_WINGET__ = true` (set before load) pretends winget isn't installed.
  const MB = 1024 ** 2;
  const program = (name, publisher, version, sizeMb, installDate, extra = {}) => ({
    id: `${extra.scope === "user" ? "HKCU" : "HKLM64"}\\${name}`,
    name,
    publisher,
    version,
    sizeBytes: sizeMb ? Math.round(sizeMb * MB) : null,
    installDate,
    location: `C:\\Program Files\\${name.split(" (")[0]}`,
    scope: "machine",
    canUninstall: true,
    canQuiet: false,
    isSelf: false,
    ...extra,
  });
  const appData = (p) => `C:\\Users\\abokhalid\\AppData\\${p}`;
  let programs = [
    program("Google Chrome", "Google LLC", "120.0.6099.130", 512, "2024-01-12"),
    program("Mozilla Firefox (x64 en-US)", "Mozilla", "121.0", 236, "2023-12-19", { canQuiet: true }),
    program("7-Zip 23.01 (x64)", "Igor Pavlov", "23.01", 5.6, "2023-09-02", { canQuiet: true }),
    program("Discord", "Discord Inc.", "1.0.9013", 87, "2024-02-03", { scope: "user", location: appData("Local\\Discord") }),
    program("Spotify", "Spotify AB", "1.2.26.1187", 302, "2024-01-28", { scope: "user", location: appData("Roaming\\Spotify"), handsOver: true }),
    program("Microsoft Visual Studio Code (User)", "Microsoft Corporation", "1.85.1", 362, "2023-12-14", { scope: "user", location: appData("Local\\Programs\\Microsoft VS Code") }),
    program("Microsoft Edge", "Microsoft Corporation", "120.0.2210.91", 742, "2024-01-15", { canUninstall: false }),
    program("Microsoft 365 Apps for enterprise - en-us", "Microsoft Corporation", "16.0.17126.20132", 2480, "2023-11-03"),
    program("NVIDIA Graphics Driver 546.33", "NVIDIA Corporation", "546.33", 1130, "2023-12-12"),
    program("Notepad++ (64-bit x64)", "Notepad++ Team", "8.6", 14.5, "2023-11-26", { canQuiet: true }),
    program("Python 3.12.1 (64-bit)", "Python Software Foundation", "3.12.1", 103, "2023-12-08", { scope: "user", canQuiet: true }),
    program("Git", "The Git Development Community", "2.43.0", 334, "2023-11-21", { canQuiet: true }),
    program("VLC media player", "VideoLAN", "3.0.20", 168, "2023-11-02", { canQuiet: true }),
    program("Zoom Workplace", "Zoom Video Communications, Inc.", "5.17.5", 310, "2024-01-30", { scope: "user", location: appData("Roaming\\Zoom") }),
    program("Steam", "Valve Corporation", "2.10.91.91", null, "2023-08-14", { location: "C:\\Program Files (x86)\\Steam" }),
    program("Epic Games Launcher", "Epic Games, Inc.", "1.3.93.0", 245, "2023-10-07", { canQuiet: true }),
    program("Adobe Acrobat (64-bit)", "Adobe", "23.008.20470", 1310, "2024-01-09", { canQuiet: true }),
    program("Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.38.33130", "Microsoft Corporation", "14.38.33130.0", 20.4, "2024-01-04", { location: null }),
    program("Realtek High Definition Audio Driver", "Realtek Semiconductor Corp.", "6.0.9549.1", null, null, { location: null }),
    program("Logitech G HUB", "Logitech", "2024.1.536011", 610, "2024-02-01", { userCancels: true }),
    program("OBS Studio", "OBS Project", "30.0.2", 432, "2023-12-29"),
    program("WinRAR 6.24 (64-bit)", "win.rar GmbH", "6.24.0", 9.7, "2023-10-30"),
    program("Docker Desktop", "Docker Inc.", "4.26.1", 2650, "2023-12-20"),
    program("Microsoft OneDrive", "Microsoft Corporation", "23.246.1127.0002", 310, "2024-01-18", { scope: "user", location: appData("Local\\Microsoft\\OneDrive") }),
    program("Bitwarden", "Bitwarden Inc.", "2024.1.0", 410, "2024-01-22", { scope: "user", location: appData("Local\\Programs\\Bitwarden") }),
    program("PowerToys (Preview) x64", "Microsoft Corporation", "0.77.0", 820, "2024-01-10", { canQuiet: true }),
    program("Ultimate PC Tool", "abokhalid", "0.1.0", 12, "2024-02-05", { scope: "user", isSelf: true, canUninstall: false, location: appData("Local\\Ultimate PC Tool") }),
  ];
  const wingetUpgrades = [
    { name: "Google Chrome", id: "Google.Chrome", partialId: false, version: "120.0.6099.130", available: "121.0.6167.86", source: "winget", explicit: false },
    { name: "Mozilla Firefox (x64 en-US)", id: "Mozilla.Firefox", partialId: false, version: "121.0", available: "122.0.1", source: "winget", explicit: false },
    { name: "7-Zip 23.01 (x64)", id: "7zip.7zip", partialId: false, version: "23.01", available: "24.01", source: "winget", explicit: false },
    { name: "Discord", id: "Discord.Discord", partialId: false, version: "1.0.9013", available: "1.0.9030", source: "winget", explicit: false },
    { name: "Zoom Workplace", id: "Zoom.Zoom", partialId: false, version: "5.17.5.31030", available: "6.0.2.33403", source: "winget", explicit: false },
    { name: "Microsoft Visual C++ 2015-2022 Redistributable (x64)…", id: "Microsoft.VCRedist.2015+.", partialId: true, version: "14.38.33130.0", available: "14.38.33135.0", source: "winget", explicit: false },
    { name: "Notepad++ (64-bit x64)", id: "Notepad++.Notepad++", partialId: false, version: "8.6", available: "8.6.2", source: "winget", explicit: true },
  ];
  const upgraded = new Set();
  const wingetPackages = ["Google.Chrome", "Mozilla.Firefox", "7zip.7zip", "Discord.Discord", "Spotify.Spotify", "Valve.Steam", "VideoLAN.VLC", "Git.Git", "Notepad++.Notepad++", "Zoom.Zoom", "OBSProject.OBSStudio", "Bitwarden.Bitwarden", "Microsoft.PowerToys", "EpicGames.EpicGamesLauncher"].map((id) => ({ name: id.split(".").pop(), id, partialId: false }));
  wingetPackages.push({ name: "Microsoft Visual Studio Code", id: "Microsoft.VisualStudioC", partialId: true });
  // Uninstalling also takes the app off what winget reports.
  function dropProgram(p) {
    programs = programs.filter((x) => x !== p);
    const name = p.name.toLowerCase();
    const words = name.split(/[^a-z0-9+]+/);
    for (let i = wingetPackages.length - 1; i >= 0; i--) if (words.includes(wingetPackages[i].name.toLowerCase())) wingetPackages.splice(i, 1);
    for (const u of wingetUpgrades) if (name === u.name.toLowerCase()) upgraded.add(u.id);
  }
  /** Installs that fail in the mock, to show the failure summary. */
  const WINGET_FAILS = { "Zoom.Zoom": ["0x8A150101", "The app is open. Close it, then try again."], "Proton.ProtonVPN": ["0x8A150108", "The app's installer ran into a problem. Its publisher may be able to help."] };
  const cleanWinget = (text) =>
    text
      .split("\n")
      .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
      .filter((l) => !/^[\s\\|/-]*$/.test(l) || l === "")
      .filter((l) => !/[█▒]/.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

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
      if (!dryRun) {
        record("Cleanup", "Cleaned temp files: 1873 files, 1240 MB freed", "C:\\Users\\abokhalid\\AppData\\Local\\Temp");
        tempCleaned = true;
      }
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

    run_health_check: async ({ onEvent }) => {
      if (healthRunning) fail("A speed check is already running. It takes about five seconds.");
      healthRunning = true;
      try {
        const steps = [
          [2, "Getting ready…"],
          [6, "Watching which apps use your processor…"],
          [26, "Measuring how full your memory is…"],
          [46, "Checking free space on your drives…"],
          [66, "Looking for updates waiting on a restart…"],
          [86, "Checking startup apps, temp files and power settings…"],
        ];
        for (const [percent, step] of steps) {
          send(onEvent, { type: "progress", percent, step });
          await sleep(percent === 2 ? 150 : 900);
        }
        send(onEvent, { type: "progress", percent: 100, step: "Done" });
        return healthReport();
      } finally {
        healthRunning = false;
      }
    },
    set_power_plan: async ({ guid }) => {
      await sleep(250);
      if (!PLANS[guid]) fail("That power plan isn't on this PC any more. Run the check again.");
      if (guid === powerPlan) return null;
      const previous = powerPlan;
      powerPlan = guid;
      return record("PC health", `Switched power plan to ${PLANS[guid]}`, `Was ${PLANS[previous]} (${previous})`, { type: "powerPlan", guid: previous, name: PLANS[previous] });
    },
    restart_pc: async () => {
      calls.push({ cmd: "restart_pc" });
      await sleep(300);
      record("PC health", "Restarted the PC");
    },
    open_windows_settings: ({ page }) => {
      calls.push({ cmd: "open_windows_settings", page });
      if (!["windowsupdate", "storagesense", "powersleep", "batterysaver"].includes(page)) fail("Unknown Windows Settings page.");
    },

    list_activity: () => activity,
    undo_activity: ({ id }) => {
      const r = activity.find((a) => a.id === id);
      if (!r) fail("Activity entry not found");
      if (r.undo?.type === "restoreCommand") commands.push(r.undo.command);
      if (r.undo?.type === "powerPlan") powerPlan = r.undo.guid;
      r.undone = true;
    },
    clear_activity: () => {
      activity = [];
    },

    list_installed_apps: async () => {
      await sleep(250);
      return programs.map(({ handsOver, userCancels, ...p }) => p);
    },
    uninstall_app: async ({ id, quiet }) => {
      const p = programs.find((x) => x.id === id);
      const outcome = { removed: false, pending: false, cancelled: false, restartNeeded: false, message: null };
      if (!p) return { ...outcome, removed: true };
      if (p.isSelf) fail("To remove Ultimate PC Tool, use Settings > Apps > Installed apps in Windows.");
      await sleep(quiet ? 1400 : 2400);
      if (p.userCancels) return { ...outcome, cancelled: true };
      const detail = `Version ${p.version} · "${p.location ?? "C:\\Program Files\\App"}\\uninstall.exe"${quiet ? " /S" : ""}`;
      if (p.handsOver) {
        // Like NSIS uninstallers: the first process exits and a copy finishes the job a bit later.
        setTimeout(() => dropProgram(p), 6000);
        record("Apps", `Opened the uninstaller for "${p.name}"`, detail);
        return { ...outcome, pending: true };
      }
      dropProgram(p);
      record("Apps", `Uninstalled "${p.name}"`, detail);
      return { ...outcome, removed: true };
    },
    app_still_installed: ({ id }) => programs.some((x) => x.id === id),
    open_app_folder: () => null,
    winget_list_upgrades: async () => {
      await sleep(1800);
      if (window.__MOCK_NO_WINGET__) return { wingetMissing: true, upgrades: [] };
      return { wingetMissing: false, upgrades: wingetUpgrades.filter((u) => !upgraded.has(u.id)) };
    },
    winget_list_installed: async () => {
      await sleep(1400);
      if (window.__MOCK_NO_WINGET__) return { wingetMissing: true, packages: [] };
      return { wingetMissing: false, packages: wingetPackages };
    },
    winget_run: async ({ runId, action, pkg, onEvent }) => {
      calls.push({ cmd: "winget_run", action, pkg });
      if (window.__MOCK_NO_WINGET__) fail("Windows Package Manager (winget) isn't installed. Get the free App Installer from the Microsoft Store, then try again.");
      let log = "";
      const write = (data) => {
        log += data;
        send(onEvent, { type: "output", stderr: false, data });
      };
      const args = `${action} --id ${pkg.id}${pkg.partialId ? "" : " --exact"} --accept-source-agreements --accept-package-agreements --disable-interactivity`;
      const finish = (extra) => ({ ok: false, unchanged: false, restartNeeded: false, stopped: null, message: "", code: null, output: cleanWinget(log), ...extra });
      const wasStopped = () => cancelled.delete(runId);
      const stopped = () => finish({ stopped: "cancelled", message: "Stopped before it finished." });
      for (const frame of ["\r   - ", "\r   \\ ", "\r   | ", "\r   / ", "\r          \r"]) {
        write(frame);
        await sleep(110);
      }
      write(`Found ${pkg.name} [${pkg.id}] Version ${pkg.version ?? "latest"}\r\nThis application is licensed to you by its owner.\r\nMicrosoft is not responsible for, nor does it grant any licenses to, third-party packages.\r\n`);
      write(`Downloading https://downloads.example.com/${pkg.id.toLowerCase()}/setup.exe\r\n`);
      const total = 30 + ((pkg.id.length * 37) % 150);
      for (let i = 1; i <= 24; i++) {
        if (wasStopped()) return stopped();
        const bar = "█".repeat(Math.round((i / 24) * 30)).padEnd(30, "▒");
        write(`\r  ${bar}  ${((total * i) / 24).toFixed(1)} MB / ${total.toFixed(1)} MB`);
        await sleep(120);
      }
      write("\r\nSuccessfully verified installer hash\r\nStarting package install...\r\n");
      for (let i = 0; i < 12; i++) {
        if (wasStopped()) return stopped();
        write(`\r   ${"-\\|/"[i % 4]} `);
        await sleep(120);
      }
      write("\r          \r");
      const failure = WINGET_FAILS[pkg.id];
      if (failure) {
        write(`Installer failed with exit code: ${failure[0]}\r\n`);
        return finish({ code: failure[0], message: failure[1] });
      }
      write("Successfully installed\r\n");
      if (action === "install") {
        wingetPackages.push({ name: pkg.name, id: pkg.id, partialId: false });
        record("Apps", `Installed "${pkg.name}"`, `winget ${args}`);
      } else {
        upgraded.add(pkg.id);
        record("Apps", `Updated "${pkg.name}"${pkg.version ? ` to version ${pkg.version}` : ""}`, `winget ${args}`);
      }
      return finish({ ok: true, code: "0", message: action === "install" ? "Installed." : "Updated." });
    },
    open_app_installer_page: () => null,

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
