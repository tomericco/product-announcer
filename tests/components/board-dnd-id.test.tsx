import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Board as BoardData, BoardCard } from "../../src/lib/content/board";

/**
 * The board's `DndContext` must carry an explicit `id`.
 *
 * dnd-kit derives the `aria-describedby` it puts on every draggable from
 * `useUniqueId("DndDescribedBy", id)`, which — when `id` is undefined — reads
 * and bumps a MODULE-LEVEL counter (`@dnd-kit/utilities`, `useUniqueId`):
 *
 *     const id = ids[prefix] == null ? 0 : ids[prefix] + 1;
 *
 * That counter is not React's `useId`, so it is not shared between the server
 * render and the client one. The server module starts at 0; by the time the
 * browser mounts this context its own copy has advanced, and every drag handle
 * hydrates with a different `aria-describedby` than was serialized —
 * "DndDescribedBy-0" against "DndDescribedBy-2" in the report that found this.
 * React logs a hydration mismatch and, as it says, does not patch it up.
 *
 * A mismatch is not reproducible in jsdom, which never runs the server half.
 * The *cause* is, though, and it is the same defect: an id nobody pinned is an
 * id that changes on its own. Rendering the board twice walks the counter the
 * same way a second module instance does, so this asserts the property the
 * hydration path actually needs — that the id is a function of the code and
 * not of how many times a context happened to be constructed first.
 *
 * The two existing board suites cannot catch this: `board-card-cover` mocks
 * `useDraggable` to a bare object and `board-briefs` replaces `DndContext`
 * with a stub, so in both the real id generation never runs. Here dnd-kit is
 * entirely real; only the server-action modules are mocked, for the reasons
 * `board-card-cover.test.tsx` lines 12-21 give.
 */
vi.mock("../../src/app/(dashboard)/board/actions", () => ({
  moveCard: vi.fn(),
  assignCard: vi.fn(),
  acceptBriefCard: vi.fn(),
  deleteCard: vi.fn(),
  deleteBriefCard: vi.fn(),
}));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft: vi.fn() }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Board } from "../../src/app/(dashboard)/board/board";

const COLUMNS = ["brief", "draft", "review", "scheduled", "published"] as const;
const DISPLAY_COLUMNS = ["briefs", "draft", "review", "scheduled", "published"] as const;
const MOVE_MATRIX = {
  brief: [],
  draft: ["review", "scheduled"],
  review: ["draft", "scheduled"],
  scheduled: ["draft", "review"],
  published: [],
} as unknown as Record<(typeof COLUMNS)[number], (typeof COLUMNS)[number][]>;

const MEMBERS = [
  {
    userId: "user-1",
    email: "ada@example.com",
    name: "Ada",
    role: "owner" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

const CARD_TITLE = "Ship notes for v4";

function pieceCard(): BoardCard {
  return {
    kind: "piece",
    id: "piece-1",
    title: CARD_TITLE,
    type: "product_update",
    status: "draft",
    assignedTo: null,
    scheduledFor: null,
    generationError: null,
    generatedAt: null,
    generationStep: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    cover: null,
  };
}

function boardData(): BoardData {
  return {
    briefs: [],
    brief: [],
    draft: [pieceCard()],
    review: [],
    scheduled: [],
    published: [],
  };
}

function renderBoard() {
  render(
    <Board
      initialBoard={boardData()}
      members={MEMBERS}
      assigneeFilter="all"
      columns={COLUMNS}
      displayColumns={DISPLAY_COLUMNS}
      moveMatrix={MOVE_MATRIX}
      publishedLimit={20}
    />
  );
}

/** The drag handle's `aria-describedby`, which is the attribute that mismatched. */
function describedBy(): string | null {
  return screen.getByRole("button", { name: `Move ${CARD_TITLE}` }).getAttribute("aria-describedby");
}

describe("the board's drag handles", () => {
  it("describe themselves with an id that does not depend on render order", () => {
    renderBoard();
    const first = describedBy();
    cleanup();

    renderBoard();
    const second = describedBy();

    // Without an `id` on DndContext this is "DndDescribedBy-0" then
    // "DndDescribedBy-1" — the counter advancing exactly as it does between a
    // server module and a client one.
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("takes that id from the board's own DndContext, not from a counter", () => {
    renderBoard();

    // Pinning the literal, so removing the `id` prop fails here and not only
    // through the subtler ordering test above.
    expect(describedBy()).toBe("board-dnd");
  });
});
