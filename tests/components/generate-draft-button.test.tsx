import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

/**
 * The draft detail page's Generate button, which starts a run and then has to
 * hand it somewhere.
 *
 * The modal is the only loader a generation has now — and, because the poll
 * lives inside it, the only thing that ever notices a run landing. A button
 * that started a run and merely refreshed therefore left the person who
 * pressed it on the worst version of the stale state in the app: this page
 * returns early while a piece is `status = 'brief'`, so what stays on screen
 * is the accept-time scaffold in a `<pre>` — no editor, no Ask AI, no publish
 * — with nothing watching and nothing to flip it over when the draft lands.
 *
 * So these tests are about the wiring between the start and the loader, not
 * about the checklist inside it (driven in generation-modal.test.tsx) or the
 * badge that reopens it (generating-badge.test.tsx).
 *
 * Fake timers, for the same reason as those two: the poll interval is 3s and
 * every assertion here is about a specific instant.
 */

const { generateDraft, pollGenerationProgress, refresh, toast } = vi.hoisted(() => ({
  generateDraft: vi.fn(async () => ({ ok: true as const })),
  pollGenerationProgress: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

// One router object for every render — `useRouter` sits in effect dependency
// lists, and a fresh object per render would restart those effects forever.
const { router } = vi.hoisted(() => ({ router: {} as { refresh: unknown } }));
router.refresh = refresh;

vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));

import { GenerateDraftButton } from "../../src/app/(dashboard)/drafts/[releaseId]/generate-draft-button";

const PIECE_ID = "piece-1";
const POLL_INTERVAL_MS = 3000;
/** Any DRAFT_STEPS label — its presence outside a dialog means a loader leaked. */
const STEP_LABEL = "Generating the draft";

function progress(overrides: Partial<GenerationProgress> = {}): GenerationProgress {
  return {
    generationStep: null,
    generatedAt: null,
    generationError: null,
    status: "brief",
    ...overrides,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await settle();
}

function generateButton(): HTMLElement {
  return screen.getByRole("button", { name: /generate draft/i });
}

function renderButton({ inFlight = false, isRetry = false } = {}) {
  return render(
    <GenerateDraftButton contentPieceId={PIECE_ID} isRetry={isRetry} inFlight={inFlight} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // rAF stays real — Base UI's dialog re-schedules a frame while open, and a
  // faked one turns advanceTimersByTimeAsync into an endless loop.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  pollGenerationProgress.mockResolvedValue(progress({ generationStep: "generating" }) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the draft detail page's Generate button", () => {
  it("mounts no loader and starts no poll before it is pressed", () => {
    renderButton();

    expect(generateButton()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(STEP_LABEL)).not.toBeInTheDocument();
    expect(pollGenerationProgress).not.toHaveBeenCalled();
  });

  it("opens the generation modal on the piece it just started", async () => {
    renderButton();

    await click(generateButton());

    expect(generateDraft).toHaveBeenCalledWith(PIECE_ID);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Generating a draft")).toBeInTheDocument();
    expect(pollGenerationProgress).toHaveBeenCalledWith(PIECE_ID);
    // Not `joining`: this run began a second ago, so the modal's promise about
    // how long it takes is honest here in a way it would not be for the badge.
    expect(within(dialog).getByText(/takes a minute or so/i)).toBeInTheDocument();
  });

  it("joins the run it started rather than starting a second one", async () => {
    renderButton();

    await click(generateButton());
    // Several polls' worth of watching — the modal reads a persisted column,
    // it never re-queues the work.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });

    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect(pollGenerationProgress.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps the modal open when the page re-renders with the run in flight", async () => {
    const { rerender } = renderButton();

    await click(generateButton());
    // What `router.refresh()` produces a moment later: the server now sees a
    // step for this piece. The button goes; the loader it just opened must
    // not go with it — this component used to `return null` here.
    rerender(<GenerateDraftButton contentPieceId={PIECE_ID} isRetry={false} inFlight />);

    expect(screen.queryByRole("button", { name: /generate draft/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Generating a draft")).toBeInTheDocument();
  });

  it("re-reads the page on close, not out from under the open modal", async () => {
    // A run that lands while it is being watched.
    pollGenerationProgress.mockResolvedValue(
      progress({ generationStep: null, generatedAt: new Date(), status: "draft" }) as never
    );
    renderButton();

    await click(generateButton());

    // One refresh: the one that hides the button behind the modal. The
    // checklist deliberately does not refresh on completion — doing so on this
    // page would unmount the modal at the moment it has a draft to offer.
    expect(refresh).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Open draft" })).toHaveAttribute(
      "href",
      `/drafts/${PIECE_ID}`
    );

    await click(within(dialog).getByRole("button", { name: "Close" }));

    // The second refresh is the one that matters on this page: it is what
    // re-reads a `brief`-status scaffold into the real editor.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("opens nothing when the start is refused", async () => {
    generateDraft.mockResolvedValueOnce({ ok: false, error: "Already generating." } as never);
    renderButton();

    await click(generateButton());

    expect(toast.error).toHaveBeenCalledWith("Already generating.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pollGenerationProgress).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers no button — and no loader of its own — for a run already in flight", () => {
    renderButton({ inFlight: true });

    // The page's "Generating…" badge stands in for the button; this component
    // contributes only its (closed) modal.
    expect(screen.queryByRole("button", { name: /generate draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(STEP_LABEL)).not.toBeInTheDocument();
    expect(pollGenerationProgress).not.toHaveBeenCalled();
  });

  it("still labels a retry as one, and opens the same modal", async () => {
    renderButton({ isRetry: true });

    const control = screen.getByRole("button", { name: "Retry generation" });
    await click(control);

    expect(generateDraft).toHaveBeenCalledWith(PIECE_ID);
    expect(within(screen.getByRole("dialog")).getByText("Generating a draft")).toBeInTheDocument();
  });
});
