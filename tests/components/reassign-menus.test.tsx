import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SignalEvidence } from "../../src/lib/signals/evidence";

/**
 * Renders the three "Reassign" dropdowns for real, because the bug they all
 * shared was invisible to a props-level test: `DropdownMenuLabel` is Base UI's
 * `Menu.GroupLabel`, and rendering one outside a `Menu.Group` throws
 * ("MenuGroupContext is missing") the instant the popup mounts. Every menu
 * opened straight into an error boundary whenever there was at least one
 * target to label — i.e. in exactly the case the menu exists for.
 *
 * Mocked for the usual reason the other component tests mock their neighbors:
 * `evidence-actions` / `change-events-actions` are `"use server"` modules that
 * reach `@/db`, which the jsdom project has no DATABASE_URL for.
 */
const { evidenceActions, changeEventActions, toast } = vi.hoisted(() => ({
  evidenceActions: {
    loadSignalEvidence: vi.fn(),
    loadEvidenceReassignTargets: vi.fn(),
    saveEvidenceEdit: vi.fn(),
    saveEvidenceSize: vi.fn(),
    saveEvidenceCategory: vi.fn(),
    hideEvidenceAtomicUpdate: vi.fn(),
    reassignEvidenceEvent: vi.fn(),
    removeEvidenceEvent: vi.fn(),
  },
  changeEventActions: {
    reassign: vi.fn(),
    bulkReassignChangeEvents: vi.fn(),
    bulkDeleteChangeEvents: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/app/(dashboard)/signals/evidence-actions", () => evidenceActions);
vi.mock("../../src/app/(dashboard)/company/change-events-actions", () => changeEventActions);
vi.mock("sonner", () => ({ toast }));

import { EvidenceDrawer } from "../../src/app/(dashboard)/signals/evidence-drawer";
import { ReassignControl } from "../../src/app/(dashboard)/company/reassign-control";

const evidence: SignalEvidence = {
  atomicUpdateId: "au-1",
  title: "A title",
  summary: "A summary",
  category: "new",
  size: "m",
  hidden: false,
  editable: true,
  events: [
    {
      id: "ev-1",
      type: "commit",
      provider: "github",
      label: "Commit one",
      externalUrl: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the evidence drawer's per-event reassign menu", () => {
  it("opens with its move targets and posts the chosen one", async () => {
    evidenceActions.loadSignalEvidence.mockResolvedValue(evidence);
    evidenceActions.loadEvidenceReassignTargets.mockResolvedValue([{ id: "au-2", title: "Other update" }]);
    evidenceActions.reassignEvidenceEvent.mockResolvedValue({ ok: true });

    render(<EvidenceDrawer signalId="sig-1" title="Signal title" />);
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    await waitFor(() => expect(screen.getByText("Commit one")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(screen.getByText("Move to")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Other update"));
    await waitFor(() =>
      expect(evidenceActions.reassignEvidenceEvent).toHaveBeenCalledWith(
        "ev-1",
        { kind: "existing", atomicUpdateId: "au-2" },
        false
      )
    );
  });
});

describe("the Company page's per-row reassign menu", () => {
  it("opens with its move targets and posts the chosen one", async () => {
    changeEventActions.reassign.mockResolvedValue({ ok: true });

    render(
      <ReassignControl
        eventId="ev-1"
        currentAtomicUpdateId="au-1"
        openAtomicUpdates={[
          { id: "au-1", title: "This update" },
          { id: "au-2", title: "Other update" },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(screen.getByText("Move to")).toBeInTheDocument());
    // The event's own atomic update is filtered out of the targets.
    expect(screen.queryByText("This update")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Other update"));
    await waitFor(() => expect(changeEventActions.reassign).toHaveBeenCalled());

    const formData = changeEventActions.reassign.mock.calls[0][0] as FormData;
    expect(formData.get("eventId")).toBe("ev-1");
    expect(formData.get("targetKind")).toBe("existing");
    expect(formData.get("atomicUpdateId")).toBe("au-2");
  });
});
