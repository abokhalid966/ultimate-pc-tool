//! Driver check: devices that aren't working, drivers that look old, and where to get new ones.

use std::time::Duration;

use chrono::Datelike;
use serde::{Deserialize, Serialize};

const SCRIPT: &str = r#"
$cs = Get-CimInstance Win32_ComputerSystem
$bb = Get-CimInstance Win32_BaseBoard
$problems = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -and @(22, 45) -notcontains $_.ConfigManagerErrorCode } | ForEach-Object {
  [pscustomobject]@{ name = "$($_.Name)"; class = "$($_.PNPClass)"; code = [int]$_.ConfigManagerErrorCode; id = "$($_.PNPDeviceID)" }
})
$drivers = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DriverVersion } | ForEach-Object {
  [pscustomobject]@{ name = "$($_.DeviceName)"; class = "$($_.DeviceClass)"; version = "$($_.DriverVersion)"; date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' }; provider = "$($_.DriverProviderName)"; id = "$($_.DeviceID)" }
})
[pscustomobject]@{ maker = "$($cs.Manufacturer)"; model = "$($cs.Model)"; board = "$($bb.Manufacturer)"; problems = $problems; drivers = $drivers } | ConvertTo-Json -Depth 4 -Compress
"#;

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    maker: String,
    #[serde(default)]
    board: String,
    #[serde(default)]
    problems: Vec<RawProblem>,
    #[serde(default)]
    drivers: Vec<RawDriver>,
}

#[derive(Deserialize)]
struct RawProblem {
    name: String,
    #[serde(default)]
    class: String,
    code: u32,
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
struct RawDriver {
    name: String,
    #[serde(default)]
    class: String,
    version: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    id: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Link {
    pub label: &'static str,
    pub url: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub name: String,
    pub category: &'static str,
    pub version: String,
    /// yyyy-mm-dd, or empty when Windows doesn't know.
    pub date: String,
    pub provider: String,
    pub age_days: Option<i64>,
    /// Old enough that a newer one very likely exists.
    pub old: bool,
    pub download: Link,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub name: String,
    pub category: &'static str,
    pub code: u32,
    pub message: &'static str,
    pub download: Link,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverReport {
    pub maker: String,
    pub maker_link: Option<Link>,
    pub problems: Vec<Problem>,
    pub drivers: Vec<Driver>,
}

const NVIDIA: Link = Link { label: "NVIDIA drivers", url: "https://www.nvidia.com/en-us/drivers/" };
const AMD: Link = Link { label: "AMD drivers", url: "https://www.amd.com/en/support/download/drivers.html" };
const INTEL: Link = Link { label: "Intel Driver & Support Assistant", url: "https://www.intel.com/content/www/us/en/support/detect.html" };
const WINDOWS_UPDATE: Link = Link { label: "Windows Update", url: "ms-settings:windowsupdate-optionalupdates" };

/// PC and motherboard makers' driver pages, matched on the start of the maker's name.
const MAKERS: &[(&str, Link)] = &[
    ("dell", Link { label: "Dell support", url: "https://www.dell.com/support/home/" }),
    ("alienware", Link { label: "Dell support", url: "https://www.dell.com/support/home/" }),
    ("hp", Link { label: "HP support", url: "https://support.hp.com/drivers" }),
    ("hewlett", Link { label: "HP support", url: "https://support.hp.com/drivers" }),
    ("lenovo", Link { label: "Lenovo support", url: "https://pcsupport.lenovo.com/" }),
    ("asus", Link { label: "ASUS download center", url: "https://www.asus.com/support/download-center/" }),
    ("acer", Link { label: "Acer drivers", url: "https://www.acer.com/us-en/support/drivers-and-manuals" }),
    ("micro-star", Link { label: "MSI support", url: "https://www.msi.com/support/download" }),
    ("msi", Link { label: "MSI support", url: "https://www.msi.com/support/download" }),
    ("gigabyte", Link { label: "Gigabyte support", url: "https://www.gigabyte.com/Support" }),
    ("asrock", Link { label: "ASRock support", url: "https://www.asrock.com/support/index.asp" }),
    ("samsung", Link { label: "Samsung support", url: "https://www.samsung.com/us/support/downloads/" }),
    ("razer", Link { label: "Razer support", url: "https://mysupport.razer.com/" }),
];

/// Every link the page may open, so `open_driver_link` opens nothing else.
fn known(url: &str) -> bool {
    [NVIDIA, AMD, INTEL, WINDOWS_UPDATE].iter().chain(MAKERS.iter().map(|(_, l)| l)).any(|l| l.url == url)
}

fn maker_link(name: &str) -> Option<Link> {
    let n = name.trim().to_lowercase();
    MAKERS.iter().find(|(key, _)| n.starts_with(key)).map(|(_, l)| l.clone())
}

/// Device classes worth showing, with plain names. Others (software devices, volumes, monitors...)
/// are handled by Windows itself.
fn category(class: &str) -> Option<&'static str> {
    Some(match class.to_ascii_uppercase().as_str() {
        "DISPLAY" => "Graphics",
        "NET" => "Network",
        "MEDIA" | "AUDIOENDPOINT" => "Sound",
        "BLUETOOTH" => "Bluetooth",
        "CAMERA" | "IMAGE" => "Camera",
        "HDC" | "SCSIADAPTER" => "Storage",
        "SYSTEM" => "Chipset",
        "USB" => "USB",
        "BIOMETRIC" => "Fingerprint",
        "HIDCLASS" | "MOUSE" | "KEYBOARD" => "Input",
        "PRINTER" => "Printer",
        "FIRMWARE" => "Firmware",
        _ => return None,
    })
}

#[derive(PartialEq, Clone, Copy)]
enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

fn vendor(id: &str, provider: &str) -> Vendor {
    let id = id.to_ascii_uppercase();
    let p = provider.to_ascii_lowercase();
    if id.contains("VEN_10DE") || p.contains("nvidia") {
        Vendor::Nvidia
    } else if id.contains("VEN_1002") || id.contains("VEN_1022") || p.starts_with("amd") || p.contains("advanced micro devices") {
        Vendor::Amd
    } else if id.contains("VEN_8086") || p.starts_with("intel") {
        Vendor::Intel
    } else {
        Vendor::Other
    }
}

/// Where to get a newer driver: the chip maker's own tool for graphics, chipset and Intel parts,
/// otherwise the PC or motherboard maker, otherwise Windows Update.
fn download(category: &str, vendor: Vendor, maker: &Option<Link>) -> Link {
    match (vendor, category) {
        (Vendor::Nvidia, _) => NVIDIA,
        (Vendor::Amd, "Graphics" | "Chipset") => AMD,
        (Vendor::Intel, _) => INTEL,
        _ => maker.clone().unwrap_or(WINDOWS_UPDATE),
    }
}

fn problem_message(code: u32) -> &'static str {
    match code {
        1 | 18 | 28 => "No driver is installed",
        3 | 39 => "The driver is missing or damaged",
        10 => "The device can't start",
        12 => "Not enough free resources for this device",
        14 | 21 => "Needs a restart to work",
        19 => "Its settings in Windows are damaged",
        24 => "Not connected or missing a driver",
        31 => "Not working properly",
        43 => "Windows stopped it after it reported a problem",
        48 | 52 => "Its driver was blocked or isn't signed",
        _ => "Not working",
    }
}

fn age_days(date: &str, today: chrono::NaiveDate) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    // Windows' own inbox drivers often carry a placeholder date like 2006-06-21.
    (d.year() >= 2008).then(|| (today - d).num_days())
}

fn build(raw: Raw, today: chrono::NaiveDate) -> DriverReport {
    // Self-built PCs report "To be filled by O.E.M." or similar; the motherboard maker has the drivers.
    let (maker, maker_link) = match (maker_link(&raw.maker), maker_link(&raw.board)) {
        (Some(link), _) => (raw.maker, Some(link)),
        (None, Some(link)) => (raw.board, Some(link)),
        (None, None) => (raw.maker, None),
    };

    let problems = raw
        .problems
        .into_iter()
        .map(|p| {
            let category = category(&p.class).unwrap_or("Other");
            Problem { download: download(category, vendor(&p.id, ""), &maker_link), message: problem_message(p.code), name: p.name, category, code: p.code }
        })
        .collect();

    let mut drivers: Vec<Driver> = raw
        .drivers
        .into_iter()
        // Microsoft's own drivers come with Windows and are updated by Windows Update.
        .filter(|d| !d.provider.to_ascii_lowercase().starts_with("microsoft") && !d.provider.is_empty())
        .filter_map(|d| {
            let category = category(&d.class)?;
            let age = age_days(&d.date, today);
            // Graphics drivers change every few months; most others every few years.
            let limit = if category == "Graphics" { 270 } else { 3 * 365 };
            Some(Driver {
                download: download(category, vendor(&d.id, &d.provider), &maker_link),
                old: age.is_some_and(|a| a > limit),
                age_days: age,
                name: d.name,
                category,
                version: d.version,
                date: d.date,
                provider: d.provider,
            })
        })
        .collect();
    // One row per device and driver: Windows lists some devices several times.
    drivers.sort_by(|a, b| b.old.cmp(&a.old).then(a.category.cmp(b.category)).then(a.name.cmp(&b.name)).then(a.version.cmp(&b.version)));
    drivers.dedup_by(|a, b| a.name == b.name && a.version == b.version);
    DriverReport { maker, maker_link, problems, drivers }
}

#[tauri::command]
pub async fn get_drivers() -> Result<DriverReport, String> {
    crate::blocking(|| {
        let value = crate::ps::json(SCRIPT, Duration::from_secs(60))?;
        let raw: Raw = serde_json::from_value(value).map_err(|e| format!("Couldn't read the driver list: {e}"))?;
        Ok(build(raw, chrono::Local::now().date_naive()))
    })
    .await
}

/// Opens one of the download pages above (or Windows Update).
#[tauri::command(async)]
pub fn open_driver_link(url: String) -> Result<(), String> {
    if !known(&url) {
        return Err("Unknown link.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the page: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_old_drivers_and_picks_downloads() {
        let raw: Raw = serde_json::from_str(
            r#"{"maker":"To be filled by O.E.M.","board":"Micro-Star International Co., Ltd.",
                "problems":[{"name":"Unknown device","class":"","code":28,"id":"PCI\\VEN_10EC&DEV_8125"}],
                "drivers":[
                  {"name":"NVIDIA GeForce RTX 3060","class":"DISPLAY","version":"31.0.15.1694","date":"2022-08-01","provider":"NVIDIA","id":"PCI\\VEN_10DE&DEV_2503"},
                  {"name":"Realtek Audio","class":"MEDIA","version":"6.0.9000.1","date":"2025-01-10","provider":"Realtek Semiconductor Corp.","id":"HDAUDIO\\FUNC_01&VEN_10EC"},
                  {"name":"Realtek Audio","class":"MEDIA","version":"6.0.9000.1","date":"2025-01-10","provider":"Realtek Semiconductor Corp.","id":"HDAUDIO\\FUNC_01&VEN_10EC"},
                  {"name":"Standard SATA AHCI Controller","class":"HDC","version":"10.0.26100.1","date":"2006-06-21","provider":"Microsoft","id":"PCI\\VEN_1022"},
                  {"name":"Volume","class":"VOLUME","version":"10.0","date":"2006-06-21","provider":"Generic","id":"STORAGE\\VOLUME"}
                ]}"#,
        )
        .unwrap();
        let r = build(raw, chrono::NaiveDate::from_ymd_opt(2026, 10, 22).unwrap());
        assert_eq!(r.maker, "Micro-Star International Co., Ltd.");
        assert_eq!(r.maker_link.as_ref().unwrap().label, "MSI support");
        assert_eq!(r.drivers.len(), 2);
        assert!(r.drivers[0].old && r.drivers[0].download == NVIDIA);
        assert!(!r.drivers[1].old);
        assert_eq!(r.drivers[1].download.label, "MSI support");
        assert_eq!(r.problems[0].message, "No driver is installed");
    }

    #[test]
    fn only_opens_known_links() {
        assert!(known(NVIDIA.url) && known(WINDOWS_UPDATE.url) && known("https://pcsupport.lenovo.com/"));
        assert!(!known("https://example.com/"));
    }
}
