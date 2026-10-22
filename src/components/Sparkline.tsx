import { useId, useLayoutEffect, useRef, useState } from "react";

export interface Series {
  label: string;
  values: number[];
  color: string;
  /** Drawn as a dashed line without a fill (second series in a pair). */
  dashed?: boolean;
}

interface Props {
  series: Series[];
  /** Fixed ceiling (e.g. 100 for percentages). */
  max?: number;
  /** Lowest ceiling when autoscaling, so idle noise stays small. */
  floor?: number;
  format: (v: number) => string;
  height?: number;
  /** Samples shown across the full width (one per second). */
  points?: number;
  /** Small caption in the top-right corner, e.g. "Peak 3.1 MB/s". */
  caption?: string;
}

const PAD_TOP = 4;

/** Monotone cubic curve through the points: smooth, but never overshoots the data. */
function curve(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) m.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = (x1 - x0) / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/**
 * Live line chart of the last minute, newest on the right. The grid is drawn from the first
 * second so a chart that is still filling up looks intentional; hovering shows exact values.
 */
export function Sparkline({ series, max, floor = 0, format, height = 56, points = 60, caption }: Props) {
  const id = useId().replace(/:/g, "");
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = Math.max(0, ...series.map((s) => s.values.length));
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  const ceiling = max ?? Math.max(floor, peak * 1.15, 1e-9);
  const step = width / Math.max(points - 1, 1);
  const x = (i: number, len: number) => width - (len - 1 - i) * step;
  const y = (v: number) => PAD_TOP + (1 - Math.min(Math.max(v, 0), ceiling) / ceiling) * (height - PAD_TOP - 1);
  const baseline = height - 0.5;

  const onMove = (e: React.MouseEvent) => {
    if (!wrap.current || n === 0) return;
    const rect = wrap.current.getBoundingClientRect();
    const fromRight = Math.round((rect.right - e.clientX) / step);
    setHover(fromRight >= 0 && fromRight < n ? fromRight : null);
  };

  const hx = hover !== null ? width - hover * step : 0;

  return (
    <div className="chart" ref={wrap} style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${id}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={0.28} />
                <stop offset="1" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <line className="chart-grid" x1={0} x2={width} y1={PAD_TOP + 0.5} y2={PAD_TOP + 0.5} strokeDasharray="2 4" />
          <line className="chart-grid" x1={0} x2={width} y1={Math.round(y(ceiling / 2)) + 0.5} y2={Math.round(y(ceiling / 2)) + 0.5} strokeDasharray="2 4" />
          <line className="chart-grid" x1={0} x2={width} y1={baseline} y2={baseline} />
          {series.map((s, i) => {
            const len = s.values.length;
            if (len === 0) return null;
            const pts = s.values.map((v, j) => [x(j, len), y(v)] as [number, number]);
            const line = curve(pts);
            const last = pts[pts.length - 1];
            return (
              <g key={i}>
                {!s.dashed && len > 1 && (
                  <path d={`${line}L${last[0]},${baseline}L${pts[0][0]},${baseline}Z`} fill={`url(#${id}-g${i})`} />
                )}
                {len > 1 && (
                  <path
                    d={line}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                  />
                )}
                {hover === null && <circle cx={last[0] - 1.5} cy={last[1]} r={3} fill={s.color} stroke="var(--card)" strokeWidth={2} />}
              </g>
            );
          })}
          {hover !== null && (
            <g>
              <line className="chart-cross" x1={hx} x2={hx} y1={0} y2={height} />
              {series.map((s, i) => {
                const v = s.values[s.values.length - 1 - hover];
                return v === undefined ? null : <circle key={i} cx={hx} cy={y(v)} r={3.5} fill={s.color} stroke="var(--card)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
      )}
      {caption && hover === null && <span className="chart-cap">{caption}</span>}
      {hover !== null && (
        <div className="chart-tip" style={{ left: hx, transform: `translate(${hx < width / 2 ? "-12%" : "-88%"}, -100%)` }}>
          {series.map((s, i) => {
            const v = s.values[s.values.length - 1 - hover];
            return v === undefined ? null : (
              <div key={i} className="chart-tip-row">
                <span className="legend-dot" style={{ background: s.color }} />
                {series.length > 1 && <span>{s.label}</span>}
                <strong>{format(v)}</strong>
              </div>
            );
          })}
          <div className="chart-tip-time">{hover === 0 ? "Now" : `${hover} s ago`}</div>
        </div>
      )}
    </div>
  );
}
