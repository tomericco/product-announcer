import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook, act, waitFor } from "@testing-library/react";

/**
 * The Critical this file exists for: Accept navigates away with `router.push`,
 * which is NOT a `GuardedLink`, so the unsaved-changes guard never fires — and
 * `acceptBrief` scaffolds and generates the draft from the STORED row. On the
 * natural flow of this page (open → edit → Accept) the model therefore received
 * the commission the human did not write, and the brief flipped to `accepted`,
 * which both the page and `saveBriefBody` treat as read-only. The edits were
 * unrecoverable and nothing said so.
 *
 * So this renders the real thing and clicks the real button, rather than
 * asserting on a hook in isolation: the bug lived in the wiring BETWEEN two
 * components, which is exactly what a hook-level test would have missed.
 *
 * Everything mocked below is mocked because it cannot run in jsdom (the
 * MDXEditor body editor, the App Router, the "use server" modules that import
 * `@/db`), never to stand in for the logic under test. The title field, the
 * header, the decision hook and the editor hook are all the real ones.
 */
const { calls, saveBriefBody, acceptBrief, dismissBrief, push, refresh, toastError, toastSuccess } =
  vi.hoisted(() => {
    const calls: string[] = [];
    return {
      calls,
      saveBriefBody: vi.fn(async () => {
        calls.push("save");
        return { ok: true as const };
      }),
      acceptBrief: vi.fn(async () => {
        calls.push("accept");
        return { ok: true as const, contentPieceId: "piece-1" };
      }),
      dismissBrief: vi.fn(async () => {
        calls.push("dismiss");
        return { ok: true as const };
      }),
      push: vi.fn(),
      refresh: vi.fn(),
      toastError: vi.fn(),
      toastSuccess: vi.fn(),
    };
  });

vi.mock("../../src/app/(dashboard)/briefs/[briefId]/actions", () => ({ saveBriefBody }));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ acceptBrief, dismissBrief }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

// `unsaved-changes` mounts a Dialog and calls the App Router; `GuardedLink` is
// only chrome here.
vi.mock("../../src/app/(dashboard)/unsaved-changes", () => ({
  useUnsavedChanges: () => ({
    isDirty: false,
    setSectionDirty: () => {},
    cleanToken: 0,
    notifySaved: () => {},
    requestLeave: () => {},
  }),
  // A span, not an anchor: nothing here navigates, and an `<a href="/briefs">`
  // trips @next/next/no-html-link-for-pages.
  GuardedLink: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

// The body editor is a `ssr: false` dynamic import of MDXEditor, which brings
// a CSS import and a large browser-only bundle. The title field below is the
// real component and is enough to make the editor dirty through the DOM.
vi.mock("../../src/app/(dashboard)/briefs/[briefId]/brief-body-editor", () => ({
  BriefBodyEditor: () => <div data-testid="body-editor" />,
}));

import { BriefWorkspace } from "../../src/app/(dashboard)/briefs/[briefId]/brief-workspace";
import { useBriefDecision } from "../../src/app/(dashboard)/briefs/brief-decision";

const INITIAL_TITLE = "How localization breaks design systems";
const INITIAL_BODY = "## Angle\nMost teams discover it too late";

function renderWorkspace() {
  return render(
    <BriefWorkspace
      briefId="brief-1"
      canDecide
      initialTitle={INITIAL_TITLE}
      initialBody={INITIAL_BODY}
    />
  );
}

function editTitle(value: string) {
  fireEvent.input(screen.getByLabelText("Title"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  // Restored as IMPLEMENTATIONS, not `mockResolvedValue`: the ordering
  // assertions below depend on each mock recording itself in `calls`, and a
  // resolved-value stub would silently drop that and make every order
  // assertion trivially `[]`.
  saveBriefBody.mockImplementation(async () => {
    calls.push("save");
    return { ok: true as const };
  });
  acceptBrief.mockImplementation(async () => {
    calls.push("accept");
    return { ok: true as const, contentPieceId: "piece-1" };
  });
  dismissBrief.mockImplementation(async () => {
    calls.push("dismiss");
    return { ok: true as const };
  });
});

describe("Accept from the brief editor", () => {
  it("saves the unsaved edits BEFORE accepting, so the draft is generated from them", async () => {
    renderWorkspace();
    editTitle("A title the human actually wrote");

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(acceptBrief).toHaveBeenCalled());
    // Order is the whole point. `acceptBrief` reads the STORED row, so a save
    // that lands after it is a save the generated draft never saw.
    expect(calls).toEqual(["save", "accept"]);
    expect(saveBriefBody).toHaveBeenCalledWith(
      expect.objectContaining({ briefId: "brief-1", title: "A title the human actually wrote" })
    );
  });

  it("does not accept at all when the save is refused", async () => {
    saveBriefBody.mockImplementation(async () => {
      calls.push("save");
      return { ok: false, error: "A brief needs a body." } as never;
    });
    renderWorkspace();
    editTitle("An edit the server will refuse");

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(saveBriefBody).toHaveBeenCalled());
    // Accepting anyway would generate the draft from the stored body and then
    // freeze the brief read-only, destroying the edit the save just rejected.
    expect(acceptBrief).not.toHaveBeenCalled();
    expect(calls).toEqual(["save"]);
    expect(push).not.toHaveBeenCalled();
  });

  it("accepts an untouched brief without a spurious save", async () => {
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(acceptBrief).toHaveBeenCalled());
    // `editedAt` answers "has a human touched this brief?" — merely accepting
    // one must not claim they had.
    expect(saveBriefBody).not.toHaveBeenCalled();
    expect(calls).toEqual(["accept"]);
  });
});

// Dismiss loses edits just as quietly: it refreshes the page into its
// read-only branch, which drops the editor and its state. Driven at the hook
// rather than through the DOM only because choosing a reason means operating
// the Select popup; the guard under test is the same one.
describe("Dismiss from the brief editor", () => {
  it("commits the unsaved edits before dismissing", async () => {
    const beforeDecide = vi.fn(async () => {
      calls.push("save");
      return true;
    });
    const { result } = renderHook(() => useBriefDecision("brief-1", { beforeDecide }));

    act(() => result.current.setReason("off_topic"));
    await act(async () => {
      await result.current.handleDismiss();
    });

    expect(calls).toEqual(["save", "dismiss"]);
  });

  it("does not dismiss when the save is refused", async () => {
    const beforeDecide = vi.fn(async () => false);
    const { result } = renderHook(() => useBriefDecision("brief-1", { beforeDecide }));

    act(() => result.current.setReason("off_topic"));
    await act(async () => {
      await result.current.handleDismiss();
    });

    expect(dismissBrief).not.toHaveBeenCalled();
  });
});

// The inbox card passes no `beforeDecide` — it has no editor — and must keep
// working exactly as it did.
describe("the inbox card's decisions are unaffected", () => {
  it("accepts with no commit step when no beforeDecide is supplied", async () => {
    const { result } = renderHook(() => useBriefDecision("brief-1"));

    await act(async () => {
      await result.current.handleAccept();
    });

    expect(calls).toEqual(["accept"]);
    expect(push).toHaveBeenCalledWith("/drafts/piece-1");
  });
});
