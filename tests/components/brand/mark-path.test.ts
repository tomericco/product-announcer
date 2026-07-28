import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MARK_PATH,
  MARK_STROKE_WIDTH,
  MARK_TILE_FILL,
  MARK_TILE_RADIUS,
  MARK_TILE_SIZE,
} from "../../../src/components/brand/mark-path";

// The mark has two consumers that cannot share code: <Mark /> renders from
// mark-path.ts, while src/app/icon.svg must inline the same values as literals
// -- favicons are plain static files and render without webfonts. That
// duplication has silently drifted twice (once on the glyph shape, once on the
// tile size), so pin the two together here.
const icon = readFileSync(join(__dirname, "../../../src/app/icon.svg"), "utf8");

describe("brand mark / favicon parity", () => {
  it("favicon uses the exact shared glyph path", () => {
    expect(icon).toContain(`d="${MARK_PATH}"`);
  });

  it("favicon uses the shared stroke width", () => {
    expect(icon).toContain(`stroke-width="${MARK_STROKE_WIDTH}"`);
  });

  it("favicon uses the shared tile fill", () => {
    expect(icon.toUpperCase()).toContain(`FILL="${MARK_TILE_FILL.toUpperCase()}"`);
  });

  it("favicon uses the shared tile size and radius", () => {
    expect(icon).toContain(`viewBox="0 0 ${MARK_TILE_SIZE} ${MARK_TILE_SIZE}"`);
    expect(icon).toContain(
      `<rect width="${MARK_TILE_SIZE}" height="${MARK_TILE_SIZE}" rx="${MARK_TILE_RADIUS}"`
    );
  });

  it("glyph sits low and right on the tile, as designed", () => {
    // The off-centre placement is a deliberate design choice, not the
    // text-anchor side-bearing accident it resembles. Pin it so a future
    // "fix" that recentres the glyph fails loudly instead of silently
    // changing the brand mark.
    const coords = [...MARK_PATH.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
    expect(coords.length).toBeGreaterThan(0);
    const xs = coords.map((m) => Number(m[1]));
    const ys = coords.map((m) => Number(m[2]));
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];

    // Compact, and past the midpoint on both axes.
    expect(maxX - minX).toBeLessThan(8);
    expect(maxY - minY).toBeLessThan(8);
    expect((minX + maxX) / 2).toBeGreaterThan(MARK_TILE_SIZE / 2);
    expect((minY + maxY) / 2).toBeGreaterThan(MARK_TILE_SIZE / 2);

    // Still inside the tile once the stroke is accounted for.
    expect(maxX + MARK_STROKE_WIDTH / 2).toBeLessThanOrEqual(MARK_TILE_SIZE);
    expect(maxY + MARK_STROKE_WIDTH / 2).toBeLessThanOrEqual(MARK_TILE_SIZE);
  });
});

describe("favicon is well-formed XML", () => {
  // A malformed favicon fails silently: the browser renders no icon at all and
  // there is no console error, so it looks like a caching problem. This caught
  // a real outage where a "--" inside a comment aborted parsing.
  it("has no doubled hyphen inside a comment", () => {
    const bodies = [...icon.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, "'--' is illegal inside an XML comment").not.toMatch(/--/);
    }
  });

  it("has no unterminated comment", () => {
    expect(icon.split("<!--").length).toBe(icon.split("-->").length);
  });

  it("has balanced svg tags and a single root", () => {
    expect(icon.match(/<svg\b/g)).toHaveLength(1);
    expect(icon.match(/<\/svg>/g)).toHaveLength(1);
    // Every element is either self-closing or explicitly closed.
    const stripped = icon.replace(/<!--[\s\S]*?-->/g, "");
    const opens = [...stripped.matchAll(/<([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)];
    const stack: string[] = [];
    for (const [, name, selfClose] of opens) {
      if (!selfClose) stack.push(name);
    }
    for (const [, name] of stripped.matchAll(/<\/([a-zA-Z][\w:-]*)\s*>/g)) {
      expect(stack.pop()).toBe(name);
    }
    expect(stack).toHaveLength(0);
  });
});
