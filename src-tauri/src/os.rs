//! Windows helpers: system paths, elevation, and starting programs as administrator.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The Windows folder (e.g. `C:\Windows`), asked from the system rather than `%SystemRoot%`.
pub fn windows_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(query_windows_dir)
}

#[cfg(windows)]
fn query_windows_dir() -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;

    let mut buf = [0u16; 260];
    let len = unsafe { GetSystemWindowsDirectoryW(Some(&mut buf)) } as usize;
    if len > 0 && len < buf.len() {
        return std::ffi::OsString::from_wide(&buf[..len]).into();
    }
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| r"C:\Windows".into())
}

#[cfg(not(windows))]
fn query_windows_dir() -> PathBuf {
    PathBuf::from("/")
}

/// Full path of a program under the Windows folder, falling back to a PATH lookup of `name`.
fn system_program(relative: &str, name: &str) -> PathBuf {
    let path = windows_dir().join(relative);
    if path.is_file() { path } else { name.into() }
}

/// Windows PowerShell 5.1. It lives outside System32, so a broken PATH would otherwise hide it.
pub fn powershell_exe() -> PathBuf {
    system_program(r"System32\WindowsPowerShell\v1.0\powershell.exe", "powershell.exe")
}

pub fn cmd_exe() -> PathBuf {
    system_program(r"System32\cmd.exe", "cmd.exe")
}

pub fn wsl_exe() -> PathBuf {
    system_program(r"System32\wsl.exe", "wsl.exe")
}

/// True when this app runs with administrator rights (an elevated token).
pub fn is_elevated() -> bool {
    static ELEVATED: OnceLock<bool> = OnceLock::new();
    *ELEVATED.get_or_init(query_elevated)
}

#[cfg(windows)]
fn query_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut _),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
fn query_elevated() -> bool {
    false
}

pub enum ElevateError {
    /// The user answered No on the UAC prompt.
    Cancelled,
    Failed(String),
}

/// Starts `file` as administrator in its own window. Blocks until the UAC prompt is answered.
#[cfg(windows)]
pub fn run_elevated(file: &Path, params: &str) -> Result<(), ElevateError> {
    use windows::Win32::Foundation::ERROR_CANCELLED;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize};
    use windows::Win32::UI::Shell::{SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HRESULT, PCWSTR, w};

    let file = wide(file.as_os_str());
    let params = wide(std::ffi::OsStr::new(params));
    unsafe {
        // ShellExecuteEx may hand off to COM-based shell extensions.
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        let result = ShellExecuteExW(&mut info);
        if com.is_ok() {
            CoUninitialize();
        }
        match result {
            Ok(()) => Ok(()),
            Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Err(ElevateError::Cancelled),
            Err(e) => Err(ElevateError::Failed(e.message())),
        }
    }
}

#[cfg(not(windows))]
pub fn run_elevated(_file: &Path, _params: &str) -> Result<(), ElevateError> {
    Err(ElevateError::Failed("Running as administrator is only supported on Windows".into()))
}

/// NUL-terminated UTF-16 for Win32 calls.
#[cfg(windows)]
pub fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain([0]).collect()
}

/// Waits (up to `timeout`) for a process to exit. Used after "Restart as administrator", so the
/// new instance starts only once the old one has released the single-instance lock.
#[cfg(windows)]
pub fn wait_for_exit(pid: u32, timeout: std::time::Duration) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};

    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(handle, timeout.as_millis().min(u32::MAX as u128) as u32);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
pub fn wait_for_exit(_pid: u32, _timeout: std::time::Duration) {}

/// Lowers the calling thread's priority, for background work like sensor polling.
pub fn lower_thread_priority() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_LOWEST};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    }
}

/// Decodes console program output. Expects UTF-8 (both shells are switched to it), but falls back
/// to the OEM code page (e.g. 720 on Arabic Windows) for tools that ignore the console setting.
pub fn decode_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    let lossy = String::from_utf8_lossy(bytes);
    // Real UTF-8 with a few bad bytes still contains valid multi-byte characters.
    if lossy.chars().any(|c| c as u32 >= 0x80 && c != char::REPLACEMENT_CHARACTER) {
        return lossy.into_owned();
    }
    decode_oem(bytes).unwrap_or_else(|| lossy.into_owned())
}

#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{GetOEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS, MultiByteToWideChar};

    if bytes.is_empty() || bytes.len() > i32::MAX as usize {
        return None;
    }
    unsafe {
        let cp = GetOEMCP();
        let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
        let len = MultiByteToWideChar(cp, flags, bytes, None);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let written = MultiByteToWideChar(cp, flags, bytes, Some(&mut buf));
        (written > 0).then(|| String::from_utf16_lossy(&buf[..written as usize]))
    }
}

#[cfg(not(windows))]
fn decode_oem(_bytes: &[u8]) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_utf8_and_keeps_mostly_valid_text() {
        assert_eq!(super::decode_output("مرحبا".as_bytes()), "مرحبا");
        let mut bytes = "é ok".as_bytes().to_vec();
        bytes.push(0xFF);
        assert!(super::decode_output(&bytes).starts_with("é ok"));
    }
}
