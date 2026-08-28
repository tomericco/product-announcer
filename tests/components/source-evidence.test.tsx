import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SourceEvidenceView } from "../../src/app/(dashboard)/signals/source-evidence-actions";

/**
 * The evidence dialog for link-backed signals, rendered for real — the point
 * of the whole thing is that the source page is reachable, so the assertion
 * that matters is on the `href`.
 *
 * `source-evidence-actions` is a `"use server"` module that reaches `@/db`,
 * which the jsdom project has no DATABASE_URL for, so it is mocked like every
 * other action in this directory's tests.
 */
const { loadSourceEvidence } = vi.hoisted(() => ({ loadSourceEvidence: vi.fn() }));

vi.mock("../../src/app/(dashboard)/signals/source-evidence-actions", () => ({ loadSourceEvidence }));

import { SourceEvidence } from "../../src/app/(dashboard)/signals/source-evidence";

const view: SourceEvidenceView = {
  title: "Why localization budgets moved to design",
  kindLabel: "Market news",
  occurredAtLabel: "Aug 17, 2026",
  excerpt: "The first 500 characters of the article body.",
  topics: ["localization"],
  relevanceScore: 0.82,
  relevanceRationale: "Names the buyer shift this company sells into.",
  competitorName: null,
  sourceLabel: null,
  links: [
    {
      role: "article",
      label: "Article",
      url: "https://example.com/news/localization-budgets",
      domain: "example.com",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SourceEvidence", () => {
  it("opens on demand and links out to the page the signal is based on", async () => {
    loadSourceEvidence.mockResolvedValue(view);

    render(<SourceEvidence signalId="sig-1" title="Why localization budgets moved to design" />);
    // Nothing is fetched until the dialog is opened.
    expect(loadSourceEvidence).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));

    await waitFor(() => expect(screen.getByText("Article")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /Article/ });
    expect(link).toHaveAttribute("href", "https://example.com/news/localization-budgets");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("The first 500 characters of the article body.")).toBeInTheDocument();
    expect(screen.getByText("Names the buyer shift this company sells into.")).toBeInTheDocument();
  });

  it("says so rather than rendering an empty list when no link was recorded", async () => {
    loadSourceEvidence.mockResolvedValue({ ...view, links: [], sourceLabel: "Weekly topic search" });

    render(<SourceEvidence signalId="sig-1" title="A manual note" />);
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));

    await waitFor(() =>
      expect(screen.getByText(/No link was recorded for this signal/)).toBeInTheDocument()
    );
    expect(screen.getByText(/Weekly topic search/)).toBeInTheDocument();
  });

  it("renders the aged-out empty state when the read comes back null", async () => {
    loadSourceEvidence.mockResolvedValue(null);

    render(<SourceEvidence signalId="sig-1" title="An old signal" />);
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));

    await waitFor(() => expect(screen.getByText(/may have aged out/)).toBeInTheDocument());
  });
});
