//! Startup apps manager. Enables/disables entries the same way Task Manager does
//! (the `StartupApproved` registry flags), so nothing is deleted and every change
//! can be reversed.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum StartupSource {
    UserRun,
    MachineRun,
    MachineRun32,
    UserFolder,
    MachineFolder,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub name: String,
    pub command: String,
    pub source: StartupSource,
    pub location: String,
    pub enabled: bool,
    pub needs_admin: bool,
}

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_BINARY};
    use winreg::RegValue;

    use super::{StartupItem, StartupSource};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

    impl StartupSource {
        const ALL: [StartupSource; 5] = [
            StartupSource::UserRun,
            StartupSource::MachineRun,
            StartupSource::MachineRun32,
            StartupSource::UserFolder,
            StartupSource::MachineFolder,
        ];

        fn hive(self) -> RegKey {
            match self {
                StartupSource::UserRun | StartupSource::UserFolder => RegKey::predef(HKEY_CURRENT_USER),
                _ => RegKey::predef(HKEY_LOCAL_MACHINE),
            }
        }

        fn approved_key(self) -> String {
            let leaf = match self {
                StartupSource::UserRun | StartupSource::MachineRun => "Run",
                StartupSource::MachineRun32 => "Run32",
                StartupSource::UserFolder | StartupSource::MachineFolder => "StartupFolder",
            };
            format!(r"{APPROVED}\{leaf}")
        }

        fn label(self) -> &'static str {
            match self {
                StartupSource::UserRun => "Registry (current user)",
                StartupSource::MachineRun => "Registry (all users)",
                StartupSource::MachineRun32 => "Registry (all users, 32-bit)",
                StartupSource::UserFolder => "Startup folder (current user)",
                StartupSource::MachineFolder => "Startup folder (all users)",
            }
        }

        fn needs_admin(self) -> bool {
            !matches!(self, StartupSource::UserRun | StartupSource::UserFolder)
        }

        fn folder(self) -> Option<PathBuf> {
            let base = match self {
                StartupSource::UserFolder => std::env::var_os("APPDATA")?,
                StartupSource::MachineFolder => std::env::var_os("ProgramData")?,
                _ => return None,
            };
            Some(PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
        }
    }

    /// Entries as (name, command) for one source.
    fn entries(source: StartupSource) -> Vec<(String, String)> {
        match source {
            StartupSource::UserRun | StartupSource::MachineRun | StartupSource::MachineRun32 => {
                let path = if source == StartupSource::MachineRun32 { RUN32 } else { RUN };
                let Ok(key) = source.hive().open_subkey_with_flags(path, KEY_READ) else {
                    return Vec::new();
                };
                key.enum_values()
                    .filter_map(Result::ok)
                    .filter(|(name, _)| !name.is_empty())
                    .map(|(name, value)| (name, value.to_string().trim_matches('"').to_string()))
                    .collect()
            }
            StartupSource::UserFolder | StartupSource::MachineFolder => {
                let Some(dir) = source.folder() else { return Vec::new() };
                let Ok(read) = std::fs::read_dir(&dir) else { return Vec::new() };
                read.filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| !n.eq_ignore_ascii_case("desktop.ini"))
                    .map(|n| (n.clone(), dir.join(&n).to_string_lossy().into_owned()))
                    .collect()
            }
        }
    }

    fn is_enabled(source: StartupSource, name: &str) -> bool {
        source
            .hive()
            .open_subkey_with_flags(source.approved_key(), KEY_READ)
            .and_then(|k| k.get_raw_value(name))
            // Odd first byte (0x03, 0x07...) means disabled; a missing value means enabled.
            .map(|v| v.bytes.first().is_none_or(|b| b & 1 == 0))
            .unwrap_or(true)
    }

    pub fn list() -> Vec<StartupItem> {
        StartupSource::ALL
            .into_iter()
            .flat_map(|source| {
                entries(source).into_iter().map(move |(name, command)| StartupItem {
                    enabled: is_enabled(source, &name),
                    name,
                    command,
                    source,
                    location: source.label().into(),
                    needs_admin: source.needs_admin(),
                })
            })
            .collect()
    }

    pub fn set_enabled(source: StartupSource, name: &str, enabled: bool) -> Result<(), String> {
        let (key, _) = source
            .hive()
            .create_subkey_with_flags(source.approved_key(), KEY_SET_VALUE)
            .map_err(|e| access_error(source, e))?;
        // 12 bytes: state flag, 3 reserved bytes, then a FILETIME of when it was disabled.
        let mut bytes = vec![if enabled { 0x02 } else { 0x03 }, 0, 0, 0];
        let filetime: u64 = if enabled {
            0
        } else {
            // 100ns ticks since 1601-01-01.
            let unix = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64 / 100;
            unix + 116_444_736_000_000_000
        };
        bytes.extend_from_slice(&filetime.to_le_bytes());
        key.set_raw_value(name, &RegValue { bytes: bytes.into(), vtype: REG_BINARY })
            .map_err(|e| access_error(source, e))
    }

    fn access_error(source: StartupSource, e: std::io::Error) -> String {
        if source.needs_admin() && e.kind() == std::io::ErrorKind::PermissionDenied {
            "This entry applies to all users. Run the app as administrator to change it.".into()
        } else {
            e.to_string()
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{StartupItem, StartupSource};

    pub fn list() -> Vec<StartupItem> {
        Vec::new()
    }

    pub fn set_enabled(_source: StartupSource, _name: &str, _enabled: bool) -> Result<(), String> {
        Err("Startup management is only supported on Windows".into())
    }
}

pub use imp::{list, set_enabled};
