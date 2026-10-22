//! Saved command library and one-shot command execution.

use std::process::Command;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::store;

const FILE: &str = "commands.json";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Powershell,
    Cmd,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub description: String,
    /// May contain `{variable}` placeholders that the UI asks for before running.
    pub command: String,
    pub shell: Shell,
    pub admin: bool,
    pub category: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    /// True when the command was handed to an elevated window, so no output is captured.
    pub elevated: bool,
}

#[derive(Default)]
pub struct CommandLibrary(pub Mutex<Option<Vec<SavedCommand>>>);

fn builtin(name: &str, description: &str, command: &str, admin: bool, category: &str) -> SavedCommand {
    SavedCommand {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        description: description.into(),
        command: command.into(),
        shell: Shell::Powershell,
        admin,
        category: category.into(),
    }
}

fn defaults() -> Vec<SavedCommand> {
    vec![
        builtin("Flush DNS", "Clear the DNS cache to fix sites that won't load", "ipconfig /flushdns", false, "Network"),
        builtin("Show IP configuration", "IP addresses, gateway and DNS for every adapter", "ipconfig /all", false, "Network"),
        builtin("Ping a host", "Check if a website or device responds", "ping -n 4 {host}", false, "Network"),
        builtin("Reset network stack", "Reset Winsock and TCP/IP (restart afterwards)", "netsh winsock reset; netsh int ip reset", true, "Network"),
        builtin("Public IP address", "Show your internet-facing IP", "(Invoke-RestMethod -Uri 'https://api.ipify.org')", false, "Network"),
        builtin("Restart Explorer", "Fix a frozen taskbar or desktop", "Stop-Process -Name explorer -Force; Start-Process explorer", false, "System"),
        builtin("Check system files", "Scan and repair Windows system files (SFC)", "sfc /scannow", true, "Repair"),
        builtin("Repair Windows image", "DISM health restore, run before SFC if it fails", "DISM /Online /Cleanup-Image /RestoreHealth", true, "Repair"),
        builtin("Clear temp files", "Delete files in your temp folder", "Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; 'Temp folder cleaned'", false, "Cleanup"),
        builtin("Battery report", "Generate a battery health report on your desktop", "powercfg /batteryreport /output \"$env:USERPROFILE\\Desktop\\battery-report.html\"", false, "System"),
        builtin("Drive health", "Physical disk health status", "Get-PhysicalDisk | Format-Table FriendlyName, MediaType, HealthStatus, Size -AutoSize | Out-String -Width 200", false, "System"),
        builtin("Update all apps", "Upgrade every installed app with winget", "winget upgrade --all --accept-source-agreements --accept-package-agreements", true, "Apps"),
        builtin("List app updates", "See which apps have updates available", "winget upgrade --accept-source-agreements | Out-String -Width 200", false, "Apps"),
    ]
}

impl CommandLibrary {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<SavedCommand>) -> R) -> R {
        let mut guard = self.0.lock();
        let list = guard.get_or_insert_with(|| {
            store::load(app, FILE).unwrap_or_else(|| {
                let seeded = defaults();
                let _ = store::save(app, FILE, &seeded);
                seeded
            })
        });
        f(list)
    }

    pub fn list(&self, app: &AppHandle) -> Vec<SavedCommand> {
        self.with(app, |list| list.clone())
    }

    pub fn upsert(&self, app: &AppHandle, mut cmd: SavedCommand) -> Result<SavedCommand, String> {
        if cmd.name.trim().is_empty() || cmd.command.trim().is_empty() {
            return Err("Name and command are required".into());
        }
        self.with(app, |list| {
            if cmd.id.is_empty() {
                cmd.id = uuid::Uuid::new_v4().to_string();
            }
            match list.iter_mut().find(|c| c.id == cmd.id) {
                Some(existing) => *existing = cmd.clone(),
                None => list.push(cmd.clone()),
            }
            store::save(app, FILE, list)?;
            Ok(cmd)
        })
    }

    pub fn delete(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.with(app, |list| {
            list.retain(|c| c.id != id);
            store::save(app, FILE, list)
        })
    }
}

#[cfg(windows)]
fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Runs a command to completion and captures its output. Elevated commands open
/// a separate admin PowerShell window (Windows shows the UAC prompt) that stays open.
pub fn run(command: &str, shell: Shell, admin: bool) -> Result<CommandOutput, String> {
    if admin {
        let inner = match shell {
            Shell::Powershell => command.to_string(),
            Shell::Cmd => format!("cmd /c {command}"),
        };
        // -EncodedCommand sidesteps every quoting problem when passing through Start-Process.
        let launcher = format!(
            "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','{}'",
            encode_ps(&inner)
        );
        hidden(Command::new("powershell.exe").args(["-NoProfile", "-Command", &launcher]))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(CommandOutput {
            stdout: "Opened in an administrator window.".into(),
            stderr: String::new(),
            code: None,
            elevated: true,
        });
    }

    let mut cmd = match shell {
        Shell::Powershell => {
            let mut c = Command::new("powershell.exe");
            // Force UTF-8 so non-English output isn't garbled.
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {command}"),
            ]);
            c
        }
        Shell::Cmd => {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", command]);
            c
        }
    };
    let output = hidden(&mut cmd).output().map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code(),
        elevated: false,
    })
}

/// Base64 of the UTF-16LE text, the format `powershell -EncodedCommand` expects.
fn encode_ps(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_like_powershell() {
        // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("dir"))
        assert_eq!(super::encode_ps("dir"), "ZABpAHIA");
        assert_eq!(super::encode_ps("ab"), "YQBiAA==");
    }
}
