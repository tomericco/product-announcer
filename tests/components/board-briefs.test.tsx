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
 * The Brief column holds only briefs — rows in `briefs` awaiting a decision.
 * Content pieces mid-generation (`status = "brief"`) render in Draft instead,
 * alongside finished drafts: accepting a brief creates one of these, and a
 * card that stayed in Brief until generation finished would make the
 * drag-to-accept look like it hadn't worked. There is no Generating column.
 * Accepting a brief IS the drag now — onto Draft, and onto nothing else — so
 * the drag tests here are about the one target the board offers and the four
 * it REFUSES.
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

const { router } = vi.hoisted(() => ({ router: {} as Record<string, unknown> }));
router.refresh = refresh;
router.push = vi.fn();

vi.mock("../../src/app/(dashboard)/board/actions", () => ({ moveCard, assignCard, acceptBriefCard }));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
// One object for every render: `useRouter` is in the generation checklist's
// poll-effect dependency list, and a fresh object per render would restart that
// effect — and its poll — on every render. Next's real hook is stable.
vi.mock("next/navigation", () => ({ useRouter: () => router }));
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
  // Confirming an accept now opens the board's generation modal, which mounts
  // a real `GenerationChecklist` and polls. Nothing here asserts on that — the
  // modal is driven in tests/components/generation-modal.test.tsx — but the
  // poll must resolve to something the loop can read rather than `undefined`.
  pollGenerationProgress.mockResolvedValue(null as never);
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

    // Rendered as a `Button` with `render={<Link .../>}` (see board.tsx) —
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

  // Brief holds only briefs now — the count badge must not include anything
  // else, or a leftover `board.brief` piece would inflate it silently.
  it("holds only briefs — the count badge does not include pieces mid-generation", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
      }),
    });

    const column = columnNamed("Brief");
    expect(within(column).getByText("1")).toBeInTheDocument();
    expect(within(column).queryByRole("link", { name: "Ship notes" })).not.toBeInTheDocument();
  });

  // The `draggable` prop each card is rendered with becomes `disabled` on
  // its `useDraggable`, so this is the rule about which cards can be picked
  // up at all — asserted as the whole map, so a card silently gaining or
  // losing a drag handle shows up here.
  it("makes brief cards draggable, unlike the generating pieces now in Draft", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", status: "brief" })],
        draft: [pieceCard({ id: "piece-draft" })],
        published: [pieceCard({ id: "piece-published", status: "published" })],
      }),
    });

    expect(Object.fromEntries(harness.draggables)).toEqual({
      // A brief drags — onto Draft, which is how it is accepted now.
      "brief-1": true,
      // Generate is the only exit from a generating piece; Published is terminal.
      "piece-generating": false,
      "piece-draft": true,
      "piece-published": false,
    });
    // And a grip to pick it up by — the same handle shape the piece cards
    // use, which is also the keyboard path (KeyboardSensor drags from the
    // focused handle) now that the Accept button is gone.
    expect(
      within(cardOf(BRIEF_TITLE)).getByRole("button", { name: `Move ${BRIEF_TITLE}` })
    ).toBeInTheDocument();
  });

  // The button is gone: acceptance is the drag now, and leaving a one-click
  // path beside it would be two ways to spend the same irreversible model
  // call.
  it("no longer offers an Accept button on the card", () => {
    renderBoard();

    expect(
      within(cardOf(BRIEF_TITLE)).queryByRole("button", { name: /accept brief/i })
    ).not.toBeInTheDocument();
  });
});

/**
 * A `brief`-status content piece is work in flight created by accepting a
 * brief; it renders in Draft, not Brief — see the header comment. Draft is
 * therefore the one column with two populations now: generating pieces and
 * finished drafts.
 */
describe("the Draft column", () => {
  // The placement itself. This is the test the task's mutation check targets:
  // put `board.brief` back into the Brief column's `visible` list and this
  // must fail.
  it("renders a piece mid-generation in Draft, not Brief", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [],
      }),
    });

    const draftColumn = columnNamed("Draft");
    const piece = within(draftColumn).getByRole("link", { name: "Ship notes" });
    expect(piece).toHaveAttribute("href", "/drafts/piece-generating");

    const briefColumn = columnNamed("Brief");
    expect(within(briefColumn).queryByRole("link", { name: "Ship notes" })).not.toBeInTheDocument();
  });

  // It keeps its inline checklist and its Generate affordance wherever it
  // renders — the move is presentation only, not a change to what the card
  // itself shows.
  it("keeps its checklist and Generate affordance in Draft", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [],
      }),
    });

    const piece = cardOf("Ship notes");
    expect(within(piece).getByText("Awaiting generation")).toBeInTheDocument();
    expect(within(piece).getByRole("button", { name: /generate draft/i })).toBeInTheDocument();
    expect(within(piece).getByText("Unassigned")).toBeInTheDocument();
  });

  // Ordering decision: generating pieces sit ABOVE finished drafts, not
  // below and not interleaved by date. They are work in flight whose state
  // (checklist step, Retry) changes while you watch, the same reason the
  // Brief column used to put them above the (unbounded, score-ordered)
  // brief list before this move — and they are also, in practice, the
  // newest thing in the column, since generation starts the moment a brief
  // is accepted. Pinning them to the top keeps the one card someone is
  // actually watching from drifting under a growing list of settled drafts.
  it("puts the generating piece above finished drafts", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [pieceCard({ id: "piece-draft", title: "Existing draft" })],
      }),
    });

    const links = within(columnNamed("Draft"))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/drafts/piece-generating", "/drafts/piece-draft"]);
  });

  // The count badge covers both populations sharing the column.
  it("counts both the generating piece and the finished draft", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
        draft: [pieceCard({ id: "piece-draft", title: "Existing draft" })],
      }),
    });

    expect(within(columnNamed("Draft")).getByText("2")).toBeInTheDocument();
  });
});

/** The confirmation the drop opens — distinguished from the generation modal. */
function acceptDialog(): HTMLElement {
  return screen
    .getAllByRole("dialog")
    .find((d) => /can.t be undone/i.test(d.textContent ?? "")) as HTMLElement;
}

/** Confirms the open Accept dialog — the click that actually runs acceptBriefCard. */
function confirmAccept() {
  fireEvent.click(within(acceptDialog()).getByRole("button", { name: /generate draft/i }));
}

/** Cancels the open Accept dialog. */
function cancelAccept() {
  fireEvent.click(within(acceptDialog()).getByRole("button", { name: /cancel/i }));
}

describe("accepting a brief", () => {
  // Draft is the only column that takes a brief, and the drop is what asks.
  // The confirmation itself is inherited from the button this replaced: it
  // was added at the owner's explicit request when Accept was one click, and
  // reversing that is the owner's call, not this task's.
  it("opens a confirmation naming the brief on a drop onto Draft, and calls nothing yet", async () => {
    renderBoard();

    const { over } = await drag("brief-1", "draft");

    expect(over).toBe("draft");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(new RegExp(BRIEF_TITLE))).toBeInTheDocument();
    expect(within(dialog).getByText(/can.t be undone/i)).toBeInTheDocument();
    expect(acceptBriefCard).not.toHaveBeenCalled();
    // The piece path must never see a brief id.
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("calls nothing when the confirmation is cancelled", async () => {
    renderBoard();

    await drag("brief-1", "draft");
    await screen.findByRole("dialog");
    cancelAccept();

    expect(acceptBriefCard).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("calls acceptBriefCard exactly once with the right brief id once confirmed", async () => {
    renderBoard();

    await drag("brief-1", "draft");
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() => expect(acceptBriefCard).toHaveBeenCalledTimes(1));
    expect(acceptBriefCard).toHaveBeenCalledWith("brief-1");
    expect(moveCard).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Same as the Generate button on the piece cards: the server is re-read,
    // which is what removes the brief and brings back the piece acceptance
    // created.
    expect(refresh).toHaveBeenCalled();
  });

  // The modal the button used to open, opened by the drop instead — the
  // person who just dropped the card watches the run here.
  it("opens the generation modal on the piece acceptance created", async () => {
    renderBoard();

    await drag("brief-1", "draft");
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() => expect(screen.getByText("Generating a draft")).toBeInTheDocument());
    // And the confirmation itself has closed — one dialog, not two stacked.
    expect(screen.queryByText(/can.t be undone/i)).not.toBeInTheDocument();
  });

  it("reports the error and leaves the card alone when acceptance is refused", async () => {
    acceptBriefCard.mockResolvedValueOnce({ ok: false, error: "This brief was already accepted." } as never);
    renderBoard();

    await drag("brief-1", "draft");
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This brief was already accepted.")
    );
    expect(refresh).not.toHaveBeenCalled();
    // The dialog stays open on a refusal, so the underlying brief card is
    // (correctly) aria-hidden behind it — getByText, not getByRole, so this
    // assertion isn't just re-testing that the modal is open.
    expect(acceptDialog()).toBeInTheDocument();
    expect(screen.getByText(BRIEF_TITLE)).toBeInTheDocument();
  });

  it("reports a thrown rejection rather than leaving the drop silent", async () => {
    acceptBriefCard.mockRejectedValueOnce(new Error("Network down."));
    renderBoard();

    await drag("brief-1", "draft");
    await screen.findByRole("dialog");
    confirmAccept();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network down."));
    expect(refresh).not.toHaveBeenCalled();
    expect(acceptDialog()).toBeInTheDocument();
    expect(screen.getByText(BRIEF_TITLE)).toBeInTheDocument();
  });

  // Draft is the ONLY target. Every other column refuses the brief outright:
  // no drop offered, nothing asked, nothing called.
  it.each(DISPLAY_COLUMNS.filter((c) => c !== "draft"))(
    "does not happen by dragging the brief onto %s",
    async (column) => {
      renderBoard();

      const { over } = await drag("brief-1", column);

      expect(over).toBeNull();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(acceptBriefCard).not.toHaveBeenCalled();
      expect(moveCard).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: BRIEF_TITLE })).toBeInTheDocument();
    }
  );

  // The refusal above is the `disabled` flag on `useDroppable`, not a second
  // check bolted on afterwards — asserted as the whole map so a column
  // silently becoming a target for a brief shows up here. (Brief itself is
  // absent from the enabled set for the same reason it is when a piece is
  // dragged: nothing may be dropped INTO Brief.)
  it("enables only Draft as a droppable while a brief is being dragged", () => {
    renderBoard();

    act(() => {
      harness.handlers.onDragStart?.({ active: { id: "brief-1" } });
    });

    expect(Object.fromEntries(harness.droppables)).toEqual({
      briefs: false,
      draft: true,
      review: false,
      scheduled: false,
      published: false,
    });
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
 * Brief holds only briefs now, so its filter semantics collapsed to one
 * population, one reason: `assignedTo` is a content-piece concept, briefs
 * have no assignee, and readBoard deliberately never filters them — so an
 * active filter always hides every brief in the column and says why, rather
 * than presenting a silently partial column. (Before this move, the same
 * column also held generating pieces, which the server HAD already filtered
 * — that second, differently-behaved population is what made this
 * `filterHidesBriefs` note necessary in the first place; it is gone from
 * Brief but the note is too, unless briefs remain.)
 *
 * Draft is unaffected by any of this: it renders exactly what it's handed,
 * generating pieces included, with no filter-driven note of its own — the
 * assignee filter for pieces is already applied server-side in readBoard,
 * before this component ever sees the board.
 */
describe("with an assignee filter active", () => {
  it("hides the briefs and says why", () => {
    renderBoard({ assigneeFilter: "user-1" });

    const column = columnNamed("Brief");
    expect(within(column).queryByRole("link", { name: BRIEF_TITLE })).not.toBeInTheDocument();
    expect(within(column).getByText(/assigned to anyone/i)).toBeInTheDocument();
    expect(within(column).getByText("No cards.")).toBeInTheDocument();
  });

  // filterHidesBriefs must consult board.briefs.length: with a filter active
  // but zero `new` briefs to begin with, there is nothing for the filter to
  // be withholding, and the explanatory note would contradict the
  // "No cards." right above it.
  it("says nothing is being withheld when there were no briefs to filter in the first place", () => {
    renderBoard({ board: boardData({ briefs: [] }), assigneeFilter: "user-1" });

    const column = columnNamed("Brief");
    expect(within(column).getByText("No cards.")).toBeInTheDocument();
    expect(within(column).queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });

  it("shows the briefs again when the filter is Everyone", () => {
    renderBoard({ assigneeFilter: "all" });

    expect(screen.getByRole("link", { name: BRIEF_TITLE })).toBeInTheDocument();
    expect(screen.queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });

  // The Brief-only note must never leak onto Draft — a generating piece
  // there is unaffected by `filterHidesBriefs` and carries no such note.
  it("leaves the generating piece in Draft alone — no note, still rendered", () => {
    renderBoard({
      board: boardData({
        brief: [pieceCard({ id: "piece-generating", title: "Ship notes", status: "brief" })],
      }),
      assigneeFilter: "user-1",
    });

    const draftColumn = columnNamed("Draft");
    expect(within(draftColumn).getByRole("link", { name: "Ship notes" })).toBeInTheDocument();
    expect(within(draftColumn).queryByText(/assigned to anyone/i)).not.toBeInTheDocument();
  });
});
