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
      engineLabel: "ChatGPT API + web search",
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

  it("keeps the kind label on the payload-less badge", () => {
    // Falling through to the plain badge must not cost it its "· AI
    // visibility" suffix — the row would then be the only chip that says
    // nothing about where it came from.
    render(<BriefEvidence signals={[cited({ payload: null })]} />);
    expect(screen.getByText("· AI visibility")).toBeInTheDocument();
  });

  it("keeps a chip interactive only for the kind that has a payload to show", () => {
    // Two signals side by side: only the ai_visibility one is a button.
    render(
      <BriefEvidence
        signals={[
          cited(),
          cited({
            id: "s2",
            kind: "market_news",
            title: "A news item",
            url: "https://example.com/n",
            payload: null,
          }),
        ]}
      />
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "A news item" })).toHaveAttribute(
      "href",
      "https://example.com/n"
    );
  });

  it("names the prompt, the engine and the sample count in one line", async () => {
    render(<BriefEvidence signals={[cited()]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Absent from/ }));
    });

    const popover = screen.getByRole("dialog");
    expect(
      within(popover).getByText(
        "best localization tools for design teams · ChatGPT API + web search · 0 of 3, two runs"
      )
    ).toBeInTheDocument();
  });

  it("shows the prompt line without an engine for an all-engines signal", async () => {
    // A `lost_mention` rolled up across engines carries no `engineLabel`.
    render(
      <BriefEvidence
        signals={[
          cited({
            payload: {
              signalType: "lost_mention",
              promptText: "best localization tools for design teams",
              runId: "r1",
              runDate: "2026-08-17T00:00:00.000Z",
              samples: "4 of 12",
            },
          } as Partial<CitedSignal>),
        ]}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Absent from/ }));
    });

    const popover = screen.getByRole("dialog");
    expect(
      within(popover).getByText("best localization tools for design teams · 4 of 12")
    ).toBeInTheDocument();
  });

  it("omits the source list entirely when the engine cited nothing", async () => {
    // An empty <ul> under a heading reads as "we found no sources" when it
    // actually means "the engine gave none" — so nothing is rendered at all.
    render(
      <BriefEvidence
        signals={[
          cited({
            payload: {
              signalType: "gap_vs_competitor",
              promptText: "best localization tools for design teams",
              runId: "r1",
              runDate: "2026-08-17T00:00:00.000Z",
              samples: "0 of 3",
              excerpt: "Lokalise and Phrase are the usual choices.",
              citedUrls: [],
            },
          } as Partial<CitedSignal>),
        ]}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Absent from/ }));
    });

    const popover = screen.getByRole("dialog");
    expect(within(popover).getByText(/Lokalise and Phrase/)).toBeInTheDocument();
    expect(popover.querySelector("ul")).toBeNull();
  });
});
