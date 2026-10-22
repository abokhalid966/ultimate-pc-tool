# Ultimate PC Tool

An all-in-one Windows utility: live system monitor, process manager, saved commands, a built-in terminal and a startup apps manager, all reachable from one Ctrl+K command palette.

Built with [Tauri 2](https://tauri.app) (Rust) and React + TypeScript. The installer is around 10 MB and the app idles at low memory.

## Features (v0.1)

| Area | What it does |
|---|---|
| **Dashboard** | Live CPU (per thread), memory, network, disk activity, drive space and sensor temperatures, with one-minute graphs |
| **Processes** | Search, sort, group by app, end one or all instances, change priority, open file location |
| **Commands** | Library of one-click fixes (flush DNS, SFC, DISM, winget upgrades...) plus your own commands with `{variables}`, optionally run as administrator |
| **Terminal** | Real PowerShell, Command Prompt and WSL tabs inside the app |
| **Startup apps** | Turn apps on or off at Windows startup, using the same mechanism as Task Manager |
| **Activity** | A log of every change the app made, with undo for startup changes |
| **Command palette** | Ctrl+K anywhere: jump to a page, run a saved command, `kill chrome`, or `>` followed by any command to run it in the terminal |
| **Tray** | Closing the window keeps the app in the tray, with CPU/RAM/temperature in the tooltip |

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

Some actions (changing all-users startup entries, ending system processes) need the app to run as administrator. Everything else works as a normal user.

## Project layout

```
src/                 React UI
  pages/             Dashboard, Processes, Commands, Terminal, Startup, Activity
  components/        Command palette, charts, modals, toasts
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
