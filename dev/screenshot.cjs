// Renders the UI in headless Chromium against dev/mock-tauri.js (fake backend data)
// and saves one PNG per sidebar page, plus a few interaction states (details pane, command
// output, dialogs, palette) and the same at the smallest window size. Usage:
//   pnpm dev   (in another shell, serves http://localhost:1420)
// Set SCREENSHOT_URL to use another server, e.g. `pnpm vite --port 1450` + SCREENSHOT_URL=http://localhost:1450
//   node dev/screenshot.cjs <outDir> [light|dark]
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright");

(async () => {
  const out = path.resolve(process.argv[2] || "dev/screens");
  const scheme = process.argv[3] || "dark";
  require("fs").mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript({ path: path.join(__dirname, "mock-tauri.js") });
  await page.goto(process.env.SCREENSHOT_URL || "http://localhost:1420");
  await page.waitForTimeout(3500);

  const shot = (file) => page.screenshot({ path: path.join(out, file) });
  const go = async (label) => {
    await page.click(`.nav-item:has-text("${label}")`);
    await page.waitForTimeout(900);
  };

  const labels = await page.$$eval(".nav-item", (els) => els.map((e) => e.textContent.trim()));
  for (const [i, label] of labels.entries()) {
    await page.click(`.nav-item >> nth=${i}`);
    await page.waitForTimeout(1200);
    await shot(`${String(i + 1).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
  }

  // Interaction states.
  await go("Processes");
  await page.click('tr:has-text("Discord.exe")');
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  await shot("20-processes-details.png");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  await shot("21-end-process-dialog.png");
  await page.keyboard.press("Escape");

  await go("Quick fixes");
  await page.click('[aria-label="Run Flush DNS"]');
  await page.waitForTimeout(1200);
  await shot("22-command-output.png");
  await page.click('[aria-label="Run Ping a host"]');
  await page.waitForTimeout(300);
  await shot("23-command-variable.png");
  await page.keyboard.press("Escape");

  await go("Dashboard");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await shot("24-palette-empty.png");
  await page.keyboard.press("Escape");

  await go("PC health");
  await page.click('button:has-text("Run speed check")');
  await page.waitForTimeout(2200);
  await shot("25-health-running.png");
  await page.waitForTimeout(3500);
  await shot("26-health-results.png");

  // Smallest window (minWidth 960 minus the window frame).
  await page.setViewportSize({ width: 944, height: 600 });
  for (const label of ["Dashboard", "Processes", "Startup apps", "Quick fixes"]) {
    await go(label);
    await shot(`30-narrow-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
  }
  await go("Processes");
  await page.click('tr:has-text("Discord.exe")');
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await shot("31-narrow-processes-details.png");
  await go("Quick fixes");
  await page.click('[aria-label="Run Flush DNS"]');
  await page.waitForTimeout(1000);
  await shot("32-narrow-command-output.png");

  await page.setViewportSize({ width: 1280, height: 820 });
  await go("Dashboard");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("kill chr");
  await page.waitForTimeout(300);
  await shot("99-palette.png");
  console.log(JSON.stringify({ out, pages: labels, errors }, null, 2));
  await browser.close();
})();
