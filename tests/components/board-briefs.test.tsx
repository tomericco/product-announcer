import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import type { Board as BoardData, BoardBriefCard, BoardCard } from "../../src/lib/content/board";

/**
 * The board's Brief column, driven through a real render rather than through
 * the drag rules in isolation. Every UI defect on this branch has lived in
 * wiring a pure-function test could not see — one survived a mutation with
 * all its tests green — so these tests mount the actual `Board`, let it
 * compute each column's droppability from its own state, and then drop a
 * card the way dnd-kit would.
 *
 * Mocked, all of them because they are unreachable in jsdom rather than to
 * dodge an assertion:
 *
 *   - the three `"use server"` modules the board and its cards import
 *     (`board/actions`, `briefs/actions`, `progress-actions`). Each reaches
 *     `@/db`, which opens a `pg` Pool at import time; the jsdom project has
 *     no DATABASE_URL. What they actually DO is covered against a real
 *     Postgres in tests/app/board-actions.test.ts.
 *   - `next/navigation`, which has no router outside an app render.
 *   - `@dnd-kit/core`'s *context and hooks*, which cannot be driven in
 *     jsdom: every element's rect is 0×0, so a real drag has nothing to
 *     aim at. The stand-in below records what the board passed each
 *     droppable and draggable, so the assertions are about the board's own
 *     wiring rather than the stub's.
 *
 *     Its collision-detection functions are deliberately NOT stubbed — they
 *     are pure functions of rectangles, so `drag()` below runs the board's
 *     real strategy over a fabricated board geometry. That matters: the
 *     previous stub resolved `over` as "the column you released over, if it
 *     is enabled", which is not what the library does. dnd-kit takes the
 *     first collision the strategy returns, with no requirement that it be
 *     under the pointer, so "disabled" controls candidacy, not hit-testing.
 *     Modelling it the wrong way kept four refusal tests green while the
 *     board accepted a brief dropped anywhere on it.
 */

const { moveCard, assignCard, acceptBriefCard, generateDraft, pollGenerationProgress, refresh, toast } =
  vi.hoisted(() => ({
    moveCard: vi.fn(async () => ({ ok: true as const })),
    assignCard: vi.fn(async () => ({ ok: true as const })),
    acceptBriefCard: vi.fn(async () => ({ ok: true as const, contentPieceId: "piece-new" })),
    generateDraft: vi.fn(),
    pollGenerationProgress: vi.fn(),
    refresh: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
  }));

vi.mock("../../src/app/(dashboard)/board/actions", () => ({ moveCard, assignCard, acceptBriefCard }));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast }));

/**
 * The dnd-kit stand-in. `DndContext` hands its drag callbacks to the
 * harness; `useDroppable`/`useDraggable` record the `disabled` flag the
 * component passed for each id, which is exactly the mechanism the board
 * refuses drops with.
 */
const harness = vi.hoisted(() => ({
  handlers: {} as {
    onDragStart?: (event: unknown) => void;
    onDragEnd?: (event: unknown) => void;
    onDragCancel?: () => void;
  },
  /** The strategy the board handed `DndContext`. Run for real by `drag()`. */
  collisionDetection: undefined as
    | undefined
    | ((args: Record<string, unknown>) => Array<{ id: string | number }>),
  droppables: new Map<string, boolean>(),
  draggables: new Map<string, boolean>(),
}));

vi.mock("@dnd-kit/core", async () => {
  const { createElement, Fragment } = await import("react");
  // Everything except the context, the hooks and the sensors is the real
  // library — in particular the collision-detection functions, which
  // `drag()` runs for real. See the header comment.
  const actual = await vi.importActual<Record<string, unknown>>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: ({
      children,
      collisionDetection,
      onDragStart,
      onDragEnd,
      onDragCancel,
    }: {
      children: unknown;
      collisionDetection?: (args: Record<string, unknown>) => Array<{ id: string | number }>;
      onDragStart?: (event: unknown) => void;
      onDragEnd?: (event: unknown) => void;
      onDragCancel?: () => void;
    }) => {
      harness.handlers = { onDragStart, onDragEnd, onDragCancel };
      harness.collisionDetection = collisionDetection;
      return createElement(Fragment, null, children as never);
    },
    useDroppable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
      harness.droppables.set(String(id), !disabled);
      return { setNodeRef: () => {}, isOver: false };
    },
    useDraggable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
      harness.draggables.set(String(id), !disabled);
      return {
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        transform: null,
        isDragging: false,
      };
    },
    useSensor: () => ({}),
    useSensors: (...sensors: unknown[]) => sensors,
    PointerSensor: class {},
    KeyboardSensor: class {},
  };
});

import { Board } from "../../src/app/(dashboard)/board/board";

const COLUMNS = ["brief", "draft", "review", "scheduled", "published"] as const;
const DISPLAY_COLUMNS = ["briefs", ...COLUMNS] as const;
// What page.tsx derives server-side from the real `canMove` — restated here
// because importing `@/lib/content/board` would pull `pg` into jsdom. The
// real table is pinned by tests/lib/content/board.test.ts.
const MOVE_MATRIX = {
  brief: [],
  draft: ["review", "scheduled"],
  review: ["draft", "scheduled"],
  scheduled: ["draft", "review"],
  published: [],
} as unknown as Record<(typeof COLUMNS)[number], (typeof COLUMNS)[number][]>;

const MEMBERS = [
  { userId: "user-1", email: "ada@example.com", name: "Ada", role: "owner" as const, createdAt: new Date() },
];

function briefCard(overrides: Partial<BoardBriefCard> = {}): BoardBriefCard {
  return {
    kind: "brief",
    id: "brief-1",
    title: "How localization breaks design systems",
    contentType: "blog_post",
    score: 0.82,
    status: "new",
    ...overrides,
  };
}

function pieceCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    kind: "piece",
    id: "piece-1",
    title: "Ship notes for v4",
    type: "product_update",
    status: "draft",
    assignedTo: null,
    scheduledFor: null,
    generationError: null,
    generatedAt: null,
    generationStep: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function boardData(overrides: Partial<BoardData> = {}): BoardData {
  return {
    briefs: [briefCard()],
    brief: [],
    draft: [pieceCard()],
    review: [],
    scheduled: [],
    published: [],
    ...overrides,
  };
}

function renderBoard({
  board = boardData(),
  assigneeFilter = "all",
}: { board?: BoardData; assigneeFilter?: string } = {}) {
  render(
    <Board
      initialBoard={board}
      members={MEMBERS}
      assigneeFilter={assigneeFilter}
      columns={COLUMNS}
      displayColumns={DISPLAY_COLUMNS}
      moveMatrix={MOVE_MATRIX}
      publishedLimit={20}
    />
  );
}

// A fabricated board geometry: the six columns as a left-to-right strip.
// jsdom measures every element as 0×0, so the board's own rects cannot aim
// a collision strategy — but a strategy is a pure function of rectangles,
// so a plausible strip is enough to ask the real question.
const COLUMN_W = 200;
const COLUMN_H = 600;
const COLUMN_RECTS = new Map<string, Record<string, number>>(
  DISPLAY_COLUMNS.map((id, i) => [
    id,
    {
      top: 0,
      bottom: COLUMN_H,
      height: COLUMN_H,
      left: i * COLUMN_W,
      right: (i + 1) * COLUMN_W,
      width: COLUMN_W,
    },
  ])
);

/**
 * Picks a card up and releases it with the pointer over `columnId`,
 * resolving `over` the way dnd-kit actually does rather than the way it
 * would be convenient for it to work:
 *
 *   - `DndContext` passes `droppableContainers.getEnabled()` to the
 *     strategy, so `disabled` decides which columns are *candidates*;
 *   - it then takes `getFirstCollision(collisions)` **unconditionally**.
 *     Nothing requires the winner to be under the pointer.
 *
 * So the board's own strategy — captured from the `DndContext` it renders —
 * is run here for real against the geometry above. Returns the id `over`
 * resolved to, which is the whole question: with `closestCenter`, releasing
 * a brief anywhere resolves to the single enabled column.
 */
async function drag(cardId: string, columnId: string) {
  act(() => {
    harness.handlers.onDragStart?.({ active: { id: cardId } });
  });

  const index = DISPLAY_COLUMNS.indexOf(columnId as (typeof DISPLAY_COLUMNS)[number]);
  const pointer = { x: index * COLUMN_W + COLUMN_W / 2, y: COLUMN_H / 2 };
  // The dragged card, centred on the pointer: narrower and far shorter
  // than a column.
  const collisionRect = {
    top: pointer.y - 40,
    bottom: pointer.y + 40,
    height: 80,
    left: pointer.x - 90,
    right: pointer.x + 90,
    width: 180,
  };
  // Exactly what DndContext hands the strategy: the ENABLED droppables
  // only, but every measured rect.
  const droppableContainers = [...COLUMN_RECTS.keys()]
    .filter((id) => harness.droppables.get(id))
    .map((id) => ({ id, disabled: false, rect: { current: COLUMN_RECTS.get(id) } }));

  const collisions =
    harness.collisionDetection?.({
      active: {
        id: cardId,
        data: { current: undefined },
        rect: { current: { initial: collisionRect, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: COLUMN_RECTS,
      droppableContainers,
      pointerCoordinates: pointer,
    }) ?? [];
  const over = collisions.length > 0 ? String(collisions[0].id) : null;

  await act(async () => {
    harness.handlers.onDragEnd?.({
      active: { id: cardId },
      over: over === null ? null : { id: over },
    });
  });
  return { over };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.droppables.clear();
  harness.draggables.clear();
});

describe("the Brief column", () => {
  it("renders a brief card linking to its editor, with content type and score", () => {
    renderBoard();

    const link = screen.getByRole("link", { name: "How localization breaks design systems" });
    expect(link).toHaveAttribute("href", "/briefs/brief-1");
    expect(screen.getByText("Blog post")).toBeInTheDocument();
    expect(screen.getByText("0.82")).toBeInTheDocument();
  });

  // The rename is the load-bearing half of this change: a Brief column added
  // beside a column still called "Brief" would only relocate the confusion.
  it("is titled Brief and comes first, and the old brief column is now Generating", () => {
    renderBoard();

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Brief", "Generating", "Draft", "Review", "Scheduled", "Published"]);
  });

  // The `draggable` prop each card is rendered with becomes `disabled` on
  // its `useDraggable`, so this is the rule about which cards can be picked
  // up at all — asserted as the whole map, so a card silently gaining or
  // losing a drag handle shows up here.
  it("makes brief cards draggable, and Generating and Published pieces not", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", status: "brief" })],
        draft: [pieceCard({ id: "piece-draft" })],
        published: [pieceCard({ id: "piece-published", status: "published" })],
      }),
    });

    expect(Object.fromEntries(harness.draggables)).toEqual({
      // A brief's one drag target is Generating, which accepts it.
      "brief-1": true,
      // Generate is the only exit from Generating; Published is terminal.
      "piece-generating": false,
      "piece-draft": true,
      "piece-published": false,
    });
  });

  it("shows no assignee picker or generation controls on a brief card", () => {
    renderBoard({ board: boardData({ draft: [] }) });

    expect(screen.queryByRole("button", { name: /generate draft/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });
});

describe("dragging a brief", () => {
  it("accepts it when dropped on Generating", async () => {
    renderBoard();

    const { over } = await drag("brief-1", "brief");

    expect(over).toBe("brief");
    expect(acceptBriefCard).toHaveBeenCalledWith("brief-1");
    expect(moveCard).not.toHaveBeenCalled();
    // Optimistic: the brief leaves the Brief column at once, and the server
    // is re-read for the content piece acceptance created.
    expect(
      screen.queryByRole("link", { name: "How localization breaks design systems" })
    ).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it.each(["draft", "review", "scheduled", "published"])(
    "refuses it on %s — no drop offered, and nothing accepted or moved",
    async (column) => {
      renderBoard();

      // Released over a column the board refuses: the drop must resolve to
      // nothing at all, not to whichever column happens to be enabled.
      const { over } = await drag("brief-1", column);

      expect(over).toBeNull();
      expect(acceptBriefCard).not.toHaveBeenCalled();
      expect(moveCard).not.toHaveBeenCalled();
      // Still there: a refused drag is a no-op, not a silent removal.
      expect(
        screen.getByRole("link", { name: "How localization breaks design systems" })
      ).toBeInTheDocument();
    }
  );

  it("puts the brief back and reports the error when acceptance is refused", async () => {
    acceptBriefCard.mockResolvedValueOnce({ ok: false, error: "This brief was already accepted." } as never);
    renderBoard();

    await drag("brief-1", "brief");

    expect(toast.error).toHaveBeenCalledWith("This brief was already accepted.");
    expect(
      screen.getByRole("link", { name: "How localization breaks design systems" })
    ).toBeInTheDocument();
  });
});

describe("dropping into Brief", () => {
  // A content piece cannot become a brief; the relationship is one-way.
  it.each(["draft", "review", "scheduled"])(
    "is refused for a %s piece — no drop offered, and no move",
    async (from) => {
      renderBoard({
        board: boardData({
          draft: [],
          [from]: [pieceCard({ status: from as BoardCard["status"] })],
        } as Partial<BoardData>),
      });

      const { over } = await drag("piece-1", "briefs");

      expect(over).toBeNull();
      expect(moveCard).not.toHaveBeenCalled();
      expect(acceptBriefCard).not.toHaveBeenCalled();
    }
  );

  it("leaves the ordinary piece moves working", async () => {
    renderBoard();

    const { over } = await drag("piece-1", "review");

    expect(over).toBe("review");
    expect(moveCard).toHaveBeenCalledWith("piece-1", "review", undefined);
  });
});

describe("with an assignee filter active", () => {
  it("explains the Brief column instead of vanishing or ignoring the filter", () => {
    renderBoard({ assigneeFilter: "user-1" });

    // Not showing the briefs anyway...
    expect(
      screen.queryByRole("link", { name: "How localization breaks design systems" })
    ).not.toBeInTheDocument();
    // ...and not gone either: the column is still there, saying why.
    const heading = screen.getByRole("heading", { level: 2, name: /^Brief/ });
    const column = heading.closest("div")?.parentElement as HTMLElement;
    expect(within(column).getByText(/assigned to anyone/i)).toBeInTheDocument();
    expect(within(column).queryByText("No cards.")).not.toBeInTheDocument();
  });

  it("shows the briefs again when the filter is Everyone", () => {
    renderBoard({ assigneeFilter: "all" });

    expect(
      screen.getByRole("link", { name: "How localization breaks design systems" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });
});
