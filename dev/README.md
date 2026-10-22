# Dev tools

`mock-tauri.js` fakes the Rust backend (`window.__TAURI_INTERNALS__`) with sample data so the React UI can run in a normal browser. Every new Tauri command should get a handler here.

`screenshot.cjs` opens each sidebar page in headless Chromium with the mock and saves screenshots:

```bash
pnpm dev &
node dev/screenshot.cjs /tmp/screens dark
node dev/screenshot.cjs /tmp/screens-light light
```
