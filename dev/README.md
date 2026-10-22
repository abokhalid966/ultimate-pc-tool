# Dev tools

`mock-tauri.js` fakes the Rust backend (`window.__TAURI_INTERNALS__`) with sample data so the React UI can run in a normal browser. Every new or changed Tauri command should get a handler here. It also fakes IPC channels (command output, terminal sessions), so streaming works in the browser.

Hooks for manual checks or tests, from the browser console or a Playwright script:

- `window.__mock.emit("app://close-requested")` shows the first-close question; any backend event can be emitted this way.
- `window.__mock.calls` lists `run_command`, `terminal_write` and `terminal_close` calls.
- `window.__MOCK_ELEVATED__ = true` (set before load) pretends the app runs as administrator.
- `window.__MOCK_NOTICES__ = ["..."]` then `__mock.emit("app://notice")` shows backend notices as toasts.
- PC health: the speed check streams progress for about five seconds and reports issues that match the rest of the mock (busy Chrome, nearly full D:, temp files, Power saver, six startup apps). Fixing one clears it on the next check. `window.__MOCK_HEALTH__ = "clear"` (set before load) reports a healthy PC, and `"restart"` adds updates waiting on a restart. `restart_pc` and `open_windows_settings` calls are listed in `__mock.calls`.

`screenshot.cjs` opens each sidebar page in headless Chromium with the mock and saves screenshots:

```bash
pnpm dev &
node dev/screenshot.cjs /tmp/screens dark
node dev/screenshot.cjs /tmp/screens-light light
```

`format.test.ts` holds unit tests for `{variable}` parsing and shell quoting. Run them with `pnpm test` (Node's built-in test runner, Node 22.18 or newer).
