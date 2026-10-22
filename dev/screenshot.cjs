// Renders the UI in headless Chromium against dev/mock-tauri.js (fake backend data)
// and saves one PNG per sidebar page. Usage:
//   pnpm dev   (in another shell, serves http://localhost:1420)
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
  await page.goto("http://localhost:1420");
  await page.waitForTimeout(3500);

  const labels = await page.$$eval(".nav-item", (els) => els.map((e) => e.textContent.trim()));
  for (const [i, label] of labels.entries()) {
    await page.click(`.nav-item >> nth=${i}`);
    await page.waitForTimeout(1200);
    const file = `${String(i + 1).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
    await page.screenshot({ path: path.join(out, file) });
  }
  await page.keyboard.press("Control+k");
  await page.keyboard.type("kill chr");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, "99-palette.png") });
  console.log(JSON.stringify({ out, pages: labels, errors }, null, 2));
  await browser.close();
})();
