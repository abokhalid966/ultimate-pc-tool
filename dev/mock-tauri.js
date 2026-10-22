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

    list_activity: () => activity,
    undo_activity: ({ id }) => {
      const r = activity.find((a) => a.id === id);
      if (!r) fail("Activity entry not found");
      if (r.undo?.type === "restoreCommand") commands.push(r.undo.command);
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
