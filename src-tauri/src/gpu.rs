//! Live graphics card stats: load and memory from Windows' own counters (the ones Task Manager
//! uses) and temperature from the driver, when it reports one.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub name: String,
    /// Busiest engine (3D, video, copy...), like Task Manager's headline number.
    pub load: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub temperature: Option<f32>,
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use windows::Wdk::Graphics::Direct3D::{
        D3DKMT_ADAPTER_PERFDATA, D3DKMT_CLOSEADAPTER, D3DKMT_OPENADAPTERFROMLUID, D3DKMT_QUERYADAPTERINFO, D3DKMTCloseAdapter,
        D3DKMTOpenAdapterFromLuid, D3DKMTQueryAdapterInfo, KMTQAITYPE_ADAPTERPERFDATA,
    };
    use windows::Win32::Foundation::LUID;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    use windows::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PdhAddEnglishCounterW, PdhCloseQuery,
        PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    };
    use windows::core::PCWSTR;

    use super::GpuStats;

    /// New GPU engines appear as apps start, so the counters are set up again now and then.
    const REBUILD: Duration = Duration::from_secs(60);

    struct Adapter {
        name: String,
        luid: LUID,
        /// How the counters name it: "luid_0x00000000_0x0000c2e1".
        tag: String,
        mem_total: u64,
    }

    pub struct Sampler {
        adapter: Option<Adapter>,
        query: PDH_HQUERY,
        engines: PDH_HCOUNTER,
        memory: PDH_HCOUNTER,
        built: Instant,
        warmed: bool,
    }

    // The PDH handles are only used from the sampler thread.
    unsafe impl Send for Sampler {}

    impl Sampler {
        pub fn new() -> Self {
            let mut s = Sampler {
                adapter: main_adapter(),
                query: PDH_HQUERY::default(),
                engines: PDH_HCOUNTER::default(),
                memory: PDH_HCOUNTER::default(),
                built: Instant::now(),
                warmed: false,
            };
            s.build();
            s
        }

        fn build(&mut self) {
            self.close();
            self.built = Instant::now();
            self.warmed = false;
            if self.adapter.is_none() {
                return;
            }
            unsafe {
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut self.query) != 0 {
                    self.query = PDH_HQUERY::default();
                    return;
                }
                let add = |path: &str, counter: &mut PDH_HCOUNTER| {
                    let wide = crate::os::wide(std::ffi::OsStr::new(path));
                    PdhAddEnglishCounterW(self.query, PCWSTR(wide.as_ptr()), 0, counter);
                };
                let (mut engines, mut memory) = (PDH_HCOUNTER::default(), PDH_HCOUNTER::default());
                add(r"\GPU Engine(*)\Utilization Percentage", &mut engines);
                add(r"\GPU Adapter Memory(*)\Dedicated Usage", &mut memory);
                self.engines = engines;
                self.memory = memory;
                PdhCollectQueryData(self.query);
            }
        }

        fn close(&mut self) {
            if !self.query.is_invalid() {
                unsafe { PdhCloseQuery(self.query) };
                self.query = PDH_HQUERY::default();
            }
        }

        pub fn sample(&mut self) -> Option<GpuStats> {
            self.adapter.as_ref()?;
            if self.built.elapsed() >= REBUILD {
                self.build();
            }
            let adapter = self.adapter.as_ref()?;
            if self.query.is_invalid() || unsafe { PdhCollectQueryData(self.query) } != 0 {
                return None;
            }
            // Utilization needs two collections; the first one after a rebuild only primes it.
            let first = !self.warmed;
            self.warmed = true;

            // Sum each engine's use over all apps, then report the busiest engine.
            let mut per_engine: HashMap<String, f64> = HashMap::new();
            for (name, value) in read_array(self.engines, false) {
                if !name.contains(&adapter.tag) {
                    continue;
                }
                // "pid_1234_luid_0x..._phys_0_eng_3_engtype_3D": group by everything after the pid.
                let key = name.find("luid_").map(|i| name[i..].to_string()).unwrap_or(name);
                *per_engine.entry(key).or_default() += value;
            }
            let load = if first { 0.0 } else { per_engine.values().copied().fold(0.0, f64::max).clamp(0.0, 100.0) as f32 };
            let mem_used = read_array(self.memory, true)
                .into_iter()
                .filter(|(name, _)| name.contains(&adapter.tag))
                .map(|(_, v)| v as u64)
                .max()
                .unwrap_or(0);
            Some(GpuStats { name: adapter.name.clone(), load, mem_used, mem_total: adapter.mem_total, temperature: temperature(adapter.luid) })
        }
    }

    impl Drop for Sampler {
        fn drop(&mut self) {
            self.close();
        }
    }

    /// The real graphics card with the most memory (skips "Microsoft Basic Render Driver").
    fn main_adapter() -> Option<Adapter> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        let mut best: Option<Adapter> = None;
        for i in 0.. {
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(i) }) else { break };
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..len]).trim().to_string();
            let luid = desc.AdapterLuid;
            let mem_total = desc.DedicatedVideoMemory as u64;
            if best.as_ref().is_none_or(|b| mem_total > b.mem_total) {
                let tag = format!("luid_0x{:08x}_0x{:08x}", luid.HighPart as u32, luid.LowPart).to_ascii_lowercase();
                best = Some(Adapter { name, luid, tag, mem_total });
            }
        }
        best
    }

    /// Instance name (lower case) and value for every instance of a wildcard counter.
    fn read_array(counter: PDH_HCOUNTER, large: bool) -> Vec<(String, f64)> {
        let format = if large { PDH_FMT_LARGE } else { PDH_FMT_DOUBLE };
        let (mut size, mut count) = (0u32, 0u32);
        unsafe {
            PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, None);
        }
        if size == 0 {
            return Vec::new();
        }
        // u64 storage keeps the items aligned.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, Some(items)) } != 0 {
            return Vec::new();
        }
        (0..count as usize)
            .filter_map(|i| {
                let item = unsafe { &*items.add(i) };
                if item.FmtValue.CStatus > 1 {
                    return None;
                }
                let name = unsafe { item.szName.to_string() }.ok()?.to_ascii_lowercase();
                let value = unsafe { if large { item.FmtValue.Anonymous.largeValue as f64 } else { item.FmtValue.Anonymous.doubleValue } };
                Some((name, value))
            })
            .collect()
    }

    /// Driver-reported temperature (WDDM 2.4+), in tenths of a degree; 0 when it has none.
    fn temperature(luid: LUID) -> Option<f32> {
        let mut open = D3DKMT_OPENADAPTERFROMLUID { AdapterLuid: luid, hAdapter: 0 };
        if unsafe { D3DKMTOpenAdapterFromLuid(&mut open) }.is_err() {
            return None;
        }
        let mut perf = D3DKMT_ADAPTER_PERFDATA::default();
        let mut query = D3DKMT_QUERYADAPTERINFO {
            hAdapter: open.hAdapter,
            Type: KMTQAITYPE_ADAPTERPERFDATA,
            pPrivateDriverData: &mut perf as *mut _ as *mut _,
            PrivateDriverDataSize: size_of::<D3DKMT_ADAPTER_PERFDATA>() as u32,
        };
        let ok = unsafe { D3DKMTQueryAdapterInfo(&mut query) }.is_ok();
        unsafe {
            let _ = D3DKMTCloseAdapter(&D3DKMT_CLOSEADAPTER { hAdapter: open.hAdapter });
        }
        let celsius = perf.Temperature as f32 / 10.0;
        (ok && celsius > 1.0 && celsius < 130.0).then_some(celsius)
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Sampler;
    impl Sampler {
        pub fn new() -> Self {
            Sampler
        }
        pub fn sample(&mut self) -> Option<super::GpuStats> {
            None
        }
    }
}

pub use imp::Sampler;
