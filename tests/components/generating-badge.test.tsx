import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { BoardCard } from "../../src/lib/content/board";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

/**
 * The badge is the only route left to watching a generation.
 *
 * `GenerationChecklist` used to mount inline on three surfaces as well as in
 * the modal. It now mounts only in the modal, which means the "Generating…"
 * badge each surface already showed has to become the way back in: a real
 * control that opens the modal for THAT piece. Without it, a run started in
 * another tab — or continued after the modal was closed — would have no loader
 * anywhere, which is strictly worse than the inline checklist it replaced.
 *
 * So this file drives the control, not the checklist: the checklist's own
 * behaviour is covered in generation-modal.test.tsx (through the modal) and
 * generation-checklist.test.tsx (its derivations).
 *
 * Fake timers throughout, for the same reason as generation-modal.test.tsx:
 * the poll interval is 3s and every assertion here is about a specific instant.
 */

const { generateDraft, pollGenerationProgress, assignCard, refresh, toast } = vi.hoisted(() => ({
  generateDraft: vi.fn(async () => ({ ok: true as const })),
  pollGenerationProgress: vi.fn(),
  assignCard: vi.fn(async () => ({ ok: true as const })),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

// One router object for every render — `useRouter` sits in effect dependency
// lists, and a fresh object per render would restart those effects forever.
const { router } = vi.hoisted(() => ({ router: {} as { refresh: unknown } }));
router.refresh = refresh;

vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft }));
vi.mock("../../src/app/(dashboard)/board/actions", () => ({ assignCard }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

// dnd-kit cannot be driven in jsdom (every rect is 0x0) and this file never
// drags anything — the card is rendered outside a DndContext, so its hook is
// stubbed rather than left to look for a provider that isn't there.
vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@dnd-kit/core");
  return {
    ...actual,
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
  };
});

import { GeneratingBadge } from "../../src/components/generating-badge";
import { BoardCardItem } from "../../src/app/(dashboard)/board/card";

const PIECE_ID = "piece-1";
const TITLE = "How localization breaks design systems";
const POLL_INTERVAL_MS = 3000;
/** Any DRAFT_STEPS label — its presence outside a dialog means a loader leaked. */
const STEP_LABEL = "Generating the draft";

const MEMBERS = [
  { userId: "user-1", email: "ada@example.com", name: "Ada", role: "owner" as const, createdAt: new Date() },
];

function pieceCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    kind: "piece",
    id: PIECE_ID,
    title: TITLE,
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

function progress(overrides: Partial<GenerationProgress> = {}): GenerationProgress {
  return {
    generationStep: null,
    generatedAt: null,
    generationError: null,
    status: "brief",
    ...overrides,
  };
}

function pollReturns(...results: (GenerationProgress | null)[]) {
  let index = 0;
  pollGenerationProgress.mockImplementation(async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  });
}

const STEP = (key: GenerationProgress["generationStep"]) => progress({ generationStep: key });

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function badge(): HTMLElement {
  return screen.getByRole("button", { name: /generating…/i });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await settle();
}

/** The `data-status` of a step row inside `scope`. */
function statusOf(scope: HTMLElement, label: string): string | null {
  return within(scope).getByText(label).closest("li")?.getAttribute("data-status") ?? null;
}

function renderCard(overrides: Partial<BoardCard> = {}) {
  return render(
    <BoardCardItem
      card={pieceCard(overrides)}
      members={MEMBERS}
      draggable={false}
      onGenerated={() => {}}
      onAssigned={() => {}}
      onDelete={() => {}}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // rAF stays real — Base UI's dialog re-schedules a frame while open, and a
  // faked one turns advanceTimersByTimeAsync into an endless loop.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  pollReturns(STEP("generating"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Generating… badge", () => {
  it("is a real control with an accessible name, not a div with a click handler", async () => {
    render(<GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />);

    const control = badge();
    // A <button>: reachable by keyboard and announced as actionable. This is
    // the only route to watching a run now, so it cannot be a bare <div>.
    expect(control.tagName).toBe("BUTTON");
    expect(control).toHaveAttribute("type", "button");
    // The visible text is part of the accessible name (WCAG 2.5.3), with the
    // piece's title appended so a list of generating rows is distinguishable.
    expect(control).toHaveAccessibleName(`Generating… — ${TITLE}`);
  });

  it("mounts no loader and starts no poll until it is activated", async () => {
    render(<GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />);

    expect(screen.queryByText(STEP_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pollGenerationProgress).not.toHaveBeenCalled();
  });

  it("opens the modal for THAT piece, joining the run rather than claiming to start one", async () => {
    render(<GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />);

    await click(badge());

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Generating a draft")).toBeInTheDocument();
    expect(pollGenerationProgress).toHaveBeenCalledWith(PIECE_ID);
    // Opened onto a run already under way: the accept path's "This takes a
    // minute or so" is a promise about a run that just started, and would be
    // a lie about one that has been going for two minutes.
    expect(within(dialog).queryByText(/takes a minute or so/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/already under way/i)).toBeInTheDocument();
  });

  it("keeps the run going when closed, and reopens onto current progress, not a restart", async () => {
    pollReturns(STEP("generating"));
    render(<GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />);

    await click(badge());
    await advance(POLL_INTERVAL_MS);
    expect(statusOf(screen.getByRole("dialog"), STEP_LABEL)).toBe("active");

    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));

    // Closing is not a cancel — nothing was asked to stop, and the badge is
    // still there because the piece is still generating.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(generateDraft).not.toHaveBeenCalled();
    expect(badge()).toBeInTheDocument();
    // The surface behind it is re-read on close, so a run that landed while
    // the modal was open is picked up.
    expect(refresh).toHaveBeenCalled();

    await click(badge());

    // Reopened onto the run's CURRENT step. A restart would show
    // "Collecting pending changes" active with the model call pending.
    const reopened = screen.getByRole("dialog");
    expect(statusOf(reopened, STEP_LABEL)).toBe("active");
    expect(statusOf(reopened, "Collecting pending changes")).toBe("done");
  });

  it("self-heals a stale badge: a run that already landed is reported, then re-read on close", async () => {
    // The cost of moving the poll into the modal: with the modal CLOSED,
    // nothing notices a run landing, so a surface can sit on a "Generating…"
    // badge after the draft is finished. This is what the user gets when they
    // click it — the truth, and a refresh on the way out.
    pollReturns(progress({ generationStep: null, generatedAt: new Date(), status: "draft" }));
    render(<GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />);

    await click(badge());

    const dialog = screen.getByRole("dialog");
    expect(statusOf(dialog, STEP_LABEL)).toBe("done");
    expect(within(dialog).getByRole("button", { name: "Open draft" })).toHaveAttribute(
      "href",
      `/drafts/${PIECE_ID}`
    );
    // Not while it is open — a refresh under an open modal is what
    // GenerationChecklist stopped doing.
    expect(refresh).not.toHaveBeenCalled();

    await click(within(dialog).getByRole("button", { name: "Close" }));
    expect(refresh).toHaveBeenCalled();
  });
});

describe("the board card", () => {
  it("shows the badge and no inline checklist while a piece is generating", async () => {
    renderCard({ generationStep: "generating" });

    expect(badge()).toBeInTheDocument();
    expect(screen.queryByText(STEP_LABEL)).not.toBeInTheDocument();
    expect(pollGenerationProgress).not.toHaveBeenCalled();
  });

  it("opens the modal for the card's own piece", async () => {
    renderCard({ generationStep: "generating" });

    await click(badge());

    expect(within(screen.getByRole("dialog")).getByText("Generating a draft")).toBeInTheDocument();
    expect(pollGenerationProgress).toHaveBeenCalledWith(PIECE_ID);
  });

  it("keeps its failure affordance — a landed failure is badged, printed and retryable", async () => {
    renderCard({ generationStep: null, generationError: "The model refused." });

    // Not a control: there is nothing in flight to watch.
    expect(screen.queryByRole("button", { name: /generating…/i })).not.toBeInTheDocument();
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    expect(screen.getByText("The model refused.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry generation" })).toBeInTheDocument();
  });

  it("keeps the un-run state as a plain badge, with Generate offered", async () => {
    renderCard({ generationStep: null, generationError: null });

    expect(screen.queryByRole("button", { name: /generating…/i })).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting generation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate draft" })).toBeInTheDocument();
  });
});
