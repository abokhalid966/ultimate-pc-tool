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
    `${name} is a core part of Windows. Ending it could crash your PC, sign you out or break the desktop, so Optimo won't do it.`;
  const selfMsg = "That's part of Optimo. Use Quit in the tray menu to close it.";
  let procs = [
    proc("System", { pid: 4, parentPid: 0, exe: null, protected: core("System"), memory: 2e6 }),
    proc("csrss.exe", { pid: 600, exe: null, protected: core("csrss.exe") }),
    proc("winlogon.exe", { pid: 700, exe: "C:\\Windows\\System32\\winlogon.exe", protected: core("winlogon.exe") }),
    ...Array.from({ length: 6 }, () => proc("svchost.exe", { exe: "C:\\Windows\\System32\\svchost.exe", protected: core("svchost.exe") })),
    proc("explorer.exe", {
      exe: "C:\\Windows\\explorer.exe",
      warning: "Your taskbar, desktop and File Explorer windows will close. Windows usually starts them again within a few seconds.",
    }),
    proc("ultimate-pc-tool.exe", { pid: 5000, isSelf: true, protected: selfMsg, exe: "C:\\Users\\me\\AppData\\Local\\Optimo\\ultimate-pc-tool.exe" }),
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

  // ---- Storage data ----
  const cat = (kind, label, group, bytes, files, extra = {}) => ({ kind, label, description: `Leftover ${label.toLowerCase()} that are safe to remove.`, group, needsAdmin: false, suggested: true, locations: [`C:\\Users\\Alex\\AppData\\Local\\${label.replace(/ /g, "")}`], present: true, bytes, files, blocked: null, unmeasured: false, ...extra });
  const cleanupCats = [
    cat("userTemp", "Temporary files", "files", 3.4 * GB, 18234),
    cat("thumbnails", "Thumbnail cache", "files", 0.31 * GB, 42),
    cat("recycleBin", "Recycle Bin", "files", 1.8 * GB, 96, { suggested: false }),
    cat("errorReports", "Error reports", "files", 0.05 * GB, 12),
    cat("edge", "Microsoft Edge cache", "browsers", 0.92 * GB, 5120),
    cat("chrome", "Google Chrome cache", "browsers", 1.2 * GB, 8400, { blocked: "Close Chrome first." }),
    cat("windowsTemp", "Windows temporary files", "windows", 0.6 * GB, 900, { needsAdmin: true, blocked: "Needs administrator rights.", unmeasured: true, bytes: 0 }),
    cat("windowsUpdate", "Windows Update leftovers", "windows", 2.7 * GB, 310, { needsAdmin: true, blocked: "Needs administrator rights." }),
    cat("deliveryOptimization", "Delivery Optimization files", "windows", 0.8 * GB, 40, { needsAdmin: true, blocked: "Needs administrator rights." }),
  ];
  const cleanedKinds = new Set();
  const folderTree = [
    { node: 0, parent: null, name: "C:\\", path: "C:\\", bytes: 620 * GB, files: 912000, folders: 140000 },
    { node: 1, parent: 0, name: "Users", path: "C:\\Users", bytes: 310 * GB, files: 402000, folders: 61000 },
    { node: 2, parent: 0, name: "Program Files", path: "C:\\Program Files", bytes: 128 * GB, files: 210000, folders: 30000 },
    { node: 3, parent: 0, name: "Windows", path: "C:\\Windows", bytes: 34 * GB, files: 180000, folders: 41000 },
    { node: 4, parent: 0, name: "Program Files (x86)", path: "C:\\Program Files (x86)", bytes: 92 * GB, files: 70000, folders: 6000 },
    { node: 5, parent: 0, name: "ProgramData", path: "C:\\ProgramData", bytes: 21 * GB, files: 30000, folders: 2000 },
    { node: 6, parent: 1, name: "Alex", path: "C:\\Users\\Alex", bytes: 300 * GB, files: 390000, folders: 60000 },
    { node: 7, parent: 1, name: "Public", path: "C:\\Users\\Public", bytes: 10 * GB, files: 12000, folders: 1000 },
    { node: 8, parent: 6, name: "Videos", path: "C:\\Users\\Alex\\Videos", bytes: 140 * GB, files: 800, folders: 20 },
    { node: 9, parent: 6, name: "AppData", path: "C:\\Users\\Alex\\AppData", bytes: 96 * GB, files: 360000, folders: 58000 },
    { node: 10, parent: 6, name: "Downloads", path: "C:\\Users\\Alex\\Downloads", bytes: 48 * GB, files: 1900, folders: 60 },
    { node: 11, parent: 6, name: "Documents", path: "C:\\Users\\Alex\\Documents", bytes: 16 * GB, files: 27000, folders: 1900 },
  ];
  const bigFiles = [
    { dir: 8, name: "Holiday 2025.mp4", bytes: 38 * GB },
    { dir: 10, name: "Win11_24H2_English_x64.iso", bytes: 5.8 * GB },
    { dir: 8, name: "Gameplay capture.mkv", bytes: 12.4 * GB },
    { dir: 10, name: "Setup_BigGame.exe", bytes: 3.1 * GB },
    { dir: 0, name: "hiberfil.sys", bytes: 12.7 * GB },
    { dir: 0, name: "pagefile.sys", bytes: 8 * GB },
  ];
  const isInside = (node, root) => {
    for (let n = folderTree[node]; n; n = n.parent === null ? null : folderTree[n.parent]) if (n.node === root) return true;
    return false;
  };
  const folderView = (node) => {
    const f = folderTree[node];
    const children = folderTree.filter((x) => x.parent === node).map((x) => ({ node: x.node, name: x.name, path: x.path, bytes: x.bytes, files: x.files, folders: x.folders, denied: false, hasChildren: folderTree.some((y) => y.parent === x.node) || x.files > 0 }));
    const crumbs = [];
    for (let n = f; n; n = n.parent === null ? null : folderTree[n.parent]) crumbs.unshift({ node: n.node, name: n.name });
    const largestFiles = bigFiles.filter((b) => isInside(b.dir, node)).sort((a, b) => b.bytes - a.bytes).map((b) => ({ ...b, path: `${folderTree[b.dir].path}\\${b.name}`.replace("\\\\", "\\"), modifiedMs: Date.now() - 86400e3 * 40 }));
    const childBytes = children.reduce((s, c) => s + c.bytes, 0);
    const ownBytes = Math.max(0, f.bytes - childBytes - (children.length ? 6 * GB : 0));
    return { node, name: f.name, path: f.path, bytes: f.bytes, files: f.files, folders: f.folders, ownBytes, ownFiles: 14, denied: false, crumbs, children, otherCount: children.length ? 23 : 0, otherBytes: children.length ? 6 * GB : 0, largestFiles };
  };

  const metrics = () => ({ timestampMs: Date.now(), cpuName: "AMD Ryzen 7 7800X3D", cpuTotal: 20 + Math.random() * 30, cpuPerCore: Array.from({ length: 16 }, () => Math.random() * 100), cpuFreqMhz: 4200, memUsed: 14.2 * GB, memTotal: 32 * GB, swapUsed: 1 * GB, swapTotal: 4 * GB, netRxBps: Math.random() * 3e6, netTxBps: Math.random() * 4e5, diskReadBps: Math.random() * 2e7, diskWriteBps: Math.random() * 5e6, disks: [{ name: "Samsung 990 Pro", mount: "C:\\", fileSystem: "NTFS", totalBytes: 1000 * GB, availableBytes: 380 * GB, removable: false }, { name: "Data", mount: "D:\\", fileSystem: "NTFS", totalBytes: 2000 * GB, availableBytes: 90 * GB, removable: false }], temps: [{ label: "CPU Package", celsius: 61 }, { label: "GPU", celsius: 54 }], processCount: procs.length, uptimeSecs: 93784, gpu: { name: "NVIDIA GeForce RTX 4070", load: 10 + Math.random() * 40, memUsed: 3.1 * GB, memTotal: 12 * GB, temperature: 52 } });
  const startup = [
    { name: "Discord", command: "C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe", source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "SecurityHealth", command: "%windir%\\system32\\SecurityHealthSystray.exe", source: "machineRun", location: "Registry (all users)", enabled: true, needsAdmin: true },
    { name: "Spotify", command: '"C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe" /minimized', source: "userRun", location: "Registry (current user)", enabled: false, needsAdmin: false },
    { name: "OneDrive", command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "Steam", command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false },
    { name: "RtkAudUService", command: '"C:\\Windows\\System32\\DriverStore\\FileRepository\\realtekservice.inf_amd64\\RtkAudUService64.exe" -background', source: "machineRun", location: "Registry (all users)", enabled: true, needsAdmin: true },
    { name: "Notes.lnk", command: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Notes.lnk", source: "userFolder", location: "Startup folder (current user)", enabled: true, needsAdmin: false },
  ];
  const settings = { closeAction: null, alerts: { enabled: true, cpuPercent: 90, memoryPercent: 90, temperature: 90, diskFreePercent: 10 }, overlay: false };
  let autostart = false;
  const HOUR = 3600e3;
  const autos = [
    { id: "clean-temp", name: "Clean temporary files", task: { type: "cleanup", kinds: ["userTemp", "thumbnails", "errorReports"] }, schedule: { type: "weekly", day: 0, minute: 720 }, enabled: true, builtin: true, armedAt: 0, lastRun: { at: Date.now() - 50 * HOUR, ok: true, summary: "Freed 2.31 GB (18,204 files)" } },
    { id: "clean-browsers", name: "Clear browser caches", task: { type: "cleanup", kinds: ["edge", "chrome", "brave", "firefox"] }, schedule: { type: "weekly", day: 0, minute: 725 }, enabled: false, builtin: true, armedAt: 0, lastRun: null },
    { id: "check-updates", name: "Check for app updates", task: { type: "checkUpdates" }, schedule: { type: "daily", minute: 600 }, enabled: true, builtin: true, armedAt: 0, lastRun: { at: Date.now() - 5 * HOUR, ok: true, summary: "3 updates available: Google Chrome, Zoom, 7-Zip" } },
    { id: "health-check", name: "Check why the PC is slow", task: { type: "healthCheck" }, schedule: { type: "weekly", day: 1, minute: 660 }, enabled: false, builtin: true, armedAt: 0, lastRun: null },
    { id: "flush-dns", name: "Flush DNS", task: { type: "command", commandId: "builtin.flush-dns" }, schedule: { type: "appStart" }, enabled: false, builtin: true, armedAt: 0, lastRun: null },
    { id: "clean-windows", name: "Clean Windows Update leftovers", task: { type: "cleanup", kinds: ["windowsUpdate", "deliveryOptimization", "windowsTemp"] }, schedule: { type: "weekly", day: 0, minute: 730 }, enabled: true, builtin: true, armedAt: 0, lastRun: { at: Date.now() - 49 * HOUR, ok: false, summary: "Needs administrator rights. Start Optimo as administrator to let this run." } },
  ];
  const autoRunning = new Set();

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
    program("Optimo", "abokhalid", "0.1.0", 12, "2024-02-05", { scope: "user", isSelf: true, canUninstall: false, location: appData("Local\\Optimo") }),
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


  // ---- v0.4: System info, Network, Boost, Privacy ----
  const specs = { manufacturer: "Micro-Star International Co., Ltd.", model: "MS-7E26", pcName: "GAMING-PC", board: "MSI MAG B650 TOMAHAWK WIFI", bios: "American Megatrends 1.A0", biosDate: "2025-03-12", firmware: "UEFI, Secure Boot on", serial: "To be filled by O.E.M.", os: "Microsoft Windows 11 Pro", osVersion: "24H2", osBuild: "26100.2314", osArch: "64-bit", installed: "2024-11-02", lastBoot: "2026-10-21 08:14", cpu: "AMD Ryzen 7 7800X3D 8-Core Processor", cores: 8, threads: 16, maxMhz: 4201, memory: 32 * GB, memorySlots: 4, modules: [{ slot: "DIMM A2", size: 16 * GB, speed: 6000, maker: "G.Skill", part: "F5-6000J3038F16G" }, { slot: "DIMM B2", size: 16 * GB, speed: 6000, maker: "G.Skill", part: "F5-6000J3038F16G" }], gpus: [{ name: "NVIDIA GeForce RTX 4070", driver: "32.0.15.6614", driverDate: "2025-09-30", memory: 12 * GB, resolution: "2560 x 1440", refresh: 165 }], disks: [{ name: "Samsung SSD 990 PRO 1TB", media: "SSD", bus: "NVMe", size: 1000 * GB, health: "Healthy" }, { name: "WDC WD20EZBX", media: "HDD", bus: "SATA", size: 2000 * GB, health: "Healthy" }], battery: null };
  const adapters = [{ index: 12, name: "Wi-Fi", description: "Intel Wi-Fi 6E AX211", wireless: true, linkSpeed: 1.2e9, mac: "A4-C3-F0-11-22-33", ipv4: ["192.168.1.24"], ipv6: [], gateway: ["192.168.1.1"], dns: ["192.168.1.1"], dnsAutomatic: true }];
  const tweaks = [
    ["ads-id", "Turn off the advertising ID", "Apps can't use an ID to show you personalized ads.", "Ads and suggestions", true, false, false, true],
    ["start-suggestions", "No app suggestions in Start", "Stops promoted apps showing in Start.", "Ads and suggestions", true, false, false, false],
    ["explorer-ads", "No OneDrive and Microsoft 365 ads in File Explorer", "Hides sync provider notifications.", "Ads and suggestions", true, false, true, false],
    ["tailored", "No tailored experiences", "Microsoft won't use diagnostic data for tips and ads.", "Privacy", true, false, false, false],
    ["telemetry", "Send only required diagnostic data", "Sends the minimum Windows needs. Needs administrator.", "Privacy", false, true, false, false],
    ["bing", "No Bing web results in Start search", "Start searches only your PC.", "Search and taskbar", true, false, true, false],
  ].map(([id, title, description, group, recommended, admin, explorer, applied]) => ({ id, title, description, group, recommended, admin, explorer, applied }));
  let bloat = [["king.com.CandyCrushSaga", "Candy Crush Saga", true], ["Microsoft.BingNews", "Microsoft News", true], ["Microsoft.BingWeather", "Weather", false], ["Clipchamp.Clipchamp", "Clipchamp", true], ["Microsoft.GetHelp", "Get Help", false]].map(([pkg, label, recommended]) => ({ label, package: pkg, fullName: `${pkg}_1.0_x64__8wekyb3d8bbwe`, family: `${pkg}_8wekyb3d8bbwe`, recommended }));
  const boost = { settings: { powerPlan: true, closeApps: ["OneDrive.exe"], reopenApps: true, pauseServices: true }, state: { active: false, startedAt: 0, previousPlan: null, closed: [], pausedServices: [], done: [] } };
  let speedCancel = false;
  const handlers = {
    get_specs: async () => (await sleep(800), specs),
    get_network_info: () => ({ adapters, wifi: { ssid: window.__MOCK_WIFI_LOCATION__ ? null : "Home-5G", signal: 82, rxMbps: 1201, txMbps: 960, channel: 36, standard: "Wi-Fi 6E", needsLocation: !!window.__MOCK_WIFI_LOCATION__ } }),
    get_public_info: async () => (await sleep(400), { ip: "203.0.113.42", isp: "Example Fiber", city: "Riyadh", country: "SA" }),
    network_speed_test: async ({ onEvent }) => {
      speedCancel = false;
      await sleep(400);
      send(onEvent, { type: "ping", ms: 11.4 });
      for (const [phase, top] of [["download", 480], ["upload", 92]]) {
        for (let i = 1; i <= 10; i++) {
          if (speedCancel) return { pingMs: 11.4, jitterMs: 0, downMbps: 0, upMbps: 0, public: {}, cancelled: true, dataMb: 0 };
          await sleep(250);
          send(onEvent, { type: "progress", phase, mbps: top * (0.7 + i * 0.03), percent: i * 10 });
        }
      }
      return { pingMs: 11.4, jitterMs: 1.8, downMbps: 487.3, upMbps: 94.1, public: { ip: "203.0.113.42", isp: "Example Fiber", city: "Riyadh", country: "SA" }, cancelled: false, dataMb: 312 };
    },
    network_cancel_speed_test: () => {
      speedCancel = true;
    },
    network_connections: () => [
      { name: "chrome.exe", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", pids: [1200, 1300], connections: 24, remotes: ["142.250.74.46", "151.101.1.140", "104.18.32.7", "13.107.42.14"] },
      { name: "Discord.exe", exe: null, pids: [2200], connections: 3, remotes: ["162.159.135.234"] },
      { name: "OneDrive.exe", exe: null, pids: [3300], connections: 2, remotes: ["13.107.42.12"] },
    ],
    network_set_dns: ({ provider }) => {
      if (!window.__MOCK_ELEVATED__) fail("Changing DNS needs administrator rights. Use Restart as administrator first.");
      const servers = { cloudflare: ["1.1.1.1", "1.0.0.1"], google: ["8.8.8.8", "8.8.4.4"], quad9: ["9.9.9.9"], adguard: ["94.140.14.14"] }[provider];
      adapters[0].dnsAutomatic = !servers;
      adapters[0].dns = servers || ["192.168.1.1"];
      return "dns-undo";
    },
    network_dns_benchmark: async ({ current }) => (await sleep(700), [{ provider: null, server: current, ms: 18 }, { provider: "cloudflare", server: "1.1.1.1", ms: 9 }, { provider: "google", server: "8.8.8.8", ms: 14 }, { provider: "quad9", server: "9.9.9.9", ms: 22 }, { provider: "adguard", server: "94.140.14.14", ms: null }]),
    get_boost: () => ({ ...boost, runningApps: [{ name: "chrome.exe", memory: 2.1 * GB, count: 18 }, { name: "OneDrive.exe", memory: 120e6, count: 1 }, { name: "Teams.exe", memory: 640e6, count: 4 }, { name: "Spotify.exe", memory: 310e6, count: 5 }], elevated: !!window.__MOCK_ELEVATED__, highPerformance: true }),
    set_boost_settings: ({ settings }) => {
      boost.settings = settings;
    },
    start_boost: async () => {
      await sleep(600);
      const done = ["Switched to the High performance power plan", "Closed OneDrive"];
      boost.state = { active: true, startedAt: Date.now(), previousPlan: "x", closed: [{ name: "OneDrive.exe", path: null }], pausedServices: [], done };
      return { done, problems: window.__MOCK_ELEVATED__ ? [] : ["Pausing Windows Search and SysMain needs administrator rights, so they were left running."] };
    },
    stop_boost: async () => {
      await sleep(400);
      boost.state = { active: false, startedAt: 0, previousPlan: null, closed: [], pausedServices: [], done: [] };
      return { done: ["Switched back to the Balanced power plan", "Reopened OneDrive"], problems: [] };
    },
    list_privacy_tweaks: () => tweaks,
    set_privacy_tweaks: ({ ids, on }) => {
      tweaks.filter((t) => ids.includes(t.id)).forEach((t) => (t.applied = on));
      return "privacy-undo";
    },
    list_bloat_apps: async () => (await sleep(500), bloat),
    remove_bloat_apps: async ({ targets }) => {
      await sleep(600);
      bloat = bloat.filter((b) => !targets.some((t) => t.fullName === b.fullName));
      return targets.map((t) => ({ label: t.label, error: null }));
    },
    get_app_info: () => ({ elevated: !!window.__MOCK_ELEVATED__, version: "0.4.0" }),
    restart_as_admin: () => fail("You chose No on the administrator prompt, so the app keeps running as before."),
    take_notices: () => (window.__MOCK_NOTICES__ || []).splice(0),
    get_settings: () => ({ ...settings }),
    set_close_action: ({ action }) => {
      settings.closeAction = action;
    },
    set_alerts: ({ alerts }) => {
      settings.alerts = alerts;
    },
    get_autostart: () => autostart,
    set_autostart: ({ enabled }) => {
      autostart = enabled;
    },
    set_overlay: ({ show }) => {
      settings.overlay = show;
    },
    show_main: () => {},
    list_automations: () => autos.map((a) => ({ ...a, running: autoRunning.has(a.id), nextRun: a.enabled && a.schedule.type !== "appStart" ? Date.now() + 26 * HOUR : null })),
    save_automation: ({ automation }) => {
      if (!automation.name.trim()) fail("Give it a name.");
      const i = autos.findIndex((a) => a.id === automation.id);
      if (i >= 0) autos[i] = { ...autos[i], ...automation };
      else autos.push({ ...automation, id: `auto-${Date.now()}`, builtin: false, armedAt: Date.now(), lastRun: null });
    },
    set_automation_enabled: ({ id, enabled }) => {
      autos.find((a) => a.id === id).enabled = enabled;
    },
    delete_automation: ({ id }) => {
      autos.splice(autos.findIndex((a) => a.id === id), 1);
    },
    run_automation: ({ id }) => {
      autoRunning.add(id);
      emit("automations://changed");
      setTimeout(() => {
        autoRunning.delete(id);
        autos.find((a) => a.id === id).lastRun = { at: Date.now(), ok: true, summary: "Finished" };
        emit("automations://changed");
      }, 1200);
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
      if (priority === "realtime") fail("Realtime priority can freeze your PC, so Optimo doesn't offer it.");
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

    // ---- Storage ----
    storage_cleanup_scan: async ({ onEvent }) => {
      const out = [];
      for (const c of cleanupCats) {
        await sleep(90);
        const cat = { ...c, bytes: cleanedKinds.has(c.kind) ? 0 : c.bytes, files: cleanedKinds.has(c.kind) ? 0 : c.files };
        send(onEvent, cat);
        out.push(cat);
      }
      return out;
    },
    storage_cleanup_run: async ({ kinds, onEvent }) => {
      const results = [];
      for (const kind of kinds) {
        const c = cleanupCats.find((x) => x.kind === kind);
        send(onEvent, { type: "started", kind });
        await sleep(500);
        const result = { kind, label: c.label, files: c.files, bytes: cleanedKinds.has(kind) ? 0 : c.bytes, skipped: kind === "userTemp" ? 12 : 0, error: null };
        cleanedKinds.add(kind);
        send(onEvent, { type: "finished", result });
        results.push(result);
      }
      const sum = (k) => results.reduce((s, r) => s + r[k], 0);
      record("Storage", `Cleaned ${results.length} item(s)`, null);
      return { results, bytes: sum("bytes"), files: sum("files"), skipped: sum("skipped") };
    },
    storage_scan: async ({ scanId, path, onEvent }) => {
      for (let i = 1; i <= 8; i++) {
        await sleep(160);
        send(onEvent, { type: "progress", files: i * 41000, folders: i * 5200, bytes: i * 21 * GB, denied: i, current: `${path}Users\\Alex\\AppData\\Local\\Packages\\${i}` });
      }
      const view = folderView(0);
      return { scanId, root: path, bytes: view.bytes, files: view.files, folders: view.folders, denied: 7, links: 3, cancelled: false, elapsedMs: 1400, view };
    },
    storage_cancel_scan: () => {},
    storage_folder: async ({ node }) => {
      await sleep(80);
      return folderView(node);
    },
    storage_check_delete: async ({ target }) => {
      const f = target.type === "folder" ? folderTree.find((x) => x.node === target.node) : { name: target.name, path: `C:\\Users\\Alex\\Downloads\\${target.name}`, bytes: 4.2 * GB, files: 1 };
      return { path: f.path, name: f.name, isFolder: target.type === "folder", bytes: f.bytes, files: f.files, blocked: f.name === "Windows" ? "This is a Windows system folder." : null, warning: null };
    },
    storage_delete: async ({ target }) => {
      await sleep(300);
      const name = target.type === "folder" ? folderTree.find((x) => x.node === target.node).name : target.name;
      const id = record("Storage", `Moved ${name} to the Recycle Bin`, null, { type: "restoreFromRecycleBin", paths: [name], deletedAt: Date.now() });
      return { path: name, bytes: 0, activityId: id };
    },
    storage_reveal: ({ path }) => calls.push({ cmd: "storage_reveal", path }),
    storage_pick_folder: async () => "C:\\Users\\Alex\\Downloads",

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
      if (r.undo?.type === "powerPlan") powerPlan = r.undo.guid;
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

    list_installed_apps: async () => {
      await sleep(250);
      return programs.map(({ handsOver, userCancels, ...p }) => p);
    },
    uninstall_app: async ({ id, quiet }) => {
      const p = programs.find((x) => x.id === id);
      const outcome = { removed: false, pending: false, cancelled: false, restartNeeded: false, message: null };
      if (!p) return { ...outcome, removed: true };
      if (p.isSelf) fail("To remove Optimo, use Settings > Apps > Installed apps in Windows.");
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
