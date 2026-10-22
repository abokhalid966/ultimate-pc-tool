//! Pure helpers for Uninstall registry entries: which entries are apps, their install dates, and
//! turning an uninstall command line into a program to start. Free of Windows APIs so it can be
//! unit tested anywhere.

/// The values of one `...\CurrentVersion\Uninstall\<key>` entry that matter here.
#[derive(Default, Debug, Clone)]
pub struct Entry {
    pub key: String,
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub size_kb: Option<u32>,
    pub install_date: Option<String>,
    pub location: Option<String>,
    pub uninstall: Option<String>,
    pub quiet_uninstall: Option<String>,
    pub system_component: bool,
    pub parent_key: Option<String>,
    pub release_type: Option<String>,
    pub windows_installer: bool,
    pub no_remove: bool,
}

/// What to start to uninstall an app.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub program: String,
    pub args: String,
}

/// Whether Windows would list the entry as an app, rather than an update or a hidden part of
/// another app.
pub fn is_app(e: &Entry) -> bool {
    if e.name.trim().is_empty() || e.system_component || e.parent_key.as_deref().is_some_and(|p| !p.trim().is_empty()) {
        return false;
    }
    if let Some(kind) = &e.release_type {
        let kind = kind.to_ascii_lowercase();
        if ["update", "hotfix", "service pack"].iter().any(|u| kind.contains(u)) {
            return false;
        }
    }
    !mentions_kb(&e.name) && (e.uninstall.is_some() || e.windows_installer)
}

/// Names of Windows and Office updates, e.g. "Security Update for ... (KB5034441)".
fn mentions_kb(name: &str) -> bool {
    let bytes = name.as_bytes();
    (0..bytes.len().saturating_sub(2)).any(|i| {
        bytes[i] == b'K'
            && bytes[i + 1] == b'B'
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
            && bytes[i + 2..].iter().take_while(|b| b.is_ascii_digit()).count() >= 6
    })
}

/// `InstallDate` as `YYYY-MM-DD`. The documented format is `YYYYMMDD`; some installers add dashes
/// or slashes. Anything else (e.g. a locale-specific date) is ignored rather than guessed.
pub fn parse_install_date(raw: &str) -> Option<String> {
    let t = raw.trim();
    let b = t.as_bytes();
    let (y, m, d) = if b.len() == 8 && b.iter().all(u8::is_ascii_digit) {
        (&t[0..4], &t[4..6], &t[6..8])
    } else if b.len() == 10 && b[4] == b[7] && matches!(b[4], b'-' | b'/' | b'.') {
        (&t[0..4], &t[5..7], &t[8..10])
    } else {
        return None;
    };
    let (y, m, d): (u32, u32, u32) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    ((1990..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)).then(|| format!("{y:04}-{m:02}-{d:02}"))
}

/// Expands `%NAME%` variables (uninstall strings are often `REG_EXPAND_SZ`). Unknown names stay
/// as written.
pub fn expand_env(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').and_then(|end| lookup(&after[..end]).map(|v| (end, v))) {
            Some((end, value)) => {
                out.push_str(&value);
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Splits a command line into the program and its arguments. Unquoted paths with spaces are
/// common in uninstall entries (`C:\Program Files\App\uninst.exe /S`), so the program is the
/// shortest prefix that is an existing file, or else the first one ending in `.exe`.
pub fn split_command(cmd: &str, exists: impl Fn(&str) -> bool) -> Option<(String, String)> {
    let cmd = cmd.trim();
    if let Some(rest) = cmd.strip_prefix('"') {
        let end = rest.find('"')?;
        let program = rest[..end].trim();
        return (!program.is_empty()).then(|| (program.to_string(), rest[end + 1..].trim().to_string()));
    }
    if cmd.is_empty() {
        return None;
    }
    let mut exe_end = None;
    for end in cmd.match_indices(' ').map(|(i, _)| i).chain([cmd.len()]) {
        let program = &cmd[..end];
        if exists(program) {
            return Some((program.to_string(), cmd[end..].trim().to_string()));
        }
        if exe_end.is_none() && program.to_ascii_lowercase().ends_with(".exe") {
            exe_end = Some(end);
        }
    }
    let end = exe_end.or_else(|| cmd.find(' ')).unwrap_or(cmd.len());
    Some((cmd[..end].to_string(), cmd[end..].trim().to_string()))
}

/// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`
pub fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && b[1..37].iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

fn find_guid(s: &str) -> Option<&str> {
    s.match_indices('{').find_map(|(i, _)| s.get(i..i + 38).filter(|g| is_guid(g)))
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn is_msiexec(cmd: &str) -> bool {
    split_command(cmd, |_| false).is_some_and(|(program, _)| {
        let name = file_name(&program);
        name.eq_ignore_ascii_case("msiexec") || name.eq_ignore_ascii_case("msiexec.exe")
    })
}

/// The Windows Installer product code, for entries that `msiexec` removes.
pub fn msi_product_code(e: &Entry) -> Option<String> {
    let from_command = e.uninstall.as_deref().filter(|u| is_msiexec(u)).and_then(find_guid);
    let from_key = (e.windows_installer && is_guid(&e.key)).then_some(e.key.as_str());
    from_command.or(from_key).map(str::to_ascii_uppercase)
}

pub fn can_quiet(e: &Entry) -> bool {
    e.quiet_uninstall.is_some() || msi_product_code(e).is_some()
}

/// What to start to uninstall `e`. Windows Installer products always go through `msiexec /X`
/// (their entries often say `/I`, which opens a repair screen instead). `quiet` uses the app's own
/// quiet command, or msiexec's unattended mode, which shows progress but asks nothing.
pub fn plan(
    e: &Entry,
    quiet: bool,
    msiexec: &str,
    exists: impl Fn(&str) -> bool,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Plan, String> {
    let split = |cmd: &str| {
        split_command(&expand_env(cmd, &env), &exists)
            .map(|(program, args)| Plan { program, args })
            .ok_or_else(|| format!("{}'s uninstall command is empty.", e.name))
    };
    if quiet && let Some(q) = &e.quiet_uninstall {
        return split(q);
    }
    if let Some(code) = msi_product_code(e) {
        let args = if quiet { format!("/X{code} /passive /norestart") } else { format!("/X{code}") };
        return Ok(Plan { program: msiexec.to_string(), args });
    }
    if quiet {
        return Err(format!("{} has no quiet uninstall option. Use Uninstall instead.", e.name));
    }
    split(e.uninstall.as_deref().ok_or_else(|| format!("{} doesn't say how to uninstall it.", e.name))?)
}

/// How an uninstaller's exit code reads to a person. Most uninstallers use the Windows Installer
/// codes, so those are the ones recognized.
#[derive(Debug, PartialEq, Eq)]
pub enum Exit {
    Finished,
    /// Finished, but Windows has to restart to remove the last files.
    Restart,
    Cancelled,
    Failed(String),
}

pub fn describe_exit(code: u32) -> Exit {
    match code {
        0 => Exit::Finished,
        // ERROR_SUCCESS_REBOOT_REQUIRED, ERROR_SUCCESS_REBOOT_INITIATED
        3010 | 1641 => Exit::Restart,
        // ERROR_INSTALL_USEREXIT, ERROR_CANCELLED
        1602 | 1223 => Exit::Cancelled,
        // ERROR_UNKNOWN_PRODUCT: it was already gone.
        1605 => Exit::Finished,
        1618 => Exit::Failed("Another installation is running. Wait for it to finish, then try again.".into()),
        1603 => Exit::Failed("The uninstaller ran into a problem (error 1603). Restarting your PC and trying again often helps.".into()),
        code => Exit::Failed(format!("The uninstaller stopped with error code {code}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> Entry {
        Entry { key: name.into(), name: name.into(), uninstall: Some("uninst.exe".into()), ..Default::default() }
    }

    #[test]
    fn hides_updates_and_system_components() {
        assert!(is_app(&entry("7-Zip 23.01 (x64)")));
        assert!(!is_app(&Entry { system_component: true, ..entry("Hidden") }));
        assert!(!is_app(&Entry { parent_key: Some("Office16.PROPLUS".into()), ..entry("Part") }));
        assert!(!is_app(&Entry { release_type: Some("Security Update".into()), ..entry("Fix") }));
        assert!(!is_app(&Entry { release_type: Some("Hotfix".into()), ..entry("Fix") }));
        assert!(!is_app(&entry("Security Update for Microsoft Office (KB5002469) 64-Bit Edition")));
        assert!(is_app(&entry("KeePassXC")));
        assert!(!is_app(&Entry { uninstall: None, ..entry("No way to remove") }));
        assert!(is_app(&Entry { uninstall: None, windows_installer: true, ..entry("MSI app") }));
        assert!(!is_app(&entry("  ")));
    }

    #[test]
    fn reads_install_dates() {
        assert_eq!(parse_install_date("20240115").as_deref(), Some("2024-01-15"));
        assert_eq!(parse_install_date("2023-11-02").as_deref(), Some("2023-11-02"));
        assert_eq!(parse_install_date("2023/11/02").as_deref(), Some("2023-11-02"));
        assert_eq!(parse_install_date("1/15/2024"), None);
        assert_eq!(parse_install_date("20241345"), None);
        assert_eq!(parse_install_date(""), None);
    }

    #[test]
    fn expands_known_variables_only() {
        let env = |n: &str| (n.eq_ignore_ascii_case("ProgramFiles")).then(|| r"C:\Program Files".to_string());
        assert_eq!(expand_env(r"%ProgramFiles%\App\un.exe", env), r"C:\Program Files\App\un.exe");
        assert_eq!(expand_env("100% sure %UNKNOWN%", env), "100% sure %UNKNOWN%");
        assert_eq!(expand_env("%%", env), "%%");
    }

    #[test]
    fn splits_quoted_and_unquoted_command_lines() {
        let none = |_: &str| false;
        assert_eq!(
            split_command(r#""C:\Program Files\App\uninstall.exe" /S"#, none),
            Some((r"C:\Program Files\App\uninstall.exe".into(), "/S".into()))
        );
        assert_eq!(
            split_command(r"C:\Program Files\My App\uninst.exe /quiet /x", none),
            Some((r"C:\Program Files\My App\uninst.exe".into(), "/quiet /x".into()))
        );
        let exists = |p: &str| p == r"C:\Program Files (x86)\Setup Files\setup";
        assert_eq!(
            split_command(r"C:\Program Files (x86)\Setup Files\setup -remove", exists),
            Some((r"C:\Program Files (x86)\Setup Files\setup".into(), "-remove".into()))
        );
        assert_eq!(split_command("rundll32.exe dfshim.dll,ShArpMaintain app", none), Some(("rundll32.exe".into(), "dfshim.dll,ShArpMaintain app".into())));
        assert_eq!(split_command(r#""unterminated"#, none), None);
        assert_eq!(split_command("   ", none), None);
    }

    #[test]
    fn plans_msi_uninstalls_with_slash_x() {
        let code = "{23170F69-40C1-2702-2301-000001000000}";
        let e = Entry { uninstall: Some(format!("MsiExec.exe /I{code}")), ..entry("7-Zip") };
        let msiexec = r"C:\Windows\System32\msiexec.exe";
        let p = plan(&e, false, msiexec, |_| false, |_| None).unwrap();
        assert_eq!(p, Plan { program: msiexec.into(), args: format!("/X{code}") });
        let q = plan(&e, true, msiexec, |_| false, |_| None).unwrap();
        assert_eq!(q.args, format!("/X{code} /passive /norestart"));
        assert!(can_quiet(&e));

        // The key name is the product code for Windows Installer entries.
        let by_key = Entry { key: code.to_lowercase(), windows_installer: true, uninstall: None, ..entry("x") };
        assert_eq!(msi_product_code(&by_key).as_deref(), Some(code));
    }

    #[test]
    fn plans_regular_and_quiet_uninstalls() {
        let e = Entry {
            uninstall: Some(r#""%ProgramFiles%\App\uninstall.exe""#.into()),
            quiet_uninstall: Some(r#""%ProgramFiles%\App\uninstall.exe" /S"#.into()),
            ..entry("App")
        };
        let env = |n: &str| (n == "ProgramFiles").then(|| r"C:\Program Files".to_string());
        let p = plan(&e, false, "msiexec", |_| false, env).unwrap();
        assert_eq!(p, Plan { program: r"C:\Program Files\App\uninstall.exe".into(), args: String::new() });
        let q = plan(&e, true, "msiexec", |_| false, env).unwrap();
        assert_eq!(q.args, "/S");
        let no_quiet = Entry { quiet_uninstall: None, ..e };
        assert!(!can_quiet(&no_quiet));
        assert!(plan(&no_quiet, true, "msiexec", |_| false, env).is_err());
    }

    #[test]
    fn explains_exit_codes() {
        assert_eq!(describe_exit(0), Exit::Finished);
        assert_eq!(describe_exit(3010), Exit::Restart);
        assert_eq!(describe_exit(1602), Exit::Cancelled);
        assert!(matches!(describe_exit(1618), Exit::Failed(t) if t.contains("Another installation")));
        assert!(matches!(describe_exit(5), Exit::Failed(t) if t.contains('5')));
    }
}
