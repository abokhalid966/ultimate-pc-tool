//! Built-in terminal: real pseudo-console sessions (ConPTY on Windows) streamed to xterm.js.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;

use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const OUTPUT_EVENT: &str = "terminal://output";
pub const EXIT_EVENT: &str = "terminal://exit";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Serialize, Clone)]
struct Output {
    id: u32,
    data: String,
}

fn shell_program(shell: &str) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = match shell {
            "cmd" => CommandBuilder::new("cmd.exe"),
            "wsl" => CommandBuilder::new("wsl.exe"),
            _ => {
                let mut c = CommandBuilder::new("powershell.exe");
                c.arg("-NoLogo");
                c
            }
        };
        if let Some(home) = std::env::var_os("USERPROFILE") {
            cmd.cwd(home);
        }
        cmd
    }
    #[cfg(not(windows))]
    {
        let _ = shell;
        let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        if let Some(home) = std::env::var_os("HOME") {
            cmd.cwd(home);
        }
        cmd
    }
}

/// Splits off any incomplete UTF-8 sequence at the end of `buf` so it can be
/// completed by the next read instead of turning into replacement characters.
fn take_valid_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let s = s.to_owned();
            buf.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            s
        }
    }
}

impl Terminals {
    pub fn spawn(&self, app: AppHandle, shell: &str, rows: u16, cols: u16) -> Result<u32, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(shell_program(shell)).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut chunk = [0u8; 8192];
                let mut pending = Vec::new();
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            pending.extend_from_slice(&chunk[..n]);
                            let data = take_valid_utf8(&mut pending);
                            if !data.is_empty() {
                                let _ = app.emit(OUTPUT_EVENT, Output { id, data });
                            }
                        }
                    }
                }
                let _ = app.emit(EXIT_EVENT, id);
            })
            .map_err(|e| e.to_string())?;

        self.sessions.lock().insert(id, Session { master: pair.master, writer, child });
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions.get_mut(&id).ok_or("Terminal session has ended")?;
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock();
        let session = sessions.get(&id).ok_or("Terminal session has ended")?;
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u32) {
        if let Some(mut session) = self.sessions.lock().remove(&id) {
            let _ = session.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::take_valid_utf8;

    #[test]
    fn keeps_partial_utf8_for_next_read() {
        let bytes = "é".as_bytes();
        let mut buf = vec![b'a', bytes[0]];
        assert_eq!(take_valid_utf8(&mut buf), "a");
        buf.push(bytes[1]);
        assert_eq!(take_valid_utf8(&mut buf), "é");
        assert!(buf.is_empty());
    }
}
