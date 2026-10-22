// Unit tests for the Apps page helpers and the Fresh-install toolkit catalog. Run with `pnpm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG, CATALOG_CATEGORIES } from "../src/data/appCatalog.ts";
import { installedCatalogIds } from "../src/pages/apps/match.ts";
import { parseProgress, phaseOf, Screen } from "../src/pages/apps/screen.ts";

test("catalog ids are unique and safe to hand to winget", () => {
  const seen = new Set<string>();
  for (const app of CATALOG) {
    const key = app.id.toLowerCase();
    assert.ok(!seen.has(key), `duplicate id ${app.id}`);
    seen.add(key);
    // Same rule as winget::table::valid_id on the Rust side, which refuses anything else.
    assert.match(app.id, /^[A-Za-z0-9+_][A-Za-z0-9._+-]{0,127}$/, `bad id ${app.id}`);
    if (app.source === "msstore") assert.match(app.id, /^[0-9A-Z]{12}$/, `Store ids are 12 letters and digits: ${app.id}`);
    else assert.ok(app.id.includes("."), `winget ids look like Publisher.App: ${app.id}`);
  }
  assert.ok(CATALOG.length >= 35 && CATALOG.length <= 50, `catalog has ${CATALOG.length} apps`);
});

test("every catalog category has apps and every app has text", () => {
  for (const category of CATALOG_CATEGORIES) assert.ok(CATALOG.some((a) => a.category === category), `${category} is empty`);
  for (const app of CATALOG) {
    assert.ok(CATALOG_CATEGORIES.includes(app.category), `${app.name} has unknown category ${app.category}`);
    assert.ok(app.name.trim() && app.description.trim(), `${app.id} needs a name and description`);
    assert.ok(app.description.length <= 70, `${app.name}'s description is too long for its card`);
    assert.ok(/[.!]$/.test(app.description), `${app.name}'s description should be a sentence`);
    // A global or sticky pattern keeps state between test() calls and would skip matches.
    if (app.match) assert.ok(!app.match.global && !app.match.sticky, `${app.name}'s match pattern can't be /g or /y`);
  }
});

test("catalog name patterns recognize real program names", () => {
  const byId = (id: string) => CATALOG.find((a) => a.id === id)!;
  const cases: [string, string, boolean][] = [
    ["Google.Chrome", "Google Chrome", true],
    ["Mozilla.Firefox", "Mozilla Firefox (x64 en-US)", true],
    ["Microsoft.VisualStudioCode", "Microsoft Visual Studio Code (User)", true],
    ["7zip.7zip", "7-Zip 23.01 (x64)", true],
    ["Python.Python.3.13", "Python 3.13.1 (64-bit)", true],
    ["Python.Python.3.13", "Python 3.12.4 (64-bit)", false],
    ["Git.Git", "Git", true],
    ["Git.Git", "GitHub Desktop", false],
    ["Valve.Steam", "Steam", true],
    ["Valve.Steam", "Steam Link", false],
    ["Notepad++.Notepad++", "Notepad++ (64-bit x64)", true],
  ];
  for (const [id, program, expected] of cases) assert.equal(byId(id).match!.test(program), expected, `${id} vs "${program}"`);
});

test("installed toolkit apps are found by winget id, shortened id or program name", () => {
  const catalog = [
    { id: "Google.Chrome", match: /^Google Chrome$/i },
    { id: "Microsoft.VisualStudioCode" },
    { id: "Mozilla.Firefox", match: /^Mozilla Firefox\b/i },
    { id: "Brave.Brave", match: /^Brave\b/i },
    { id: "Git.Git" },
  ];
  const winget = [
    { id: "google.chrome", partialId: false },
    { id: "Microsoft.VisualStud", partialId: true },
    // Too short to trust as the start of an id.
    { id: "Git", partialId: true },
  ];
  const found = installedCatalogIds(catalog, winget, ["Mozilla Firefox (x64 en-US)", "Bravery Game"]);
  assert.deepEqual([...found].sort(), ["Google.Chrome", "Microsoft.VisualStudioCode", "Mozilla.Firefox"]);
  assert.equal(installedCatalogIds(catalog, [], []).size, 0);
});

test("the console emulator redraws lines in place like a terminal", () => {
  const s = new Screen();
  s.write("\r   - \r   \\ \r          \r");
  s.write("Found Google Chrome [Google.Chrome] Version 121.0\r\n");
  s.write("  ██████▒▒▒▒  10.0 MB / 40.0 MB");
  assert.equal(s.current, "  ██████▒▒▒▒  10.0 MB / 40.0 MB");
  assert.equal(s.status, "Found Google Chrome [Google.Chrome] Version 121.0");
  s.write("\r  ████████████  40.0 MB / 40.0 MB\r\nSuccessfully verified installer hash\r\n");
  assert.equal(s.text(), "Found Google Chrome [Google.Chrome] Version 121.0\nSuccessfully verified installer hash");

  const b = new Screen();
  b.write("abc\b\bX\n");
  assert.deepEqual(b.lines, ["aXc"]);
});

test("escape codes are dropped, even when split across chunks", () => {
  const s = new Screen();
  s.write("\x1b[2KStarting \x1b[3");
  s.write("2mpackage\x1b[0m install...\x1b]0;title\x07\n");
  assert.deepEqual(s.lines, ["Starting package install..."]);
});

test("progress comes from sizes or percentages", () => {
  assert.equal(parseProgress("  ██▒▒  10.0 MB / 40.0 MB"), 0.25);
  assert.equal(parseProgress("  ██▒▒  512 KB / 1.00 MB"), 0.5);
  assert.equal(parseProgress("  ██▒▒  52,3 MB / 104,6 MB"), 0.5);
  assert.equal(parseProgress("  ██▒▒  45%"), 0.45);
  assert.equal(parseProgress("  ██▒▒  100%"), 1);
  assert.equal(parseProgress("Starting package install..."), null);
});

test("the phase follows what winget prints", () => {
  assert.equal(phaseOf("  ██▒▒  1.0 MB / 9.0 MB", "Downloading https://example.com/setup.exe"), "downloading");
  assert.equal(phaseOf("", "Successfully verified installer hash"), "verifying");
  assert.equal(phaseOf("", "Starting package install..."), "installing");
  assert.equal(phaseOf("", "Found Google Chrome [Google.Chrome] Version 121.0"), "preparing");
  assert.equal(phaseOf("", ""), "preparing");
});
