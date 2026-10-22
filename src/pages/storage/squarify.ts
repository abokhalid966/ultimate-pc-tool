// Squarified treemap layout (Bruls, Huizing & van Wijk): biggest items first, laid out in rows
// along the shorter side so tiles stay as close to square as possible.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tile<T> = Rect & { item: T; value: number };

/** The worst (largest) aspect ratio in a row of tile areas laid along `side`. */
function worst(areas: number[], side: number): number {
  const sum = areas.reduce((s, a) => s + a, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/** Tiles that exactly fill `bounds`, with areas proportional to `value`. Zero values are left out. */
export function squarify<T>(input: { value: number; item: T }[], bounds: Rect): Tile<T>[] {
  const items = input.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const scale = (bounds.w * bounds.h) / total;
  const tiles: Tile<T>[] = [];
  let rect = { ...bounds };
  let i = 0;
  while (i < items.length) {
    const side = Math.min(rect.w, rect.h);
    const areas = [items[i].value * scale];
    let best = worst(areas, side);
    let j = i + 1;
    while (j < items.length) {
      const next = worst([...areas, items[j].value * scale], side);
      if (next > best) break;
      areas.push(items[j].value * scale);
      best = next;
      j++;
    }
    const rowArea = areas.reduce((s, a) => s + a, 0);
    // The last row takes whatever is left, so rounding never leaves a gap.
    const thickness = j >= items.length ? (rect.w >= rect.h ? rect.w : rect.h) : rowArea / side;
    let offset = 0;
    areas.forEach((area, k) => {
      const item = items[i + k];
      const length = area / thickness;
      if (rect.w >= rect.h) tiles.push({ x: rect.x, y: rect.y + offset, w: thickness, h: length, item: item.item, value: item.value });
      else tiles.push({ x: rect.x + offset, y: rect.y, w: length, h: thickness, item: item.item, value: item.value });
      offset += length;
    });
    rect = rect.w >= rect.h ? { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h } : { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness };
    i = j;
  }
  return tiles;
}
