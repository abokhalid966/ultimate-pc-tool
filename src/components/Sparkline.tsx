interface Props {
  values: number[];
  /** Fixed ceiling (e.g. 100 for percentages); defaults to the largest value. */
  max?: number;
  color: string;
  height?: number;
  points?: number;
}

/** Filled line chart of the last N samples, newest on the right. */
export function Sparkline({ values, max, color, height = 64, points = 60 }: Props) {
  const width = 300;
  const ceiling = Math.max(max ?? Math.max(...values, 1), 1e-9);
  const step = width / (points - 1);
  const offset = points - values.length;
  const coords = values.map((v, i) => {
    const x = (i + offset) * step;
    const y = height - (Math.min(v, ceiling) / ceiling) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
      {coords.length > 1 && (
        <>
          <polygon
            points={`${offset * step},${height} ${coords.join(" ")} ${width},${height}`}
            fill={color}
            fillOpacity={0.15}
          />
          <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}
