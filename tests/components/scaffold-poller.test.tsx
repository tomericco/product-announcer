import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

/**
 * `/drafts/[releaseId]` is the one surface that watches a generation for
 * itself.
 *
 * The stepped checklist mounts only inside the generation modal, so nothing
 * polls while no modal is open. On the board and on `/drafts` that costs one
 * stale badge, and clicking it self-heals. On this page it costs the whole
 * page: the Server Component returns early for `status = 'brief'` and renders
 * the accept-time scaffold in a `<pre>` — no editor, no Ask AI, no publish —
 * so a run that lands while nobody has a modal open leaves the author looking
 * at the brief document.
 *
 * So `ScaffoldPoller` polls the same persisted column the checklist reads and
 * calls `router.refresh()` when the run lands, which re-runs the page past
 * that early return. This file drives that loop directly: it renders nothing,
 * so every assertion here is about calls, timers and the refresh — not the
 * DOM.
 *
 * Fake timers throughout, like generation-modal.test.tsx, because every
 * assertion is about a specific instant on a 3s cadence.
 */

const { pollGenerationProgress, refresh } = vi.hoisted(() => ({
  pollGenerationProgress: vi.fn(),
  refresh: vi.fn(),
}));

// One router object for every render — it sits in the effect's dependency
// list, and a fresh object per render would tear the poll down and restart it
// on every parent render.
const { router } = vi.hoisted(() => ({ router: {} as { refresh: unknown } }));
router.refresh = refresh;

vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ScaffoldPoller } from "../../src/app/(dashboard)/drafts/[releaseId]/scaffold-poller";
import { MAX_POLL_ATTEMPTS } from "../../src/components/generation-checklist";

const PIECE_ID = "piece-1";
const POLL_INTERVAL_MS = 3000;

function progress(overrides: Partial<GenerationProgress> = {}): GenerationProgress {
  return {
    generationStep: null,
    generatedAt: null,
    generationError: null,
    status: "brief",
    ...overrides,
  };
}

const STEP = (key: GenerationProgress["generationStep"]) => progress({ generationStep: key });
/** The run landed: the draft exists and the piece has moved on from `brief`. */
const COMPLETE = progress({ generationStep: null, generatedAt: new Date(), status: "draft" });
/** A landed failure: the error written, the in-flight step already cleared. */
const FAILED = progress({ generationStep: null, generationError: "The model refused." });

function pollReturns(...results: (GenerationProgress | null)[]) {
  let index = 0;
  pollGenerationProgress.mockImplementation(async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  });
}

/** Move the clock, flushing the promises each timer callback creates. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Flush pending promises without moving the clock. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  pollReturns(STEP("generating"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the draft page's scaffold poller", () => {
  it("polls while the page is showing the scaffold for a generating piece", async () => {
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    // The first poll fires on mount rather than an interval later: a run can
    // land between the server render and hydration.
    await settle();
    expect(pollGenerationProgress).toHaveBeenCalledWith(PIECE_ID);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(1);

    await advance(POLL_INTERVAL_MS);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(2);

    await advance(POLL_INTERVAL_MS * 2);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(4);
    // Still in flight, so nothing has been re-read yet — a refresh mid-run
    // would only render the same scaffold again.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders nothing — the badge is the awareness, this is only the re-read", async () => {
    const { container } = render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    expect(container).toBeEmptyDOMElement();
  });

  it("refreshes the page and stops polling once the run lands", async () => {
    pollReturns(STEP("generating"), COMPLETE);
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    await advance(POLL_INTERVAL_MS);

    // The refresh is the whole point: it re-runs the Server Component past
    // its `status === "brief"` early return, so the page becomes the editor.
    expect(refresh).toHaveBeenCalledTimes(1);
    const callsAtTerminal = pollGenerationProgress.mock.calls.length;

    // Terminal means stop. Without this the loop would keep POSTing a server
    // action every 3s at a piece whose run is over.
    await advance(POLL_INTERVAL_MS * 5);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(callsAtTerminal);
    expect(vi.getTimerCount()).toBe(0);
    // And at most one refresh per effect run — a terminal read that leaves
    // this page on the same branch (see the landed-failure case below) must
    // not re-read it forever.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops on a landed failure too, not only on a success", async () => {
    // `generationError` set with the step already cleared: the failure
    // landed. The page keeps its scaffold, now with a "Generation failed"
    // badge and a Retry — but there is nothing left to watch either way.
    pollReturns(STEP("generating"), FAILED);
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    await advance(POLL_INTERVAL_MS);
    const callsAtTerminal = pollGenerationProgress.mock.calls.length;

    await advance(POLL_INTERVAL_MS * 5);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(callsAtTerminal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the piece disappears from under it", async () => {
    // Deleted mid-generation: the read comes back null and there is no id
    // left to poll about.
    pollReturns(STEP("generating"), null);
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    await advance(POLL_INTERVAL_MS);
    const callsAtTerminal = pollGenerationProgress.mock.calls.length;

    await advance(POLL_INTERVAL_MS * 5);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(callsAtTerminal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll at all when the piece is not generating", async () => {
    // A brief accepted but never generated, or one whose failure already
    // landed: the scaffold is the correct, final thing to show, and it can
    // sit there for days. Opening a loop against an unchanging row would be
    // a server action POST every 3s for as long as the tab stays open.
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating={false} />);
    await settle();

    expect(pollGenerationProgress).not.toHaveBeenCalled();

    await advance(POLL_INTERVAL_MS * 10);

    expect(pollGenerationProgress).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts polling if the same piece flips into generating", async () => {
    // The other half of the guard: it gates on server state, so a re-read
    // that reports a step in flight has to start the loop rather than leave
    // it off for the life of the mount.
    const { rerender } = render(<ScaffoldPoller contentPieceId={PIECE_ID} generating={false} />);
    await settle();
    expect(pollGenerationProgress).not.toHaveBeenCalled();

    rerender(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    expect(pollGenerationProgress).toHaveBeenCalledTimes(1);
  });

  it("clears its interval on unmount", async () => {
    const { unmount } = render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();
    expect(pollGenerationProgress).toHaveBeenCalledTimes(1);

    unmount();

    // No timer left behind, and no further polling once the page is gone.
    expect(vi.getTimerCount()).toBe(0);
    await advance(POLL_INTERVAL_MS * 5);
    expect(pollGenerationProgress).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a route it has already left", async () => {
    // The terminal read arrives after unmount. Refreshing here would fire at
    // a route this component no longer belongs to.
    let resolvePoll: (value: GenerationProgress) => void = () => {};
    pollGenerationProgress.mockImplementationOnce(
      () =>
        new Promise<GenerationProgress>((resolve) => {
          resolvePoll = resolve;
        })
    );
    const { unmount } = render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    unmount();
    await act(async () => {
      resolvePoll(COMPLETE);
      await Promise.resolve();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("gives up at the attempt cap rather than polling a wedged run forever", async () => {
    // A wedged piece: `generationStep` stays non-null forever (the
    // interrupted-generation marker is written before the model call and
    // nothing ever clears it), so nothing terminal ever lands and
    // `shouldStopPolling` correctly keeps saying "not terminal".
    pollReturns(STEP("generating"));
    render(<ScaffoldPoller contentPieceId={PIECE_ID} generating />);
    await settle();

    // The first poll fires on mount, so the cap is reached one interval early.
    await advance(POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS);

    expect(pollGenerationProgress).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);

    await advance(POLL_INTERVAL_MS * 10);

    expect(pollGenerationProgress).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);
    // Giving up is not a landed run: the scaffold and its badge stay as they
    // are, and the modal behind that badge still offers the Retry.
    expect(refresh).not.toHaveBeenCalled();
  });
});
