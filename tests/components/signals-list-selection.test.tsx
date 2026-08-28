import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Signal } from "../../src/db/schema";

/**
 * `/signals`' selection bar, driven for real — the wiring between the list and
 * the creation modal, not a re-derivation of it. The whole defect this covers
 * lives in a prop handed from one component to the other, so extracting a
 * helper and testing that would prove nothing about it.
 *
 * Three `"use server"`-backed things are mocked because they reach `@/db` (and,
 * for propose, a model), and the jsdom project has no DATABASE_URL — not to
 * dodge an assertion. `evidence-actions` is only pulled in transitively by
 * `SignalRow`'s drawer and is never called here. `next/navigation` and `sonner`
 * are mocked because `SignalsList` now calls `useRouter()` and `toast` for its
 * delete flow (covered in `signals-list-delete.test.tsx`), and `useRouter`
 * throws outside a mounted App Router.
 */
const { proposeAndCreateBrief, deleteSignals, router, toast } = vi.hoisted(() => ({
  proposeAndCreateBrief: vi.fn(),
  deleteSignals: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/app/(dashboard)/signals/propose-actions", () => ({
  proposeAndCreateBrief: (signalIds: string[]) => proposeAndCreateBrief(signalIds),
}));

vi.mock("../../src/app/(dashboard)/signals/actions", () => ({ deleteSignals }));

vi.mock("../../src/app/(dashboard)/signals/evidence-actions", () => ({
  loadSignalEvidence: vi.fn(),
  loadEvidenceReassignTargets: vi.fn(),
  saveEvidenceEdit: vi.fn(),
  saveEvidenceSize: vi.fn(),
  saveEvidenceCategory: vi.fn(),
  hideEvidenceAtomicUpdate: vi.fn(),
  reassignEvidenceEvent: vi.fn(),
  removeEvidenceEvent: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

import { SignalsList } from "../../src/app/(dashboard)/signals/signals-list";

function makeSignal(title: string): Signal {
  return {
    id: crypto.randomUUID(),
    tenantId: "tenant-1",
    sourceId: null,
    kind: "market_news",
    externalId: crypto.randomUUID(),
    url: null,
    fetchedUrl: null,
    title,
    excerpt: "An excerpt",
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    atomicUpdateId: null,
    competitorId: null,
    relevanceScore: 0.8,
    relevanceRationale: null,
    topics: [],
    payload: null,
    status: "new",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  } as Signal;
}

const ROWS = [makeSignal("Signal one"), makeSignal("Signal two")];

function renderList() {
  return render(<SignalsList rows={ROWS} competitorsById={new Map()} maxSelectable={10} />);
}

async function select(title: string) {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(`Select ${title}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SignalsList — the selection after a brief is made", () => {
  it("hands the selected ids to the modal and drops them once the brief is made", async () => {
    proposeAndCreateBrief.mockResolvedValue({
      ok: true,
      briefId: "brief-9",
      usedSignalCount: 2,
      droppedSignalCount: 0,
    });

    renderList();
    await select("Signal one");
    await select("Signal two");
    expect(screen.getByText("2 of 10 signals selected")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    });
    expect(proposeAndCreateBrief).toHaveBeenCalledWith([ROWS[0].id, ROWS[1].id]);

    // Still selected while the result is on screen — clearing here would
    // unmount the modal the user is reading, since this bar only renders
    // while something is selected.
    await waitFor(() => expect(screen.getByRole("button", { name: "Open brief" })).toBeInTheDocument());
    expect(screen.getByText("2 of 10 signals selected")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    // The evidence has been spent. The old flow navigated to /briefs/new and
    // unmounted this list; the modal comes back here, so a second click would
    // otherwise commission a second brief from the same signals.
    await waitFor(() => expect(screen.queryByText("2 of 10 signals selected")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Create brief" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select Signal one")).not.toBeChecked();
  });

  it("keeps the selection when the proposal failed, so it can still be written by hand", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: false, error: "No angle." });

    renderList();
    await select("Signal one");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Write it by hand" })).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    expect(screen.getByText("1 of 10 signals selected")).toBeInTheDocument();
    expect(screen.getByLabelText("Select Signal one")).toBeChecked();
  });
});
