import { describe, it, expect } from "vitest";
import {
  loadStateFromResult,
  shouldFetchOnOpen,
  shouldApplyResponse,
  draftsFromEvidence,
  classifyEventMutationResult,
  eventMutationSuccessMessage,
  evidenceAfterHide,
  type EvidenceLoadState,
} from "../../src/app/(dashboard)/signals/evidence-drawer";
import type { SignalEvidence } from "../../src/lib/signals/evidence";
import type { ReassignResult } from "../../src/lib/change-events/reassign";

// No jsdom/testing-library in this project (vitest.config.ts runs the
// "node" environment) — component rendering is verified indirectly, by
// exercising the same pure derivation functions the drawer renders from and
// gates its fetch on, the way tests/components/generation-checklist.test.tsx
// does for the draft checklist's poll loop.

function fakeEvidence(overrides: Partial<SignalEvidence> = {}): SignalEvidence {
  return {
    atomicUpdateId: "au-1",
    title: "Faster CSV export",
    summary: "Export now streams instead of buffering the whole file.",
    category: "improvement",
    size: "m",
    hidden: false,
    editable: true,
    events: [
      {
        id: "ev-1",
        type: "pull_request",
        provider: "github",
        label: "Stream CSV export",
        externalUrl: "https://github.com/acme/repo/pull/42",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("loadStateFromResult", () => {
  it("renders the no-evidence state for a null result, not a throw", () => {
    expect(() => loadStateFromResult(null)).not.toThrow();
    expect(loadStateFromResult(null)).toEqual<EvidenceLoadState>({ status: "empty" });
  });

  it("carries the evidence through for a non-null result", () => {
    const evidence = fakeEvidence();
    expect(loadStateFromResult(evidence)).toEqual<EvidenceLoadState>({ status: "loaded", evidence });
  });
});

describe("shouldFetchOnOpen", () => {
  it("is closed initially, and a closed dialog never fetches regardless of state", () => {
    expect(shouldFetchOnOpen(false, { status: "idle" })).toBe(false);
    expect(shouldFetchOnOpen(false, { status: "loading" })).toBe(false);
    expect(shouldFetchOnOpen(false, { status: "loaded", evidence: fakeEvidence() })).toBe(false);
  });

  it("opening from idle calls the load action — fetches exactly once for that open", () => {
    expect(shouldFetchOnOpen(true, { status: "idle" })).toBe(true);
  });

  it("does not refetch once a load is already in flight or has landed", () => {
    // Guards against a re-render while `open` stays true from double-firing
    // the request — the drawer only ever holds one signal's evidence in
    // flight at a time.
    expect(shouldFetchOnOpen(true, { status: "loading" })).toBe(false);
    expect(shouldFetchOnOpen(true, { status: "loaded", evidence: fakeEvidence() })).toBe(false);
    expect(shouldFetchOnOpen(true, { status: "empty" })).toBe(false);
  });
});

describe("shouldApplyResponse", () => {
  // The request-generation guard (Important finding 1 from review): every
  // async path captures a token before firing, and closing the drawer (or a
  // newer request starting) bumps the ref. A response is only safe to apply
  // if its captured token still matches what's current.
  it("applies a response whose token still matches the current one", () => {
    expect(shouldApplyResponse(1, 1)).toBe(true);
  });

  it("discards a response whose token has fallen behind — the request was superseded or the drawer closed", () => {
    // Captured before a close (or a newer request) bumped the ref.
    expect(shouldApplyResponse(1, 2)).toBe(false);
    // Same shape, a few generations later — not an off-by-one special case.
    expect(shouldApplyResponse(3, 7)).toBe(false);
  });
});

describe("draftsFromEvidence", () => {
  it("seeds every editable draft field straight from the loaded evidence", () => {
    const evidence = fakeEvidence({ title: "Bulk export", summary: "Now supports 10k rows.", size: "l", category: "new" });
    expect(draftsFromEvidence(evidence)).toEqual({
      title: "Bulk export",
      summary: "Now supports 10k rows.",
      size: "l",
      category: "new",
    });
  });

  it("carries a null size/category through rather than defaulting them", () => {
    const evidence = fakeEvidence({ size: null, category: null });
    const drafts = draftsFromEvidence(evidence);
    expect(drafts.size).toBeNull();
    expect(drafts.category).toBeNull();
  });
});

describe("classifyEventMutationResult", () => {
  // The three-way fork both per-event controls act on — remove AND reassign,
  // which share this path because either way the event leaves this atomic
  // update: success, needs-confirmation (the mutation would empty its atomic
  // update), and an outright rejection (e.g. the event no longer belongs to
  // this atomic update, or its source is already released).
  it("classifies a success as applied", () => {
    const result: ReassignResult = { ok: true };
    expect(classifyEventMutationResult(result, "ev-1")).toEqual({ kind: "applied" });
  });

  it("classifies a success that also deleted the emptied source atomic update as applied", () => {
    // `deletedAtomicUpdate` is present but irrelevant to this fork — the
    // caller only branches on ok/needsConfirmation, not on this extra field.
    const result: ReassignResult = { ok: true, deletedAtomicUpdate: { id: "au-2", title: "Old thing" } };
    expect(classifyEventMutationResult(result, "ev-1")).toEqual({ kind: "applied" });
  });

  it("classifies a needs-confirmation result, folding in the eventId that triggered it", () => {
    // `ReassignResult`'s own needsConfirmation branch never carries the
    // eventId — only the atomic update it would empty — so the caller must
    // supply it, and this is what proves it lands in the right outcome.
    const result: ReassignResult = {
      ok: false,
      reason: "needs_confirmation",
      needsConfirmation: true,
      emptiedAtomicUpdate: { id: "au-1", title: "Faster CSV export", inDraft: false },
    };
    expect(classifyEventMutationResult(result, "ev-1")).toEqual({
      kind: "needs_confirmation",
      eventId: "ev-1",
      emptiedAtomicUpdate: { id: "au-1", title: "Faster CSV export", inDraft: false },
    });
  });

  it("classifies an outright rejection with its reason, not as a needs-confirmation", () => {
    const result: ReassignResult = { ok: false, reason: "Change event does not belong to this atomic update." };
    expect(classifyEventMutationResult(result, "ev-1")).toEqual({
      kind: "rejected",
      reason: "Change event does not belong to this atomic update.",
    });
  });
});

describe("eventMutationSuccessMessage", () => {
  // Reassign was missing from the drawer entirely (design line 68 asks for
  // per-event reassign AND remove), so moving an event between two atomic
  // updates meant remove → /company → "Show hidden" → reassign — and the
  // remove leg fires forceRegenerate on the source update on the way past.
  // The two mutations now share one code path, so the wording is the only
  // thing that distinguishes them to the user.
  it("distinguishes a remove from a move and from a split", () => {
    expect(eventMutationSuccessMessage({ kind: "remove" })).toBe("Change event removed");
    expect(
      eventMutationSuccessMessage({ kind: "reassign", target: { kind: "existing", atomicUpdateId: "au-2" } })
    ).toBe("Change event reassigned");
    expect(eventMutationSuccessMessage({ kind: "reassign", target: { kind: "new" } })).toBe(
      "Split into a new atomic update"
    );
  });
});

describe("evidenceAfterHide", () => {
  // The regression this exists for: the drawer's read-only gates were moved
  // from `hidden` to `!editable`, but hide() went on setting only
  // `hidden: true`. A just-hidden update therefore kept enabled inputs and a
  // Hide/Save footer — and both then FAILED, because every curation write is
  // guarded on `status='open'`. The fixture above only ever had
  // `hidden: false, editable: true`, so nothing caught it.
  it("flips editable off together with hidden — they cannot move apart", () => {
    const after = evidenceAfterHide(fakeEvidence({ hidden: false, editable: true }));
    expect(after.hidden).toBe(true);
    expect(after.editable).toBe(false);
  });

  it("leaves everything else about the evidence alone", () => {
    const before = fakeEvidence({ title: "Bulk export", size: "l", category: "new" });
    const after = evidenceAfterHide(before);
    expect(after.atomicUpdateId).toBe(before.atomicUpdateId);
    expect(after.title).toBe("Bulk export");
    expect(after.size).toBe("l");
    expect(after.category).toBe("new");
    expect(after.events).toEqual(before.events);
    // A new object, not a mutation of the state React is still holding.
    expect(before.hidden).toBe(false);
    expect(before.editable).toBe(true);
  });

  // What the component reads off the post-hide state, spelled out: this is
  // the footer's badge branch and every input's `disabled` prop.
  it("puts the drawer in exactly the read-only state a freshly loaded hidden update would", () => {
    const hiddenFromServer = fakeEvidence({ hidden: true, editable: false });
    const hiddenLocally = evidenceAfterHide(fakeEvidence());
    expect(hiddenLocally.hidden).toBe(hiddenFromServer.hidden);
    expect(hiddenLocally.editable).toBe(hiddenFromServer.editable);
  });
});
