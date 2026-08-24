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

  it("collapses sub-cent amounts, which is what a single sample costs", () => {
    // Below half a cent there is no money to show, and the cap page must say
    // "$0.00" rather than "$0.004".
    expect(roundUsd(0.004)).toBe(0);
    expect(roundUsd(0.006)).toBe(0.01);
  });

  it("is idempotent, so a value can pass through it twice safely", () => {
    // It is applied on the read path AND at display time; applying it again
    // must not move the number.
    for (const value of [0.036000000312924385, 19.999999552965164, 1.006, 499.99]) {
      expect(roundUsd(roundUsd(value))).toBe(roundUsd(value));
    }
  });

  it("puts a float4 sum on the right side of the cap comparison", () => {
    // The gate is `spend >= cap`. A month of float4 sample costs that really
    // adds up to $20 arrives as 19.999999552965164, and unrounded that is
    // BELOW the cap — one more run gets planned past a cap already reached.
    // Rounding first is what makes the boundary mean $20.
    const cap = 20;
    expect(roundUsd(19.999999552965164) >= cap).toBe(true);
    expect(roundUsd(19.994) >= cap).toBe(false);
  });
});
