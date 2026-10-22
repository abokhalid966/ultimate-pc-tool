//! Safe temp-folder cleaner. Unlike a recursive `Remove-Item`, it never follows links or
//! junctions out of the folder, keeps recent files that installers may still need, and reports
//! what it actually removed.

use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// Files touched more recently than this are left alone (Disk Cleanup uses 7 days).
const MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub folder: String,
    /// Files removed (or, for a dry run, that would be removed).
    pub files: u64,
    pub bytes: u64,
    /// Files kept because they are new, in use or not ours to delete.
    pub skipped: u64,
}

/// Cleans the user's temp folder. With `dry_run` it only measures what would be freed.
pub fn clean_temp(dry_run: bool) -> Result<CleanReport, String> {
    let dir = temp_folder()?;
    let cutoff = SystemTime::now().checked_sub(MIN_AGE).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut report = CleanReport { folder: display(&dir), ..Default::default() };
    clean_dir(&dir, cutoff, dry_run, &mut report);
    Ok(report)
}

/// The temp folder, refused unless it really looks like one (Windows falls back to the profile
/// or Windows folder when TEMP/TMP are unset, and a bad "tweak" can point them anywhere).
fn temp_folder() -> Result<PathBuf, String> {
    let refuse = |why: &str| Err(format!("Your temp folder setting looks unusual ({why}), so nothing was cleaned."));
    let dir = std::env::temp_dir();
    let dir = dir.canonicalize().map_err(|e| format!("Couldn't open the temp folder: {e}"))?;
    let named_temp = dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("temp"));
    if !named_temp {
        return refuse("it isn't a folder named Temp");
    }
    if dir.parent().is_none_or(|p| p.parent().is_none()) {
        return refuse("it is at the top of a drive");
    }
    let same = |other: Option<PathBuf>| other.and_then(|p| p.canonicalize().ok()).is_some_and(|p| p == dir);
    if same(std::env::var_os("USERPROFILE").map(PathBuf::from)) || same(Some(crate::os::windows_dir().to_path_buf())) {
        return refuse("it is your user or Windows folder");
    }
    Ok(dir)
}

/// Cleans one folder's contents. Returns true when the folder ended up empty.
fn clean_dir(dir: &Path, cutoff: SystemTime, dry_run: bool, report: &mut CleanReport) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        report.skipped += 1;
        return false;
    };
    let mut empty = true;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            report.skipped += 1;
            empty = false;
            continue;
        };
        let old_enough = last_change(&meta).is_some_and(|t| t < cutoff);
        if is_link(&meta) {
            // Remove only the link itself, never what it points to.
            let removed = old_enough && (dry_run || remove_link(&path, &meta));
            if removed {
                report.files += 1;
            }
            if !removed || dry_run {
                empty = false;
            }
        } else if meta.is_dir() {
            let child_empty = clean_dir(&path, cutoff, dry_run, report);
            let removed = child_empty && old_enough && !dry_run && fs::remove_dir(&path).is_ok();
            if !removed {
                empty = false;
            }
        } else if !old_enough {
            report.skipped += 1;
            empty = false;
        } else if dry_run || remove_file(&path, &meta) {
            report.files += 1;
            report.bytes += meta.len();
            if dry_run {
                empty = false;
            }
        } else {
            report.skipped += 1;
            empty = false;
        }
    }
    empty
}

/// The newest of modified and created time: extracted files often keep an old modified time.
fn last_change(meta: &Metadata) -> Option<SystemTime> {
    match (meta.modified().ok(), meta.created().ok()) {
        (Some(m), Some(c)) => Some(m.max(c)),
        (m, c) => m.or(c),
    }
}

#[cfg(windows)]
fn is_link(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link(meta: &Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Whether a link is a directory link or junction (even when its target is gone).
#[cfg(windows)]
fn is_dir_link(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
}

#[cfg(not(windows))]
fn is_dir_link(_meta: &Metadata) -> bool {
    false
}

fn remove_link(path: &Path, meta: &Metadata) -> bool {
    // Directory links and junctions are removed like empty folders, which leaves the target alone.
    if is_dir_link(meta) { fs::remove_dir(path).is_ok() } else { fs::remove_file(path).is_ok() }
}

fn remove_file(path: &Path, meta: &Metadata) -> bool {
    if fs::remove_file(path).is_ok() {
        return true;
    }
    // Read-only files can't be deleted until the flag is cleared. Files in use just stay.
    let mut perms = meta.permissions();
    if !perms.readonly() {
        return false;
    }
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(path, perms).is_ok() && fs::remove_file(path).is_ok()
}

fn display(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_new_files_and_counts_old_ones() {
        let root = std::env::temp_dir().join(format!("upt-clean-{}", std::process::id())).join("Temp");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("new.txt"), b"hello").unwrap();
        fs::write(root.join("sub").join("new2.txt"), b"hi").unwrap();
        let mut report = CleanReport::default();
        // Nothing is older than the epoch, so everything is "new" and kept.
        clean_dir(&root, SystemTime::UNIX_EPOCH, false, &mut report);
        assert_eq!(report.files, 0);
        assert_eq!(report.skipped, 2);
        // With a cutoff in the future, everything counts as old.
        let future = SystemTime::now() + Duration::from_secs(60);
        let mut dry = CleanReport::default();
        clean_dir(&root, future, true, &mut dry);
        assert_eq!((dry.files, dry.bytes), (2, 7));
        assert!(root.join("new.txt").exists());
        let mut real = CleanReport::default();
        assert!(clean_dir(&root, future, false, &mut real));
        assert_eq!(real.files, 2);
        assert!(!root.join("sub").exists());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }
}
