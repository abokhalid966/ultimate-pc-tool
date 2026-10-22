//! Duplicate file finder: files grouped by size, then by their first bytes, then by a SHA-256 of
//! the whole file. Only files from the latest search can be moved to the Recycle Bin, and at least
//! one copy in every group is always kept.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::{recycle, scan, size_text, verdict};
use crate::actions::{ActivityLog, Undo};
use crate::blocking;
use crate::storage::safety::Verdict;

/// Folders that hold programs or Windows itself, where copies are expected and needed.
const SKIP: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "$windows.~bt",
    "$windows.~ws",
    "node_modules",
    ".git",
];
const HEAD: usize = 64 * 1024;
const MAX_GROUPS: usize = 2000;

#[derive(Default)]
pub struct Dupes {
    cancel: AtomicBool,
    /// Groups from the latest search, as lower-cased paths.
    groups: Mutex<Vec<Vec<String>>>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DupeEvent {
    Scanning { files: u64, current: String },
    Comparing { done: u64, total: u64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeFile {
    pub path: String,
    /// Unix milliseconds.
    pub modified: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroup {
    pub size: u64,
    pub files: Vec<DupeFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeResult {
    pub root: String,
    pub groups: Vec<DupeGroup>,
    pub scanned: u64,
    /// Space the extra copies take.
    pub wasted: u64,
    pub cancelled: bool,
    /// More groups were found than are shown.
    pub truncated: bool,
}

struct Candidate {
    path: PathBuf,
    modified: i64,
}

#[tauri::command]
pub async fn storage_find_duplicates(app: AppHandle, path: Option<String>, min_size: u64, on_event: Channel<DupeEvent>) -> Result<DupeResult, String> {
    blocking(move || {
        let root = match path.filter(|p| !p.trim().is_empty()) {
            Some(p) => PathBuf::from(p),
            None => PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Couldn't find your user folder.")?),
        };
        if !root.is_dir() {
            return Err("That folder no longer exists.".into());
        }
        let dupes = app.state::<Dupes>();
        dupes.cancel.store(false, Ordering::SeqCst);
        dupes.groups.lock().clear();
        let cancel = &dupes.cancel;

        let (by_size, scanned) = walk(&root, min_size.max(1), cancel, &on_event);
        let mut groups = compare(by_size, cancel, &on_event);
        let cancelled = cancel.load(Ordering::SeqCst);
        groups.sort_by_key(|g| std::cmp::Reverse(g.size * (g.files.len() as u64 - 1)));
        let truncated = groups.len() > MAX_GROUPS;
        groups.truncate(MAX_GROUPS);
        for g in &mut groups {
            g.files.sort_by_key(|f| f.modified);
        }
        let wasted = groups.iter().map(|g| g.size * (g.files.len() as u64 - 1)).sum();
        *dupes.groups.lock() = groups.iter().map(|g| g.files.iter().map(|f| f.path.to_lowercase()).collect()).collect();
        Ok(DupeResult { root: scan::display(&root), groups, scanned, wasted, cancelled, truncated })
    })
    .await
}

#[tauri::command]
pub fn storage_cancel_duplicates(dupes: State<Dupes>) {
    dupes.cancel.store(true, Ordering::SeqCst);
}

fn walk(root: &Path, min_size: u64, cancel: &AtomicBool, events: &Channel<DupeEvent>) -> (HashMap<u64, Vec<Candidate>>, u64) {
    let mut by_size: HashMap<u64, Vec<Candidate>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    let mut scanned = 0u64;
    let mut last = Instant::now();
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            // Links and junctions point somewhere else; following them would count files twice.
            if meta.file_type().is_symlink() || skipped_attributes(&meta) {
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !SKIP.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
                continue;
            }
            scanned += 1;
            if meta.len() < min_size {
                continue;
            }
            let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
            by_size.entry(meta.len()).or_default().push(Candidate { path: entry.path(), modified });
        }
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = events.send(DupeEvent::Scanning { files: scanned, current: scan::display(&dir) });
        }
    }
    by_size.retain(|_, list| list.len() > 1);
    (by_size, scanned)
}

/// System files, and cloud files that aren't on this PC (reading them would download them).
#[cfg(windows)]
fn skipped_attributes(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const SYSTEM: u32 = 0x4;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x40000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x400000;
    meta.file_attributes() & (SYSTEM | OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(windows))]
fn skipped_attributes(_meta: &std::fs::Metadata) -> bool {
    false
}

fn compare(by_size: HashMap<u64, Vec<Candidate>>, cancel: &AtomicBool, events: &Channel<DupeEvent>) -> Vec<DupeGroup> {
    let total: u64 = by_size.values().map(|l| l.len() as u64).sum();
    let mut done = 0u64;
    let mut last = Instant::now();
    let mut groups = Vec::new();
    for (size, list) in by_size {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // Small files are compared in full by the first pass.
        let mut by_head: HashMap<[u8; 32], Vec<Candidate>> = HashMap::new();
        for c in list {
            done += 1;
            if let Some(h) = hash(&c.path, Some(HEAD), cancel) {
                by_head.entry(h).or_default().push(c);
            }
        }
        for (_, same_head) in by_head.into_iter().filter(|(_, l)| l.len() > 1) {
            let sets = if size as usize <= HEAD {
                vec![same_head]
            } else {
                let mut by_full: HashMap<[u8; 32], Vec<Candidate>> = HashMap::new();
                for c in same_head {
                    if let Some(h) = hash(&c.path, None, cancel) {
                        by_full.entry(h).or_default().push(c);
                    }
                }
                by_full.into_values().collect()
            };
            for set in sets.into_iter().filter(|s| s.len() > 1) {
                groups.push(DupeGroup { size, files: set.into_iter().map(|c| DupeFile { path: scan::display(&c.path), modified: c.modified }).collect() });
            }
        }
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = events.send(DupeEvent::Comparing { done, total });
        }
    }
    groups
}

/// SHA-256 of the first `limit` bytes, or of the whole file. `None` if it can't be read or the
/// search was stopped.
fn hash(path: &Path, limit: Option<usize>, cancel: &AtomicBool) -> Option<[u8; 32]> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; limit.unwrap_or(1024 * 1024).min(1024 * 1024)];
    let mut left = limit.unwrap_or(usize::MAX);
    while left > 0 {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let want = buf.len().min(left);
        let n = file.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        left -= n;
    }
    Some(hasher.finalize().into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeDeleteResult {
    pub deleted: Vec<String>,
    pub bytes: u64,
    pub failed: Vec<DupeFailure>,
    pub activity_id: Option<String>,
}

/// Moves extra copies to the Recycle Bin, logged as one Activity entry with Undo.
#[tauri::command]
pub async fn storage_delete_duplicates(app: AppHandle, paths: Vec<String>) -> Result<DupeDeleteResult, String> {
    #[cfg(windows)]
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    #[cfg(not(windows))]
    let owner = None;
    blocking(move || {
        let wanted: Vec<String> = paths.iter().map(|p| p.to_lowercase()).collect();
        let dupes = app.state::<Dupes>();
        {
            let groups = dupes.groups.lock();
            if let Some(p) = wanted.iter().find(|p| !groups.iter().any(|g| g.contains(p))) {
                return Err(format!("\"{p}\" isn't in the latest results. Search again."));
            }
            if groups.iter().any(|g| g.iter().all(|p| wanted.contains(p))) {
                return Err("Keep at least one copy of every file.".into());
            }
        }
        let deleted_at = chrono::Utc::now().timestamp();
        let (mut deleted, mut failed, mut bytes) = (Vec::new(), Vec::new(), 0u64);
        for path in paths {
            let p = PathBuf::from(&path);
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let result = match verdict(&app, &p) {
                Verdict::Blocked(why) => Err(why),
                Verdict::Allowed { .. } => recycle(&p, owner).and_then(|()| if p.exists() { Err("It may be open in an app.".into()) } else { Ok(()) }),
            };
            match result {
                Ok(()) => {
                    bytes += size;
                    deleted.push(path);
                }
                Err(error) => failed.push(DupeFailure { path, error }),
            }
        }
        {
            let gone: Vec<String> = deleted.iter().map(|p| p.to_lowercase()).collect();
            let mut groups = dupes.groups.lock();
            for g in groups.iter_mut() {
                g.retain(|p| !gone.contains(p));
            }
        }
        let activity_id = if deleted.is_empty() {
            None
        } else {
            let n = deleted.len();
            app.state::<ActivityLog>().record(
                &app,
                "Storage",
                format!("Moved {n} duplicate {} to the Recycle Bin ({})", if n == 1 { "file" } else { "files" }, size_text(bytes)),
                Some(deleted.join("\n")),
                Some(Undo::RestoreFromRecycleBin { paths: deleted.clone(), deleted_at }),
            )
        };
        Ok(DupeDeleteResult { deleted, bytes, failed, activity_id })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_identical_files() {
        let dir = std::env::temp_dir().join(format!("optimo-dupes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let mut other = big.clone();
        *other.last_mut().unwrap() ^= 1;
        std::fs::write(dir.join("a.bin"), &big).unwrap();
        std::fs::write(dir.join("sub").join("b.bin"), &big).unwrap();
        std::fs::write(dir.join("node_modules").join("c.bin"), &big).unwrap();
        // Same size and same start, different end.
        std::fs::write(dir.join("d.bin"), &other).unwrap();
        std::fs::write(dir.join("small1.txt"), b"hello").unwrap();
        std::fs::write(dir.join("small2.txt"), b"hello").unwrap();

        let cancel = AtomicBool::new(false);
        let events: Channel<DupeEvent> = Channel::new(|_| Ok(()));
        let (by_size, scanned) = walk(&dir, 1, &cancel, &events);
        assert_eq!(scanned, 5);
        let mut groups = compare(by_size, &cancel, &events);
        groups.sort_by_key(|g| g.size);
        assert_eq!(groups.len(), 2);
        assert_eq!((groups[0].size, groups[0].files.len()), (5, 2));
        assert_eq!((groups[1].size, groups[1].files.len()), (200_000, 2));
        assert!(groups[1].files.iter().all(|f| !f.path.ends_with("d.bin")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
