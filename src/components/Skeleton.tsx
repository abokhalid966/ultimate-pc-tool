import { CSSProperties } from "react";

export function Skeleton({ width = "100%", height = 12, radius, style }: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

/** Placeholder table rows shown until the first data arrives. */
export function SkeletonRows({ columns, rows = 6 }: { columns: number; rows?: number }) {
  const widths = ["62%", "48%", "70%", "55%", "40%", "66%"];
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="skeleton-row" aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c}>
              <Skeleton width={c === 0 ? widths[r % widths.length] : "60%"} style={c > 0 ? { marginLeft: "auto" } : undefined} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
