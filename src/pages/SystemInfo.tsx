import { ReactNode, useCallback, useEffect, useState } from "react";
import { BatteryMedium, CircleAlert, Copy, Cpu, Gpu, HardDrive, Laptop, MemoryStick, Monitor, RefreshCw, ScrollText } from "lucide-react";
import { api, errorText, Specs } from "../api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { bytes } from "../format";
import { useOnRefresh } from "../hooks/useRefresh";
import "./specs/specs.css";

/** Read once per run: the parts don't change while the app is open. */
let cached: Specs | null = null;

const gb = (n: number) => (n >= 1024 ** 3 ? `${Math.round(n / 1024 ** 3)} GB` : bytes(n));
const pcName = (s: Specs) => {
  const generic = /to be filled|system product name|default string|^$/i;
  const model = generic.test(s.model) ? "" : s.model;
  const maker = generic.test(s.manufacturer) ? "" : s.manufacturer;
  return model ? (model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`.trim()) : "Your PC";
};
const windowsText = (s: Specs) => `${s.os.replace(/^Microsoft /, "")}${s.osVersion ? ` ${s.osVersion}` : ""}`;
const memoryText = (s: Specs) => {
  const sizes = s.modules.map((m) => gb(m.size));
  const same = sizes.length > 0 && sizes.every((x) => x === sizes[0]);
  const speed = s.modules.find((m) => m.speed > 0)?.speed;
  const layout = s.modules.length > 0 ? ` (${same ? `${s.modules.length} x ${sizes[0]}` : sizes.join(" + ")}${speed ? `, ${speed} MT/s` : ""})` : "";
  return `${gb(s.memory)}${layout}`;
};
const diskKind = (d: Specs["disks"][number]) => [d.media && d.media !== "Unspecified" ? d.media : "", d.bus && d.bus !== "Unknown" ? d.bus : ""].filter(Boolean).join(", ");

function specsText(s: Specs): string {
  const lines = [
    `PC: ${pcName(s)}`,
    `Windows: ${windowsText(s)} (build ${s.osBuild}), ${s.osArch}`,
    `Processor: ${s.cpu} (${s.cores} cores, ${s.threads} threads)`,
    `Memory: ${memoryText(s)}`,
    ...s.gpus.map((g) => `Graphics: ${g.name}${g.memory > 0 ? ` (${gb(g.memory)})` : ""}`),
    ...s.disks.map((d) => `Storage: ${d.name} (${gb(d.size)}${diskKind(d) ? `, ${diskKind(d)}` : ""})`),
    s.board && `Motherboard: ${s.board}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function SystemInfo() {
  const toast = useToast();
  const [specs, setSpecs] = useState<Specs | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .specs()
      .then((s) => {
        cached = s;
        setSpecs(s);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!cached) load();
  }, [load]);
  useOnRefresh(load);

  const copy = () =>
    specs &&
    navigator.clipboard.writeText(specsText(specs)).then(
      () => toast("Specs copied. Paste them anywhere, like a forum post or a message.", "success"),
      () => toast("Couldn't copy to the clipboard.", "error"),
    );

  return (
    <div className="page">
      <PageHeader
        title="System info"
        subtitle="What's inside your PC, in plain words. Handy for support, upgrades or selling."
        actions={
          <>
            <button className="btn" onClick={load} disabled={loading} title="Read the details again">
              <RefreshCw size={16} className={loading ? "spin" : undefined} /> Refresh
            </button>
            <button className="btn btn-primary" onClick={copy} disabled={!specs}>
              <Copy size={16} /> Copy specs
            </button>
          </>
        }
      />
      {error && !specs ? (
        <div className="card">
          <EmptyState icon={CircleAlert} tone="danger" title="Couldn't read your PC's details" body={error} actions={<button className="btn" onClick={load}>Try again</button>} />
        </div>
      ) : !specs ? (
        <SpecsSkeleton />
      ) : (
        <SpecsView s={specs} />
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="spec-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Card({ icon: Icon, title, children }: { icon: typeof Cpu; title: string; children: ReactNode }) {
  return (
    <section className="card spec-card">
      <h3>
        <Icon size={16} /> {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

function SpecsView({ s }: { s: Specs }) {
  const health = s.battery ? Math.min(100, Math.round((s.battery.full / s.battery.design) * 100)) : null;
  return (
    <>
      <section className="card spec-hero">
        <span className="spec-hero-icon">
          <Laptop size={28} />
        </span>
        <div>
          <h2>{pcName(s)}</h2>
          <p className="muted">
            {windowsText(s)} · {s.cpu} · {gb(s.memory)} memory
          </p>
        </div>
      </section>
      <div className="spec-grid">
        <Card icon={Cpu} title="Processor">
          <Row k="Model">{s.cpu}</Row>
          <Row k="Cores">
            {s.cores} cores, {s.threads} threads
          </Row>
          <Row k="Base speed">{s.maxMhz > 0 ? `${(s.maxMhz / 1000).toFixed(2)} GHz` : null}</Row>
        </Card>
        <Card icon={MemoryStick} title="Memory">
          <Row k="Installed">{memoryText(s)}</Row>
          <Row k="Slots">{s.memorySlots > 0 ? `${s.modules.length} of ${s.memorySlots} used` : null}</Row>
          {s.modules.map((m, i) => (
            <Row key={i} k={m.slot || `Module ${i + 1}`}>
              {gb(m.size)}
              {m.speed > 0 && ` · ${m.speed} MT/s`}
              {m.maker && !/^0+$|unknown/i.test(m.maker) && ` · ${m.maker}`}
              {m.part && <span className="muted"> {m.part}</span>}
            </Row>
          ))}
        </Card>
        <Card icon={Gpu} title={s.gpus.length > 1 ? "Graphics cards" : "Graphics card"}>
          {s.gpus.map((g, i) => (
            <div key={i} className="spec-sub">
              <Row k="Model">{g.name}</Row>
              <Row k="Video memory">{g.memory > 0 ? gb(g.memory) : null}</Row>
              <Row k="Driver">{g.driver ? `${g.driver}${g.driverDate ? ` (${g.driverDate})` : ""}` : null}</Row>
              <Row k="Screen">{g.resolution ? `${g.resolution}${g.refresh > 0 ? ` at ${g.refresh} Hz` : ""}` : null}</Row>
            </div>
          ))}
        </Card>
        <Card icon={HardDrive} title="Storage">
          {s.disks.map((d, i) => (
            <Row key={i} k={d.name || `Drive ${i + 1}`}>
              {gb(d.size)}
              {diskKind(d) && ` · ${diskKind(d)}`}
              {d.health && (
                <span className={`pill pill-sm ${/healthy|ok/i.test(d.health) ? "pill-ok" : "pill-warn"}`} style={{ marginLeft: 8 }}>
                  {/healthy|ok/i.test(d.health) ? "Healthy" : d.health}
                </span>
              )}
            </Row>
          ))}
        </Card>
        <Card icon={Monitor} title="Windows">
          <Row k="Edition">{windowsText(s)}</Row>
          <Row k="Build">
            {s.osBuild} · {s.osArch}
          </Row>
          <Row k="Installed">{s.installed}</Row>
          <Row k="Last started">{s.lastBoot}</Row>
          <Row k="PC name">{s.pcName}</Row>
        </Card>
        <Card icon={ScrollText} title="Motherboard and BIOS">
          <Row k="Motherboard">{s.board}</Row>
          <Row k="BIOS">{s.bios ? `${s.bios}${s.biosDate ? ` (${s.biosDate})` : ""}` : null}</Row>
          <Row k="Firmware">{s.firmware}</Row>
          <Row k="Serial number">{s.serial && !/to be filled|default|^0+$/i.test(s.serial) ? s.serial : null}</Row>
        </Card>
        {s.battery && health !== null && (
          <Card icon={BatteryMedium} title="Battery">
            <Row k="Health">
              <span className={health < 60 ? "text-danger" : health < 80 ? "text-warn" : undefined}>{health}%</span>
              <span className="muted"> of its original capacity</span>
            </Row>
            <Row k="Capacity now">{`${(s.battery.full / 1000).toFixed(1)} Wh (new: ${(s.battery.design / 1000).toFixed(1)} Wh)`}</Row>
            <BatteryReport />
          </Card>
        )}
      </div>
    </>
  );
}

/** Windows' own battery report: charge history, usage and capacity over time, opened in the browser. */
function BatteryReport() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const open = () => {
    setBusy(true);
    api
      .runCommand(`$f = Join-Path $env:TEMP 'optimo-battery-report.html'; powercfg /batteryreport /output $f | Out-Null; Start-Process $f`, "powershell", false, "Battery report")
      .then((out) => out.code !== 0 && toast(out.stderr || "Windows couldn't make the battery report.", "error"))
      .catch((e) => toast(errorText(e), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="spec-actions">
      <button className="btn btn-sm" onClick={open} disabled={busy}>
        <ScrollText size={14} /> {busy ? "Making the report..." : "Full battery report"}
      </button>
      <span className="muted small">Charge history, usage and how capacity changed over time.</span>
    </div>
  );
}

function SpecsSkeleton() {
  return (
    <>
      <section className="card spec-hero" aria-busy="true">
        <Skeleton width={56} height={56} radius={12} />
        <div style={{ flex: 1 }}>
          <Skeleton width="40%" height={20} />
          <Skeleton width="70%" height={13} style={{ marginTop: 10 }} />
        </div>
      </section>
      <p className="muted small">Reading your PC's details. This takes a few seconds the first time.</p>
    </>
  );
}
