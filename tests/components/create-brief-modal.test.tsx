import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

/**
 * The brief-creation modal, driven for real in jsdom rather than re-derived
 * from extracted helpers — the last several defects on this branch lived in
 * untested effect wiring, and one survived a mutation with every test green.
 *
 * Two module mocks, both because they are unreachable here rather than to
 * dodge an assertion:
 *
 *   - `propose-actions` is a `"use server"` module that reaches `@/db` and a
 *     model; the jsdom project has no DATABASE_URL. The server side is
 *     covered by tests/app/propose-actions.test.ts.
 *   - `briefs/actions` is mocked purely so `dismissBrief` is a spy: the
 *     "closing is not a cancel" test needs something to assert was NOT
 *     called. The modal never imports it, which is the point.
 *
 * Spies come through `vi.hoisted` because `vi.mock` factories hoist above
 * every top-level statement — a plain `const` would still be in its temporal
 * dead zone when the factory runs.
 */
const { proposeAndCreateBrief, acceptBrief, dismissBrief, generateDraft } = vi.hoisted(() => ({
  proposeAndCreateBrief: vi.fn(),
  acceptBrief: vi.fn(),
  dismissBrief: vi.fn(),
  generateDraft: vi.fn(),
}));

vi.mock("../../src/app/(dashboard)/signals/propose-actions", () => ({
  proposeAndCreateBrief: (signalIds: string[]) => proposeAndCreateBrief(signalIds),
}));

vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({
  acceptBrief,
  dismissBrief,
  generateDraft,
}));

import { CreateBriefModal } from "../../src/app/(dashboard)/signals/create-brief-modal";

const SIGNAL_IDS = ["sig-1", "sig-2", "sig-3"];

type ActionResult =
  | { ok: true; briefId: string; usedSignalCount: number; droppedSignalCount: number }
  | { ok: false; error: string };

/** A success with nothing dropped, which is the ordinary case. */
function created(briefId: string, used = SIGNAL_IDS.length, dropped = 0): ActionResult {
  return { ok: true, briefId, usedSignalCount: used, droppedSignalCount: dropped };
}

/** Hands back the resolver so a test can hold the round trip open. */
function deferred() {
  let settle: (value: ActionResult) => void = () => {};
  const promise = new Promise<ActionResult>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * The repo renders link-shaped buttons as `<Button render={<Link/>}>`, which
 * is a Base UI non-native button: an `<a href>` carrying `role="button"`
 * (see the `nativeButton` inference in src/components/ui/button.tsx). So
 * these are queried by the button role and asserted on their `href`.
 */
function linkButton(name: string) {
  return screen.getByRole("button", { name });
}

function statusOf(label: string): string | null {
  const step = screen.getByText(label).closest("li");
  return step?.getAttribute("data-status") ?? null;
}

async function clickCreate() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateBriefModal — the run", () => {
  it("opens the modal and sends the selected ids to the one action", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    // Nothing is on screen — and nothing has been asked of the server — until
    // the button is clicked. The old Link navigated instead.
    expect(screen.queryByText("Proposing an angle")).not.toBeInTheDocument();
    expect(proposeAndCreateBrief).not.toHaveBeenCalled();

    await clickCreate();

    expect(proposeAndCreateBrief).toHaveBeenCalledTimes(1);
    expect(proposeAndCreateBrief).toHaveBeenCalledWith(SIGNAL_IDS);
    expect(screen.getByText("Proposing an angle")).toBeInTheDocument();

    await act(async () => settle(created("brief-9")));
  });

  // The step wiring, which is the whole reason this modal exists. Asserted at
  // both moments the client can actually observe: the request in flight, and
  // the result back.
  it("reaches all three steps — proposing carries the wait, then everything lands done", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    // Mid-flight: resolving is behind us and the model call is what's being
    // waited on, so that is the step that spins.
    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("active");
    expect(statusOf("Creating the brief")).toBe("pending");

    await act(async () => settle(created("brief-9")));

    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("done");
    expect(statusOf("Creating the brief")).toBe("done");
  });

  it("shows no result controls while the action is in flight", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    expect(screen.queryByRole("button", { name: "Open brief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => settle(created("brief-9")));
  });
});

/**
 * A Server Action fetch has no timeout. When Escape was swallowed, the corner
 * X removed and the footer Close disabled all at once, a stalled connection
 * left a page reload as the only exit. The run still can't be cancelled — it
 * can be walked away from, which is safe for exactly the reason Close is safe
 * after a success: the brief lands in the inbox either way.
 */
describe("CreateBriefModal — walking out of a stalled run", () => {
  it("lets the user close while the action is still in flight", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(close);
    });

    await waitFor(() => expect(screen.queryByText("Proposing an angle")).not.toBeInTheDocument());

    // The request was never cancelled — it simply stopped being watched.
    await act(async () => settle(created("brief-9")));
    expect(proposeAndCreateBrief).toHaveBeenCalledTimes(1);
  });

  it("still dismisses on Escape mid-run — onOpenChange no longer swallows it", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();
    expect(screen.getByText("Proposing an angle")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    });

    await waitFor(() => expect(screen.queryByText("Proposing an angle")).not.toBeInTheDocument());
    await act(async () => settle(created("brief-9")));
  });

  it("survives the action throwing synchronously instead of rejecting", async () => {
    // The bug: the call sat outside the try, so a synchronous throw escaped as
    // an unhandled rejection and pinned the modal at `resolving: "active"`
    // with every exit shut.
    proposeAndCreateBrief.mockImplementation(() => {
      throw new Error("dispatch blew up before returning a promise");
    });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("stalled");
    expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled();
  });

  it("ignores an abandoned run's result once a newer run has started", async () => {
    const first = deferred();
    proposeAndCreateBrief.mockReturnValue(first.promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    const second = deferred();
    proposeAndCreateBrief.mockReturnValue(second.promise);
    await clickCreate();

    // The abandoned run lands last, and must not overwrite the live one.
    await act(async () => first.settle({ ok: false, error: "stale failure" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(statusOf("Proposing an angle")).toBe("active");

    await act(async () => second.settle(created("brief-9")));
    expect(linkButton("Open brief")).toHaveAttribute("href", "/briefs/brief-9");
  });
});

describe("CreateBriefModal — success", () => {
  it("offers Open brief pointing at the brief that was created", async () => {
    proposeAndCreateBrief.mockResolvedValue(created("brief-9"));

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());
    expect(linkButton("Open brief")).toHaveAttribute("href", "/briefs/brief-9");
  });

  // The pivot of the design: Close is safe BECAUSE the brief already exists
  // and nothing undoes it. A delete-on-close would turn Close into a decision.
  it("closing after success destroys nothing — no dismiss, no second action call", async () => {
    proposeAndCreateBrief.mockResolvedValue(created("brief-9"));

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();
    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open brief" })).not.toBeInTheDocument()
    );
    expect(dismissBrief).not.toHaveBeenCalled();
    expect(acceptBrief).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
    expect(proposeAndCreateBrief).toHaveBeenCalledTimes(1);
  });
});

describe("CreateBriefModal — failure", () => {
  it("shows the refusal's own reason, not a generic message", async () => {
    proposeAndCreateBrief.mockResolvedValue({
      ok: false,
      error: "The model couldn't find an angle worth writing about.",
    });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The model couldn't find an angle worth writing about."
      )
    );
  });

  it("stops the failed step spinning rather than leaving it looking busy", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: false, error: "No angle." });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(statusOf("Proposing an angle")).toBe("stalled"));
    expect(statusOf("Creating the brief")).toBe("pending");
  });

  // "Never block the form": a failed proposal must not cost the user their
  // selection.
  it("offers Write it by hand, carrying the same ids to /briefs/new", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: false, error: "No angle." });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Write it by hand")).toBeInTheDocument());
    expect(linkButton("Write it by hand")).toHaveAttribute(
      "href",
      "/briefs/new?signals=sig-1,sig-2,sig-3"
    );
    expect(screen.queryByRole("button", { name: "Open brief" })).not.toBeInTheDocument();
  });

  it("survives the action throwing outright, with a message instead of a blank modal", async () => {
    proposeAndCreateBrief.mockRejectedValue(new Error("Failed to fetch"));

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(linkButton("Write it by hand")).toBeInTheDocument();
  });

  it("re-runs cleanly after a failure, with no stale reason or stalled step left over", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: false, error: "No angle." });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();
    await waitFor(() => expect(linkButton("Write it by hand")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);
    await clickCreate();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(statusOf("Proposing an angle")).toBe("active");

    await act(async () => settle(created("brief-9")));
    expect(linkButton("Open brief")).toHaveAttribute("href", "/briefs/brief-9");
  });
});

/**
 * `listSignals` drops stale signals and anything past its 60-day window
 * before the proposal ever sees them, so a five-signal selection can become a
 * three-signal brief. Task 4 deleted `/briefs/new`'s notice about that on the
 * grounds it explained a partial *proposal* — but the condition never went
 * away, so the modal has to say it instead.
 */
describe("CreateBriefModal — partial resolution", () => {
  it("reports the count the brief was built from, not the count that was selected", async () => {
    proposeAndCreateBrief.mockResolvedValue(created("brief-9", 3, 2));

    render(<CreateBriefModal signalIds={["a", "b", "c", "d", "e"]} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());
    expect(screen.getByText(/Built from 3 signals/)).toBeInTheDocument();
  });

  it("surfaces the signals that were dropped rather than swallowing them", async () => {
    proposeAndCreateBrief.mockResolvedValue(created("brief-9", 3, 2));

    render(<CreateBriefModal signalIds={["a", "b", "c", "d", "e"]} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("2 of the 5 signals you selected weren't usable");
  });

  it("says nothing when every selected signal was used", async () => {
    proposeAndCreateBrief.mockResolvedValue(created("brief-9", 3, 0));

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

/**
 * The old flow navigated to `/briefs/new`, which unmounted the list and took
 * the selection with it. The modal comes back to `/signals` with every row
 * still ticked and the same button still live, so without this a second click
 * commissions a second brief from the same evidence.
 */
describe("CreateBriefModal — handing the selection back", () => {
  it("reports the creation when the modal is closed, not while it is still on screen", async () => {
    const onBriefCreated = vi.fn();
    proposeAndCreateBrief.mockResolvedValue(created("brief-9"));

    render(<CreateBriefModal signalIds={SIGNAL_IDS} onBriefCreated={onBriefCreated} />);
    await clickCreate();
    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());

    // Not yet: `SignalsList` renders this modal inside its selection bar, so
    // clearing now would unmount the result the user is reading.
    expect(onBriefCreated).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    expect(onBriefCreated).toHaveBeenCalledTimes(1);
  });

  it("reports a creation that landed after the user walked out", async () => {
    const onBriefCreated = vi.fn();
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} onBriefCreated={onBriefCreated} />);
    await clickCreate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(onBriefCreated).not.toHaveBeenCalled();

    // Nobody is watching, so no Close will ever fire for this run — the brief
    // exists all the same and the evidence has been spent.
    await act(async () => settle(created("brief-9")));
    expect(onBriefCreated).toHaveBeenCalledTimes(1);
  });

  it("keeps the selection when the run failed — Write it by hand still needs it", async () => {
    const onBriefCreated = vi.fn();
    proposeAndCreateBrief.mockResolvedValue({ ok: false, error: "No angle." });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} onBriefCreated={onBriefCreated} />);
    await clickCreate();
    await waitFor(() => expect(linkButton("Write it by hand")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    expect(onBriefCreated).not.toHaveBeenCalled();
  });
});
