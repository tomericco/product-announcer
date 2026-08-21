import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { CitedSignal } from "../../../src/lib/briefs/query";
import { BriefEvidence } from "../../../src/app/(dashboard)/briefs/brief-evidence";

function cited(overrides: Partial<CitedSignal> = {}): CitedSignal {
  return {
    id: "s1",
    title: "Absent from 'best localization tools' on ChatGPT",
    url: null,
    kind: "ai_visibility",
    payload: {
      signalType: "gap_vs_competitor",
      promptId: "p1",
      promptText: "best localization tools for design teams",
      engine: "openai",
      engineLabel: "GPT-5.x API + web search",
      runId: "r1",
      runDate: "2026-08-17T00:00:00.000Z",
      samples: "0 of 3, two runs",
      excerpt: "For design teams, Lokalise and Phrase are the usual choices.",
      citedUrls: [
        { url: "https://g2.com/x", domain: "g2.com", domainClass: "review" },
        { url: "https://lokalise.com/y", domain: "lokalise.com", domainClass: "competitor" },
      ],
    },
    ...overrides,
  } as CitedSignal;
}

describe("BriefEvidence with an ai_visibility signal", () => {
  it("labels the chip with the kind", () => {
    render(<BriefEvidence signals={[cited()]} />);
    expect(screen.getByText(/AI visibility/)).toBeInTheDocument();
  });

  it("shows the excerpt and the cited domains on open", async () => {
    render(<BriefEvidence signals={[cited()]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Absent from/ }));
    });

    const popover = screen.getByRole("dialog");
    expect(
      within(popover).getByText(/Lokalise and Phrase are the usual choices/)
    ).toBeInTheDocument();
    expect(within(popover).getByText("g2.com")).toBeInTheDocument();
    expect(within(popover).getByText("lokalise.com")).toBeInTheDocument();
  });

  it("leaves every other kind exactly as it was — a plain, non-interactive badge", () => {
    const { container } = render(
      <BriefEvidence signals={[cited({ kind: "market_news", payload: null })]} />
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a payload-less ai_visibility signal as a plain badge, not an empty popover", () => {
    const { container } = render(<BriefEvidence signals={[cited({ payload: null })]} />);
    expect(container.querySelector("button")).toBeNull();
  });
});
