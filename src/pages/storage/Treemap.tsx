import { CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bytes } from "../../format";
import { squarify } from "./treemap";

export interface TreemapItem {
  key: string;
  label: string;
  bytes: number;
  /** Folders can be opened; "files" is the loose files in this folder; "other" is the small rest. */
  kind: "folder" | "files" | "other";
  node?: number;
}

interface Props {
  items: TreemapItem[];
  /** Size of the folder shown, for percentages. */
  total: number;
  onOpen: (node: number) => void;
  label: string;
}

/** Area-proportional map of a folder's contents: one blue, darker for bigger, so size reads at a glance. */
export function Treemap({ items, total, onOpen, label }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tiles = useMemo(() => squarify(items.map((item) => ({ value: item.bytes, item })), { x: 0, y: 0, w: size.w, h: size.h }), [items, size]);
  const biggest = Math.max(1, ...items.filter((i) => i.kind === "folder").map((i) => i.bytes));
  const hovered = hover && tiles.find((t) => t.item.key === hover.key);

  return (
    <div ref={box} className="treemap" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
      {tiles.map(({ x, y, w, h, item }) => {
        // Sequential shade: bigger folders are a deeper blue.
        const shade = item.kind === "folder" ? 18 + 32 * Math.sqrt(item.bytes / biggest) : 0;
        const openable = item.kind === "folder" && item.node !== undefined;
        return (
          <div
            key={item.key}
            className={`tm-tile tm-${item.kind} ${openable ? "clickable" : ""} ${hover?.key === item.key ? "hover" : ""}`}
            style={{ left: x, top: y, width: w, height: h, "--tm-pct": `${shade}%` } as CSSProperties}
            onClick={() => openable && onOpen(item.node!)}
            onMouseMove={(e) => {
              const r = box.current!.getBoundingClientRect();
              setHover({ key: item.key, x: e.clientX - r.left, y: e.clientY - r.top });
            }}
          >
            <span className="tm-fill">
              {w > 64 && h > 34 && (
                <span className="tm-label">
                  <span className="tm-name">{item.label}</span>
                  <span className="tm-size">{bytes(item.bytes)}</span>
                </span>
              )}
            </span>
          </div>
        );
      })}
      {hovered && hover && (
        <div
          className="tm-tip"
          style={{
            left: Math.min(hover.x + 14, size.w - 200),
            top: hover.y + 18 > size.h - 56 ? hover.y - 58 : hover.y + 18,
          }}
        >
          <strong>{hovered.item.label}</strong>
          <span>
            {bytes(hovered.item.bytes)} · {total > 0 ? `${((hovered.item.bytes / total) * 100).toFixed(hovered.item.bytes / total < 0.1 ? 1 : 0)}%` : "0%"}
          </span>
          {hovered.item.kind === "folder" && <span className="muted">Click to open</span>}
        </div>
      )}
    </div>
  );
}
