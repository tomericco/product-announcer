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

type ActionResult = { ok: true; briefId: string } | { ok: false; error: string };

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

    await act(async () => settle({ ok: true, briefId: "brief-9" }));
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

    await act(async () => settle({ ok: true, briefId: "brief-9" }));

    expect(statusOf("Resolving your signals")).toBe("done");
    expect(statusOf("Proposing an angle")).toBe("done");
    expect(statusOf("Creating the brief")).toBe("done");
  });

  it("offers no way out while the action is in flight — the run can't be cancelled", async () => {
    const { promise, settle } = deferred();
    proposeAndCreateBrief.mockReturnValue(promise);

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open brief" })).not.toBeInTheDocument();

    await act(async () => settle({ ok: true, briefId: "brief-9" }));
  });
});

describe("CreateBriefModal — success", () => {
  it("offers Open brief pointing at the brief that was created", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: true, briefId: "brief-9" });

    render(<CreateBriefModal signalIds={SIGNAL_IDS} />);
    await clickCreate();

    await waitFor(() => expect(linkButton("Open brief")).toBeInTheDocument());
    expect(linkButton("Open brief")).toHaveAttribute("href", "/briefs/brief-9");
  });

  // The pivot of the design: Close is safe BECAUSE the brief already exists
  // and nothing undoes it. A delete-on-close would turn Close into a decision.
  it("closing after success destroys nothing — no dismiss, no second action call", async () => {
    proposeAndCreateBrief.mockResolvedValue({ ok: true, briefId: "brief-9" });

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

    await act(async () => settle({ ok: true, briefId: "brief-9" }));
    expect(linkButton("Open brief")).toHaveAttribute("href", "/briefs/brief-9");
  });
});
