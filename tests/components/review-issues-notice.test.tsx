import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * The failed-review notice, and the one thing about it that matters beyond
 * looking like a warning: its button has to open the whole-update agent edit
 * ALREADY carrying the reviewer's feedback. A notice that only announced the
 * failure would be the grey status line again, in a coloured box.
 */
const { openWholeEdit } = vi.hoisted(() => ({ openWholeEdit: vi.fn() }));

vi.mock("../../src/app/(dashboard)/drafts/[releaseId]/agent-edit-context", () => ({
  useAgentEdit: () => ({ openWholeEdit }),
}));

import {
  ReviewIssuesNotice,
  reviewFixInstruction,
} from "../../src/app/(dashboard)/drafts/[releaseId]/review-issues-notice";

describe("reviewFixInstruction", () => {
  it("hands the agent the reviewer's issues as the brief for the pass", () => {
    const instruction = reviewFixInstruction(["Too much jargon", "No clear benefit"]);

    expect(instruction).toContain("- Too much jargon");
    expect(instruction).toContain("- No clear benefit");
    // Scoped: the pass is meant to address the feedback, not rewrite the piece.
    expect(instruction).toContain("change nothing else");
  });
});

describe("ReviewIssuesNotice", () => {
  it("shows what the reviewer flagged and opens the edit prefilled with it", () => {
    render(<ReviewIssuesNotice issues={["Too much jargon", "No clear benefit"]} />);

    expect(screen.getByText(/didn't pass the brand-guidelines review/)).toBeInTheDocument();
    expect(screen.getByText("Too much jargon")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Fix these issues/ }));

    expect(openWholeEdit).toHaveBeenCalledTimes(1);
    expect(openWholeEdit.mock.calls[0][0]).toBe(
      reviewFixInstruction(["Too much jargon", "No clear benefit"])
    );
  });

  it("still offers the pass when the reviewer recorded no itemised issues", () => {
    // `reviewStatus='failed'` with an empty `reviewIssues` is reachable — the
    // status and the list are separate columns — and the notice is the only
    // thing that would tell the user the review failed at all.
    render(<ReviewIssuesNotice issues={[]} />);

    expect(screen.getByText(/didn't pass the brand-guidelines review/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix these issues/ })).toBeInTheDocument();
  });
});
