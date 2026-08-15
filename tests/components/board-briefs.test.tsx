import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import type { Board as BoardData, BoardBriefCard, BoardCard } from "../../src/lib/content/board";

/**
 * The board's Brief column, driven through a real render rather than through
 * the drag rules in isolation. Every UI defect on this branch has lived in
 * wiring a pure-function test could not see — one survived a mutation with
 * all its tests green — so these tests mount the actual `Board`, let it
 * compute each column's droppability from its own state, and then drop a
 * card the way dnd-kit would.
 *
 * The column holds two populations now: briefs awaiting a decision (rows in
 * `briefs`) and content pieces mid-generation (`status = "brief"`). There is
 * no Generating column and no drag path to acceptance — accepting is a
 * button on the brief card — so the drag tests here are about what the board
 * REFUSES.
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
 *     real strategy over a fabricated board geometry. That matters: an
 *     earlier stub resolved `over` as "the column you released over, if it
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
    generateDraft: vi.fn(async () => ({ ok: true as const })),
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
// `brief` is a status, not a column: a piece mid-generation renders inside
// the Brief column beside the briefs. This is BOARD_DISPLAY_COLUMNS.
const DISPLAY_COLUMNS = ["briefs", "draft", "review", "scheduled", "published"] as const;
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

const BRIEF_TITLE = "How localization breaks design systems";

function briefCard(overrides: Partial<BoardBriefCard> = {}): BoardBriefCard {
  return {
    kind: "brief",
    id: "brief-1",
    title: BRIEF_TITLE,
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

/** The column element (header + card list) whose title starts with `title`. */
function columnNamed(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) });
  return heading.closest("div")?.parentElement as HTMLElement;
}

/** The card element containing the given link, for scoping queries to it. */
function cardOf(linkName: string): HTMLElement {
  return screen.getByRole("link", { name: linkName }).closest("[data-slot='card']") as HTMLElement;
}

// A fabricated board geometry: the five columns as a left-to-right strip.
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
 * resolved to, which is the whole question.
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

    const link = screen.getByRole("link", { name: BRIEF_TITLE });
    expect(link).toHaveAttribute("href", "/briefs/brief-1");
    const card = cardOf(BRIEF_TITLE);
    expect(within(card).getByText("Blog post")).toBeInTheDocument();
    expect(within(card).getByText("0.82")).toBeInTheDocument();
  });

  // The hand-written-from-scratch path (`/briefs/new` with no `?signals=`)
  // had no UI entry point after the standalone /briefs list was deleted —
  // the only remaining link to it carried `?signals=` and only rendered on
  // the create-brief modal's failure branch. This is the affordance that
  // closes that gap; it must not depend on there being any cards to show,
  // agent-proposed or otherwise.
  it("offers a route to /briefs/new that doesn't require picking signals first", () => {
    renderBoard({ board: boardData({ briefs: [], brief: [] }) });

    // Rendered as a `Button` with `render={<Link .../>}` (see board.tsx and
    // the other Button-wrapped links in this file, e.g. "Accept brief") —
    // Base UI's Button stamps `role="button"` on the underlying anchor, so
    // this queries by that role rather than "link".
    const column = columnNamed("Brief");
    const link = within(column).getByRole("button", { name: "New brief" });
    expect(link).toHaveAttribute("href", "/briefs/new");
  });

  // The Generating column is gone: a piece mid-generation belongs beside the
  // brief it came from, and merging the two removed the drop target that
  // made acceptance a drag.
  it("is the only brief-ish column: five columns, none of them Generating", () => {
    renderBoard();

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Brief", "Draft", "Review", "Scheduled", "Published"]);
  });

  // Two populations, two card kinds, one column.
  it("holds both a brief and a piece mid-generation, each as its own kind of card", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [],
      }),
    });

    const column = columnNamed("Brief");
    // The brief: links to the brief editor, has a score, has no assignee
    // picker and no generation controls.
    const brief = cardOf(BRIEF_TITLE);
    expect(within(brief).getByRole("link", { name: BRIEF_TITLE })).toHaveAttribute(
      "href",
      "/briefs/brief-1"
    );
    expect(within(brief).queryByRole("button", { name: /generate draft/i })).not.toBeInTheDocument();
    expect(within(brief).queryByText("Unassigned")).not.toBeInTheDocument();

    // The piece: links to the draft, keeps its status badge, its assignee
    // picker and its Generate affordance.
    const piece = cardOf("Ship notes");
    expect(within(piece).getByRole("link", { name: "Ship notes" })).toHaveAttribute(
      "href",
      "/drafts/piece-generating"
    );
    expect(within(piece).getByText("Awaiting generation")).toBeInTheDocument();
    expect(within(piece).getByRole("button", { name: /generate draft/i })).toBeInTheDocument();
    expect(within(piece).getByText("Unassigned")).toBeInTheDocument();

    // The count badge covers both.
    expect(within(column).getByText("2")).toBeInTheDocument();
  });

  // Pieces first: a piece is work already committed and moving, a brief is
  // still a proposal. Accepting therefore reads as a promotion to the top of
  // the same column, and the in-flight cards — the ones whose state changes
  // while you watch — never sit below an unbounded, score-ordered brief list.
  it("puts the pieces mid-generation above the briefs", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [],
      }),
    });

    const links = within(columnNamed("Brief"))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/drafts/piece-generating", "/briefs/brief-1"]);
  });

  // The `draggable` prop each card is rendered with becomes `disabled` on
  // its `useDraggable`, so this is the rule about which cards can be picked
  // up at all — asserted as the whole map, so a card silently gaining or
  // losing a drag handle shows up here.
  it("makes brief cards non-draggable, like the generating pieces beside them", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", status: "brief" })],
        draft: [pieceCard({ id: "piece-draft" })],
        published: [pieceCard({ id: "piece-published", status: "published" })],
      }),
    });

    // The brief is absent from this map entirely — it does not register a
    // draggable at all, which is a stronger statement than registering a
    // disabled one, and the whole map is asserted so a card silently gaining
    // or losing a drag handle shows up here.
    expect(Object.fromEntries(harness.draggables)).toEqual({
      // Generate is the only exit from a generating piece; Published is terminal.
      "piece-generating": false,
      "piece-draft": true,
      "piece-published": false,
    });
    expect(harness.draggables.has("brief-1")).toBe(false);
    // And no grip either — a handle for a drag that cannot happen.
    expect(within(cardOf(BRIEF_TITLE)).queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
  });
});

/** Clicks the Accept button on the brief card. Opens the confirmation; calls nothing. */
function clickAccept() {
  fireEvent.click(within(cardOf(BRIEF_TITLE)).getByRole("button", { name: /accept brief/i }));
}

/** Confirms the open Accept dialog — the click that actually runs acceptBriefCard. */
function confirmAccept() {
  fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
}

/** Cancels the open Accept dialog. */
function cancelAccept() {
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
}

describe("accepting a brief", () => {
  // The row-level-Accept hazard an earlier spec deliberately designed out of
  // the editor (see briefs-list.tsx) — a row-level Accept lets you accept a
  // brief you never opened. Putting Accept back on the board's card
  // reintroduces exactly that risk unless the click itself asks first.
  it("opens a confirmation naming the brief, and does not call acceptBriefCard yet", async () => {
    renderBoard();

    clickAccept();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(new RegExp(BRIEF_TITLE))).toBeInTheDocument();
    expect(within(dialog).getByText(/can.t be undone/i)).toBeInTheDocument();
    expect(acceptBriefCard).not.toHaveBeenCalled();
  });

  it("calls nothing when the confirmation is cancelled", async () => {
    renderBoard();

    clickAccept();
    await screen.findByRole("dialog");
    cancelAccept();

    expect(acceptBriefCard).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("calls acceptBriefCard exactly once with the right brief id once confirmed", async () => {
    renderBoard();

    clickAccept();
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() => expect(acceptBriefCard).toHaveBeenCalledTimes(1));
    expect(acceptBriefCard).toHaveBeenCalledWith("brief-1");
    expect(moveCard).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Same as the Generate button beside it: the server is re-read, which is
    // what removes the brief and brings back the piece acceptance created.
    expect(refresh).toHaveBeenCalled();
  });

  it("reports the error and leaves the card alone when acceptance is refused", async () => {
    acceptBriefCard.mockResolvedValueOnce({ ok: false, error: "This brief was already accepted." } as never);
    renderBoard();

    clickAccept();
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This brief was already accepted.")
    );
    expect(refresh).not.toHaveBeenCalled();
    // The dialog stays open on a refusal, so the underlying brief card is
    // (correctly) aria-hidden behind it — getByText, not getByRole, so this
    // assertion isn't just re-testing that the modal is open.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(BRIEF_TITLE)).toBeInTheDocument();
  });

  it("reports a thrown rejection rather than leaving the click silent", async () => {
    acceptBriefCard.mockRejectedValueOnce(new Error("Network down."));
    renderBoard();

    clickAccept();
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network down."));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(BRIEF_TITLE)).toBeInTheDocument();
  });

  // There is no drop target for a brief any more, and the board must not
  // acquire one by accident: a brief released over ANY column is a no-op.
  it.each(DISPLAY_COLUMNS)("cannot happen by dragging the brief onto %s", async (column) => {
    renderBoard();

    const { over } = await drag("brief-1", column);

    expect(over).toBeNull();
    expect(acceptBriefCard).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: BRIEF_TITLE })).toBeInTheDocument();
  });
});

describe("dropping into Brief", () => {
  // A content piece cannot become a brief; the relationship is one-way. The
  // `brief` status is still not a drop target either — it is simply not a
  // column of its own any more.
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

/**
 * One column, two populations, two filter semantics. `assignedTo` is a
 * content-piece concept: readBoard filters the pieces by it and deliberately
 * does not filter the briefs, which have no assignee. So under a filter the
 * column keeps showing its pieces and hides its briefs — and says so, rather
 * than presenting a silently partial column.
 */
describe("with an assignee filter active", () => {
  it("hides the briefs and says why, while the generating pieces stay", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
      }),
      assigneeFilter: "user-1",
    });

    const column = columnNamed("Brief");
    // The briefs are gone...
    expect(screen.queryByRole("link", { name: BRIEF_TITLE })).not.toBeInTheDocument();
    // ...the piece, which the server already filtered, is not...
    expect(within(column).getByRole("link", { name: "Ship notes" })).toBeInTheDocument();
    // ...and the column explains the difference instead of looking partial.
    expect(within(column).getByText(/assigned to anyone/i)).toBeInTheDocument();
    expect(within(column).queryByText("No cards.")).not.toBeInTheDocument();
  });

  // Two populations empty for two different reasons, so the column says two
  // things: nothing is shown here (true of the pieces, which the filter can
  // and did apply to), and the briefs are excluded wholesale because the
  // filter cannot apply to them at all. Suppressing either one would leave a
  // column that looks like it has answered a question it hasn't.
  it("says both when the pieces are filtered out and the briefs are hidden", () => {
    renderBoard({ board: boardData({ brief: [], draft: [] }), assigneeFilter: "user-1" });

    const column = columnNamed("Brief");
    expect(within(column).getByText("No cards.")).toBeInTheDocument();
    expect(within(column).getByText(/assigned to anyone/i)).toBeInTheDocument();
  });

  // filterHidesBriefs must consult board.briefs.length: with a filter active
  // but zero `new` briefs to begin with, there is nothing for the filter to
  // be withholding, and the explanatory note would contradict the
  // "No cards." right above it.
  it("says nothing is being withheld when there were no briefs to filter in the first place", () => {
    renderBoard({ board: boardData({ briefs: [], brief: [], draft: [] }), assigneeFilter: "user-1" });

    const column = columnNamed("Brief");
    expect(within(column).getByText("No cards.")).toBeInTheDocument();
    expect(within(column).queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });

  it("shows the briefs again when the filter is Everyone", () => {
    renderBoard({ assigneeFilter: "all" });

    expect(screen.getByRole("link", { name: BRIEF_TITLE })).toBeInTheDocument();
    expect(screen.queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });
});
