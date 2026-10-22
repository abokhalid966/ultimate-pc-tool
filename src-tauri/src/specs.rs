//! System information: the PC's parts and Windows details, read once when the page opens.

use std::time::Duration;

/// One PowerShell pass over the WMI classes. Field names are what the page reads.
const SCRIPT: &str = r#"
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$bb = Get-CimInstance Win32_BaseBoard
$cpu = @(Get-CimInstance Win32_Processor)
$nt = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$day = { param($d) if ($d) { $d.ToString('yyyy-MM-dd') } else { $null } }
# Win32_VideoController stops at 4 GB, so take the real size from the driver's registry key.
$vram = @{}
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  $m = $p.'HardwareInformation.qwMemorySize'
  if ($p.DriverDesc -and $m) { $vram[$p.DriverDesc] = [uint64]("$m" -replace '[^0-9]', '') }
}
$disks = @()
try {
  $disks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ name = "$($_.FriendlyName)".Trim(); media = "$($_.MediaType)"; bus = "$($_.BusType)"; size = [uint64]$_.Size; health = "$($_.HealthStatus)" }
  })
} catch {
  $disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
    [pscustomobject]@{ name = "$($_.Model)".Trim(); media = ''; bus = "$($_.InterfaceType)"; size = [uint64]$_.Size; health = "$($_.Status)" }
  })
}
$battery = $null
try {
  $bs = Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1
  $bf = Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1
  if ($bs.DesignedCapacity -gt 0 -and $bf.FullChargedCapacity -gt 0) {
    $battery = [pscustomobject]@{ design = [uint64]$bs.DesignedCapacity; full = [uint64]$bf.FullChargedCapacity }
  }
} catch {}
$fw = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control' -ErrorAction SilentlyContinue).PEFirmwareType
[pscustomobject]@{
  manufacturer = "$($cs.Manufacturer)".Trim()
  model = "$($cs.Model)".Trim()
  pcName = $env:COMPUTERNAME
  board = "$($bb.Manufacturer) $($bb.Product)".Trim()
  bios = "$($bios.Manufacturer) $($bios.SMBIOSBIOSVersion)".Trim()
  biosDate = & $day $bios.ReleaseDate
  firmware = if ($fw -eq 2) { 'UEFI' } elseif ($fw -eq 1) { 'Legacy BIOS' } else { $null }
  serial = "$($bios.SerialNumber)".Trim()
  os = "$($os.Caption)".Trim()
  osVersion = $nt.DisplayVersion
  osBuild = "$($os.BuildNumber).$($nt.UBR)"
  osArch = $os.OSArchitecture
  installed = & $day $os.InstallDate
  lastBoot = & $day $os.LastBootUpTime
  cpu = "$($cpu[0].Name)".Trim()
  cores = [int]($cpu | Measure-Object NumberOfCores -Sum).Sum
  threads = [int]($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum
  maxMhz = [int]$cpu[0].MaxClockSpeed
  memory = [uint64]$cs.TotalPhysicalMemory
  memorySlots = [int](Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum
  modules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
    [pscustomobject]@{ slot = "$($_.DeviceLocator)"; size = [uint64]$_.Capacity; speed = [int]$(if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }); maker = "$($_.Manufacturer)".Trim(); part = "$($_.PartNumber)".Trim() }
  })
  gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    $mem = if ($vram[$_.Name]) { $vram[$_.Name] } else { [uint64]$_.AdapterRAM }
    [pscustomobject]@{
      name = "$($_.Name)".Trim(); driver = $_.DriverVersion; driverDate = & $day $_.DriverDate; memory = $mem
      resolution = if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution) x $($_.CurrentVerticalResolution)" } else { $null }
      refresh = [int]$_.CurrentRefreshRate
    }
  })
  disks = $disks
  battery = $battery
} | ConvertTo-Json -Depth 4 -Compress
"#;

#[tauri::command]
pub async fn get_specs() -> Result<serde_json::Value, String> {
    crate::blocking(|| crate::ps::json(SCRIPT, Duration::from_secs(40))).await
}
