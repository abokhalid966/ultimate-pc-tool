# Ultimate PC Tool

An all-in-one Windows utility: live system monitor, process manager, saved commands, a built-in terminal and a startup apps manager, all reachable from one Ctrl+K command palette.

Built with [Tauri 2](https://tauri.app) (Rust) and React + TypeScript. The installer is around 10 MB and the app idles at low memory.

## Features (v0.1)

| Area | What it does |
|---|---|
| **Dashboard** | A plain-language health check ("Your PC is running smoothly", or what needs attention with a one-click fix), live CPU and memory gauges, network and disk graphs, top apps, drive space and sensor temperatures |
| **Processes** | Search, sort, group by app, end one or all instances, change priority, open file location |
| **Quick fixes** | Library of one-click fixes (flush DNS, SFC, DISM, winget upgrades...) plus your own commands with `{variables}`, optionally run as administrator |
| **Terminal** | Real PowerShell, Command Prompt and WSL tabs inside the app |
| **Startup apps** | Turn apps on or off at Windows startup, using the same mechanism as Task Manager |
| **Activity** | A log of every change the app made, with undo for startup changes, priority changes and deleted commands |
| **Command palette** | Ctrl+K anywhere: jump to a page, run a saved command, `kill chrome`, or `>` followed by any command to run it in the terminal |
| **Tray** | Closing the window can keep the app in the tray (it asks the first time), with CPU/RAM in the tooltip |
| **Settings** | Light, dark or follow-Windows theme, what the close button does, keyboard shortcuts and version info |

## Download

Every push to `main` builds a Windows installer on GitHub Actions. Open the **Actions** tab, pick the latest successful **Build Windows installer** run, and download `ultimate-pc-tool-windows` from its artifacts. Pushing a tag like `v0.1.0` also creates a draft GitHub release with the installer attached.

The app is not code-signed yet, so Windows SmartScreen will show a warning on first run ("More info" then "Run anyway").

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
src-tauri/src/
  metrics.rs         1-second sampler for system stats and the process table
  processes.rs       End process, priority, open location
  commands.rs        Saved command library and command runner
  terminal.rs        Pseudo-console terminal sessions
  startup.rs         Startup apps (registry + startup folders)
  actions.rs         Activity log and undo
  tray.rs            Tray icon and live tooltip
```

User data (saved commands, activity log) is stored as JSON in `%APPDATA%\com.abokhalid.ultimatepctool`.

## Roadmap

See the project plan. Next up: "Why is my PC slow?" diagnosis, services manager, installed apps via winget, cleanup and disk usage map, GPU stats and alerts.
