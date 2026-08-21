import { describe, it, expect } from "vitest";
import { roundUsd } from "../../../src/lib/ai-visibility/money";

describe("roundUsd", () => {
  it("turns the debris of float4 arithmetic back into money", () => {
    // Verbatim from Postgres: `select 0.012::real * 3`. Three samples at
    // 1.2 cents each is what a real run's cost column is summed out of.
    expect(roundUsd(0.036000000312924385)).toBe(0.04);
    expect(roundUsd(19.999999552965164)).toBe(20);
  });

  it("leaves an already-exact amount alone", () => {
    expect(roundUsd(20)).toBe(20);
    expect(roundUsd(0)).toBe(0);
    expect(roundUsd(499.99)).toBe(499.99);
  });

  it("rounds to the nearer cent", () => {
    expect(roundUsd(1.006)).toBe(1.01);
    expect(roundUsd(1.004)).toBe(1);
    // Exact .005 ties are deliberately NOT promised: the argument is already a
    // binary float, and 1.005 is really 1.00499999..., so it rounds down. No
    // caller depends on tie behaviour — this is display and cap-comparison
    // rounding, not accounting.
    expect(roundUsd(1.005)).toBe(1);
  });
});
