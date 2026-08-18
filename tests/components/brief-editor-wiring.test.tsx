import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The three bugs on this branch that reached review all lived in untested
// effect wiring, and the repo now has jsdom + @testing-library/react — so the
// brief editor's dirty-state and save wiring is exercised by actually running
// the hook, not by re-deriving it from extracted pure functions.
//
// Two modules are mocked, both because they are unreachable in jsdom rather
// than to dodge the assertion:
//
//   - `unsaved-changes` renders a Dialog and calls next/navigation's
//     `useRouter`, which throws outside a mounted App Router. Mocking it also
//     turns "did the editor report itself dirty to the page-level guard?" into
//     something directly assertable.
//   - `actions` is a "use server" module that imports `@/db`; the jsdom
//     project has no DATABASE_URL, and a real save is not what is under test
//     here (tests/app/briefs-save-body.test.ts covers the server side).
//
// The spies are created through `vi.hoisted` because `vi.mock` factories are
// hoisted above every top-level statement in this file — a plain `const` would
// still be in its temporal dead zone when the factory runs.
const { setSectionDirty, notifySaved, saveBriefBody, toastError, toastSuccess } = vi.hoisted(() => ({
  setSectionDirty: vi.fn(),
  notifySaved: vi.fn(),
  saveBriefBody: vi.fn(async (_args: { briefId: string; body: string; title?: string }) => ({
    ok: true as const,
  })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../src/app/(dashboard)/unsaved-changes", () => ({
  useUnsavedChanges: () => ({
    isDirty: false,
    setSectionDirty,
    cleanToken: 0,
    notifySaved,
    requestLeave: () => {},
  }),
}));

vi.mock("../../src/app/(dashboard)/briefs/[briefId]/actions", () => ({
  saveBriefBody: (args: { briefId: string; body: string; title?: string }) => saveBriefBody(args),
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { useBriefEditor } from "../../src/app/(dashboard)/briefs/[briefId]/use-brief-editor";

const INITIAL_TITLE = "How localization breaks design systems";
const INITIAL_BODY = "## Angle\nMost teams discover it too late";

function setup() {
  return renderHook(() =>
    useBriefEditor({ briefId: "brief-1", initialTitle: INITIAL_TITLE, initialBody: INITIAL_BODY })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  saveBriefBody.mockResolvedValue({ ok: true as const });
});

describe("useBriefEditor dirty state", () => {
  it("starts clean, so Save is not offered on a brief nobody has touched", () => {
    const { result } = setup();
    expect(result.current.dirty).toBe(false);
  });

  it("goes dirty on a body edit and reports it to the page-level guard", () => {
    const { result } = setup();

    act(() => result.current.setBody("## Angle\nEdited", false));

    expect(result.current.dirty).toBe(true);
    expect(setSectionDirty).toHaveBeenCalledWith("brief-body", true);
  });

  it("goes dirty on a title edit and reports it under its own key", () => {
    const { result } = setup();

    act(() => result.current.setTitle("A new title"));

    expect(result.current.dirty).toBe(true);
    expect(setSectionDirty).toHaveBeenCalledWith("brief-title", true);
  });

  it("goes clean again when an edit is reverted", () => {
    const { result } = setup();

    act(() => result.current.setTitle("A new title"));
    act(() => result.current.setTitle(INITIAL_TITLE));

    expect(result.current.dirty).toBe(false);
    expect(setSectionDirty).toHaveBeenLastCalledWith("brief-title", false);
  });

  // The exact bug the drafts editor's comment warns about: on mount MDXEditor
  // rewrites the stored markdown into its own dialect and fires onChange. That
  // is the resting state, not an edit — treating it as one leaves EVERY brief
  // permanently dirty the moment it loads.
  it("treats the editor's initial normalize as the resting state, not an edit", () => {
    const { result } = setup();

    act(() => result.current.setBody("## Angle\n\nMost teams discover it too late", true));

    expect(result.current.dirty).toBe(false);
    expect(setSectionDirty).toHaveBeenCalledWith("brief-body", false);
  });

  it("re-baselines on normalize, so reverting to the RAW stored text is a real edit", () => {
    const { result } = setup();

    act(() => result.current.setBody("## Angle\n\nMost teams discover it too late", true));
    act(() => result.current.setBody(INITIAL_BODY, false));

    expect(result.current.dirty).toBe(true);
  });

  it("clears both section flags on unmount, so no stale warning is left armed", () => {
    const { result, unmount } = setup();

    act(() => result.current.setBody("## Angle\nEdited", false));
    setSectionDirty.mockClear();

    unmount();

    expect(setSectionDirty).toHaveBeenCalledWith("brief-title", false);
    expect(setSectionDirty).toHaveBeenCalledWith("brief-body", false);
  });
});

describe("useBriefEditor save wiring", () => {
  it("sends the current title and body under the brief's own id", async () => {
    const { result } = setup();

    act(() => result.current.setTitle("A new title"));
    act(() => result.current.setBody("## Angle\nEdited", false));
    await act(async () => {
      await result.current.save();
    });

    expect(saveBriefBody).toHaveBeenCalledWith({
      briefId: "brief-1",
      title: "A new title",
      body: "## Angle\nEdited",
    });
  });

  it("goes clean on success and tells the page-level guard the edits were committed", async () => {
    const { result } = setup();

    act(() => result.current.setBody("## Angle\nEdited", false));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.dirty).toBe(false);
    expect(notifySaved).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
  });

  // Without re-baselining, undoing an edit AFTER saving it would look clean
  // while the text on screen differs from what the server holds — the leave
  // guard would then let the user walk away from a real unsaved change.
  it("re-baselines to what was saved, so a later revert to the loaded text is dirty", async () => {
    const { result } = setup();

    act(() => result.current.setBody("## Angle\nEdited", false));
    await act(async () => {
      await result.current.save();
    });
    act(() => result.current.setBody(INITIAL_BODY, false));

    expect(result.current.dirty).toBe(true);
  });

  it("surfaces a refusal and keeps the edits dirty rather than pretending they landed", async () => {
    saveBriefBody.mockResolvedValue({ ok: false, error: "A brief needs a body." } as never);
    const { result } = setup();

    act(() => result.current.setBody("   ", false));
    await act(async () => {
      await result.current.save();
    });

    expect(toastError).toHaveBeenCalledWith("A brief needs a body.");
    expect(notifySaved).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);
  });

  it("keeps keystrokes typed during the round trip dirty", async () => {
    let release: (value: { ok: true }) => void = () => {};
    saveBriefBody.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }) as never
    );
    const { result } = setup();

    act(() => result.current.setBody("## Angle\nFirst", false));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.save();
    });
    // Typed after the request went out — this is NOT part of what was saved.
    act(() => result.current.setBody("## Angle\nFirst, then more", false));
    await act(async () => {
      release({ ok: true });
      await pending;
    });

    expect(result.current.dirty).toBe(true);
  });
});
