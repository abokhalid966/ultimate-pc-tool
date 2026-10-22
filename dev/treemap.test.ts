// Unit tests for the Storage page's treemap layout. Run with `pnpm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { squarify } from "../src/pages/storage/treemap.ts";

const bounds = { x: 0, y: 0, w: 600, h: 200 };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("tiles fill the area in proportion to their values", () => {
  const values = [500, 300, 120, 60, 15, 5];
  const tiles = squarify(
    values.map((value, i) => ({ value, item: i })),
    bounds,
  );
  assert.equal(tiles.length, values.length);
  const total = values.reduce((s, v) => s + v, 0);
  for (const t of tiles) {
    assert.ok(close(t.w * t.h, (t.value / total) * 600 * 200), `area of ${t.item}`);
    assert.ok(t.x >= -1e-6 && t.y >= -1e-6 && t.x + t.w <= 600 + 1e-6 && t.y + t.h <= 200 + 1e-6, `bounds of ${t.item}`);
  }
  // Biggest first, and no two tiles overlap.
  assert.equal(tiles[0].item, 0);
  for (const a of tiles)
    for (const b of tiles) {
      if (a === b) continue;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${a.item} overlaps ${b.item}`);
    }
});

test("keeps tiles roughly square", () => {
  const tiles = squarify(
    Array.from({ length: 12 }, (_, i) => ({ value: 12 - i, item: i })),
    bounds,
  );
  const ratios = tiles.map((t) => Math.max(t.w / t.h, t.h / t.w));
  assert.ok(Math.max(...ratios) < 4, `worst ratio ${Math.max(...ratios)}`);
});

test("skips empty items and empty areas", () => {
  assert.deepEqual(squarify([{ value: 0, item: "a" }], bounds), []);
  assert.deepEqual(squarify([{ value: 5, item: "a" }], { x: 0, y: 0, w: 0, h: 10 }), []);
  const [only] = squarify([{ value: 0, item: "a" }, { value: 3, item: "b" }], bounds);
  assert.deepEqual({ x: only.x, y: only.y, w: only.w, h: only.h, item: only.item }, { ...bounds, item: "b" });
});
