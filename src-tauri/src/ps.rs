//! Runs short PowerShell scripts that print JSON, for Windows details that have no simple API.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::os;

/// Runs `script` hidden and parses what it prints as JSON. The script should end with
/// `ConvertTo-Json`. Errors carry PowerShell's own message.
pub fn json(script: &str, timeout: Duration) -> Result<serde_json::Value, String> {
    let (out, err) = run(script, timeout)?;
    let text = out.trim();
    if text.is_empty() {
        let err = err.trim();
        return Err(if err.is_empty() { "Windows didn't return any details.".into() } else { first_line(err) });
    }
    serde_json::from_str(text).map_err(|e| format!("Couldn't read the details Windows returned: {e}"))
}

/// Runs `script` hidden; Ok holds (output, errors) whatever the exit code.
pub fn run(script: &str, timeout: Duration) -> Result<(String, String), String> {
    let full = format!("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; {script}");
    let mut cmd = Command::new(os::powershell_exe());
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::commands::encode_ps(&full)])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start PowerShell: {e}"))?;
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Windows took too long to answer. Try again.".into());
            }
            Err(e) => return Err(format!("Couldn't run PowerShell: {e}")),
        }
    }
    Ok((os::decode_output(&stdout.join().unwrap_or_default()), os::decode_output(&stderr.join().unwrap_or_default())))
}

/// Text for a PowerShell single-quoted string.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(s).to_string()
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}
