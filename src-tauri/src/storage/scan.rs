//! Folder-size scanner for the Space finder.
//!
//! A few threads read folders in parallel into one shared list of folder nodes. A folder is always
//! added before the folders inside it, so all totals are summed in one backwards pass at the end.
//! Links and junctions are never followed, cloud-only files (OneDrive placeholders) count as zero
//! bytes because they take no space, and folders Windows won't open are only counted.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

const NO_PARENT: u32 = u32::MAX;
/// Largest files remembered for the whole scan; each folder view shows the biggest ones inside it.
const TOP_FILES: usize = 1000;
const VIEW_FILES: usize = 40;
const VIEW_FOLDERS: usize = 250;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

struct Node {
    name: Box<str>,
    parent: u32,
    /// Files directly in this folder.
    own_bytes: u64,
    own_files: u64,
    /// Totals including every subfolder, filled in when the scan ends.
    bytes: u64,
    files: u64,
    folders: u64,
    children: Vec<u32>,
    /// Windows wouldn't let us look inside.
    denied: bool,
    /// Moved to the Recycle Bin since the scan.
    removed: bool,
}

impl Node {
    fn new(name: Box<str>, parent: u32) -> Self {
        Node { name, parent, own_bytes: 0, own_files: 0, bytes: 0, files: 0, folders: 0, children: Vec::new(), denied: false, removed: false }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BigFile {
    bytes: u64,
    dir: u32,
    name: Box<str>,
    modified_ms: Option<i64>,
}

/// Live counts while a scan runs.
pub struct Progress {
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
    pub denied: u64,
    /// The folder being read right now.
    pub current: String,
}

pub struct Tree {
    root: PathBuf,
    nodes: Vec<Node>,
    /// Biggest files first.
    files: Vec<BigFile>,
    pub denied: u64,
    /// Links and junctions that were skipped.
    pub links: u64,
    pub cancelled: bool,
    pub elapsed: Duration,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub node: u32,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub node: u32,
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    pub folders: u64,
    pub denied: bool,
    pub has_children: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// The folder the file is in.
    pub dir: u32,
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub node: u32,
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    pub folders: u64,
    /// Files directly in this folder (not in a subfolder).
    pub own_bytes: u64,
    pub own_files: u64,
    pub denied: bool,
    /// From the scanned folder down to this one.
    pub crumbs: Vec<Crumb>,
    /// Biggest first, at most `VIEW_FOLDERS`; the rest are summed in `other_*`.
    pub children: Vec<FolderEntry>,
    pub other_count: u64,
    pub other_bytes: u64,
    /// The biggest files anywhere inside this folder (from the scan's overall top list).
    pub largest_files: Vec<FileEntry>,
}

struct Shared {
    nodes: Vec<Node>,
    /// Folders still to read, as (node, path). Used as a stack, which keeps it short.
    queue: Vec<(u32, PathBuf)>,
    /// Workers reading a folder right now.
    active: usize,
}

#[derive(Default)]
struct Counters {
    files: AtomicU64,
    folders: AtomicU64,
    bytes: AtomicU64,
    denied: AtomicU64,
    links: AtomicU64,
    current: AtomicU32,
}

#[derive(Default)]
struct Listing {
    bytes: u64,
    files: u64,
    dirs: Vec<(Box<str>, OsString)>,
    links: u64,
}

/// Scans `root` (a folder or a drive like `C:\`). `on_progress` is called about every 150 ms from
/// this thread. Setting `cancel` stops early and returns what was read so far.
pub fn scan(root: &Path, cancel: &AtomicBool, mut on_progress: impl FnMut(Progress)) -> Result<Tree, String> {
    let started = Instant::now();
    fs::read_dir(root).map_err(|e| open_error(&e))?;

    let state = Mutex::new(Shared { nodes: vec![Node::new(root_name(root).into(), NO_PARENT)], queue: vec![(0, root.to_path_buf())], active: 0 });
    let wake = Condvar::new();
    let counters = Counters::default();
    let finished = AtomicBool::new(false);
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);

    let tops = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers).map(|_| s.spawn(|| worker(&state, &wake, cancel, &counters))).collect();
        // Report progress from this thread until every worker is done.
        let done = s.spawn(|| {
            let mut tops = Vec::new();
            for h in handles {
                tops.extend(h.join().unwrap_or_default());
            }
            finished.store(true, Ordering::SeqCst);
            tops
        });
        let mut reported = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(30));
            if finished.load(Ordering::SeqCst) {
                break;
            }
            if reported.elapsed() < PROGRESS_EVERY {
                continue;
            }
            reported = Instant::now();
            let current = {
                let s = state.lock().unwrap_or_else(|e| e.into_inner());
                path_from(root, &s.nodes, counters.current.load(Ordering::Relaxed))
            };
            on_progress(Progress {
                files: counters.files.load(Ordering::Relaxed),
                folders: counters.folders.load(Ordering::Relaxed),
                bytes: counters.bytes.load(Ordering::Relaxed),
                denied: counters.denied.load(Ordering::Relaxed),
                current: display(&current),
            });
        }
        done.join().unwrap_or_default()
    });

    let mut nodes = state.into_inner().unwrap_or_else(|e| e.into_inner()).nodes;
    for n in nodes.iter_mut() {
        n.bytes = n.own_bytes;
        n.files = n.own_files;
    }
    // Children always come after their parent, so walking backwards adds each finished subtree.
    for i in (1..nodes.len()).rev() {
        let (bytes, files, folders, parent) = (nodes[i].bytes, nodes[i].files, nodes[i].folders, nodes[i].parent);
        let p = &mut nodes[parent as usize];
        p.bytes += bytes;
        p.files += files;
        p.folders += folders + 1;
    }
    let mut files = tops;
    files.sort_unstable_by(|a, b| b.cmp(a));
    files.truncate(TOP_FILES);

    Ok(Tree {
        root: root.to_path_buf(),
        nodes,
        files,
        denied: counters.denied.load(Ordering::Relaxed),
        links: counters.links.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::SeqCst),
        elapsed: started.elapsed(),
    })
}

fn worker(state: &Mutex<Shared>, wake: &Condvar, cancel: &AtomicBool, counters: &Counters) -> Vec<BigFile> {
    let mut top: BinaryHeap<Reverse<BigFile>> = BinaryHeap::new();
    loop {
        let (node, path) = {
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if cancel.load(Ordering::Relaxed) {
                    s.queue.clear();
                    wake.notify_all();
                    return top.into_iter().map(|r| r.0).collect();
                }
                if let Some(job) = s.queue.pop() {
                    s.active += 1;
                    break job;
                }
                if s.active == 0 {
                    wake.notify_all();
                    return top.into_iter().map(|r| r.0).collect();
                }
                s = wake.wait(s).unwrap_or_else(|e| e.into_inner());
            }
        };
        counters.current.store(node, Ordering::Relaxed);
        let listing = read_folder(&path, node, &mut top);

        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        match listing {
            Ok(l) => {
                counters.files.fetch_add(l.files, Ordering::Relaxed);
                counters.bytes.fetch_add(l.bytes, Ordering::Relaxed);
                counters.folders.fetch_add(l.dirs.len() as u64, Ordering::Relaxed);
                counters.links.fetch_add(l.links, Ordering::Relaxed);
                let n = &mut s.nodes[node as usize];
                n.own_bytes = l.bytes;
                n.own_files = l.files;
                for (name, os_name) in l.dirs {
                    let child = s.nodes.len() as u32;
                    s.nodes.push(Node::new(name, node));
                    s.nodes[node as usize].children.push(child);
                    s.queue.push((child, path.join(os_name)));
                }
            }
            Err(_) => {
                counters.denied.fetch_add(1, Ordering::Relaxed);
                s.nodes[node as usize].denied = true;
            }
        }
        s.active -= 1;
        drop(s);
        wake.notify_all();
    }
}

/// Reads one folder's entries without following links, keeping the biggest files in `top`.
fn read_folder(path: &Path, node: u32, top: &mut BinaryHeap<Reverse<BigFile>>) -> std::io::Result<Listing> {
    let mut l = Listing::default();
    for entry in fs::read_dir(path)?.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            // Symbolic links and junctions (e.g. "Documents and Settings"): never followed.
            l.links += 1;
            continue;
        }
        let name = entry.file_name();
        if kind.is_dir() {
            l.dirs.push((name.to_string_lossy().into(), name));
            continue;
        }
        // On Windows this comes from the folder listing itself, so it costs no extra disk access.
        let Ok(meta) = entry.metadata() else { continue };
        let bytes = disk_bytes(&meta);
        l.files += 1;
        l.bytes += bytes;
        if bytes > 0 && (top.len() < TOP_FILES || top.peek().is_some_and(|min| bytes > min.0.bytes)) {
            let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
            top.push(Reverse(BigFile { bytes, dir: node, name: name.to_string_lossy().into(), modified_ms }));
            if top.len() > TOP_FILES {
                top.pop();
            }
        }
    }
    Ok(l)
}

/// Space the file takes on this PC: cloud-only OneDrive files take none.
#[cfg(windows)]
fn disk_bytes(meta: &Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    if meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0 { 0 } else { meta.len() }
}

#[cfg(not(windows))]
fn disk_bytes(meta: &Metadata) -> u64 {
    meta.len()
}

fn open_error(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        "Windows didn't allow opening that folder. Try one of its subfolders, or restart as administrator.".into()
    } else if e.kind() == std::io::ErrorKind::NotFound {
        "That folder no longer exists.".into()
    } else {
        format!("Couldn't open that folder: {e}")
    }
}

/// "C:" for a drive, else the folder's own name.
fn root_name(root: &Path) -> String {
    match root.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => display(root).trim_end_matches(['\\', '/']).to_string(),
    }
}

/// Path without the `\\?\` prefix Windows adds to long and resolved paths.
pub fn display(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn path_from(root: &Path, nodes: &[Node], node: u32) -> PathBuf {
    let mut names = Vec::new();
    let mut n = node;
    while let Some(item) = nodes.get(n as usize) {
        if item.parent == NO_PARENT {
            break;
        }
        names.push(&*item.name);
        n = item.parent;
    }
    let mut path = root.to_path_buf();
    for name in names.into_iter().rev() {
        path.push(name);
    }
    path
}

impl Tree {
    pub fn root_path(&self) -> String {
        display(&self.root)
    }

    pub fn total(&self) -> (u64, u64, u64) {
        let r = &self.nodes[0];
        (r.bytes, r.files, r.folders)
    }

    fn live(&self, node: u32) -> Option<&Node> {
        self.nodes.get(node as usize).filter(|n| !n.removed)
    }

    pub fn path_of(&self, node: u32) -> Option<PathBuf> {
        self.live(node).map(|_| path_from(&self.root, &self.nodes, node))
    }

    /// True when `node` is `ancestor` or inside it.
    fn within(&self, mut node: u32, ancestor: u32) -> bool {
        loop {
            if node == ancestor {
                return true;
            }
            match self.nodes.get(node as usize) {
                Some(n) if n.parent != NO_PARENT => node = n.parent,
                _ => return false,
            }
        }
    }

    /// A folder's size and its file count, or `None` if it was removed.
    pub fn folder_size(&self, node: u32) -> Option<(u64, u64)> {
        self.live(node).map(|n| (n.bytes, n.files))
    }

    /// A file from the largest-files list: its path and size.
    pub fn file(&self, dir: u32, name: &str) -> Option<(PathBuf, u64)> {
        let f = self.files.iter().find(|f| f.dir == dir && &*f.name == name)?;
        Some((self.path_of(dir)?.join(name), f.bytes))
    }

    pub fn view(&self, node: u32) -> Option<FolderView> {
        let n = self.live(node)?;
        let path = self.path_of(node)?;
        let mut crumbs = Vec::new();
        let mut c = node;
        loop {
            crumbs.push(Crumb { node: c, name: self.nodes[c as usize].name.to_string() });
            match self.nodes[c as usize].parent {
                NO_PARENT => break,
                p => c = p,
            }
        }
        crumbs.reverse();

        let mut kids: Vec<u32> = n.children.iter().copied().filter(|&k| !self.nodes[k as usize].removed).collect();
        kids.sort_unstable_by(|a, b| self.nodes[*b as usize].bytes.cmp(&self.nodes[*a as usize].bytes));
        let rest = kids.split_off(kids.len().min(VIEW_FOLDERS));
        let children = kids
            .into_iter()
            .map(|k| {
                let kid = &self.nodes[k as usize];
                FolderEntry {
                    node: k,
                    name: kid.name.to_string(),
                    path: display(&path.join(&*kid.name)),
                    bytes: kid.bytes,
                    files: kid.files,
                    folders: kid.folders,
                    denied: kid.denied,
                    has_children: kid.children.iter().any(|&g| !self.nodes[g as usize].removed),
                }
            })
            .collect();
        let largest_files = self
            .files
            .iter()
            .filter(|f| self.live(f.dir).is_some() && self.within(f.dir, node))
            .take(VIEW_FILES)
            .filter_map(|f| {
                Some(FileEntry {
                    dir: f.dir,
                    name: f.name.to_string(),
                    path: display(&self.path_of(f.dir)?.join(&*f.name)),
                    bytes: f.bytes,
                    modified_ms: f.modified_ms,
                })
            })
            .collect();

        Some(FolderView {
            node,
            name: n.name.to_string(),
            path: display(&path),
            bytes: n.bytes,
            files: n.files,
            folders: n.folders,
            own_bytes: n.own_bytes,
            own_files: n.own_files,
            denied: n.denied,
            crumbs,
            children,
            other_count: rest.len() as u64,
            other_bytes: rest.iter().map(|&k| self.nodes[k as usize].bytes).sum(),
            largest_files,
        })
    }

    /// Takes a removed folder out of the totals of every folder above it.
    pub fn remove_folder(&mut self, node: u32) {
        let Some(n) = self.live(node) else { return };
        if n.parent == NO_PARENT {
            return;
        }
        let (bytes, files, folders, parent) = (n.bytes, n.files, n.folders + 1, n.parent);
        self.nodes[node as usize].removed = true;
        self.nodes[parent as usize].children.retain(|&k| k != node);
        self.subtract(parent, bytes, files, folders);
        let files = std::mem::take(&mut self.files);
        self.files = files.into_iter().filter(|f| !self.within(f.dir, node)).collect();
    }

    /// Takes a removed file out of its folder's totals.
    pub fn remove_file(&mut self, dir: u32, name: &str) {
        let Some(pos) = self.files.iter().position(|f| f.dir == dir && &*f.name == name) else { return };
        let bytes = self.files.remove(pos).bytes;
        let n = &mut self.nodes[dir as usize];
        n.own_bytes = n.own_bytes.saturating_sub(bytes);
        n.own_files = n.own_files.saturating_sub(1);
        self.subtract(dir, bytes, 1, 0);
    }

    fn subtract(&mut self, mut node: u32, bytes: u64, files: u64, folders: u64) {
        while let Some(n) = self.nodes.get_mut(node as usize) {
            n.bytes = n.bytes.saturating_sub(bytes);
            n.files = n.files.saturating_sub(files);
            n.folders = n.folders.saturating_sub(folders);
            node = n.parent;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tree() -> PathBuf {
        let root = std::env::temp_dir().join(format!("upt-scan-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("big").join("deeper")).unwrap();
        fs::create_dir_all(root.join("small")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("top.txt"), vec![0u8; 10]).unwrap();
        fs::write(root.join("big").join("a.bin"), vec![0u8; 3000]).unwrap();
        fs::write(root.join("big").join("deeper").join("b.bin"), vec![0u8; 5000]).unwrap();
        fs::write(root.join("small").join("c.txt"), vec![0u8; 100]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("big"), root.join("link-to-big")).unwrap();
        root
    }

    #[test]
    fn sums_folders_and_skips_links() {
        let root = make_tree();
        let cancel = AtomicBool::new(false);
        let tree = scan(&root, &cancel, |_| {}).unwrap();
        assert_eq!(tree.total(), (8110, 4, 4));
        #[cfg(unix)]
        assert_eq!(tree.links, 1);
        assert!(!tree.cancelled);

        let view = tree.view(0).unwrap();
        assert_eq!(view.own_bytes, 10);
        let names: Vec<_> = view.children.iter().map(|c| (c.name.as_str(), c.bytes)).collect();
        assert_eq!(names, [("big", 8000), ("small", 100), ("empty", 0)]);
        assert_eq!(view.largest_files.iter().map(|f| f.bytes).collect::<Vec<_>>(), [5000, 3000, 100, 10]);
        assert_eq!(view.crumbs.len(), 1);

        let big = view.children[0].node;
        let big_view = tree.view(big).unwrap();
        assert_eq!(big_view.crumbs.iter().map(|c| c.name.as_str()).collect::<Vec<_>>()[1], "big");
        assert_eq!(big_view.largest_files.len(), 2);
        assert!(big_view.children[0].path.ends_with("deeper"));
        assert_eq!(tree.path_of(big).unwrap(), root.join("big"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removing_updates_every_total() {
        let root = make_tree();
        let mut tree = scan(&root, &AtomicBool::new(false), |_| {}).unwrap();
        let view = tree.view(0).unwrap();
        let big = view.children[0].node;
        let deeper = tree.view(big).unwrap().children[0].node;

        let (path, bytes) = tree.file(big, "a.bin").unwrap();
        assert_eq!((path, bytes), (root.join("big").join("a.bin"), 3000));
        tree.remove_file(big, "a.bin");
        assert_eq!(tree.total().0, 5110);
        assert_eq!(tree.view(big).unwrap().own_files, 0);

        tree.remove_folder(deeper);
        assert_eq!(tree.total(), (110, 2, 3));
        assert!(tree.view(deeper).is_none());
        assert!(tree.view(big).unwrap().children.is_empty());
        assert_eq!(tree.view(0).unwrap().largest_files.len(), 2);
        // The scanned folder itself is never removed.
        tree.remove_folder(0);
        assert!(tree.view(0).is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stops_when_cancelled() {
        let root = make_tree();
        let tree = scan(&root, &AtomicBool::new(true), |_| {}).unwrap();
        assert!(tree.cancelled);
        assert!(tree.total().0 < 8110);
        assert!(scan(&root.join("missing"), &AtomicBool::new(false), |_| {}).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
