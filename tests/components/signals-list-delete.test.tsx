import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { Signal } from "../../src/db/schema";

/**
 * The signals browser's bulk delete, driven through a real render — the
 * floating selection bar's "Delete selected" button, the confirm dialog it
 * opens, and `SignalsList`'s wiring to the `deleteSignals` server action.
 *
 * Mocked for the same reasons `signals-list-selection.test.tsx` mocks its
 * neighbors: `actions` and `propose-actions` are `"use server"` modules that
 * reach `@/db` (and, for propose, a model), which the jsdom project has no
 * DATABASE_URL for; `evidence-actions` is only pulled in transitively by
 * `SignalRow`'s drawer and is never called here; `next/navigation`'s
 * `useRouter` throws outside a mounted App Router.
 */
const { deleteSignals, proposeAndCreateBrief, router, toast } = vi.hoisted(() => ({
  deleteSignals: vi.fn(),
  proposeAndCreateBrief: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/app/(dashboard)/signals/actions", () => ({ deleteSignals }));

vi.mock("../../src/app/(dashboard)/signals/propose-actions", () => ({
  proposeAndCreateBrief: (signalIds: string[]) => proposeAndCreateBrief(signalIds),
}));

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

/**
 * The delete confirm dialog, told apart from any other `role="dialog"` (the
 * bar always renders `CreateBriefModal` alongside it) by its own wording.
 */
function deleteDialog(): HTMLElement {
  return screen
    .getAllByRole("dialog")
    .find((d) => /can.t be undone/i.test(d.textContent ?? "")) as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SignalsList — bulk delete", () => {
  it("asks before calling anything, naming how many are selected", async () => {
    renderList();
    await select("Signal one");
    await select("Signal two");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    });

    expect(within(deleteDialog()).getByText("Delete 2 signals?")).toBeInTheDocument();
    expect(deleteSignals).not.toHaveBeenCalled();
  });

  it("uses singular wording for one signal", async () => {
    renderList();
    await select("Signal one");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    });

    expect(within(deleteDialog()).getByText("Delete 1 signal?")).toBeInTheDocument();
  });

  it("deletes nothing and keeps the selection when cancelled", async () => {
    renderList();
    await select("Signal one");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    });
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: /cancel/i }));
    });

    expect(deleteSignals).not.toHaveBeenCalled();
    expect(screen.getByText("1 of 10 signals selected")).toBeInTheDocument();
  });

  it("deletes the selected ids, clears the selection, and refreshes on success", async () => {
    deleteSignals.mockResolvedValueOnce({ ok: true, deletedCount: 2 });
    renderList();
    await select("Signal one");
    await select("Signal two");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    });
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: /^delete$/i }));
    });

    await waitFor(() => expect(deleteSignals).toHaveBeenCalledWith([ROWS[0].id, ROWS[1].id]));
    expect(toast.success).toHaveBeenCalledWith("Deleted 2 signals");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("2 of 10 signals selected")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select Signal one")).not.toBeChecked();
  });

  it("keeps the dialog open and the selection intact when the delete is refused", async () => {
    deleteSignals.mockResolvedValueOnce({ ok: false, error: "No signals selected." });
    renderList();
    await select("Signal one");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    });
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: /^delete$/i }));
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No signals selected."));
    expect(within(deleteDialog()).getByText("Delete 1 signal?")).toBeInTheDocument();
    expect(screen.getByText("1 of 10 signals selected")).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
