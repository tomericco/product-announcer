import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

const { loadAiVisibilityEvidence } = vi.hoisted(() => ({ loadAiVisibilityEvidence: vi.fn() }));
vi.mock("../../../src/app/(dashboard)/signals/ai-visibility-actions", () => ({
  loadAiVisibilityEvidence,
}));

import { AiVisibilityEvidence } from "../../../src/app/(dashboard)/signals/ai-visibility-evidence";

const VIEW = {
  promptId: "p1",
  promptText: "best localization tools for design teams",
  engineLabel: "GPT-5.x API + web search",
  modelId: "gpt-5.2-2026-07-01",
  runDateLabel: "Aug 17, 2026",
  samples: "0 of 3, two runs",
  excerpt: "For design teams, Lokalise and Phrase are the usual choices.",
  citedUrls: [
    { url: "https://g2.com/categories/localization", domain: "g2.com", domainClass: "review" },
    { url: "https://lokalise.com/blog/x", domain: "lokalise.com", domainClass: "competitor" },
  ],
  aliases: [{ name: "Lokalise", kind: "competitor" as const, label: "Lokalise" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  loadAiVisibilityEvidence.mockResolvedValue(VIEW);
});

async function open() {
  render(
    <AiVisibilityEvidence signalId="s1" title="Absent from 'best localization tools' on ChatGPT" />
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
  });
  return screen.getByRole("dialog");
}

describe("AiVisibilityEvidence", () => {
  it("loads on open, not on mount — most rows are never expanded", async () => {
    render(<AiVisibilityEvidence signalId="s1" title="t" />);
    expect(loadAiVisibilityEvidence).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    });
    expect(loadAiVisibilityEvidence).toHaveBeenCalledWith("s1");
    expect(loadAiVisibilityEvidence).toHaveBeenCalledTimes(1);
  });

  it("shows the whole methodology line: engine, model, date, samples", async () => {
    const dialog = await open();
    expect(within(dialog).getByText("GPT-5.x API + web search")).toBeInTheDocument();
    expect(within(dialog).getByText("gpt-5.2-2026-07-01")).toBeInTheDocument();
    expect(within(dialog).getByText("Aug 17, 2026")).toBeInTheDocument();
    expect(within(dialog).getByText("0 of 3, two runs")).toBeInTheDocument();
  });

  it("lists cited urls in the order the engine gave them", async () => {
    const dialog = await open();
    const items = within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(items[0]).toContain("g2.com");
    expect(items[1]).toContain("lokalise.com");
  });

  it("links to the prompt it is about", async () => {
    const dialog = await open();
    expect(within(dialog).getByRole("link", { name: "Open prompt" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p1"
    );
  });

  it("offers no Open prompt link for a signal that is not about one prompt", async () => {
    // Engine-level summary and new_cited_domain signals carry no promptId; a
    // link to /ai-visibility/prompts/null is a 404 with extra steps.
    loadAiVisibilityEvidence.mockResolvedValue({ ...VIEW, promptId: null });
    const dialog = await open();
    expect(within(dialog).queryByRole("link", { name: "Open prompt" })).not.toBeInTheDocument();
  });

  it("offers nothing to edit — this is a read-only record of what an engine said", async () => {
    const dialog = await open();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Hide" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says so plainly when the evidence is gone rather than rendering an empty shell", async () => {
    loadAiVisibilityEvidence.mockResolvedValue(null);
    const dialog = await open();
    expect(within(dialog).getByText(/no evidence/i)).toBeInTheDocument();
  });
});
