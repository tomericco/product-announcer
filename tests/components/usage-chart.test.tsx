import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageChart } from "../../src/app/(dashboard)/settings/usage-chart";

/**
 * The brief assumed recharts draws nothing in jsdom (zero-size container),
 * but `ChartContainer` (src/components/ui/chart.tsx) passes recharts'
 * `ResponsiveContainer` an `initialDimension` fallback (320x200), so it DOES
 * render axes and bars even without real layout — including Y-axis tick text
 * that can collide with the same number in the breakdown table (e.g. "100").
 * Scoping to the table (the thing this test is actually meant to pin, per
 * the brief) avoids that collision without weakening the assertion.
 */
function breakdownTable() {
  return within(screen.getByRole("table"));
}

const DATASETS = {
  daily: {
    rows: [{ bucket: "2026-08-28", label: "Aug 28", content_generation: 100 }],
    totals: [{ feature: "content_generation" as const, credits: 100 }],
  },
  weekly: {
    rows: [{ bucket: "2026-08-24", label: "Aug 24", content_generation: 700 }],
    totals: [{ feature: "content_generation" as const, credits: 700 }],
  },
  monthly: {
    rows: [{ bucket: "2026-08", label: "Aug 2026", content_generation: 3000 }],
    totals: [{ feature: "content_generation" as const, credits: 3000 }],
  },
};

describe("UsageChart", () => {
  it("shows the daily dataset by default and switches on toggle", async () => {
    const user = userEvent.setup();
    render(<UsageChart datasets={DATASETS} features={["content_generation"]} />);

    expect(breakdownTable().getByText("100")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Monthly" }));
    expect(breakdownTable().getByText("3,000")).toBeInTheDocument();
    expect(breakdownTable().queryByText("100")).not.toBeInTheDocument();
  });

  it("renders a feature row with label and share", async () => {
    render(<UsageChart datasets={DATASETS} features={["content_generation"]} />);
    expect(screen.getByText("Content generation")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
