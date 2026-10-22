# Dev tools

`mock-tauri.js` fakes the Rust backend (`window.__TAURI_INTERNALS__`) with sample data so the React UI can run in a normal browser. Every new or changed Tauri command should get a handler here. It also fakes IPC channels (command output, terminal sessions), so streaming works in the browser.

Hooks for manual checks or tests, from the browser console or a Playwright script:

- `window.__mock.emit("app://close-requested")` shows the first-close question; any backend event can be emitted this way.
- `window.__mock.calls` lists `run_command`, `terminal_write`, `terminal_close` and `winget_run` calls.
- `window.__MOCK_ELEVATED__ = true` (set before load) pretends the app runs as administrator.
- `window.__MOCK_NOTICES__ = ["..."]` then `__mock.emit("app://notice")` shows backend notices as toasts.
- `window.__MOCK_NO_WINGET__ = true` (set before load) pretends Windows Package Manager isn't installed, for the Apps page's Updates and Fresh-install toolkit tabs. In the mock, winget jobs for Zoom and Proton VPN fail on purpose, and Spotify's uninstaller hands over to a second window.

`screenshot.cjs` opens each sidebar page in headless Chromium with the mock and saves screenshots:

```bash
pnpm dev &
node dev/screenshot.cjs /tmp/screens dark
node dev/screenshot.cjs /tmp/screens-light light
```

`format.test.ts` holds unit tests for `{variable}` parsing and shell quoting, and `apps.test.ts` covers the Apps page's console emulator, progress parsing, installed-app matching and the toolkit catalog. Run them with `pnpm test` (Node's built-in test runner, Node 22.18 or newer).
