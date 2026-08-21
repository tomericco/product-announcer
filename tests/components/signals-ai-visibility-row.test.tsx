import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Signal } from "../../src/db/schema";

vi.mock("../../src/app/(dashboard)/signals/evidence-actions", () => ({
  loadSignalEvidence: vi.fn(async () => null),
  loadEvidenceReassignTargets: vi.fn(async () => []),
}));
vi.mock("../../src/app/(dashboard)/signals/ai-visibility-actions", () => ({
  loadAiVisibilityEvidence: vi.fn(async () => null),
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

  it("leaves the other kinds alone", () => {
    renderRow({ kind: "market_news" });
    expect(screen.queryByRole("button", { name: "Evidence" })).not.toBeInTheDocument();
  });
});
