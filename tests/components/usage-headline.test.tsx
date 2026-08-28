import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageHeadline } from "../../src/app/(dashboard)/settings/usage-headline";

describe("UsageHeadline", () => {
  it("renders a plain total when there is no limit", () => {
    render(<UsageHeadline credits={1234567} limit={null} />);
    expect(screen.getByText(/1,234,567 credits/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
  });

  it("renders progress against a limit when one exists", () => {
    render(<UsageHeadline credits={250_000} limit={1_000_000} />);
    expect(screen.getByText(/250,000 of 1,000,000 credits/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "250000");
    expect(bar).toHaveAttribute("aria-valuemax", "1000000");
  });
});
