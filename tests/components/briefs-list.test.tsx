import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BriefsList } from "../../src/app/(dashboard)/briefs/briefs-list";
import type { Brief } from "../../src/db/schema";

/**
 * The row-level Accept/Dismiss removal this task exists for (design doc:
 * "`/briefs` becomes a list") — a row-level Accept let you accept a brief you
 * never opened, and the editor (Task 4) is what makes reading a brief mean
 * opening it. Pinning this here means the removal cannot silently regress by
 * a future row growing its own decision buttons back.
 */
function fakeBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    id: "brief-1",
    tenantId: "tenant-1",
    origin: "agent",
    createdBy: null,
    contentType: "blog_post",
    title: "How localization breaks design systems",
    angle: "Teams discover it too late",
    whyNow: "Three customers hit it this week",
    suggestedChannel: "Blog",
    audience: null,
    keyPoints: [],
    targetLength: null,
    score: 0.82,
    scoreRationale: null,
    status: "new",
    acceptedBy: null,
    acceptedAt: null,
    contentPieceId: null,
    dismissReason: null,
    dismissNote: null,
    dismissedBy: null,
    dismissedAt: null,
    editedAt: null,
    body: null,
    lastEvidenceAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("BriefsList", () => {
  it("renders a full-row link to the brief editor", () => {
    render(<BriefsList briefs={[fakeBrief()]} />);

    const link = screen.getByRole("link", { name: "How localization breaks design systems" });
    expect(link).toHaveAttribute("href", "/briefs/brief-1");
  });

  it("shows title, content type, suggested channel, score and status", () => {
    render(<BriefsList briefs={[fakeBrief({ status: "accepted" })]} />);

    expect(screen.getByText("How localization breaks design systems")).toBeInTheDocument();
    expect(screen.getByText("Blog post")).toBeInTheDocument();
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("0.82")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });

  // The regression this file exists to prevent: the old card grid put Accept
  // and Dismiss on every row, letting a brief be accepted unopened. Those
  // decisions now live only in the editor at /briefs/[briefId].
  it("offers no Accept or Dismiss control on the row", () => {
    render(<BriefsList briefs={[fakeBrief()]} />);

    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("renders one row per brief, in the order given", () => {
    render(
      <BriefsList
        briefs={[
          fakeBrief({ id: "brief-1", title: "First brief" }),
          fakeBrief({ id: "brief-2", title: "Second brief" }),
        ]}
      />
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/briefs/brief-1");
    expect(links[1]).toHaveAttribute("href", "/briefs/brief-2");
  });
});
