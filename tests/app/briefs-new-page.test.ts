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
// testing-library involved. `children` is a fixed-length array here (the JSX
// below always has the same four syntactic children), so position is stable
// regardless of which conditionals are truthy.
function childrenOf(node: ReactNode): ReactNode[] {
  const el = node as ReactElement<{ children?: ReactNode }>;
  const children = el?.props?.children;
  return Array.isArray(children) ? children : [children];
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
  const [headerDiv, unavailableNotice, overCapNotice, briefForm] = childrenOf(page);
  return {
    headerText: textOf(headerDiv),
    unavailableNotice,
    overCapNotice,
    briefFormProps: (briefForm as ReactElement<Record<string, unknown>>).props,
  };
}

describe("NewBriefPage", () => {
  it("proposes a brief from resolved signals and passes it to the form", async () => {
    currentTenantId = crypto.randomUUID();
    const s1 = makeSignal({ title: "Signal one" });
    const s2 = makeSignal({ title: "Signal two" });
    listSignals.mockResolvedValue([s1, s2]);
    const brief = {
      contentType: "blog_post" as const,
      title: "A brief",
      angle: "An angle",
      whyNow: "Because",
      audience: null,
      keyPoints: ["One.", "Two.", "Three."],
      targetLength: 800,
      suggestedChannel: "blog",
      score: 0.8,
      scoreRationale: "Strong",
    };
    proposeBriefFromSignals.mockResolvedValue({ ok: true, brief });

    const { headerText, unavailableNotice, overCapNotice, briefFormProps } = await renderPage({
      signals: `${s1.id},${s2.id}`,
    });

    expect(headerText).toContain("Proposed from the signals you selected");
    expect(unavailableNotice).toBe(false);
    expect(overCapNotice).toBe(false);
    expect(briefFormProps.proposal).toEqual(brief);
    expect(briefFormProps.proposalError).toBeNull();
    expect(briefFormProps.evidence).toEqual([
      { id: s1.id, title: "Signal one", kind: "market_news" },
      { id: s2.id, title: "Signal two", kind: "market_news" },
    ]);
    expect(proposeBriefFromSignals).toHaveBeenCalledTimes(1);
  });

  it("degrades to a blank form with the error surfaced when the proposal fails", async () => {
    currentTenantId = crypto.randomUUID();
    const s1 = makeSignal({ title: "Signal one" });
    listSignals.mockResolvedValue([s1]);
    proposeBriefFromSignals.mockResolvedValue({ ok: false, error: "model overloaded" });

    const { briefFormProps } = await renderPage({ signals: s1.id });

    expect(briefFormProps.proposal).toBeNull();
    expect(briefFormProps.proposalError).toBe("model overloaded");
    // The human's selection is not the model's to revise — evidence is kept
    // even though the proposal itself failed.
    expect(briefFormProps.evidence).toEqual([{ id: s1.id, title: "Signal one", kind: "market_news" }]);
  });

  it("renders the write-it-by-hand state when no signals were requested", async () => {
    currentTenantId = crypto.randomUUID();

    const { headerText, unavailableNotice, overCapNotice, briefFormProps } = await renderPage({});

    expect(headerText).toContain("Write a brief by hand");
    expect(unavailableNotice).toBe(false);
    expect(overCapNotice).toBe(false);
    expect(briefFormProps.proposal).toBeNull();
    expect(briefFormProps.proposalError).toBeNull();
    expect(briefFormProps.evidence).toEqual([]);
    expect(listSignals).not.toHaveBeenCalled();
    expect(proposeBriefFromSignals).not.toHaveBeenCalled();
  });

  it("tells the user when some requested signals are no longer available, instead of silently dropping them", async () => {
    currentTenantId = crypto.randomUUID();
    // Three requested; only one survives `listSignals`' tenant/window/staleness
    // scoping — as if the other two went stale between selection and render.
    const kept = makeSignal({ title: "Still here" });
    const droppedIds = [crypto.randomUUID(), crypto.randomUUID()];
    listSignals.mockResolvedValue([kept]);
    proposeBriefFromSignals.mockResolvedValue({
      ok: true,
      brief: {
        contentType: "blog_post" as const,
        title: "T",
        angle: "A",
        whyNow: "W",
        audience: null,
        keyPoints: ["One.", "Two.", "Three."],
        targetLength: null,
        suggestedChannel: "blog",
        score: 0.6,
        scoreRationale: "R",
      },
    });

    const { unavailableNotice, overCapNotice, briefFormProps } = await renderPage({
      signals: [...droppedIds, kept.id].join(","),
    });

    expect(unavailableNotice).not.toBe(false);
    const noticeText = textOf(unavailableNotice);
    expect(noticeText).toContain("2 of 3");
    expect(noticeText).toContain("no longer available");
    expect(overCapNotice).toBe(false);
    // Deleting the drop-notice guard in page.tsx (rendering it unconditionally
    // as `false`, or dropping the comparison against `requestedIds.length`)
    // must make this assertion fail.
    expect(briefFormProps.evidence).toEqual([{ id: kept.id, title: "Still here", kind: "market_news" }]);
  });

  it("caps attached evidence server-side, so a hand-edited URL past the selection cap can't save more evidence than informed the prose", async () => {
    currentTenantId = crypto.randomUUID();
    const extra = MAX_PROPOSAL_SIGNALS + 2;
    const resolved = Array.from({ length: extra }, (_, i) => makeSignal({ title: `Signal ${i}` }));
    listSignals.mockResolvedValue(resolved);
    proposeBriefFromSignals.mockResolvedValue({
      ok: true,
      brief: {
        contentType: "blog_post" as const,
        title: "T",
        angle: "A",
        whyNow: "W",
        audience: null,
        keyPoints: ["One.", "Two.", "Three."],
        targetLength: null,
        suggestedChannel: "blog",
        score: 0.6,
        scoreRationale: "R",
      },
    });

    const { unavailableNotice, overCapNotice, briefFormProps } = await renderPage({
      signals: resolved.map((s) => s.id).join(","),
    });

    expect(unavailableNotice).toBe(false);
    expect(overCapNotice).not.toBe(false);
    expect(textOf(overCapNotice)).toContain(String(MAX_PROPOSAL_SIGNALS));
    expect(briefFormProps.evidence).toHaveLength(MAX_PROPOSAL_SIGNALS);
    const proposeArgs = proposeBriefFromSignals.mock.calls[0][0];
    expect(proposeArgs.signals).toHaveLength(MAX_PROPOSAL_SIGNALS);
  });
});
