import { describe, it, expect } from "vitest";
import {
  loadStateFromResult,
  shouldFetchOnOpen,
  type EvidenceLoadState,
} from "../../src/app/(dashboard)/signals/evidence-drawer";
import type { SignalEvidence } from "../../src/lib/signals/evidence";

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
