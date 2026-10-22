//! Windows shell calls for the Storage page: the Recycle Bin, known folders and drive types.

use std::ffi::c_void;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{FILETIME, HWND, PROPERTYKEY};
use windows::Win32::Storage::FileSystem::GetDriveTypeW;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOF_ALLOWUNDO, FOF_NO_UI, FOF_WANTNUKEWARNING, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOLDERID_RecycleBinFolder,
    FileOperation, IEnumShellItems, IFileOperation, IFileOperationProgressSink, IShellItem, IShellItem2, KF_FLAG_DEFAULT, PID_DISPLACED_DATE,
    PID_DISPLACED_FROM, PSGUID_DISPLACED, SHCreateItemFromParsingName, SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI,
    SHERB_NOSOUND, SHGetKnownFolderItem, SHGetKnownFolderPath, SHQUERYRBINFO, SHQueryRecycleBinW, SIGDN_PARENTRELATIVE,
};
use windows::core::{GUID, Interface, PCWSTR, PWSTR};

use crate::os::wide;

/// Where a Recycle Bin item was deleted from, and when.
const ORIGINAL_LOCATION: PROPERTYKEY = PROPERTYKEY { fmtid: PSGUID_DISPLACED, pid: PID_DISPLACED_FROM };
const DATE_DELETED: PROPERTYKEY = PROPERTYKEY { fmtid: PSGUID_DISPLACED, pid: PID_DISPLACED_DATE };
const DRIVE_FIXED: u32 = 3;

fn shell_error(e: windows::core::Error) -> String {
    e.message()
}

/// Runs shell work on a new thread in a single-threaded COM apartment, which the shell's file
/// operations need. Every COM object must be dropped inside `f`.
fn in_sta<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    std::thread::spawn(move || {
        let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        let result = f();
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }
        result
    })
    .join()
    .map_err(|_| "The Windows shell stopped unexpectedly.".to_string())?
}

/// Reads and frees a string the shell allocated.
unsafe fn take_string(p: PWSTR) -> String {
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as *const c_void)) };
    s
}

fn unix_seconds(t: FILETIME) -> i64 {
    let ticks = ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    (ticks / 10_000_000) as i64 - 11_644_473_600
}

/// Size and item count of the Recycle Bin on all drives.
pub fn recycle_bin_size() -> Result<(u64, u64), String> {
    let mut info = SHQUERYRBINFO { cbSize: size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.map_err(shell_error)?;
    Ok((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
}

pub fn empty_recycle_bin() -> Result<(), String> {
    in_sta(|| {
        unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND) }
            .map_err(|e| format!("Windows couldn't empty the Recycle Bin: {}", e.message()))
    })
}

/// A known folder such as Documents, wherever the user moved it.
pub fn known_folder(id: &GUID) -> Option<PathBuf> {
    let path = unsafe { take_string(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?) };
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// True for internal drives. USB sticks, memory cards and network drives have no Recycle Bin, so
/// anything deleted there would be gone for good.
pub fn has_recycle_bin(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let Some(root) = s.get(..3).filter(|r| r.ends_with(":\\")) else { return false };
    let root = wide(std::ffi::OsStr::new(root));
    unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) == DRIVE_FIXED }
}

/// Moves one file or folder to the Recycle Bin. If Windows can't keep it there (for example it is
/// bigger than the Recycle Bin), Windows itself asks before deleting it for good. `owner` is the
/// main window, so that question appears in front of it.
pub fn move_to_recycle_bin(path: &Path, owner: Option<isize>) -> Result<(), String> {
    let path = wide(path.as_os_str());
    in_sta(move || unsafe {
        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(shell_error)?;
        op.SetOperationFlags(FOF_NO_UI | FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_WANTNUKEWARNING).map_err(shell_error)?;
        if let Some(hwnd) = owner {
            let _ = op.SetOwnerWindow(HWND(hwnd as *mut c_void));
        }
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None).map_err(shell_error)?;
        op.DeleteItem(&item, None::<&IFileOperationProgressSink>).map_err(shell_error)?;
        let done = op.PerformOperations();
        if op.GetAnyOperationsAborted().is_ok_and(|b| b.as_bool()) {
            return Err("Nothing was deleted.".into());
        }
        done.map_err(shell_error)
    })
}

/// Puts files and folders back from the Recycle Bin, matched by where they were deleted from and
/// deleted no earlier than `since` (Unix seconds). The newest match wins.
pub fn restore_from_recycle_bin(paths: Vec<String>, since: i64) -> Result<(), String> {
    in_sta(move || unsafe {
        let wanted: Vec<(PathBuf, String, String, String)> = paths
            .iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                let parent = path.parent()?.to_string_lossy().trim_end_matches('\\').to_lowercase();
                let name = path.file_name()?.to_string_lossy().to_lowercase();
                // The shell may show names without their extension.
                let stem = path.file_stem()?.to_string_lossy().to_lowercase();
                Some((path, parent, name, stem))
            })
            .collect();
        if wanted.len() != paths.len() {
            return Err("That item can't be restored automatically. Open the Recycle Bin to restore it.".into());
        }

        let bin: IShellItem = SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None).map_err(shell_error)?;
        let items: IEnumShellItems = bin.BindToHandler(None, &BHID_EnumItems).map_err(shell_error)?;
        let mut best: Vec<Option<(IShellItem, i64)>> = vec![None; wanted.len()];
        loop {
            let mut batch = [None];
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = batch[0].take() else { break };
            let Ok(item2) = item.cast::<IShellItem2>() else { continue };
            let deleted = item2.GetFileTime(&DATE_DELETED).map(unix_seconds).unwrap_or(0);
            // A minute of slack for clock rounding between this app and the shell.
            if deleted < since - 60 {
                continue;
            }
            let Ok(from) = item2.GetString(&ORIGINAL_LOCATION).map(|p| take_string(p)) else { continue };
            let Ok(name) = item.GetDisplayName(SIGDN_PARENTRELATIVE).map(|p| take_string(p)) else { continue };
            let (from, name) = (from.trim_end_matches('\\').to_lowercase(), name.to_lowercase());
            for (i, (_, parent, file, stem)) in wanted.iter().enumerate() {
                if from == *parent && (name == *file || name == *stem) && best[i].as_ref().is_none_or(|(_, t)| deleted > *t) {
                    best[i] = Some((item.clone(), deleted));
                }
            }
        }

        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(shell_error)?;
        op.SetOperationFlags(FOF_NO_UI | FOFX_EARLYFAILURE).map_err(shell_error)?;
        for ((path, ..), found) in wanted.iter().zip(&best) {
            let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let Some((item, _)) = found else {
                return Err(format!("\"{shown}\" is no longer in the Recycle Bin, so it can't be restored."));
            };
            if path.exists() {
                return Err(format!("Something named \"{shown}\" is already in that folder, so nothing was restored."));
            }
            let parent = path.parent().ok_or("That item has no folder to go back to.")?;
            std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't recreate the folder it was in: {e}"))?;
            let folder_path = wide(parent.as_os_str());
            let folder: IShellItem = SHCreateItemFromParsingName(PCWSTR(folder_path.as_ptr()), None).map_err(shell_error)?;
            let name = wide(path.file_name().unwrap_or_default());
            op.MoveItem(item, &folder, PCWSTR(name.as_ptr()), None::<&IFileOperationProgressSink>).map_err(shell_error)?;
        }
        let done = op.PerformOperations();
        if op.GetAnyOperationsAborted().is_ok_and(|b| b.as_bool()) {
            return Err("Windows stopped the restore before it finished.".into());
        }
        done.map_err(shell_error)
    })
}
