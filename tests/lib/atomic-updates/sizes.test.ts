import { describe, it, expect } from "vitest";
import {
  SIZE_BANDS,
  SIZE_KEYS,
  ASCENDING_SIZE_KEYS,
  SIZE_RANK,
  SIZES_BELOW_SIGNAL_FLOOR,
} from "../../../src/lib/atomic-updates/sizes";
import { atomicUpdateSizeEnum } from "../../../src/db/schema";

describe("SIZE_BANDS", () => {
  it("carries the six bands, most significant first", () => {
    expect(SIZE_BANDS.map((b) => b.key)).toEqual(["xl", "l", "m", "s", "xs", "xxs"]);
  });

  it("marks xl/l/m/s as signal and xs/xxs as not", () => {
    const signalByKey = Object.fromEntries(SIZE_BANDS.map((b) => [b.key, b.signal]));
    expect(signalByKey).toEqual({
      xl: true,
      l: true,
      m: true,
      s: true,
      xs: false,
      xxs: false,
    });
  });
});

describe("SIZE_KEYS", () => {
  it("matches SIZE_BANDS' keys in the same order", () => {
    expect(SIZE_KEYS).toEqual(SIZE_BANDS.map((b) => b.key));
  });

  it("agrees with the pg enum on the set of size keys", () => {
    expect([...atomicUpdateSizeEnum.enumValues].sort()).toEqual([...SIZE_KEYS].sort());
  });
});

describe("ASCENDING_SIZE_KEYS", () => {
  it("is the exact reverse of SIZE_KEYS", () => {
    expect(ASCENDING_SIZE_KEYS).toEqual([...SIZE_KEYS].reverse());
  });
});

describe("SIZE_RANK", () => {
  it("ranks strictly descending over SIZE_BANDS' order", () => {
    for (let i = 0; i < SIZE_BANDS.length - 1; i++) {
      const higher = SIZE_BANDS[i].key;
      const lower = SIZE_BANDS[i + 1].key;
      expect(SIZE_RANK[higher]).toBeGreaterThan(SIZE_RANK[lower]);
    }
  });

  it("has an entry for every band and nothing else", () => {
    expect(Object.keys(SIZE_RANK).sort()).toEqual(SIZE_BANDS.map((b) => b.key).sort());
  });
});

describe("SIZES_BELOW_SIGNAL_FLOOR", () => {
  it("equals exactly xs and xxs", () => {
    expect(SIZES_BELOW_SIGNAL_FLOOR).toEqual(["xs", "xxs"]);
  });

  it("is derived from the signal flag: every other band has signal: true", () => {
    const above = SIZE_BANDS.filter((b) => !SIZES_BELOW_SIGNAL_FLOOR.includes(b.key));
    for (const band of above) {
      expect(band.signal).toBe(true);
    }
  });
});
