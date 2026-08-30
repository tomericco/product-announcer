import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { Board as BoardData, BoardBriefCard, BoardCard } from "../../src/lib/content/board";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

/**
 * Draft generation shown in a modal, driven through both of its real entry
 * points — the board's brief card and the brief editor's Accept — rather than
 * through the modal in isolation. Where the modal is MOUNTED is half of this
 * feature: accepting removes the card that started it and (after a refresh)
 * swaps the editor into its read-only branch, so a modal mounted in the wrong
 * place is torn down by its own success. Only a render of the real callers
 * can catch that.
 *
 * The poll is the production one. `pollGenerationProgress` is mocked (a
 * `"use server"` module reaching `@/db`, unreachable in jsdom — the server
 * side is covered in tests/app/), but everything between it and the screen —
 * the interval, `statusesForStep`, the pacing, the terminal branches — is the
 * real `GenerationChecklist`.
 *
 * Fake timers throughout: the poll interval is 3s and the pacing floor is
 * 800ms, and every assertion here is about a specific instant.
 */

const {
  moveCard,
  assignCard,
  acceptBriefCard,
  acceptBrief,
  dismissBrief,
  generateDraft,
  saveBriefBody,
  pollGenerationProgress,
  push,
  refresh,
  toast,
} = vi.hoisted(() => ({
  moveCard: vi.fn(async () => ({ ok: true as const })),
  assignCard: vi.fn(async () => ({ ok: true as const })),
  acceptBriefCard: vi.fn(async () => ({ ok: true as const, contentPieceId: "piece-new" })),
  acceptBrief: vi.fn(async () => ({ ok: true as const, contentPieceId: "piece-new" })),
  dismissBrief: vi.fn(async () => ({ ok: true as const })),
  generateDraft: vi.fn(async () => ({ ok: true as const })),
  saveBriefBody: vi.fn(async () => ({ ok: true as const })),
  pollGenerationProgress: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ONE router object for every render, hoisted with the spies. `useRouter` is in
// the poll effect's dependency list (GenerationChecklist) and Next's real hook
// returns a stable reference — a mock that builds a fresh object per render
// makes that effect tear down and re-poll on every render, which spins forever
// the moment a poll result causes one.
const { router } = vi.hoisted(() => ({ router: {} as { push: unknown; refresh: unknown } }));
router.push = push;
router.refresh = refresh;

vi.mock("../../src/app/(dashboard)/board/actions", () => ({ moveCard, assignCard, acceptBriefCard }));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ acceptBrief, dismissBrief, generateDraft }));
vi.mock("../../src/app/(dashboard)/briefs/[briefId]/actions", () => ({ saveBriefBody }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

// The editor's chrome, mocked for the same reasons as in
// tests/components/brief-decision-commits-edits.test.tsx: MDXEditor is a
// browser-only dynamic import, and `unsaved-changes` needs a mounted router.
vi.mock("../../src/app/(dashboard)/unsaved-changes", () => ({
  useUnsavedChanges: () => ({
    isDirty: false,
    setSectionDirty: () => {},
    cleanToken: 0,
    notifySaved: () => {},
    requestLeave: () => {},
  }),
  GuardedLink: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../src/app/(dashboard)/briefs/brief-body-editor", () => ({
  BriefBodyEditor: () => <div data-testid="body-editor" />,
}));

// dnd-kit cannot be driven in jsdom (every rect is 0×0), so the drag that
// starts an acceptance is fed to the board's own handlers directly here — the
// stand-in captures them, and `acceptFromBoard` below calls them with the drop
// already resolved to Draft. WHICH drops resolve where is a different question
// and is covered, against the board's real collision strategy, in
// tests/components/board-briefs.test.tsx; this file is about what the modal
// does once one has landed.
const dnd = vi.hoisted(() => ({
  handlers: {} as {
    onDragStart?: (event: unknown) => void;
    onDragEnd?: (event: unknown) => void;
  },
}));

vi.mock("@dnd-kit/core", async () => {
  const { createElement, Fragment } = await import("react");
  // Everything except the context, the hooks and the sensors stays real —
  // `./collision` imports the library's own strategies at module load.
  const actual = await vi.importActual<Record<string, unknown>>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: ({
      children,
      onDragStart,
      onDragEnd,
    }: {
      children?: unknown;
      onDragStart?: (event: unknown) => void;
      onDragEnd?: (event: unknown) => void;
    }) => {
      dnd.handlers = { onDragStart, onDragEnd };
      return createElement(Fragment, null, children as never);
    },
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
    useSensor: () => ({}),
    useSensors: (...sensors: unknown[]) => sensors,
    PointerSensor: class {},
    KeyboardSensor: class {},
  };
});

import { Board } from "../../src/app/(dashboard)/board/board";
import { BriefWorkspace } from "../../src/app/(dashboard)/briefs/[briefId]/brief-workspace";
import { MAX_POLL_ATTEMPTS } from "../../src/components/generation-checklist";
import { MIN_STEP_VISIBLE_MS } from "../../src/components/draft-progress-checklist";

const BRIEF_TITLE = "How localization breaks design systems";
const PIECE_ID = "piece-new";
/** The poll interval in GenerationChecklist. */
const POLL_INTERVAL_MS = 3000;

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
  { userId: "user-1", email: "ada@example.com", name: "Ada", role: "owner" as const, createdAt: new Date() },
];

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
    id: PIECE_ID,
    title: BRIEF_TITLE,
    type: "blog_post",
    status: "brief",
    assignedTo: null,
    scheduledFor: null,
    generationError: null,
    generatedAt: null,
    generationStep: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    cover: null,
    ...overrides,
  };
}

function boardData(overrides: Partial<BoardData> = {}): BoardData {
  return {
    briefs: [briefCard()],
    brief: [],
    draft: [],
    review: [],
    scheduled: [],
    published: [],
    ...overrides,
  };
}

function boardProps(board: BoardData) {
  return {
    initialBoard: board,
    members: MEMBERS,
    assigneeFilter: "all",
    columns: COLUMNS,
    displayColumns: DISPLAY_COLUMNS,
    moveMatrix: MOVE_MATRIX,
    publishedLimit: 20,
  } as const;
}

/** One poll result. */
function progress(overrides: Partial<GenerationProgress> = {}): GenerationProgress {
  return {
    generationStep: null,
    generatedAt: null,
    generationError: null,
    status: "brief",
    ...overrides,
  };
}

/**
 * The poll's answers, in order; the last one is repeated for every further
 * tick. This is what "advances through real polled steps" means here — the
 * checklist is reading a persisted `generationStep` exactly as it does in
 * production, one poll at a time.
 */
function pollReturns(...results: (GenerationProgress | null)[]) {
  let index = 0;
  pollGenerationProgress.mockImplementation(async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  });
}

const STEP = (key: GenerationProgress["generationStep"]) => progress({ generationStep: key });
const COMPLETE = progress({ generationStep: null, generatedAt: new Date(), status: "draft" });
/** A landed failure: the error written, the in-flight step already cleared. */
const FAILED = progress({ generationStep: null, generationError: "The model refused." });

/** Flush pending promises without moving the clock. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Move the clock, flushing the promises each timer callback creates. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function modal(): HTMLElement {
  return screen.getByRole("dialog");
}

/** The `data-status` of a step row inside `scope`. */
function statusOf(scope: HTMLElement, label: string): string | null {
  return within(scope).getByText(label).closest("li")?.getAttribute("data-status") ?? null;
}

/** Board: drop the brief card on Draft, which is the accept gesture. */
async function dropBriefOnDraft() {
  // Two acts, not one: `onDragEnd` reads the `activeCard` that `onDragStart`
  // set, and batching both into a single act would have the end handler close
  // over the pre-start render's null.
  await act(async () => {
    dnd.handlers.onDragStart?.({ active: { id: "brief-1" } });
  });
  await act(async () => {
    dnd.handlers.onDragEnd?.({ active: { id: "brief-1" }, over: { id: "draft" } });
  });
}

/** Board: drop the brief on Draft, then confirm. */
async function acceptFromBoard() {
  await dropBriefOnDraft();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deliberately NOT the default fake-timer set: `requestAnimationFrame` stays
  // real. Base UI's dialog re-schedules a frame for as long as it is open, and
  // a faked rAF turns `advanceTimersByTimeAsync` into an endless loop — every
  // frame it runs schedules another one inside the same window. The clock,
  // `setTimeout` and `setInterval` are what this file needs to control: the
  // 3s poll and the pacing floor, which reads `Date.now()`.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  pollReturns(STEP("collecting"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the board's drop onto Draft, into the modal", () => {
  it("keeps the confirmation, and opens the modal only once it is confirmed", async () => {
    render(<Board {...boardProps(boardData())} />);

    await dropBriefOnDraft();

    // The confirmation, not the generation: nothing has been asked of the
    // server, and no poll has started.
    expect(within(modal()).getByText(/can.t be undone/i)).toBeInTheDocument();
    expect(acceptBriefCard).not.toHaveBeenCalled();
    expect(pollGenerationProgress).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
    });
    await settle();

    expect(within(modal()).getByText("Generating a draft")).toBeInTheDocument();
    expect(pollGenerationProgress).toHaveBeenCalledWith(PIECE_ID);
  });

  it("advances through the steps the server actually reports, one poll at a time", async () => {
    pollReturns(STEP("collecting"), STEP("preparing"), STEP("generating"), COMPLETE);
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();

    // The first poll fires on mount, with no interval to wait out.
    expect(statusOf(modal(), "Collecting pending changes")).toBe("active");
    expect(statusOf(modal(), "Preparing brand profile")).toBe("pending");

    await advance(POLL_INTERVAL_MS);
    expect(statusOf(modal(), "Collecting pending changes")).toBe("done");
    expect(statusOf(modal(), "Preparing brand profile")).toBe("active");

    await advance(POLL_INTERVAL_MS);
    expect(statusOf(modal(), "Generating the draft")).toBe("active");

    await advance(POLL_INTERVAL_MS);
    for (const label of [
      "Collecting pending changes",
      "Preparing brand profile",
      "Generating the draft",
      "Reviewing against brand guidelines",
      "Saving the draft",
    ]) {
      expect(statusOf(modal(), label)).toBe("done");
    }
  });

  it("walks through a step the poll never sampled, holding it for its floor", async () => {
    // The sequence above is not one the server can produce. On the real
    // timeline (src/lib/briefs/draft.ts) `preparing` and `generating` are
    // written a few statements apart, so a 3s poll never catches `preparing`
    // at all: it reads `collecting`, then `generating`. Announcing only what
    // was sampled jumps straight to the model call with `preparing`
    // retro-marked done — the exact problem the pacing was commissioned to
    // fix, which pacing alone cannot fix, because the client never saw the
    // step it was supposed to hold.
    pollReturns(STEP("collecting"), STEP("generating"), COMPLETE);
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();
    expect(statusOf(modal(), "Collecting pending changes")).toBe("active");

    await advance(POLL_INTERVAL_MS);

    // The poll jumped. The checklist does not: the unsampled step is shown,
    // and the model call it skipped to is still pending.
    expect(statusOf(modal(), "Collecting pending changes")).toBe("done");
    expect(statusOf(modal(), "Preparing brand profile")).toBe("active");
    expect(statusOf(modal(), "Generating the draft")).toBe("pending");

    // Held for the full floor — one millisecond short, it is still there.
    await advance(MIN_STEP_VISIBLE_MS - 1);
    expect(statusOf(modal(), "Preparing brand profile")).toBe("active");

    await advance(1);
    expect(statusOf(modal(), "Preparing brand profile")).toBe("done");
    expect(statusOf(modal(), "Generating the draft")).toBe("active");
  });

  it("does not walk on the first sample — a run may have started before this mounted", async () => {
    // A board card (or a modal reopened) can meet a generation already in its
    // model call. Walking there would replay steps that finished minutes ago,
    // which is the dishonest version of the walk-through above.
    pollReturns(STEP("generating"));
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();

    expect(statusOf(modal(), "Generating the draft")).toBe("active");
    expect(statusOf(modal(), "Collecting pending changes")).toBe("done");

    // And nothing is queued behind it: waiting out a floor rewinds nothing.
    await advance(MIN_STEP_VISIBLE_MS);
    expect(statusOf(modal(), "Generating the draft")).toBe("active");
  });

  it("offers Open draft only once the run has landed, pointing at the new piece", async () => {
    pollReturns(STEP("generating"), COMPLETE);
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();

    // Mid-run there is no draft to open — offering one would link to a piece
    // still holding the accept-time scaffold.
    expect(within(modal()).queryByRole("button", { name: "Open draft" })).not.toBeInTheDocument();
    expect(within(modal()).getByRole("button", { name: "Close" })).toBeInTheDocument();

    await advance(POLL_INTERVAL_MS);

    // A `Button render={<Link/>}`: an anchor carrying role="button".
    const open = within(modal()).getByRole("button", { name: "Open draft" });
    expect(open).toHaveAttribute("href", `/drafts/${PIECE_ID}`);
    expect(within(modal()).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("surfaces a failure at once, with no pacing floor in front of it", async () => {
    pollReturns(STEP("collecting"), FAILED);
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();
    expect(statusOf(modal(), "Collecting pending changes")).toBe("active");

    // The failure lands on the next poll, while `collecting` is still inside
    // its minimum-visible window. Waiting that window out to say the run broke
    // is the worst version of the pacing feature.
    await advance(POLL_INTERVAL_MS);

    expect(within(modal()).getByText("Generation failed.")).toBeInTheDocument();
    expect(within(modal()).queryByRole("button", { name: "Open draft" })).not.toBeInTheDocument();
    // No timer is left holding anything back.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops promising a minute once the poll has given up", async () => {
    // A wedged piece: a step stays in flight forever and nothing terminal ever
    // lands, so the poll exhausts its cap. The checklist says so — but the
    // description above it used to keep saying "This takes a minute or so",
    // because the give-up branch never told the modal anything.
    pollReturns(STEP("generating"));
    render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();
    expect(within(modal()).getByText(/takes a minute or so/i)).toBeInTheDocument();

    // The first poll fires on mount, so the cap is reached one interval early.
    await advance(POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS);

    expect(within(modal()).queryByText(/takes a minute or so/i)).not.toBeInTheDocument();
    expect(within(modal()).getByText(/still no result/i)).toBeInTheDocument();
    // And the two now agree, rather than contradicting each other.
    expect(within(modal()).getByText(/taking longer than expected/i)).toBeInTheDocument();
    expect(within(modal()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Not a landed run: nothing to open.
    expect(within(modal()).queryByRole("button", { name: "Open draft" })).not.toBeInTheDocument();
  });

  it("keeps the run going when the modal is closed, and the card's badge reopens it", async () => {
    pollReturns(STEP("generating"));
    const { rerender } = render(<Board {...boardProps(boardData())} />);

    await acceptFromBoard();
    expect(statusOf(modal(), "Generating the draft")).toBe("active");

    // What the refetch `onAccepted` triggers brings back: the brief is gone
    // and the piece it created is in the same column, mid-generation.
    const afterAccept = boardData({
      briefs: [],
      brief: [pieceCard({ generationStep: "generating" })],
    });
    rerender(<Board {...boardProps(afterAccept)} />);
    await settle();

    await act(async () => {
      fireEvent.click(within(modal()).getByRole("button", { name: "Close" }));
    });
    await settle();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Nothing was asked to stop: generation runs in `after()` and there is no
    // cancel to call. The only server calls this whole flow made are the
    // accept and the polls.
    expect(acceptBriefCard).toHaveBeenCalledTimes(1);
    expect(generateDraft).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();

    // The card behind it carries no loader of its own anymore — that is the
    // whole point of this change — but it does carry the way back in: a real
    // "Generating…" control, which is what covers both this case and a
    // generation started in another tab.
    const card = screen.getByRole("link", { name: BRIEF_TITLE }).closest("[data-slot='card']") as HTMLElement;
    expect(within(card).queryByText("Generating the draft")).not.toBeInTheDocument();
    const badge = within(card).getByRole("button", { name: /generating…/i });

    // Nothing polls while no modal is open — the loader and the poll are the
    // same thing now.
    const pollsWhileClosed = pollGenerationProgress.mock.calls.length;
    await advance(POLL_INTERVAL_MS);
    expect(pollGenerationProgress.mock.calls.length).toBe(pollsWhileClosed);

    // And activating the badge puts the run back on screen, at the step it is
    // actually on rather than at the beginning.
    await act(async () => {
      fireEvent.click(badge);
    });
    await settle();
    expect(statusOf(modal(), "Generating the draft")).toBe("active");
    expect(statusOf(modal(), "Collecting pending changes")).toBe("done");
  });
});

describe("the brief editor's Accept, into the modal", () => {
  function renderEditor() {
    return render(
      <BriefWorkspace briefId="brief-1" canDecide initialTitle={BRIEF_TITLE} initialBody="## Angle" />
    );
  }

  async function acceptFromEditor() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^accept/i }));
    });
    await settle();
  }

  it("opens the modal instead of redirecting to the draft", async () => {
    pollReturns(STEP("collecting"));
    renderEditor();

    await acceptFromEditor();

    // The redirect this replaces threw the author off the brief they had just
    // read, onto a page showing the accept-time scaffold for the whole run.
    expect(push).not.toHaveBeenCalled();
    expect(within(modal()).getByText("Generating a draft")).toBeInTheDocument();
    expect(statusOf(modal(), "Collecting pending changes")).toBe("active");
  });

  it("survives the run landing, and offers the draft it produced", async () => {
    pollReturns(STEP("generating"), COMPLETE);
    renderEditor();

    await acceptFromEditor();
    await advance(POLL_INTERVAL_MS);

    // The modal must still be here. A `router.refresh()` fired at completion
    // would have swapped this page into its read-only branch and unmounted the
    // workspace — and the modal with it — at the exact moment it had something
    // to offer. The refresh is deferred to close for that reason.
    expect(refresh).not.toHaveBeenCalled();
    expect(within(modal()).getByRole("button", { name: "Open draft" })).toHaveAttribute(
      "href",
      `/drafts/${PIECE_ID}`
    );
  });

  it("re-reads the page when it is closed, and stops nothing by closing", async () => {
    pollReturns(STEP("generating"));
    renderEditor();

    await acceptFromEditor();
    await act(async () => {
      fireEvent.click(within(modal()).getByRole("button", { name: "Close" }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The brief is `accepted` now, so the page has to re-read itself into its
    // read-only branch — which is exactly why this waits until close.
    expect(refresh).toHaveBeenCalled();
    expect(acceptBrief).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
