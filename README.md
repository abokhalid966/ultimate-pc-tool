# Optimo

An all-in-one Windows utility: live system monitor, PC health check, cleanup and disk space finder, apps, services and startup managers, scheduled automations, alerts and a mini overlay, all reachable from one Ctrl+K command palette.

Built with [Tauri 2](https://tauri.app) (Rust) and React + TypeScript. The installer is around 10 MB and the app idles at low memory.

## Features (v0.5)

| Area | What it does |
|---|---|
| **Dashboard** | A plain-language health check ("Your PC is running smoothly", or what needs attention with a one-click fix), live CPU and memory gauges, network and disk graphs, top apps, drive space and sensor temperatures |
| **PC health** | "Why is my PC slow?": a five-second speed check that gives a 0-100 score and ranked, plain-language issues (apps hogging the processor or memory, full drives, too many startup apps, pending restarts and updates, temp files, Power saver, heat, a busy hard disk), each with a one-click fix and "Fix all safe items" |
| **Graphics card** | GPU load, video memory and temperature on the Dashboard and in the mini overlay |
| **System info** | Everything inside the PC in plain words: processor, memory sticks and speed, graphics card and driver, drives and their health, Windows version, motherboard and BIOS, battery health and the full Windows battery report. "Copy specs" puts a short summary on the clipboard (without the serial number) |
| **Network** | Wi-Fi or Ethernet details, public IP and provider, an internet speed test (download, upload, ping) with live progress, a DNS switcher (Cloudflare, Google, Quad9, AdGuard or automatic, with undo) and DNS speed test, and the apps that are online right now |
| **Processes** | Search, sort, group by app, end one or all instances, change priority, open file location |
| **Quick fixes** | Library of one-click fixes (flush DNS, SFC, DISM, winget upgrades...) plus your own commands with `{variables}`, optionally run as administrator |
| **Terminal** | Real PowerShell, Command Prompt and WSL tabs inside the app |
| **Startup apps** | Turn apps on or off at Windows startup, using the same mechanism as Task Manager |
| **Apps** | Every installed app with its size and install date, and an Uninstall button that runs the app's own uninstaller; app updates through winget (one at a time or all at once, with live progress); and a Fresh-install toolkit to install popular apps in one go |
| **Drivers** | Devices that aren't working (no driver, stopped by Windows...) and drivers from device makers that look out of date, each with the right download page: NVIDIA, AMD or Intel's own tools, your PC or motherboard maker's support site, or Windows Update |
| **Services** | Every Windows service with a plain-language explanation, start, stop and restart, and change how it starts (with undo) |
| **Storage** | Safe cleanup of temp files, caches, browser caches, the Recycle Bin and Windows Update leftovers; a Space finder that scans a drive or folder and shows a map of the biggest folders and largest files, with Move to Recycle Bin and undo; and a Duplicate finder that compares files byte for byte and moves the extra copies to the Recycle Bin (always keeping one), with undo |
| **Boost** | One-click game mode: switches to the High performance power plan, closes the apps you pick, and pauses Windows Search indexing and SysMain. One more click (or the tray icon) puts everything back and reopens the apps |
| **Privacy** | 17 plain-language switches for Windows ads, suggestions, tracking, Bing in Start search and the Copilot button, with "Apply recommended" and undo; and a remover for preinstalled extras like Candy Crush, Clipchamp and Microsoft News |
| **Automations** | Routine jobs on a schedule: clean temporary files weekly, clear browser caches, check for app updates daily, run the speed check, or any of your saved commands, when Optimo starts, daily, weekly or every few hours. Missed runs catch up the next time the app is open |
| **Alerts** | Windows notifications when the processor or memory stays maxed out, the PC runs hot, or a drive is almost full (limits in Settings) |
| **Mini overlay** | A small always-on-top box with CPU, memory, network and temperature. Drag it anywhere; toggle it from Settings, the tray or Ctrl+K |
| **Start with Windows** | Optional: opens quietly in the tray at sign-in so alerts and automations keep working |
| **Activity** | A log of every change the app made, with undo for startup changes, priority changes, service changes, power plans, DNS changes, privacy settings, deleted commands and files moved to the Recycle Bin. Automation runs are logged here too |
| **Command palette** | Ctrl+K anywhere: jump to a page, run a saved command, `kill chrome`, or `>` followed by any command to run it in the terminal |
| **Tray** | Closing the window can keep the app in the tray (it asks the first time), with CPU/RAM in the tooltip |
| **Settings** | Theme, close button, start with Windows, mini overlay, alert limits, keyboard shortcuts and version info |

## Download and install

1. Open the [latest release](https://github.com/abokhalid966/ultimate-pc-tool/releases/latest).
2. Under **Assets**, download the file ending in `_x64-setup.exe`.
3. Run it. The app is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**.
4. Updating from an older version: just run the new installer. If you had the old "Ultimate PC Tool", uninstall it first in Windows **Settings > Apps > Installed apps** (your saved commands and settings are kept).
5. The installer adds Optimo to the Start menu. Some actions (all-users startup apps, services, Windows temp cleanup) need **Restart as administrator** from the sidebar.

Every push to `main` also builds the installer on GitHub Actions (download `optimo-windows` from the run's artifacts), and each push to `main` publishes the release for the version in `src-tauri/tauri.conf.json`.

## Develop

Prerequisites on Windows: [Rust](https://rustup.rs), [Node.js 22+](https://nodejs.org), [pnpm](https://pnpm.io) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Microsoft C++ Build Tools and WebView2, already present on Windows 11).

```powershell
pnpm install
pnpm tauri dev      # run with hot reload
pnpm tauri build    # produce the installer in src-tauri/target/release/bundle
```

Changing all-users startup entries needs administrator rights: use **Restart as administrator** in the sidebar or the command palette. Everything else works as a normal user. Core Windows processes (and the app's own processes) are protected and can't be ended from the app, even as administrator.

## Project layout

```
src/                 React UI
  pages/             Dashboard, Processes, Quick fixes (Commands.tsx), Terminal, Startup, Activity, Settings
  components/        Command palette, charts and gauges, menus, modals, toasts, empty states
  styles.css         Design tokens (light and dark) and all styles
  theme.ts           Follows the Windows light/dark setting, or the choice in Settings
  api.ts             Typed wrappers around the Rust commands
  data/appCatalog.ts The Fresh-install toolkit's app list
src-tauri/src/
  metrics.rs         1-second sampler for system stats and the process table
  health.rs          PC health speed check, power plan switch, restart
  processes.rs       End process, priority, open location
  commands.rs        Saved command library and command runner
  terminal.rs        Pseudo-console terminal sessions
  startup.rs         Startup apps (registry + startup folders)
  apps.rs            Installed apps (Uninstall registry keys) and uninstalling
  winget.rs          winget updates and installs, with table parsing in winget/table.rs
  actions.rs         Activity log and undo
  tray.rs            Tray icon and live tooltip
```

User data (saved commands, activity log) is stored as JSON in `%APPDATA%\com.abokhalid.ultimatepctool`.

## Roadmap

See the project plan. Next up: built-in updates and code signing.
