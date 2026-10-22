interface Props {
  /** 0–100 */
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  label?: string;
}

/** Circular percentage gauge; the number in the middle is the value. */
export function RingGauge({ value, color, size = 64, stroke = 7, label }: Props) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  // A tiny visible arc even at 0-1%, so the gauge never looks broken.
  const len = Math.max((v / 100) * c, 0.5);
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="ring-value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${len} ${c}`}
        />
      </svg>
      <span className="ring-label" aria-hidden="true">
        <span>
          {Math.round(v)}
          <small>%</small>
        </span>
      </span>
    </div>
  );
}
