import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

/**
 * `RunControls` — the /ai-visibility header's run cluster.
 *
 * Two things live here that nothing else can cover. The first is the LIVE
 * counter: the page's own test renders a server snapshot and stops, so it
 * cannot see that the number moves. Before this component existed it did not —
 * `runNowAction` fired one refresh at the moment the run was planned, when the
 * count is 0 of 270 by definition, and the line then sat frozen for the several
 * minutes the run took. Watching a run meant reloading by hand.
 *
 * The second is where Stop sits. It is passed through `RunNowButton`'s
 * `actions` slot now rather than rendered as a sibling of it, so "Stop is in
 * the same block as Run now" is a claim about a prop, and a refactor that put
 * it back in the page's flex row would not fail any other test.
 */

const refresh = vi.fn();
// ONE router object, returned by every call. Next's own `useRouter` is stable
// across renders and the watch effect depends on it; a mock that minted a fresh
// object each render would restart the poll on every state update this
// component makes — which is every reading it takes.
const router = { refresh, push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { pollRunProgressAction, cancelRunAction, resumeRunAction, runNowAction } = vi.hoisted(() => ({
  pollRunProgressAction: vi.fn(),
  cancelRunAction: vi.fn(),
  resumeRunAction: vi.fn(),
  runNowAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/ai-visibility/actions", () => ({
  pollRunProgressAction,
  cancelRunAction,
  resumeRunAction,
  runNowAction,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RunControls } from "../../../src/app/(dashboard)/ai-visibility/run-controls";
import type { RunEstimate } from "../../../src/app/(dashboard)/ai-visibility/run-now-button";

const ESTIMATE: RunEstimate = { prompts: 5, engines: 3, samples: 3, calls: 270, usd: 3.12 };

function progress(overrides: Partial<Parameters<typeof RunControls>[0]["initialProgress"]> = {}) {
  return { inFlight: false, stalled: false, completedCalls: 0, plannedCalls: 0, ...overrides };
}

function renderControls(overrides: Partial<Parameters<typeof RunControls>[0]> = {}) {
  return render(
    <RunControls
      initialProgress={progress()}
      estimate={ESTIMATE}
      blockedReason={null}
      capBlocking={null}
      nextScanNote="Next scan in 5 days"
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // No `shouldAdvanceTime`: with it, real elapsed time also drives the 3s
  // interval, so a test that advanced the clock once saw the poll fire five
  // times and consumed the readings it had queued for the assertions.
  vi.useFakeTimers();
  // The default keeps the run in flight, so a test that does not care about
  // polling is not silently swept into the finished branch.
  pollRunProgressAction.mockResolvedValue(progress({ inFlight: true, completedCalls: 41, plannedCalls: 270 }));
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Advances the clock and lets the reads it fires settle.
 *
 * Two flushes, not one: `advanceTimersByTimeAsync` runs the interval callback,
 * which only STARTS the async read — the `setProgress` that follows its
 * resolution lands a microtask later, after the timer helper has returned.
 */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("RunControls — live progress", () => {
  it("moves the counter while the run runs, with no navigation and no refresh", async () => {
    pollRunProgressAction
      .mockResolvedValueOnce(progress({ inFlight: true, completedCalls: 41, plannedCalls: 270 }))
      .mockResolvedValueOnce(progress({ inFlight: true, completedCalls: 88, plannedCalls: 270 }));

    renderControls({ initialProgress: progress({ inFlight: true, completedCalls: 0, plannedCalls: 270 }) });
    // The server's snapshot, before anything is polled.
    expect(screen.getByText("Running… 0 / 270 calls")).toBeInTheDocument();

    // The read on mount: the run may have moved between the server render and
    // hydration, and three seconds of a stale "0 / 270" on a fresh page is the
    // exact staleness this component removes.
    await tick();
    expect(screen.getByText("Running… 41 / 270 calls")).toBeInTheDocument();

    await tick(3000);
    expect(screen.getByText("Running… 88 / 270 calls")).toBeInTheDocument();
    // None of that was a navigation.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once when the run finishes, because everything below the header is now a run stale", async () => {
    pollRunProgressAction.mockResolvedValue(
      progress({ inFlight: false, completedCalls: 270, plannedCalls: 270 })
    );

    renderControls({ initialProgress: progress({ inFlight: true, completedCalls: 250, plannedCalls: 270 }) });
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Running…/)).not.toBeInTheDocument();

    // And it stops: no second refresh however long the page is left open.
    await tick(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll at all when no run is in flight", async () => {
    renderControls();
    await tick(30_000);

    expect(pollRunProgressAction).not.toHaveBeenCalled();
  });

  it("stops polling a stalled run — its counter cannot move until somebody presses Resume", async () => {
    pollRunProgressAction.mockResolvedValue(
      progress({ inFlight: true, stalled: true, completedCalls: 41, plannedCalls: 270 })
    );

    renderControls({ initialProgress: progress({ inFlight: true, completedCalls: 41, plannedCalls: 270 }) });
    await tick();
    expect(pollRunProgressAction).toHaveBeenCalledTimes(1);

    expect(screen.getByText("Stalled at 41 / 270 calls — resume to finish it")).toBeInTheDocument();
    await tick(30_000);
    expect(pollRunProgressAction).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh server snapshot over its own last reading", async () => {
    const { rerender } = renderControls({
      initialProgress: progress({ inFlight: true, completedCalls: 0, plannedCalls: 270 }),
    });
    await tick();
    expect(screen.getByText("Running… 41 / 270 calls")).toBeInTheDocument();

    // What a Stop looks like from here: the action refreshes, the server says
    // the run is over, and that has to win over whatever the last poll read.
    rerender(
      <RunControls
        initialProgress={progress()}
        estimate={ESTIMATE}
        blockedReason={null}
        capBlocking={null}
        nextScanNote="Next scan in 5 days"
        warnings={[]}
      />
    );
    expect(screen.queryByText(/Running…/)).not.toBeInTheDocument();
    expect(screen.getByText("Next scan in 5 days")).toBeInTheDocument();
  });
});

describe("RunControls — what shares the button's block", () => {
  it("puts Stop in the same block as Run now, not beside it in the page", async () => {
    renderControls({ initialProgress: progress({ inFlight: true, completedCalls: 41, plannedCalls: 270 }) });
    await tick();

    const stop = screen.getByRole("button", { name: "Stop" });
    const runNow = screen.getByRole("button", { name: "Run now" });
    // One row holds both. `contains` rather than a parent identity check
    // because a disabled "Run now" is wrapped in its own tooltip trigger — what
    // matters is the enclosing row, not how deep inside it each button sits.
    const row = stop.parentElement!;
    expect(row.contains(runNow)).toBe(true);
    // And that row is inside the column the status line sits under.
    expect(row.parentElement!.textContent).toContain("Running… 41 / 270 calls");
  });

  it("offers Resume beside Stop once the run is stalled, and neither before", async () => {
    pollRunProgressAction.mockResolvedValue(
      progress({ inFlight: true, stalled: true, completedCalls: 41, plannedCalls: 270 })
    );

    renderControls();
    await tick();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

    renderControls({
      initialProgress: progress({ inFlight: true, stalled: true, completedCalls: 41, plannedCalls: 270 }),
    });
    await tick();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("shows the next scan only when nothing is blocking a run", async () => {
    renderControls();
    await tick();
    expect(screen.getByText("Next scan in 5 days")).toBeInTheDocument();

    renderControls({ capBlocking: "Paused — monthly engine budget reached ($20.40 of $20.00)." });
    await tick();
    expect(screen.queryByText("Next scan in 5 days")).toBeInTheDocument();
  });

  it("prefers a missing key over the cap, and a run in flight over both", async () => {
    const { rerender } = renderControls({
      blockedReason: "No engine key is connected, so a run has nothing to ask with.",
      capBlocking: "Paused — monthly engine budget reached.",
    });
    await tick();
    expect(screen.getByText("No engine key is connected, so a run has nothing to ask with.")).toBeInTheDocument();
    expect(screen.queryByText(/Paused/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Next scan/)).not.toBeInTheDocument();

    rerender(
      <RunControls
        initialProgress={progress({ inFlight: true, completedCalls: 41, plannedCalls: 270 })}
        estimate={ESTIMATE}
        blockedReason="No engine key is connected, so a run has nothing to ask with."
        capBlocking="Paused — monthly engine budget reached."
        nextScanNote="Next scan in 5 days"
        warnings={[]}
      />
    );
    await tick();
    expect(screen.getByText("Running… 41 / 270 calls")).toBeInTheDocument();
    expect(screen.queryByText(/No engine key/)).not.toBeInTheDocument();
  });
});

/**
 * Readiness warnings reach the one place they can still change a decision: the
 * confirmation dialog, between "I want a run" and the money being spent.
 *
 * Blocks are deliberately not tested here — a block is the page's
 * `blockedReason`, which renders a disabled button and no dialog at all, and
 * that split is asserted in the overview page's own tests.
 */
describe("RunControls — readiness warnings", () => {
  const WARNINGS = [
    {
      id: "competitors" as const,
      level: "warn" as const,
      message: "No competitors, so this run measures your mention rate but cannot benchmark it.",
      fix: { label: "Add competitors", href: "/company#competitors" },
    },
    {
      id: "judge" as const,
      level: "warn" as const,
      message: "Something with nowhere to go.",
      fix: null,
    },
  ];

  async function openDialog(overrides = {}) {
    renderControls({ warnings: WARNINGS, ...overrides });
    await tick();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    });
  }

  it("lists them in the dialog, above the button that spends the money", async () => {
    await openDialog();

    for (const warning of WARNINGS) {
      expect(screen.getByText(new RegExp(warning.message.slice(0, 30)))).toBeInTheDocument();
    }
  });

  it("gives each one its route out, and copes with a warning that has none", async () => {
    await openDialog();

    expect(screen.getByRole("link", { name: "Add competitors" })).toHaveAttribute(
      "href",
      "/company#competitors"
    );
    // The second warning carries `fix: null` and must still render its sentence
    // rather than crashing or swallowing it.
    expect(screen.getByText(/Something with nowhere to go/)).toBeInTheDocument();
  });

  it("still quotes the estimate — the warnings sit beside the money, not instead of it", async () => {
    await openDialog();

    expect(screen.getByText(/≈ 270 calls/)).toBeInTheDocument();
    expect(screen.getByText(/about \$3\.12/)).toBeInTheDocument();
  });

  it("renders no list at all for a ready workspace", async () => {
    await openDialog({ warnings: [] });

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
