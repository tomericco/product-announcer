import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { signalKindEnum, type Signal } from "../../src/db/schema";

const { loadSignalEvidence, loadAiVisibilityEvidence, loadSourceEvidence } = vi.hoisted(() => ({
  loadSignalEvidence: vi.fn(async () => null),
  loadAiVisibilityEvidence: vi.fn(async () => null),
  loadSourceEvidence: vi.fn(async () => null),
}));
vi.mock("../../src/app/(dashboard)/signals/evidence-actions", () => ({
  loadSignalEvidence,
  loadEvidenceReassignTargets: vi.fn(async () => []),
}));
vi.mock("../../src/app/(dashboard)/signals/ai-visibility-actions", () => ({
  loadAiVisibilityEvidence,
}));
vi.mock("../../src/app/(dashboard)/signals/source-evidence-actions", () => ({
  loadSourceEvidence,
}));

import { SignalRow } from "../../src/app/(dashboard)/signals/signal-row";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "s1",
    tenantId: "t1",
    kind: "ai_visibility",
    title: "Absent from 'best localization tools' on ChatGPT — Lokalise named 3/3",
    excerpt: null,
    url: null,
    competitorId: null,
    relevanceScore: null,
    relevanceRationale: null,
    status: "new",
    externalId: null,
    payload: null,
    occurredAt: new Date("2026-08-17T00:00:00.000Z"),
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
    ...overrides,
  } as Signal;
}

function renderRow(overrides: Partial<Signal> = {}) {
  return render(
    <SignalRow row={signal(overrides)} selected={false} onToggleSelected={() => {}} />
  );
}

describe("an ai_visibility signal row", () => {
  it("carries its own kind label", () => {
    renderRow();
    expect(screen.getByText("AI visibility")).toBeInTheDocument();
  });

  it("opens the new evidence dialog, not the atomic-update drawer", () => {
    // EvidenceDrawer is a CURATION tool for atomic updates — its Save, Hide
    // and reassign controls have no meaning for an engine's answer, and its
    // load path would return null and render "no atomic update behind this
    // signal" forever.
    renderRow();
    expect(screen.getByRole("button", { name: "Evidence" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reassign" })).not.toBeInTheDocument();
  });

  it("does not hand its own dialog to a link-backed kind", () => {
    // Every kind now offers an "Evidence" button, so the button's presence no
    // longer distinguishes the three components behind it — only which loader
    // fires does. A market_news row must reach `SourceEvidence`.
    renderRow({ kind: "market_news" });
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    expect(loadSourceEvidence).toHaveBeenCalled();
    expect(loadAiVisibilityEvidence).not.toHaveBeenCalled();
    expect(loadSignalEvidence).not.toHaveBeenCalled();
  });

  it("does not hand an ai_visibility row the atomic-update drawer's loader", () => {
    // The two controls are both spelled "Evidence". Asserting only on the
    // button's name would pass just as well if the row had opened
    // `EvidenceDrawer` — which loads through `evidence-actions` and would
    // render "no atomic update behind this signal" forever.
    renderRow();
    expect(loadSignalEvidence).not.toHaveBeenCalled();
    expect(loadAiVisibilityEvidence).not.toHaveBeenCalled();
  });
});

/**
 * One row per kind, because the branch at the bottom of `SignalRow` is the one
 * thing TypeScript cannot check: the four LABEL maps are `Record<Signal["kind"],
 * …>` and fail to compile when a kind is missing, but a kind with no branch is
 * simply a row whose evidence is unreachable, and that compiles fine.
 */
describe("which control each kind offers", () => {
  const cases: {
    kind: Signal["kind"];
    label: string;
    evidence: boolean;
  }[] = [
    { kind: "shipped_work", label: "Shipped work", evidence: true },
    // The link-backed three: their evidence is the web page in `signals.url`,
    // reachable through `SourceEvidence`. They offered nothing at all until
    // that component existed, which left a market-news row's source reachable
    // only by guessing its title was a link.
    { kind: "competitor_move", label: "Competitor move", evidence: true },
    { kind: "market_news", label: "Market news", evidence: true },
    { kind: "manual", label: "Manual", evidence: true },
    { kind: "ai_visibility", label: "AI visibility", evidence: true },
  ];

  for (const testCase of cases) {
    it(`${testCase.kind} reads "${testCase.label}" and ${
      testCase.evidence ? "offers Evidence" : "offers nothing to open"
    }`, () => {
      renderRow({ kind: testCase.kind });

      expect(screen.getByText(testCase.label)).toBeInTheDocument();
      const button = screen.queryByRole("button", { name: "Evidence" });
      if (testCase.evidence) expect(button).toBeInTheDocument();
      else expect(button).not.toBeInTheDocument();
    });
  }

  it("covers every kind the column can hold, so a sixth kind fails this file", () => {
    expect(new Set(cases.map((testCase) => testCase.kind))).toEqual(
      new Set(signalKindEnum.enumValues)
    );
  });

  it("never offers two Evidence controls on one row", () => {
    // The two branches are separate `&&`s over the same slot. A condition
    // widened to `!== "market_news"` would put both on a shipped_work row.
    for (const testCase of cases) {
      cleanup();
      renderRow({ kind: testCase.kind });
      expect(screen.queryAllByRole("button", { name: "Evidence" }).length).toBeLessThanOrEqual(1);
    }
  });
});
