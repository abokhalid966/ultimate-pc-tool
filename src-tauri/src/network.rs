//! Network page: connection details, Wi-Fi signal, a speed test, which apps are connected,
//! and switching DNS servers (with undo).

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::actions::{ActivityLog, Undo};
use crate::metrics::SharedSnapshot;
use crate::{blocking, ps};

// ---- Connection details ----

const ADAPTERS_SCRIPT: &str = r#"
$out = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
  $a = $_.NetAdapter
  $static = "$((Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($a.InterfaceGuid)" -ErrorAction SilentlyContinue).NameServer)".Trim()
  [pscustomobject]@{
    index = [int]$_.InterfaceIndex
    name = $_.InterfaceAlias
    description = $a.InterfaceDescription
    wireless = ("$($a.PhysicalMediaType)" -match '802\.11|Wireless') -or ($a.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\.11')
    linkSpeed = [uint64]$a.ReceiveLinkSpeed
    mac = $a.MacAddress
    ipv4 = @($_.IPv4Address | ForEach-Object { $_.IPAddress })
    ipv6 = @($_.IPv6Address | ForEach-Object { $_.IPAddress })
    gateway = @($_.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
    dns = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses })
    dnsAutomatic = -not $static
  }
})
ConvertTo-Json -InputObject $out -Depth 4 -Compress
"#;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WifiInfo {
    pub ssid: Option<String>,
    /// 0-100, as Windows shows it.
    pub signal: u32,
    pub rx_mbps: f64,
    pub tx_mbps: f64,
    pub channel: Option<u32>,
    /// "Wi-Fi 6" and so on.
    pub standard: Option<String>,
    /// Windows 11 hides Wi-Fi details from apps until location access is allowed.
    pub needs_location: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub adapters: serde_json::Value,
    pub wifi: Option<WifiInfo>,
}

#[tauri::command]
pub async fn get_network_info() -> Result<NetworkInfo, String> {
    blocking(|| {
        let wifi = thread::spawn(wifi);
        let adapters = ps::json(ADAPTERS_SCRIPT, Duration::from_secs(20))?;
        Ok(NetworkInfo { adapters, wifi: wifi.join().ok().flatten() })
    })
    .await
}

#[cfg(windows)]
fn wifi() -> Option<WifiInfo> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, HANDLE};
    use windows::Win32::NetworkManagement::WiFi::{
        WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle,
        WlanQueryInterface, wlan_interface_state_connected, wlan_intf_opcode_channel_number, wlan_intf_opcode_current_connection,
    };

    unsafe {
        let (mut version, mut handle) = (0u32, HANDLE::default());
        if WlanOpenHandle(2, None, &mut version, &mut handle) != 0 {
            return None;
        }
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        let mut found = None;
        if WlanEnumInterfaces(handle, None, &mut list) == 0 && !list.is_null() {
            let count = (*list).dwNumberOfItems as usize;
            let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), count);
            for item in items.iter().filter(|i| i.isState == wlan_interface_state_connected) {
                let (mut size, mut data) = (0u32, std::ptr::null_mut::<c_void>());
                let rc = WlanQueryInterface(handle, &item.InterfaceGuid, wlan_intf_opcode_current_connection, None, &mut size, &mut data, None);
                if rc == ERROR_ACCESS_DENIED.0 {
                    found = Some(WifiInfo { needs_location: true, ..Default::default() });
                    break;
                }
                if rc != 0 || data.is_null() {
                    continue;
                }
                let attrs = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                let a = &attrs.wlanAssociationAttributes;
                let len = (a.dot11Ssid.uSSIDLength as usize).min(32);
                let ssid = String::from_utf8_lossy(&a.dot11Ssid.ucSSID[..len]).into_owned();
                let standard = match a.dot11PhyType.0 {
                    7 => Some("Wi-Fi 4"),
                    8 => Some("Wi-Fi 5"),
                    10 => Some("Wi-Fi 6"),
                    11 => Some("Wi-Fi 7"),
                    _ => None,
                };
                let mut info = WifiInfo {
                    ssid: (!ssid.is_empty()).then_some(ssid),
                    signal: a.wlanSignalQuality.min(100),
                    rx_mbps: a.ulRxRate as f64 / 1000.0,
                    tx_mbps: a.ulTxRate as f64 / 1000.0,
                    channel: None,
                    standard: standard.map(String::from),
                    needs_location: false,
                };
                WlanFreeMemory(data);
                let (mut size, mut data) = (0u32, std::ptr::null_mut::<c_void>());
                if WlanQueryInterface(handle, &item.InterfaceGuid, wlan_intf_opcode_channel_number, None, &mut size, &mut data, None) == 0
                    && !data.is_null()
                {
                    info.channel = Some(*(data as *const u32));
                    WlanFreeMemory(data);
                }
                found = Some(info);
                break;
            }
            WlanFreeMemory(list as *const c_void);
        }
        WlanCloseHandle(handle, None);
        found
    }
}

#[cfg(not(windows))]
fn wifi() -> Option<WifiInfo> {
    None
}

// ---- Public address and provider ----

fn agent() -> Result<ureq::Agent, String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("Couldn't set up a secure connection: {e}"))?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .timeout_connect(Duration::from_secs(6))
        .timeout_read(Duration::from_secs(12))
        .user_agent("Optimo")
        .build())
}

const SPEED_HOST: &str = "https://speed.cloudflare.com";

fn offline(e: impl std::fmt::Display) -> String {
    format!("Couldn't reach the internet. Check your connection and try again. ({e})")
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublicInfo {
    pub ip: Option<String>,
    /// The internet provider.
    pub isp: Option<String>,
    pub city: Option<String>,
    pub country: Option<String>,
}

fn public_info(agent: &ureq::Agent) -> Result<PublicInfo, String> {
    let text = agent.get(&format!("{SPEED_HOST}/meta")).call().map_err(offline)?.into_string().map_err(offline)?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
    Ok(PublicInfo { ip: s("clientIp"), isp: s("asOrganization"), city: s("city"), country: s("country") })
}

#[tauri::command]
pub async fn get_public_info() -> Result<PublicInfo, String> {
    blocking(|| public_info(&agent()?)).await
}

// ---- Speed test ----

static SPEED_CANCEL: AtomicBool = AtomicBool::new(false);
static SPEED_RUNNING: AtomicBool = AtomicBool::new(false);
const STREAMS: usize = 4;
const PHASE_TIME: Duration = Duration::from_secs(8);
/// The first second only gets the connections up to speed, so it isn't counted.
const WARM_UP: Duration = Duration::from_secs(1);
const MAX_DOWN: u64 = 300_000_000;
const MAX_UP: u64 = 100_000_000;
const UP_CHUNK: usize = 4_000_000;

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SpeedEvent {
    Ping { ms: f64 },
    Progress { phase: &'static str, mbps: f64, percent: u8 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub ping_ms: f64,
    pub jitter_ms: f64,
    pub down_mbps: f64,
    pub up_mbps: f64,
    pub public: PublicInfo,
    pub cancelled: bool,
    /// Megabytes the test used.
    pub data_mb: f64,
}

#[tauri::command]
pub async fn network_speed_test(on_event: Channel<SpeedEvent>) -> Result<SpeedResult, String> {
    if SPEED_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A speed test is already running.".into());
    }
    SPEED_CANCEL.store(false, Ordering::SeqCst);
    let result = blocking(move || speed_test(&on_event)).await;
    SPEED_RUNNING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn network_cancel_speed_test() {
    SPEED_CANCEL.store(true, Ordering::SeqCst);
}

fn speed_test(events: &Channel<SpeedEvent>) -> Result<SpeedResult, String> {
    let agent = agent()?;
    let public = public_info(&agent)?;

    // Ping: small requests on a warm connection. The first one includes the handshake.
    let mut times = Vec::new();
    for i in 0..9 {
        let started = Instant::now();
        agent.get(&format!("{SPEED_HOST}/__down?bytes=0")).call().map_err(offline)?;
        if i > 0 {
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            times.push(ms);
            let _ = events.send(SpeedEvent::Ping { ms });
        }
    }
    let ping_ms = median(&mut times.clone());
    let jitter_ms = times.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (times.len() - 1).max(1) as f64;

    let down = measure("download", &agent, events, MAX_DOWN, |agent, total, stop| {
        while !stop.load(Ordering::Relaxed) {
            let Ok(resp) = agent.get(&format!("{SPEED_HOST}/__down?bytes=25000000")).call() else { break };
            let mut reader = resp.into_reader();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        total.fetch_add(n as u64, Ordering::Relaxed);
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                }
            }
        }
    });
    let up = if SPEED_CANCEL.load(Ordering::SeqCst) {
        (0.0, 0)
    } else {
        measure("upload", &agent, events, MAX_UP, |agent, total, stop| {
            while !stop.load(Ordering::Relaxed) {
                let body = Zeros { left: UP_CHUNK, total, stop };
                if agent
                    .post(&format!("{SPEED_HOST}/__up"))
                    .set("Content-Type", "application/octet-stream")
                    .set("Content-Length", &UP_CHUNK.to_string())
                    .send(body)
                    .is_err()
                {
                    break;
                }
            }
        })
    };
    let cancelled = SPEED_CANCEL.load(Ordering::SeqCst);
    if !cancelled && down.0 == 0.0 {
        return Err("The download test didn't get through. Check your connection and try again.".into());
    }
    Ok(SpeedResult { ping_ms, jitter_ms, down_mbps: down.0, up_mbps: up.0, public, cancelled, data_mb: (down.1 + up.1) as f64 / 1e6 })
}

/// Runs `stream` on several connections for a few seconds and returns (Mbps, bytes moved).
fn measure(
    phase: &'static str,
    agent: &ureq::Agent,
    events: &Channel<SpeedEvent>,
    max_bytes: u64,
    stream: fn(&ureq::Agent, &AtomicU64, &AtomicBool),
) -> (f64, u64) {
    let total = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let workers: Vec<_> = (0..STREAMS)
        .map(|_| {
            let (agent, total, stop) = (agent.clone(), total.clone(), stop.clone());
            thread::spawn(move || stream(&agent, &total, &stop))
        })
        .collect();
    let started = Instant::now();
    let mut baseline: Option<(Instant, u64)> = None;
    let mut mbps = 0.0;
    loop {
        thread::sleep(Duration::from_millis(250));
        let now = Instant::now();
        let bytes = total.load(Ordering::Relaxed);
        if baseline.is_none() && now - started >= WARM_UP {
            baseline = Some((now, bytes));
        }
        if let Some((t0, b0)) = baseline {
            let secs = (now - t0).as_secs_f64();
            if secs > 0.2 {
                mbps = (bytes - b0) as f64 * 8.0 / secs / 1e6;
            }
        } else {
            mbps = bytes as f64 * 8.0 / (now - started).as_secs_f64() / 1e6;
        }
        let elapsed = now - started;
        let percent = ((elapsed.as_secs_f64() / PHASE_TIME.as_secs_f64()).max(bytes as f64 / max_bytes as f64) * 100.0).min(100.0) as u8;
        let _ = events.send(SpeedEvent::Progress { phase, mbps, percent });
        if elapsed >= PHASE_TIME || bytes >= max_bytes || SPEED_CANCEL.load(Ordering::SeqCst) || workers.iter().all(|w| w.is_finished()) {
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
    // Workers notice `stop` at their next chunk; don't wait for slow ones.
    (mbps, total.load(Ordering::Relaxed))
}

/// An upload body of zeros that counts what has been sent.
struct Zeros<'a> {
    left: usize,
    total: &'a AtomicU64,
    stop: &'a AtomicBool,
}

impl Read for Zeros<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("stopped"));
        }
        let n = buf.len().min(self.left).min(64 * 1024);
        buf[..n].fill(0);
        self.left -= n;
        self.total.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    values[values.len() / 2]
}

// ---- Apps connected to the internet ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConnections {
    pub name: String,
    pub exe: Option<String>,
    pub pids: Vec<u32>,
    pub connections: u32,
    /// A few of the addresses it talks to.
    pub remotes: Vec<String>,
}

#[tauri::command]
pub fn network_connections(app: AppHandle) -> Vec<AppConnections> {
    let processes = app.state::<SharedSnapshot>().read().processes.clone();
    let names: HashMap<u32, (&str, Option<&String>)> = processes.iter().map(|p| (p.pid, (p.name.as_str(), p.exe.as_ref()))).collect();
    let mut by_app: HashMap<String, AppConnections> = HashMap::new();
    for (pid, remote) in tcp_connections() {
        if remote.is_loopback() || remote.is_unspecified() {
            continue;
        }
        let (name, exe) = match names.get(&pid) {
            Some((name, exe)) => (name.to_string(), exe.cloned()),
            None if pid == 4 => ("System".to_string(), None),
            None => (format!("Process {pid}"), None),
        };
        let entry = by_app.entry(name.to_ascii_lowercase()).or_insert_with(|| AppConnections {
            name: name.clone(),
            exe,
            pids: Vec::new(),
            connections: 0,
            remotes: Vec::new(),
        });
        entry.connections += 1;
        if !entry.pids.contains(&pid) {
            entry.pids.push(pid);
        }
        let addr = remote.to_string();
        if entry.remotes.len() < 4 && !entry.remotes.contains(&addr) {
            entry.remotes.push(addr);
        }
    }
    let mut list: Vec<AppConnections> = by_app.into_values().collect();
    list.sort_by(|a, b| b.connections.cmp(&a.connections).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    list
}

/// Established TCP connections as (process id, remote address), IPv4 and IPv6.
#[cfg(windows)]
fn tcp_connections() -> Vec<(u32, IpAddr)> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    const ESTABLISHED: u32 = 5;

    fn table(family: u16) -> Vec<u64> {
        for _ in 0..3 {
            let mut size = 0u32;
            unsafe { GetExtendedTcpTable(None, &mut size, false, family as u32, TCP_TABLE_OWNER_PID_ALL, 0) };
            if size == 0 {
                return Vec::new();
            }
            let mut buf = vec![0u64; (size as usize).div_ceil(8) + 64];
            size = (buf.len() * 8) as u32;
            if unsafe { GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, family as u32, TCP_TABLE_OWNER_PID_ALL, 0) } == 0 {
                return buf;
            }
        }
        Vec::new()
    }

    let mut out = Vec::new();
    let v4 = table(AF_INET.0);
    if !v4.is_empty() {
        let t = v4.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let rows: &[MIB_TCPROW_OWNER_PID] = unsafe { std::slice::from_raw_parts((*t).table.as_ptr(), (*t).dwNumEntries as usize) };
        out.extend(
            rows.iter()
                .filter(|r| r.dwState == ESTABLISHED)
                .map(|r| (r.dwOwningPid, IpAddr::V4(Ipv4Addr::from(r.dwRemoteAddr.to_ne_bytes())))),
        );
    }
    let v6 = table(AF_INET6.0);
    if !v6.is_empty() {
        let t = v6.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID;
        let rows: &[MIB_TCP6ROW_OWNER_PID] = unsafe { std::slice::from_raw_parts((*t).table.as_ptr(), (*t).dwNumEntries as usize) };
        out.extend(rows.iter().filter(|r| r.dwState == ESTABLISHED).map(|r| {
            let addr = std::net::Ipv6Addr::from(r.ucRemoteAddr);
            // IPv4 seen through an IPv6 socket.
            (r.dwOwningPid, addr.to_ipv4_mapped().map_or(IpAddr::V6(addr), IpAddr::V4))
        }));
    }
    out
}

#[cfg(not(windows))]
fn tcp_connections() -> Vec<(u32, IpAddr)> {
    Vec::new()
}

// ---- DNS ----

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum DnsProvider {
    /// Whatever the router hands out.
    Automatic,
    Cloudflare,
    Google,
    Quad9,
    /// Blocks ads and trackers.
    Adguard,
}

impl DnsProvider {
    const ALL: [DnsProvider; 4] = [DnsProvider::Cloudflare, DnsProvider::Google, DnsProvider::Quad9, DnsProvider::Adguard];

    fn servers(self) -> &'static [&'static str] {
        match self {
            DnsProvider::Automatic => &[],
            DnsProvider::Cloudflare => &["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"],
            DnsProvider::Google => &["8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"],
            DnsProvider::Quad9 => &["9.9.9.9", "149.112.112.112", "2620:fe::fe", "2620:fe::9"],
            DnsProvider::Adguard => &["94.140.14.14", "94.140.15.15", "2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff"],
        }
    }

    fn label(self) -> &'static str {
        match self {
            DnsProvider::Automatic => "Automatic (from your router)",
            DnsProvider::Cloudflare => "Cloudflare",
            DnsProvider::Google => "Google",
            DnsProvider::Quad9 => "Quad9",
            DnsProvider::Adguard => "AdGuard",
        }
    }
}

/// The DNS servers set by hand on an adapter, or None when it uses automatic DNS.
fn manual_dns(index: u32) -> Result<Option<Vec<String>>, String> {
    let script = format!(
        r#"$g = (Get-NetAdapter -InterfaceIndex {index} -ErrorAction Stop).InterfaceGuid
$v4 = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$g" -ErrorAction SilentlyContinue).NameServer
$v6 = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\$g" -ErrorAction SilentlyContinue).NameServer
ConvertTo-Json -InputObject "$v4 $v6" -Compress"#
    );
    let text = ps::json(&script, Duration::from_secs(15))?;
    let servers: Vec<String> = text.as_str().unwrap_or("").split([',', ' ']).filter(|s| !s.is_empty()).map(String::from).collect();
    Ok((!servers.is_empty()).then_some(servers))
}

fn apply_dns(index: u32, servers: Option<&[String]>) -> Result<(), String> {
    let set = match servers {
        Some(list) if !list.is_empty() => {
            format!("-ServerAddresses @({})", list.iter().map(|s| ps::quote(s)).collect::<Vec<_>>().join(","))
        }
        _ => "-ResetServerAddresses".to_string(),
    };
    let script = format!(
        "try {{ Set-DnsClientServerAddress -InterfaceIndex {index} {set} -ErrorAction Stop; Clear-DnsClientCache; 'ok' }} catch {{ $_.Exception.Message }}"
    );
    let (out, err) = ps::run(&script, Duration::from_secs(20))?;
    if out.trim() == "ok" {
        Ok(())
    } else {
        Err(format!("Windows didn't change the DNS servers. {}", if out.trim().is_empty() { err.trim() } else { out.trim() }))
    }
}

#[tauri::command]
pub async fn network_set_dns(app: AppHandle, index: u32, adapter: String, provider: DnsProvider) -> Result<Option<String>, String> {
    if !crate::os::is_elevated() {
        return Err("Changing DNS needs administrator rights. Use Restart as administrator first.".into());
    }
    blocking(move || {
        let previous = manual_dns(index)?;
        let servers: Vec<String> = provider.servers().iter().map(|s| s.to_string()).collect();
        apply_dns(index, (!servers.is_empty()).then_some(&servers[..]))?;
        let was = previous.as_ref().map_or("automatic".to_string(), |s| s.join(", "));
        let id = app.state::<ActivityLog>().record(
            &app,
            "Network",
            format!("Switched DNS on {adapter} to {}", provider.label()),
            Some(format!("Was {was}")),
            Some(Undo::Dns { index, adapter, servers: previous }),
        );
        Ok(id)
    })
    .await
}

/// Puts an adapter's DNS servers back (activity undo). `None` means automatic.
pub fn restore_dns(index: u32, servers: &Option<Vec<String>>) -> Result<(), String> {
    if !crate::os::is_elevated() {
        return Err("Changing DNS needs administrator rights. Use Restart as administrator first.".into());
    }
    apply_dns(index, servers.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsSpeed {
    /// `None` for the DNS the PC uses now.
    pub provider: Option<DnsProvider>,
    pub server: String,
    /// Typical answer time; `None` when it didn't answer.
    pub ms: Option<f64>,
}

const TEST_NAMES: [&str; 6] = ["google.com", "microsoft.com", "wikipedia.org", "amazon.com", "github.com", "cloudflare.com"];

/// Times a few lookups against each provider, and against `current` (the DNS in use now).
#[tauri::command]
pub async fn network_dns_benchmark(current: Option<String>) -> Vec<DnsSpeed> {
    blocking(move || {
        let mut targets: Vec<(Option<DnsProvider>, String)> = DnsProvider::ALL.iter().map(|p| (Some(*p), p.servers()[0].to_string())).collect();
        if let Some(c) = current.filter(|c| c.parse::<Ipv4Addr>().is_ok() && !targets.iter().any(|(_, s)| s == c)) {
            targets.insert(0, (None, c));
        }
        let handles: Vec<_> = targets
            .into_iter()
            .map(|(provider, server)| {
                thread::spawn(move || {
                    let ip: IpAddr = server.parse().unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
                    let mut times: Vec<f64> = TEST_NAMES.iter().filter_map(|n| dns_query_ms(ip, n)).collect();
                    let ms = (times.len() >= 3).then(|| median(&mut times));
                    DnsSpeed { provider, server, ms }
                })
            })
            .collect();
        Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
    })
    .await
    .unwrap_or_default()
}

/// One DNS lookup (A record) over UDP, in milliseconds.
fn dns_query_ms(server: IpAddr, name: &str) -> Option<f64> {
    let socket = UdpSocket::bind(if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).ok()?;
    socket.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    socket.connect((server, 53)).ok()?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let id = (nanos as u16) ^ (name.len() as u16).wrapping_mul(7919) ^ std::process::id() as u16;
    let packet = dns_packet(id, name);
    let started = Instant::now();
    socket.send(&packet).ok()?;
    let mut buf = [0u8; 512];
    loop {
        let n = socket.recv(&mut buf).ok()?;
        if n >= 2 && u16::from_be_bytes([buf[0], buf[1]]) == id {
            return Some(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

fn dns_packet(id: u16, name: &str) -> Vec<u8> {
    let mut p = Vec::with_capacity(32 + name.len());
    p.extend_from_slice(&id.to_be_bytes());
    // Recursion desired; one question.
    p.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    for label in name.split('.') {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    // End of name, type A, class IN.
    p.extend_from_slice(&[0, 0, 1, 0, 1]);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_dns_question() {
        let p = dns_packet(0x1234, "a.bc");
        assert_eq!(&p[..12], &[0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&p[12..], &[1, b'a', 2, b'b', b'c', 0, 0, 1, 0, 1]);
    }

    #[test]
    fn medians() {
        assert_eq!(median(&mut [5.0, 1.0, 3.0]), 3.0);
        assert_eq!(median(&mut []), 0.0);
    }
}
