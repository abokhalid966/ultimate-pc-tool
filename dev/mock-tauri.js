// Fake Tauri backend for running the UI in a plain browser (see dev/README.md).
window.__TAURI_INTERNALS__ = (() => {
  let cb = 0; const cbs = {}; const listeners = {};
  const GB = 1024 ** 3;
  const procs = Array.from({ length: 40 }, (_, i) => ({ pid: 1000 + i, parentPid: 4, name: ["chrome.exe","Code.exe","explorer.exe","Discord.exe","svchost.exe","steam.exe"][i % 6], cpu: Math.random() * 8, memory: Math.random() * 600e6, diskRead: Math.random() * 1e5, diskWrite: 0, exe: "C:\\Program Files\\App\\app.exe", cmd: "app.exe --flag", status: "Run", startTime: 1760000000 }));
  const metrics = () => ({ timestampMs: Date.now(), cpuName: "AMD Ryzen 7 7800X3D", cpuTotal: 20 + Math.random() * 30, cpuPerCore: Array.from({ length: 16 }, () => Math.random() * 100), cpuFreqMhz: 4200, memUsed: 14.2 * GB, memTotal: 32 * GB, swapUsed: 1 * GB, swapTotal: 4 * GB, netRxBps: Math.random() * 3e6, netTxBps: Math.random() * 4e5, diskReadBps: Math.random() * 2e7, diskWriteBps: Math.random() * 5e6, disks: [{ name: "Samsung 990 Pro", mount: "C:\\", fileSystem: "NTFS", totalBytes: 1000 * GB, availableBytes: 380 * GB, removable: false }, { name: "Data", mount: "D:\\", fileSystem: "NTFS", totalBytes: 2000 * GB, availableBytes: 90 * GB, removable: false }], temps: [{ label: "CPU Package", celsius: 61 }, { label: "GPU", celsius: 54 }], processCount: 241, uptimeSecs: 93784 });
  const commands = [{ id: "1", name: "Flush DNS", description: "Clear the DNS cache", command: "ipconfig /flushdns", shell: "powershell", admin: false, category: "Network" }, { id: "2", name: "Ping a host", description: "Check if a site responds", command: "ping -n 4 {host}", shell: "powershell", admin: false, category: "Network" }, { id: "3", name: "Check system files", description: "SFC scan", command: "sfc /scannow", shell: "powershell", admin: true, category: "Repair" }];
  const startup = [{ name: "Discord", command: "C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe", source: "userRun", location: "Registry (current user)", enabled: true, needsAdmin: false }, { name: "SecurityHealth", command: "%windir%\\system32\\SecurityHealthSystray.exe", source: "machineRun", location: "Registry (all users)", enabled: true, needsAdmin: true }, { name: "Spotify", command: "Spotify.exe /minimized", source: "userRun", location: "Registry (current user)", enabled: false, needsAdmin: false }];
  const handlers = {
    get_overview: () => ({ hostName: "ABOKHALID-PC", osName: "Windows", osVersion: "Windows 11 Pro 24H2", kernelVersion: "26100", cpuName: "AMD Ryzen 7 7800X3D", physicalCores: 8, logicalCores: 16, memTotal: 32 * GB }),
    get_metrics: metrics, list_processes: () => procs, list_commands: () => commands, list_startup_items: () => startup,
    list_activity: () => [{ id: "a", timestamp: new Date().toISOString(), category: "Startup", description: 'Disabled startup app "Spotify"', undo: {}, undone: false }],
    run_command: () => ({ stdout: "Windows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.", stderr: "", code: 0, elevated: false }),
    terminal_spawn: () => { setTimeout(() => (listeners["terminal://output"] || []).forEach((h) => cbs[h]({ payload: { id: 1, data: "Windows PowerShell\r\nPS C:\\Users\\abokhalid> " } })), 300); return 1; },
    "plugin:event|listen": (a) => { (listeners[a.event] ||= []).push(a.handler); return 1; },
    "plugin:event|unlisten": () => null,
  };
  setInterval(() => (listeners["metrics://update"] || []).forEach((h) => cbs[h] && cbs[h]({ event: "metrics://update", payload: metrics() })), 1000);
  setTimeout(() => (listeners["terminal://output"] || []).forEach((h) => cbs[h]({ payload: { id: 1, data: "Windows PowerShell\r\nPS C:\\Users\\abokhalid> " } })), 1500);
  return {
    transformCallback: (f) => { cb++; cbs[cb] = f; return cb; },
    unregisterCallback: () => {},
    invoke: async (cmd, args) => (handlers[cmd] ? handlers[cmd](args) : null),
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  };
})();
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
