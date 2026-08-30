import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  ProgressChecklist,
  usePacedStatuses,
  MIN_STEP_VISIBLE_MS,
  type StepStatus,
} from "../../src/components/draft-progress-checklist";
import {
  DRAFT_STEPS,
  PROPOSAL_STEPS,
  type DraftStepKey,
  type ProgressStep,
  type ProposalStepKey,
} from "../../src/lib/drafting/draft-progress";

/**
 * The minimum-visible-duration pacing, driven through a real render rather
 * than by calling the hook's internals: the whole point of the feature is what
 * is on screen at a given moment, and `data-status` on the rendered `<li>` is
 * the only machine-readable trace of that (see ProgressChecklist).
 *
 * The harness below is the smallest real consumer — the hook plus the
 * checklist it paces — parameterised by step list, so both flows' actual
 * constants are exercised, `slow` flags and all. Each entry of `script` is one
 * button that announces its whole group inside a single synchronous handler,
 * which is how a caller really reaches this hook: create-brief-modal.tsx
 * announces two steps in one block, with the server round trip dispatched
 * between them. The production consumers are covered where they live —
 * create-brief-modal.test.tsx drives PROPOSAL_STEPS end to end through the
 * modal.
 *
 * Fake timers throughout. Every assertion is about a specific instant, so time
 * has to be moved deliberately rather than waited out.
 */
function Harness<K extends string>({
  steps,
  script,
}: {
  steps: readonly ProgressStep<K>[];
  script: Record<K, StepStatus>[][];
}) {
  const [statuses, showStatuses, cancelPacing] = usePacedStatuses<K>(steps);
  return (
    <>
      <ProgressChecklist steps={steps} statuses={statuses} />
      {/* The third return value, for callers whose terminal state never
          arrives as a snapshot — GenerationChecklist stops rendering the
          checklist outright on a failure, and freezes it at render time on a
          give-up. */}
      <button type="button" onClick={cancelPacing}>
        cancel
      </button>
      {script.map((group, index) => (
        <button
          key={index}
          type="button"
          onClick={() => {
            for (const snapshot of group) showStatuses(snapshot);
          }}
        >
          {`announce-${index}`}
        </button>
      ))}
    </>
  );
}

function statusOf(label: string): string | null {
  const row = screen.getByText(label).closest("li");
  return row?.getAttribute("data-status") ?? null;
}

/** Fire one group of the script. */
function announce(index: number) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: `announce-${index}` }));
  });
}

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The snapshot a flow reports while `key` is the step in flight. */
function inFlight<K extends string>(
  steps: readonly ProgressStep<K>[],
  key: K
): Record<K, StepStatus> {
  const index = steps.findIndex((step) => step.key === key);
  const statuses = {} as Record<K, StepStatus>;
  for (const [i, step] of steps.entries()) {
    statuses[step.key] = i < index ? "done" : i === index ? "active" : "pending";
  }
  return statuses;
}

/** Every step the same — how a completion, and a reset, both report. */
function every<K extends string>(
  steps: readonly ProgressStep<K>[],
  status: StepStatus
): Record<K, StepStatus> {
  const statuses = {} as Record<K, StepStatus>;
  for (const step of steps) statuses[step.key] = status;
  return statuses;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePacedStatuses — a deterministic step is held long enough to read", () => {
  it("keeps a step that finished instantly on screen for the floor", () => {
    render(
      <Harness
        steps={PROPOSAL_STEPS}
        script={[[inFlight(PROPOSAL_STEPS, "resolving"), inFlight(PROPOSAL_STEPS, "proposing")]]}
      />
    );

    // Exactly what create-brief-modal.tsx does: `resolving` goes active and is
    // over in the same tick, because resolving signal ids is server
    // bookkeeping. Both announcements land in one synchronous block.
    announce(0);

    expect(statusOf("Resolving your signals")).toBe("active");
    expect(statusOf("Proposing an angle")).toBe("pending");

    // Still there one millisecond short of the floor.
    tick(MIN_STEP_VISIBLE_MS - 1);
    expect(statusOf("Resolving your signals")).toBe("active");

    tick(1);
    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("active");
  });

  it("holds each of a burst of deterministic steps in turn, dropping none", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[
          [
            inFlight(DRAFT_STEPS, "collecting"),
            inFlight(DRAFT_STEPS, "preparing"),
            inFlight(DRAFT_STEPS, "generating"),
          ],
        ]}
      />
    );

    // Three steps announced in one tick. Without the queue, the first would
    // show and the run would jump straight to the last — the same never-read
    // outcome, one step further along.
    announce(0);
    expect(statusOf("Collecting pending changes")).toBe("active");

    tick(MIN_STEP_VISIBLE_MS);
    expect(statusOf("Preparing brand profile")).toBe("active");
    expect(statusOf("Generating the draft")).toBe("pending");

    tick(MIN_STEP_VISIBLE_MS);
    expect(statusOf("Generating the draft")).toBe("active");
  });

  it("does not hold the first step back — there is nothing in flight to make room after", () => {
    render(<Harness steps={DRAFT_STEPS} script={[[inFlight(DRAFT_STEPS, "collecting")]]} />);

    announce(0);

    // No timer advanced.
    expect(statusOf("Collecting pending changes")).toBe("active");
  });
});

describe("usePacedStatuses — the model call is never paced", () => {
  it("advances off the slow step with no delay at all", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[[inFlight(DRAFT_STEPS, "generating")], [inFlight(DRAFT_STEPS, "reviewing")]]}
      />
    );

    announce(0);
    expect(statusOf("Generating the draft")).toBe("active");

    // The next step arrives in the very same instant the slow one was shown.
    // A floor here would buy nothing — the model call has already taken as
    // long as it takes — and would delay a fast failure out of it.
    announce(1);

    expect(statusOf("Generating the draft")).toBe("done");
    expect(statusOf("Reviewing against brand guidelines")).toBe("active");
    // Nothing was scheduled, so nothing is waiting to fire either.
    expect(vi.getTimerCount()).toBe(0);
  });

  // The other model call in DRAFT_STEPS. `reviewing -> saving` used to be
  // charged a floor, which held the last step of a run behind a fake wait —
  // and would have held a failure out of the review behind it too.
  it("advances off the review step with no delay either", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[[inFlight(DRAFT_STEPS, "reviewing")], [inFlight(DRAFT_STEPS, "saving")]]}
      />
    );

    announce(0);
    expect(statusOf("Reviewing against brand guidelines")).toBe("active");

    announce(1);

    expect(statusOf("Reviewing against brand guidelines")).toBe("done");
    expect(statusOf("Saving the draft")).toBe("active");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still paces the deterministic step that precedes it, in the same list", () => {
    // The contrast that makes the test above mean something: the exemption is
    // the `slow` flag on the step being replaced, not "pacing is off for
    // DRAFT_STEPS".
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[[inFlight(DRAFT_STEPS, "preparing"), inFlight(DRAFT_STEPS, "generating")]]}
      />
    );

    announce(0);
    expect(statusOf("Preparing brand profile")).toBe("active");

    tick(MIN_STEP_VISIBLE_MS);
    expect(statusOf("Generating the draft")).toBe("active");
  });

  it("marks the model calls, and only them, as the slow steps in each flow", () => {
    // The identification the two rules above hang off. A property on the step
    // definition rather than a key list inside the hook: `saving` is a key in
    // both lists, so a key list could not tell these two flows apart.
    //
    // `reviewing` is on this list because `generateDraftForPiece` runs
    // `review(draft, brandProfile)` under it (src/lib/briefs/draft.ts) — it is
    // a second model call, not bookkeeping, and pacing it charged an 800ms
    // floor against a wait that had already happened. The membership test is
    // "is this step a model call", not "is it the slowest one".
    // "illustrating" is the image plan + renders (src/lib/images/illustrate.ts) — two model round trips, the longest wait in the list.
    expect(DRAFT_STEPS.filter((step) => step.slow).map((step) => step.key)).toEqual([
      "generating",
      "reviewing",
      "illustrating",
    ]);
    expect(PROPOSAL_STEPS.filter((step) => step.slow).map((step) => step.key)).toEqual([
      "proposing",
    ]);
  });
});

describe("usePacedStatuses — terminal states are never paced", () => {
  // "stalled" is how a failure, and a give-up, report the step that stopped
  // advancing: it renders frozen rather than spinning.
  const refused: Record<ProposalStepKey, StepStatus> = {
    resolving: "done",
    proposing: "stalled",
    saving: "pending",
  };

  it("surfaces a failure that arrives mid-pace at once, not after the remainder", () => {
    render(
      <Harness
        steps={PROPOSAL_STEPS}
        script={[
          [inFlight(PROPOSAL_STEPS, "resolving"), inFlight(PROPOSAL_STEPS, "proposing")],
          [refused],
        ]}
      />
    );

    announce(0);
    tick(100);
    expect(statusOf("Resolving your signals")).toBe("active");

    // The run blew up while a pace was still running.
    announce(1);

    // No timer advanced between the announcement and these assertions.
    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("stalled");
    expect(statusOf("Creating the brief")).toBe("pending");
    // The pending pace was cancelled outright, not left to fire later and
    // repaint the failure with a stale in-flight snapshot.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a completion that arrives mid-pace at once", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[
          [inFlight(DRAFT_STEPS, "collecting"), inFlight(DRAFT_STEPS, "preparing")],
          [every(DRAFT_STEPS, "done")],
        ]}
      />
    );

    announce(0);
    tick(100);
    announce(1);

    for (const step of DRAFT_STEPS) expect(statusOf(step.label)).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a give-up at once — the step frozen, not spinning", () => {
    // What statusesForGaveUp produces: the in-flight step downgraded to
    // "stalled" so it stops animating next to text saying polling gave up.
    const gaveUp: Record<DraftStepKey, StepStatus> = {
      ...inFlight(DRAFT_STEPS, "collecting"),
      collecting: "stalled",
    };

    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[
          [inFlight(DRAFT_STEPS, "collecting"), inFlight(DRAFT_STEPS, "preparing")],
          [gaveUp],
        ]}
      />
    );

    announce(0);
    tick(100);
    announce(1);

    expect(statusOf("Collecting pending changes")).toBe("stalled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pace outright for a caller that has no final snapshot to push", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[[inFlight(DRAFT_STEPS, "collecting"), inFlight(DRAFT_STEPS, "preparing")]]}
      />
    );

    announce(0);
    tick(100);
    expect(statusOf("Collecting pending changes")).toBe("active");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    });

    // Whatever was displayed stays displayed — this is a cancel, not a reset.
    expect(statusOf("Collecting pending changes")).toBe("active");
    expect(vi.getTimerCount()).toBe(0);

    // And the queued step is gone, not merely deferred: letting it fire later
    // would walk the checklist forward underneath a result already on screen.
    tick(MIN_STEP_VISIBLE_MS * 2);
    expect(statusOf("Collecting pending changes")).toBe("active");
    expect(statusOf("Preparing brand profile")).toBe("pending");
  });

  it("resets to all-pending at once, so a fresh run starts from a clean checklist", () => {
    render(
      <Harness
        steps={DRAFT_STEPS}
        script={[
          [inFlight(DRAFT_STEPS, "collecting"), inFlight(DRAFT_STEPS, "preparing")],
          [every(DRAFT_STEPS, "pending")],
        ]}
      />
    );

    announce(0);
    tick(100);
    announce(1);

    for (const step of DRAFT_STEPS) expect(statusOf(step.label)).toBe("pending");
    // And the queued step from the abandoned cycle is gone, not merely
    // deferred — advancing past the floor must not resurrect it.
    tick(MIN_STEP_VISIBLE_MS * 2);
    for (const step of DRAFT_STEPS) expect(statusOf(step.label)).toBe("pending");
  });
});
