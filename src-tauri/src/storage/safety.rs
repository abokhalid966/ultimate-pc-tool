//! Which files and folders the Space finder may move to the Recycle Bin.
//!
//! Pure string logic, so it can be tested on any OS: paths are compared case-insensitively in a
//! normalized form (`c:\users\me`). The caller gathers the Windows facts (known folders, the
//! Windows folder, file attributes, drive types) and checks both the path as shown and the real
//! path behind it, so short names like `PROGRA~1` or a trailing dot can't slip past.

/// How a rule's folder is protected.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// The folder itself and everything inside it (e.g. the Windows folder).
    Inside,
    /// The folder itself and any folder that contains it (e.g. your user folder, or Documents),
    /// while things inside it can be deleted.
    Exact,
    /// Each folder directly inside it (e.g. every user's folder in C:\Users).
    Children,
    /// Things inside it are allowed, but the confirmation shows the rule's text as a warning.
    WarnInside,
}

struct Rule {
    path: String,
    scope: Scope,
    /// "your Windows folder"
    name: String,
    /// One sentence on why, or what to do instead.
    why: String,
}

#[derive(Default)]
pub struct Rules(Vec<Rule>);

impl Rules {
    /// Adds a rule. Paths that can't be normalized (missing known folders) are ignored.
    pub fn add(&mut self, path: &str, scope: Scope, name: &str, why: &str) {
        if let Some(path) = normalize(path) {
            self.0.push(Rule { path, scope, name: name.into(), why: why.into() });
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Blocked(String),
    Allowed { warning: Option<String> },
}

const APPS: &str = "Apps are installed here. Uninstall apps you don't need from Windows Settings instead.";

/// Folders at the top of any drive that belong to Windows or installed apps.
const DRIVE_FOLDERS: &[(&str, &str)] = &[
    ("windows", "This is a Windows folder. Deleting anything in it could stop the PC from starting."),
    ("program files", APPS),
    ("program files (x86)", APPS),
    ("program files (arm)", APPS),
    ("windowsapps", "Microsoft Store apps are installed here. Uninstall them from Windows Settings instead."),
    ("programdata", "Apps keep shared settings and their installers here. Deleting things in it can break apps or stop them from uninstalling."),
    ("$recycle.bin", "This is the Recycle Bin. Empty it from the Cleanup tab instead."),
    ("system volume information", "Windows keeps restore points and drive information here."),
    ("recovery", "Windows uses this folder to repair or reset your PC."),
    ("boot", "Windows needs this folder to start."),
    ("efi", "Your PC needs this folder to start."),
    ("config.msi", "Windows Installer uses this folder while apps install or uninstall."),
    ("msocache", "Microsoft Office keeps its installer here, so Office can repair itself."),
    ("$winreagent", "Windows uses this folder while it installs updates."),
    ("$sysreset", "Windows uses this folder to reset your PC."),
    ("$windows.~bt", "Windows uses this folder while it upgrades. Windows removes it by itself."),
    ("$windows.~ws", "Windows uses this folder while it upgrades. Windows removes it by itself."),
    ("$getcurrent", "Windows uses this folder while it upgrades. Windows removes it by itself."),
    (
        "windows.old",
        "This is your previous version of Windows. Remove it in Windows Settings > System > Storage > Temporary files, which keeps the PC working.",
    ),
];

/// `C:/Users/Me/` -> `c:\users\me`, and `D:\` -> `d:`. Returns `None` for anything that isn't a
/// plain path on a lettered drive: relative paths, `.` or `..` parts, network and device paths,
/// wildcards and alternate data streams (`file.txt:stream`).
pub fn normalize(path: &str) -> Option<String> {
    let mut p = path.trim().replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        p = rest.to_string();
    }
    let bytes = p.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || (bytes.len() > 2 && bytes[2] != b'\\') {
        return None;
    }
    let mut parts = vec![p[..2].to_lowercase()];
    for part in p[2..].split('\\').filter(|s| !s.is_empty()) {
        // Windows ignores trailing dots and spaces, so "Windows." is the Windows folder.
        let part = part.trim_end_matches(['.', ' ']);
        if part.is_empty() || part.contains([':', '*', '?', '"', '<', '>', '|']) {
            return None;
        }
        parts.push(part.to_lowercase());
    }
    Some(parts.join("\\"))
}

/// True when `path` is `folder` or inside it (both normalized).
fn within(path: &str, folder: &str) -> bool {
    path == folder || (path.len() > folder.len() && path.starts_with(folder) && path.as_bytes()[folder.len()] == b'\\')
}

fn parent(path: &str) -> Option<&str> {
    path.rfind('\\').map(|i| &path[..i])
}

/// Decides whether `path` may be moved to the Recycle Bin, and what to warn about.
pub fn check(path: &str, rules: &Rules) -> Verdict {
    let Some(p) = normalize(path) else {
        return Verdict::Blocked("Only files and folders on this PC's own drives can be deleted here.".into());
    };
    let mut parts = p.split('\\');
    let _drive = parts.next();
    let Some(top) = parts.next() else {
        return Verdict::Blocked("That's a whole drive. Delete the things inside it instead.".into());
    };
    if let Some((_, why)) = DRIVE_FOLDERS.iter().find(|(name, _)| *name == top) {
        return Verdict::Blocked((*why).into());
    }

    for rule in rules.0.iter().filter(|r| r.scope != Scope::WarnInside) {
        let blocked = match rule.scope {
            Scope::Inside if within(&p, &rule.path) => {
                let place = if p == rule.path { "This is" } else { "This is inside" };
                Some(format!("{place} {}. {}", rule.name, rule.why))
            }
            Scope::Exact if within(&rule.path, &p) => {
                let place = if p == rule.path { "This is" } else { "This folder contains" };
                Some(format!("{place} {}. {}", rule.name, rule.why))
            }
            Scope::Children if parent(&p) == Some(rule.path.as_str()) => Some(format!("This is {}. {}", rule.name, rule.why)),
            Scope::Children if within(&rule.path, &p) => Some(format!("This folder contains {}. {}", rule.name, rule.why)),
            _ => None,
        };
        if let Some(why) = blocked {
            return Verdict::Blocked(why);
        }
    }

    let warning = rules
        .0
        .iter()
        .find(|r| r.scope == Scope::WarnInside && p != r.path && within(&p, &r.path))
        .map(|r| r.why.clone());
    Verdict::Allowed { warning }
}

/// Plain-language reason for files Windows marks as system files, with what to do instead.
pub fn system_file_reason(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "pagefile.sys" => "Windows uses pagefile.sys as extra memory. To make it smaller, change the virtual memory size in Windows' advanced system settings.".into(),
        "hiberfil.sys" => "Windows uses hiberfil.sys for hibernation and fast startup. To remove it, turn off hibernation (powercfg /h off in an administrator terminal).".into(),
        "swapfile.sys" => "Windows uses swapfile.sys to run Store apps smoothly. It removes the file by itself when it's not needed.".into(),
        _ => "Windows marks this as a system item, so Ultimate PC Tool won't delete it. If you're sure, delete it in File Explorer.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        let mut r = Rules::default();
        r.add(r"C:\Users", Scope::Exact, "the folder of all user accounts", "Delete things inside your own folder instead.");
        r.add(r"C:\Users", Scope::Children, "a user account's main folder", "Delete things inside it instead.");
        r.add(r"C:\Users\Me", Scope::Exact, "your user folder", "Delete things inside it instead.");
        r.add(r"C:\Users\Me\Documents", Scope::Exact, "your Documents folder", "Windows needs it.");
        r.add(r"C:\Users\Me\AppData", Scope::Exact, "your AppData folder", "Every app keeps its settings here.");
        r.add(r"C:\Users\Me\AppData", Scope::WarnInside, "", "Apps keep their settings here.");
        r.add(r"D:\OneDrive", Scope::WarnInside, "", "This is in OneDrive.");
        r.add(r"C:\Users\Me\AppData\Local\Temp", Scope::Exact, "the temporary files folder", "Use the Cleanup tab.");
        r.add(r"C:\Tools\Ultimate PC Tool", Scope::Exact, "Ultimate PC Tool itself", "Uninstall it instead.");
        r.add(r"E:\WinNT", Scope::Inside, "your Windows folder", "It could stop the PC from starting.");
        r.add("not a path", Scope::Inside, "x", "ignored");
        r
    }

    fn blocked(path: &str) -> bool {
        matches!(check(path, &rules()), Verdict::Blocked(_))
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize("C:/Users/Me/").as_deref(), Some(r"c:\users\me"));
        assert_eq!(normalize(r"\\?\D:\Data\\x.txt").as_deref(), Some(r"d:\data\x.txt"));
        assert_eq!(normalize(r"D:\").as_deref(), Some("d:"));
        assert_eq!(normalize(r"C:\Windows. ").as_deref(), Some(r"c:\windows"));
        assert_eq!(normalize(r"relative\path"), None);
        assert_eq!(normalize(r"C:relative"), None);
        assert_eq!(normalize(r"\\server\share\x"), None);
        assert_eq!(normalize(r"\\?\UNC\server\share"), None);
        assert_eq!(normalize(r"C:\Users\..\Windows"), None);
        assert_eq!(normalize(r"C:\a\.\b"), None);
        assert_eq!(normalize(r"C:\file.txt:secret"), None);
        assert_eq!(normalize(r"C:\*"), None);
    }

    #[test]
    fn blocks_system_and_app_folders_on_any_drive() {
        assert!(blocked(r"C:\Windows"));
        assert!(blocked(r"C:\WINDOWS.\System32\drivers"));
        assert!(blocked(r"D:\Program Files\Steam"));
        assert!(blocked(r"C:\Program Files (x86)"));
        assert!(blocked(r"C:\ProgramData\Package Cache\x"));
        assert!(blocked(r"C:\$Recycle.Bin\S-1-5-21"));
        assert!(blocked(r"C:\System Volume Information"));
        assert!(blocked(r"C:\Windows.old"));
        assert!(blocked(r"E:\WinNT\x.dll"));
        assert!(blocked(r"D:\"));
        assert!(blocked(r"\\nas\share\movies"));
        // Similar names are fine.
        assert!(!blocked(r"C:\Windows Backup Files\old.zip"));
        assert!(!blocked(r"D:\Games\Program Files Copy"));
    }

    #[test]
    fn protects_profiles_and_known_folders_but_not_their_contents() {
        assert!(blocked(r"C:\Users"));
        assert!(blocked(r"C:\Users\Me"));
        assert!(blocked(r"C:\Users\Someone Else"));
        assert!(blocked(r"C:\Users\Public"));
        assert!(blocked(r"c:\users\me\documents"));
        assert!(blocked(r"C:\Users\Me\AppData\Local\Temp"));
        assert!(blocked(r"C:\Tools"));
        assert!(!blocked(r"C:\Users\Me\Documents\Old projects"));
        assert!(!blocked(r"C:\Users\Me\Downloads\setup.exe"));
        assert!(!blocked(r"C:\Users\Someone Else\Videos\clip.mp4"));
        assert!(!blocked(r"C:\Users\Me\AppData\Local\Temp\x.tmp"));
        assert!(!blocked(r"C:\Tools\Other"));
    }

    #[test]
    fn warns_inside_app_data_and_onedrive() {
        let r = rules();
        assert_eq!(check(r"C:\Users\Me\AppData\Local\OldGame", &r), Verdict::Allowed { warning: Some("Apps keep their settings here.".into()) });
        assert_eq!(check(r"D:\OneDrive\Photos", &r), Verdict::Allowed { warning: Some("This is in OneDrive.".into()) });
        assert_eq!(check(r"D:\Movies", &r), Verdict::Allowed { warning: None });
        match check(r"C:\Users\Me\AppData", &r) {
            Verdict::Blocked(why) => assert!(why.starts_with("This is your AppData folder.")),
            other => panic!("{other:?}"),
        }
        match check(r"C:\Users", &r) {
            Verdict::Blocked(why) => assert!(why.starts_with("This is the folder of all user accounts.")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn explains_system_files() {
        assert!(system_file_reason("PAGEFILE.SYS").contains("virtual memory"));
        assert!(system_file_reason("other.dat").contains("system item"));
    }
}
