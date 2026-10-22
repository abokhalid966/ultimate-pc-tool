import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowDown, ArrowUp, Maximize2, Thermometer, X } from "lucide-react";
import { api } from "./api";
import { useMetrics } from "./hooks/useMetrics";
import { rate } from "./format";
import { applyTheme, getThemePref } from "./theme";
import "./overlay.css";

const tone = (pct: number) => (pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok");

/** The mini overlay window: live stats in a small always-on-top card. Drag it anywhere. */
export function Overlay() {
  const { latest: m } = useMetrics();
  useEffect(() => {
    document.documentElement.classList.add("overlay-doc");
    // A theme picked in the main window is stored; follow it here too.
    const onStorage = () => applyTheme(getThemePref());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const drag = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    if (e.detail === 2) {
      api.showMain().catch(() => {});
      return;
    }
    getCurrentWindow()
      .startDragging()
      .catch(() => {});
  };

  const cpu = m?.cpuTotal ?? 0;
  const mem = m && m.memTotal > 0 ? (m.memUsed / m.memTotal) * 100 : 0;
  const temp = m && m.temps.length > 0 ? Math.max(...m.temps.map((t) => t.celsius)) : null;

  return (
    <div className="ov" onMouseDown={drag} title="Drag to move. Double-click to open Optimo.">
      <div className="ov-head">
        <span className="ov-brand">Optimo</span>
        <button className="ov-btn" onClick={() => api.showMain()} aria-label="Open Optimo" title="Open Optimo">
          <Maximize2 size={12} />
        </button>
        <button className="ov-btn" onClick={() => api.setOverlay(false)} aria-label="Close the overlay" title="Close the overlay">
          <X size={13} />
        </button>
      </div>
      <Meter label="CPU" pct={cpu} />
      <Meter label="RAM" pct={mem} />
      <div className="ov-row ov-net">
        <span>
          <ArrowDown size={12} /> {rate(m?.netRxBps ?? 0)}
        </span>
        <span>
          <ArrowUp size={12} /> {rate(m?.netTxBps ?? 0)}
        </span>
        {temp !== null && (
          <span className={`ov-temp ${temp >= 85 ? "danger" : temp >= 75 ? "warn" : ""}`}>
            <Thermometer size={12} /> {temp.toFixed(0)}°C
          </span>
        )}
      </div>
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="ov-row">
      <span className="ov-label">{label}</span>
      <span className="ov-bar">
        <span className={tone(pct)} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </span>
      <span className="ov-num">{pct.toFixed(0)}%</span>
    </div>
  );
}
