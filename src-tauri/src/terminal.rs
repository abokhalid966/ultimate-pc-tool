//! Built-in terminal: real pseudo-console sessions (ConPTY on Windows) streamed to xterm.js.
//! Each session sends its output through its own IPC channel, which exists before the session
//! starts, so the shell's first output (its banner and prompt) is never lost.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    Output { data: String },
    Exit { code: Option<u32> },
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

fn shell_program(shell: &str) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = match shell {
            "cmd" => CommandBuilder::new(crate::os::cmd_exe()),
            "wsl" => CommandBuilder::new(crate::os::wsl_exe()),
            _ => {
                let mut c = CommandBuilder::new(crate::os::powershell_exe());
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
pub(crate) fn take_valid_utf8(buf: &mut Vec<u8>) -> String {
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
    pub fn spawn(&self, app: AppHandle, shell: &str, rows: u16, cols: u16, events: Channel<TermEvent>) -> Result<u32, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(shell_program(shell)).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let killer = child.clone_killer();

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let exit_code: Arc<OnceLock<u32>> = Arc::default();
        // Registered before the threads start, so the exit waiter always finds it.
        self.sessions.lock().insert(id, Session { master: pair.master, writer, killer });

        let code = exit_code.clone();
        let reader_thread = thread::Builder::new().name(format!("pty-reader-{id}")).spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&chunk[..n]);
                        let data = take_valid_utf8(&mut pending);
                        if !data.is_empty() && events.send(TermEvent::Output { data }).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = events.send(TermEvent::Exit { code: code.get().copied() });
        });

        // ConPTY keeps the output pipe open after the shell exits, until the pseudo-console is
        // closed. So wait for the shell itself, then close its session: the reader gets EOF.
        let waiter_thread = reader_thread.and_then(|_| {
            thread::Builder::new().name(format!("pty-waiter-{id}")).spawn(move || {
                if let Ok(status) = child.wait() {
                    let _ = exit_code.set(status.exit_code());
                }
                // Take it out first and drop it outside the lock: closing the console can block.
                let session = app.state::<Terminals>().sessions.lock().remove(&id);
                drop(session);
            })
        });
        if let Err(e) = waiter_thread {
            self.close(id);
            return Err(e.to_string());
        }
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
        // Its own statement, so the lock is released before the session is killed and dropped.
        let session = self.sessions.lock().remove(&id);
        if let Some(mut session) = session {
            let _ = session.killer.kill();
        }
    }

    /// Ends every session, e.g. when the page reloads and no tab is left to own them.
    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock());
        for (_, mut session) in sessions {
            let _ = session.killer.kill();
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
