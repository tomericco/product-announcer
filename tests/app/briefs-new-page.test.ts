import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Signal } from "../../src/db/schema";

let currentTenantId = "";

// `vi.mock` calls are hoisted above these declarations, so the mock fns
// referenced inside the factories must themselves be hoisted alongside them.
const { listSignals, proposeBriefFromSignals } = vi.hoisted(() => ({
  listSignals: vi.fn(),
  proposeBriefFromSignals: vi.fn(),
}));

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

vi.mock("../../src/lib/signals/query", () => ({ listSignals }));

// `/briefs/new` no longer calls `proposeBriefFromSignals` — this mock exists
// purely so the assertions below can prove that, by asserting the spy was
// never invoked rather than assuming it from the absence of a call site.
vi.mock("../../src/lib/briefs/propose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/briefs/propose")>();
  return { ...actual, proposeBriefFromSignals };
});

import NewBriefPage from "../../src/app/(dashboard)/briefs/new/page";
import { MAX_PROPOSAL_SIGNALS } from "../../src/lib/briefs/propose";

afterEach(() => {
  vi.clearAllMocks();
});

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: crypto.randomUUID(),
    tenantId: currentTenantId,
    sourceId: null,
    kind: "market_news",
    externalId: crypto.randomUUID(),
    url: null,
    title: "A signal",
    excerpt: "An excerpt",
    occurredAt: new Date(),
    atomicUpdateId: null,
    competitorId: null,
    relevanceScore: 0.8,
    relevanceRationale: null,
    topics: [],
    status: "new",
    createdAt: new Date(),
    ...overrides,
  } as Signal;
}

// The page returns plain React elements without rendering — no
// testing-library involved. The editor itself is a `"use client"` component
// mounted inside an `EditorProvider`, so it is found by walking for the one
// element carrying an `evidence` prop rather than by position: this page's
// wrapper markup is presentation and must be free to change without
// rewriting these assertions.
function findEvidenceHolder(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEvidenceHolder(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props && Object.hasOwn(el.props, "evidence")) return el;
  return findEvidenceHolder(el.props?.children as ReactNode);
}

// Recursively flattens every string/number leaf so a notice's wording can be
// asserted on without hard-coding the exact element tree that produces it.
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return textOf(el.props?.children);
}

async function renderPage(query: Record<string, string> = {}) {
  const page = (await NewBriefPage({ searchParams: Promise.resolve(query) })) as ReactElement;
  const editor = findEvidenceHolder(page);
  if (!editor) throw new Error("the page rendered nothing that takes `evidence`");
  return { pageText: textOf(page), editorProps: editor.props };
}

describe("NewBriefPage", () => {
  it("resolves signals tenant-scoped and pre-selects them as evidence, with no model call", async () => {
    currentTenantId = crypto.randomUUID();
    const s1 = makeSignal({ title: "Signal one" });
    const s2 = makeSignal({ title: "Signal two" });
    listSignals.mockResolvedValue([s1, s2]);

    const { pageText, editorProps } = await renderPage({ signals: `${s1.id},${s2.id}` });

    expect(pageText).not.toContain("left out");
    // The proposal props are gone with the proposal branch — the editor is
    // unconditionally blank now, so passing them would be passing nothing.
    expect(editorProps).not.toHaveProperty("proposal");
    expect(editorProps).not.toHaveProperty("proposalError");
    // `CitedSignal`-shaped, so the editor can render the SAME `BriefEvidence`
    // row `/briefs/[briefId]` does rather than a second badge list.
    expect(editorProps.evidence).toEqual([
      { id: s1.id, title: "Signal one", url: null, kind: "market_news" },
      { id: s2.id, title: "Signal two", url: null, kind: "market_news" },
    ]);
    // The in-render proposal is gone and stays gone.
    expect(proposeBriefFromSignals).not.toHaveBeenCalled();
  });

  it("resolves nothing when no signals were requested", async () => {
    currentTenantId = crypto.randomUUID();

    const { pageText, editorProps } = await renderPage({});

    expect(pageText).not.toContain("left out");
    expect(editorProps).not.toHaveProperty("proposal");
    expect(editorProps).not.toHaveProperty("proposalError");
    expect(editorProps.evidence).toEqual([]);
    expect(listSignals).not.toHaveBeenCalled();
    expect(proposeBriefFromSignals).not.toHaveBeenCalled();
  });

  it("silently drops signal ids that don't resolve under this tenant (stale, expired, or another tenant's)", async () => {
    currentTenantId = crypto.randomUUID();
    // Three requested; only one survives `listSignals`' tenant/window/staleness
    // scoping — as if the other two went stale between selection and render,
    // or belonged to another tenant entirely.
    const kept = makeSignal({ title: "Still here" });
    const droppedIds = [crypto.randomUUID(), crypto.randomUUID()];
    listSignals.mockResolvedValue([kept]);

    const { pageText, editorProps } = await renderPage({
      signals: [...droppedIds, kept.id].join(","),
    });

    expect(pageText).not.toContain("left out");
    expect(editorProps.evidence).toEqual([
      { id: kept.id, title: "Still here", url: null, kind: "market_news" },
    ]);
    expect(proposeBriefFromSignals).not.toHaveBeenCalled();
  });

  it("caps attached evidence server-side, so a hand-edited URL past the selection cap can't attach more than the ceiling", async () => {
    currentTenantId = crypto.randomUUID();
    const extra = MAX_PROPOSAL_SIGNALS + 2;
    const resolved = Array.from({ length: extra }, (_, i) => makeSignal({ title: `Signal ${i}` }));
    listSignals.mockResolvedValue(resolved);

    const { pageText, editorProps } = await renderPage({
      signals: resolved.map((s) => s.id).join(","),
    });

    expect(pageText).toContain("left out");
    expect(pageText).toContain(String(MAX_PROPOSAL_SIGNALS));
    expect(editorProps.evidence).toHaveLength(MAX_PROPOSAL_SIGNALS);
    expect(proposeBriefFromSignals).not.toHaveBeenCalled();
  });
});
