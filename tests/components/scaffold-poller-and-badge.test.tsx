import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

/**
 * The pairing `generating-badge.tsx`'s docstring used to get wrong: on
 * `/drafts/[releaseId]`, `ScaffoldPoller` and the badge's own modal are
 * mounted side by side, and both poll the same column on the same 3s
 * cadence. When a run lands while that modal is open, the poller's refresh
 * is a mutation on the very surface the modal sits on — exactly the case the
 * badge's docstring used to (wrongly) say could not happen there.
 *
 * This file drives that pairing directly rather than through the real
 * `page.tsx`, because the interesting behaviour is a client-side race
 * (two effects, one shared column, one `router.refresh()`) that a
 * server-component snapshot test (`tests/app/drafts/one-loader-in-the-modal.test.ts`)
 * cannot exercise. `Harness` below stands in for the `status === "brief"`
 * branch of that page: it mounts the same two things that branch mounts —
 * the badge (or its terminal replacement) and the poller — and swaps to a
 * placeholder for the rest of the page once the branch would flip, the same
 * way a real `router.refresh()` re-running the Server Component would.
 *
 * What this proves is the claim the docstring now makes: the badge and its
 * modal are free to disappear mid-run, because where they land is not
 * nowhere — it's the editor (or the failure panel), the same destination
 * either surface was always heading to.
 *
 * Fake timers throughout, for the same reason as the two files this one
 * pairs: the poll interval is 3s and every assertion is about a specific
 * instant.
 */

const { generateDraft, pollGenerationProgress, refresh } = vi.hoisted(() => ({
  generateDraft: vi.fn(async () => ({ ok: true as const })),
  pollGenerationProgress: vi.fn(),
  refresh: vi.fn(),
}));

// One router object for every render, like the two files this pairs —
// `useRouter` sits in effect dependency lists in both `ScaffoldPoller` and
// the checklist inside the badge's modal, and a fresh object per render
// would restart those effects on every parent render.
const { router } = vi.hoisted(() => ({ router: {} as { refresh: () => void } }));
router.refresh = refresh;

vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { GeneratingBadge } from "../../src/components/generating-badge";
import { ScaffoldPoller } from "../../src/app/(dashboard)/drafts/[releaseId]/scaffold-poller";

const PIECE_ID = "piece-1";
const TITLE = "How localization breaks design systems";
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
/** The run landed successfully: the draft exists, the piece has moved on from `brief`. */
const COMPLETE = progress({ generationStep: null, generatedAt: new Date(), status: "draft" });
/** A landed failure: the error written, the in-flight step already cleared. */
const FAILED = progress({ generationStep: null, generationError: "The model refused." });

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

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await settle();
}

function badge(): HTMLElement | null {
  return screen.queryByRole("button", { name: /generating…/i });
}

/**
 * A mutable stand-in for the database row `pollGenerationProgress` reads.
 * Both `ScaffoldPoller`'s poll and the badge modal's checklist poll read the
 * same `server.current` through the mocked action, exactly as they'd both
 * read the same persisted column for real.
 */
type Server = { current: GenerationProgress };

/**
 * The `status === "brief"` branch of `/drafts/[releaseId]`'s `page.tsx`,
 * shrunk to the two things that matter here: the badge (or its terminal
 * replacement) and the poller, mounted together. `router.refresh()` re-runs
 * a Server Component for real; here the mocked `refresh` re-reads `server`
 * into local state, which is the one effect this harness needs to fake.
 */
function Harness({ server }: { server: Server }) {
  const [piece, setPiece] = useState(server.current);

  useEffect(() => {
    refresh.mockImplementation(() => setPiece({ ...server.current }));
  }, [server]);

  if (piece.status !== "brief") {
    // Stands in for everything past the early return in page.tsx — the
    // editor, in particular the same `/drafts/${PIECE_ID}` destination the
    // modal's own "Open draft" button points at.
    return <div data-testid="editor">the editor for {PIECE_ID}</div>;
  }

  const generating = piece.generationStep !== null;

  return (
    <div>
      {generating ? (
        <GeneratingBadge contentPieceId={PIECE_ID} title={TITLE} />
      ) : (
        <span>{piece.generationError ? "Generation failed" : "Awaiting generation"}</span>
      )}
      <ScaffoldPoller contentPieceId={PIECE_ID} generating={generating} />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the scaffold poller and the badge's own modal, mounted together", () => {
  it("ends on the editor when the run lands while the modal is open — nothing is stranded", async () => {
    const server: Server = { current: STEP("generating") };
    pollGenerationProgress.mockImplementation(async () => server.current);

    render(<Harness server={server} />);
    await settle();

    // Open the badge's modal — this is the paired state the docstring used
    // to claim couldn't coexist with a refresh on this page: an open
    // checklist, with the poller also live beside it.
    await click(badge()!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The run lands. Both the poller's poll and the checklist's poll read
    // this on their next tick, which is the same tick — they share a cadence
    // and were both mounted at the same fake-clock instant.
    server.current = COMPLETE;
    await advance(POLL_INTERVAL_MS);

    // The badge and its modal are gone — the whole `brief` branch is, not
    // just the loader. That is the benign case: what replaced it is the
    // editor, the identical place "Open draft" would have sent them.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);

    // And nothing is left polling a branch this tree no longer renders.
    const callsAtLanding = pollGenerationProgress.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 5);
    expect(pollGenerationProgress.mock.calls.length).toBe(callsAtLanding);
  });

  it("ends on the failure badge, not stranded either, when the run lands as a failure", async () => {
    const server: Server = { current: STEP("generating") };
    pollGenerationProgress.mockImplementation(async () => server.current);

    render(<Harness server={server} />);
    await settle();

    await click(badge()!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    server.current = FAILED;
    await advance(POLL_INTERVAL_MS);

    // Still `status = "brief"` — a landed failure doesn't move the piece —
    // so this is the sibling swap, not the editor: the modal and its badge
    // give way to the failed-generation badge, which is exactly what the
    // page paints in this branch.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
