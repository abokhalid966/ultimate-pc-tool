import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Cable, CircleAlert, Gauge, Globe, MapPin, RefreshCw, ShieldCheck, Timer, Wifi, X } from "lucide-react";
import { api, AppConnections, DnsProvider, DnsSpeed, errorText, NetAdapter, PublicInfo, SpeedEvent, SpeedResult, WifiInfo } from "../api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { useOnRefresh } from "../hooks/useRefresh";
import "./network/network.css";

const PROVIDERS: { id: DnsProvider; label: string; note: string; servers: string[] }[] = [
  { id: "automatic", label: "Automatic", note: "From your router or internet provider", servers: [] },
  { id: "cloudflare", label: "Cloudflare", note: "Fast and private", servers: ["1.1.1.1", "1.0.0.1"] },
  { id: "google", label: "Google", note: "Fast and reliable", servers: ["8.8.8.8", "8.8.4.4"] },
  { id: "quad9", label: "Quad9", note: "Blocks known dangerous sites", servers: ["9.9.9.9", "149.112.112.112"] },
  { id: "adguard", label: "AdGuard", note: "Blocks ads and trackers", servers: ["94.140.14.14", "94.140.15.15"] },
];

const mbps = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const linkText = (bps: number) => (bps >= 1e9 ? `${+(bps / 1e9).toFixed(1)} Gbps` : bps > 0 ? `${Math.round(bps / 1e6)} Mbps` : "");
const providerOf = (a: NetAdapter): DnsProvider | null =>
  a.dnsAutomatic ? "automatic" : PROVIDERS.find((p) => p.servers.length && a.dns.some((d) => p.servers.includes(d)))?.id ?? null;
/** The adapter that carries internet traffic: the first one with a gateway. */
const mainAdapter = (list: NetAdapter[]) => list.find((a) => a.gateway.length > 0) ?? list[0] ?? null;

export function Network({ elevated, onRestartAsAdmin }: { elevated: boolean; onRestartAsAdmin: () => void }) {
  const [info, setInfo] = useState<{ adapters: NetAdapter[]; wifi: WifiInfo | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pub, setPub] = useState<PublicInfo | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.networkInfo().then(setInfo, (e) => setError(errorText(e)));
    api.publicInfo().then(setPub, () => setPub({ ip: null, isp: null, city: null, country: null }));
  }, []);
  useEffect(load, [load]);
  useOnRefresh(load);

  const adapter = info ? mainAdapter(info.adapters) : null;

  return (
    <div className="page">
      <PageHeader
        title="Network"
        subtitle="Test your internet speed, pick a faster DNS and see which apps are online."
        actions={
          <button className="btn" onClick={load}>
            <RefreshCw size={16} /> Refresh
          </button>
        }
      />
      {error && !info ? (
        <div className="card">
          <EmptyState icon={CircleAlert} tone="danger" title="Couldn't read your network" body={error} actions={<button className="btn" onClick={load}>Try again</button>} />
        </div>
      ) : (
        <>
          <div className="net-top">
            <ConnectionCard adapter={adapter} wifi={info?.wifi ?? null} pub={pub} loading={!info} />
            <SpeedTest onDone={(r) => r.public.ip && setPub(r.public)} />
          </div>
          {adapter && <DnsCard adapter={adapter} elevated={elevated} onRestartAsAdmin={onRestartAsAdmin} onChanged={load} />}
          <AppsOnline />
        </>
      )}
    </div>
  );
}

function ConnectionCard({ adapter, wifi, pub, loading }: { adapter: NetAdapter | null; wifi: WifiInfo | null; pub: PublicInfo | null; loading: boolean }) {
  const toast = useToast();
  const wireless = adapter?.wireless ?? false;
  const Icon = wireless ? Wifi : Cable;
  const place = [pub?.city, pub?.country].filter(Boolean).join(", ");
  return (
    <section className="card net-conn">
      <div className="net-conn-head">
        <span className="net-icon">
          <Icon size={22} />
        </span>
        <div>
          <div className="muted small">{loading ? "Checking..." : adapter ? (wireless ? "Wi-Fi" : "Wired (Ethernet)") : "Not connected"}</div>
          <div className="net-conn-name">
            {loading ? <Skeleton width={160} height={18} /> : wireless && wifi?.ssid ? wifi.ssid : adapter?.name ?? "No network"}
          </div>
        </div>
        {wireless && wifi && !wifi.needsLocation && <SignalBars pct={wifi.signal} />}
      </div>
      {wireless && wifi?.needsLocation && (
        <div className="net-hint">
          <MapPin size={15} />
          <span>Windows only shares the Wi-Fi name and signal with apps when location access is on.</span>
          <button className="btn btn-sm" onClick={() => api.openWindowsSettings("privacy-location").catch((e) => toast(errorText(e), "error"))}>
            Open settings
          </button>
        </div>
      )}
      <dl className="net-facts">
        {wireless && wifi && !wifi.needsLocation && (
          <>
            <Fact k="Signal">{wifi.signal}%</Fact>
            <Fact k="Wi-Fi speed">{wifi.rxMbps > 0 ? `${wifi.rxMbps} Mbps` : null}</Fact>
            <Fact k="Wi-Fi type">{[wifi.standard, wifi.channel ? `channel ${wifi.channel}` : null].filter(Boolean).join(", ")}</Fact>
          </>
        )}
        {!wireless && <Fact k="Link speed">{adapter ? linkText(adapter.linkSpeed) : null}</Fact>}
        <Fact k="Local IP">{adapter?.ipv4[0]}</Fact>
        <Fact k="Router">{adapter?.gateway[0]}</Fact>
        <Fact k="Public IP">{pub ? pub.ip ?? "Unknown" : <Skeleton width={110} />}</Fact>
        <Fact k="Provider">{pub?.isp ? `${pub.isp}${place ? ` · ${place}` : ""}` : null}</Fact>
      </dl>
    </section>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SignalBars({ pct }: { pct: number }) {
  const bars = pct >= 80 ? 4 : pct >= 55 ? 3 : pct >= 30 ? 2 : 1;
  return (
    <span className="signal" title={`Signal ${pct}%`} aria-label={`Signal ${pct}%`}>
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={b <= bars ? "on" : undefined} style={{ height: 4 + b * 4 }} />
      ))}
    </span>
  );
}

type TestState = { phase: "idle" } | { phase: "ping" | "download" | "upload"; mbps: number; percent: number } | { phase: "done"; result: SpeedResult };

function SpeedTest({ onDone }: { onDone: (r: SpeedResult) => void }) {
  const toast = useToast();
  const [state, setState] = useState<TestState>({ phase: "idle" });
  /** Finished parts of the running test. */
  const live = useRef<{ ping?: number; down?: number }>({});

  const start = () => {
    live.current = {};
    setState({ phase: "ping", mbps: 0, percent: 0 });
    const channel = new Channel<SpeedEvent>();
    channel.onmessage = (e) => {
      if (e.type === "ping") {
        live.current.ping = e.ms;
        setState({ phase: "download", mbps: 0, percent: 0 });
      } else {
        if (e.phase === "download") live.current.down = e.mbps;
        setState({ phase: e.phase, mbps: e.mbps, percent: e.percent });
      }
    };
    api.speedTest(channel).then(
      (result) => {
        if (result.cancelled) return setState({ phase: "idle" });
        setState({ phase: "done", result });
        onDone(result);
      },
      (e) => {
        setState({ phase: "idle" });
        toast(errorText(e), "error");
      },
    );
  };

  const r = state.phase === "done" ? state.result : null;
  const s = state.phase !== "idle" && state.phase !== "done" ? state : null;
  const down = r ? mbps(r.downMbps) : s?.phase === "download" ? mbps(s.mbps) : live.current.down !== undefined && s ? mbps(live.current.down) : "–";
  const up = r ? mbps(r.upMbps) : s?.phase === "upload" ? mbps(s.mbps) : "–";
  const ping = r ? r.pingMs.toFixed(0) : s && live.current.ping !== undefined ? live.current.ping.toFixed(0) : "–";

  return (
    <section className="card net-speed">
      <div className="net-speed-head">
        <h3>
          <Gauge size={16} /> Internet speed
        </h3>
        {s ? (
          <button className="btn btn-sm" onClick={() => api.cancelSpeedTest()}>
            <X size={14} /> Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={start}>
            {r ? "Test again" : "Start test"}
          </button>
        )}
      </div>
      <div className="net-speed-grid">
        <SpeedStat icon={ArrowDown} label="Download" unit="Mbps" value={down} active={s?.phase === "download"} />
        <SpeedStat icon={ArrowUp} label="Upload" unit="Mbps" value={up} active={s?.phase === "upload"} />
        <SpeedStat icon={Timer} label="Ping" unit="ms" value={ping} active={s?.phase === "ping"} />
      </div>
      {s ? (
        <div className="net-speed-progress">
          <div className="bar">
            <span className="bar-fill" style={{ width: `${s.phase === "ping" ? 3 : (s.phase === "upload" ? 50 : 0) + s.percent / 2}%`, display: "block" }} />
          </div>
          <span className="muted small">{s.phase === "ping" ? "Checking response time..." : s.phase === "download" ? "Testing download..." : "Testing upload..."}</span>
        </div>
      ) : (
        <p className="muted small">
          {r
            ? `${verdict(r.downMbps)} Jitter ${r.jitterMs.toFixed(0)} ms. Used about ${Math.round(r.dataMb)} MB of data.`
            : "Takes about 20 seconds and uses up to 400 MB of data. Measured with Cloudflare's speed test servers."}
        </p>
      )}
    </section>
  );
}

const verdict = (down: number) =>
  down >= 200 ? "Very fast: great for 4K streaming, big downloads and gaming." : down >= 50 ? "Fast: fine for streaming, calls and gaming." : down >= 15 ? "OK for HD streaming and calls." : "Slow: videos may buffer.";

function SpeedStat({ icon: Icon, label, unit, value, active }: { icon: typeof Gauge; label: string; unit: string; value: string; active?: boolean }) {
  return (
    <div className={`net-stat ${active ? "active" : ""}`}>
      <span className="muted small">
        <Icon size={14} /> {label}
      </span>
      <span className="net-stat-value">
        {value} <small>{unit}</small>
      </span>
    </div>
  );
}

function DnsCard({ adapter, elevated, onRestartAsAdmin, onChanged }: { adapter: NetAdapter; elevated: boolean; onRestartAsAdmin: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<DnsProvider | null>(null);
  const [speeds, setSpeeds] = useState<DnsSpeed[] | null>(null);
  const [testing, setTesting] = useState(false);
  const current = providerOf(adapter);

  const choose = (p: DnsProvider) => {
    setBusy(p);
    api
      .setDns(adapter.index, adapter.name, p)
      .then((undoId) => {
        const label = PROVIDERS.find((x) => x.id === p)!.label;
        toast(`DNS is now ${label}.`, "success", undoId ? { action: { label: "Undo", run: () => api.undoActivity(undoId).then(onChanged, (e) => toast(errorText(e), "error")) } } : undefined);
        onChanged();
      })
      .catch((e) => toast(errorText(e), "error"))
      .finally(() => setBusy(null));
  };

  const test = () => {
    setTesting(true);
    api
      .dnsBenchmark(adapter.dns.find((d) => d.includes(".")) ?? null)
      .then(setSpeeds)
      .catch((e) => toast(errorText(e), "error"))
      .finally(() => setTesting(false));
  };

  const timeFor = (p: DnsProvider | null) => speeds?.find((x) => x.provider === (p === "automatic" ? null : p));
  const fastest = speeds?.filter((x) => x.ms !== null).sort((a, b) => a.ms! - b.ms!)[0];

  return (
    <section className="card net-dns">
      <div className="net-speed-head">
        <div>
          <h3>
            <Globe size={16} /> DNS
          </h3>
          <p className="muted small">
            DNS turns website names into addresses. A faster one makes sites start loading sooner. Now using:{" "}
            <strong>{adapter.dnsAutomatic ? "Automatic" : adapter.dns.filter((d) => d.includes(".")).join(", ") || "Automatic"}</strong>
          </p>
        </div>
        <button className="btn btn-sm" onClick={test} disabled={testing}>
          <RefreshCw size={14} className={testing ? "spin" : undefined} /> {testing ? "Testing..." : "Test DNS speed"}
        </button>
      </div>
      {!elevated && (
        <div className="net-hint">
          <ShieldCheck size={15} />
          <span>Changing DNS needs administrator rights.</span>
          <button className="btn btn-sm" onClick={onRestartAsAdmin}>
            Restart as administrator
          </button>
        </div>
      )}
      <div className="dns-grid" role="radiogroup" aria-label="DNS provider">
        {PROVIDERS.map((p) => {
          const t = timeFor(p.id);
          const ms = p.id === "automatic" && !t && current === "automatic" ? undefined : t?.ms;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={current === p.id}
              className={`dns-option ${current === p.id ? "selected" : ""}`}
              disabled={!elevated || busy !== null || current === p.id}
              onClick={() => choose(p.id)}
            >
              <span className="dns-option-top">
                <strong>{p.label}</strong>
                {busy === p.id && <RefreshCw size={13} className="spin" />}
                {current === p.id && <span className="pill pill-sm pill-accent">In use</span>}
              </span>
              <span className="muted small">{p.note}</span>
              {speeds && ms !== undefined && (
                <span className={`small ${fastest && t === fastest ? "text-ok" : "muted"}`}>{ms === null ? "No answer" : `${Math.round(ms)} ms${fastest && t === fastest ? " · fastest" : ""}`}</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AppsOnline() {
  const toast = useToast();
  const [list, setList] = useState<AppConnections[] | null>(null);
  const load = useCallback(() => {
    api.connections().then(setList, (e) => toast(errorText(e), "error"));
  }, [toast]);
  useEffect(load, [load]);
  useOnRefresh(load);

  return (
    <section className="card net-apps">
      <div className="net-speed-head">
        <div>
          <h3>Apps using the internet</h3>
          <p className="muted small">Apps with open internet connections right now.</p>
        </div>
        <button className="btn btn-sm" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {!list ? (
        <Skeleton height={14} />
      ) : list.length === 0 ? (
        <p className="muted small">No apps are connected right now.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>App</th>
              <th className="num">Connections</th>
              <th>Talking to</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.name}>
                <td title={a.exe ?? undefined}>{a.name}</td>
                <td className="num">{a.connections}</td>
                <td className="muted net-remotes" title={a.remotes.join("\n")}>
                  {a.remotes.slice(0, 3).join(", ")}
                  {a.remotes.length > 3 && ` +${a.remotes.length - 3} more`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
