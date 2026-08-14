import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";

const TENANT = "Propose Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// This wrapper is deliberately thin — the tenant-scoped resolution and the
// model call live in `proposeBriefForSelection` (`src/lib/briefs/propose-selection.ts`,
// tested directly in `tests/lib/briefs/propose-selection.test.ts`, including
// the tenant-by-id refusal). Mocking that seam here means these tests never
// touch the model at all, and stay focused on what this file actually does:
// resolve the session's tenant, and glue the proposal to `createManualBrief`.
vi.mock("../../src/lib/briefs/propose-selection", () => ({
  proposeBriefForSelection: vi.fn(),
}));

import { proposeAndCreateBrief } from "../../src/app/(dashboard)/signals/propose-actions";
import { proposeBriefForSelection } from "../../src/lib/briefs/propose-selection";
import { createManualBrief } from "../../src/app/(dashboard)/briefs/new/actions";
import { expireStaleBriefs } from "../../src/lib/briefs/sweep";
import { BRIEF_TTL_DAYS } from "../../src/lib/briefs/run";

afterEach(async () => {
  vi.useRealTimers();
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.clearAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedSignal(tenantId: string, title = "Evidence") {
  const [row] = await db
    .insert(signals)
    .values({ tenantId, kind: "manual", externalId: crypto.randomUUID(), title, occurredAt: new Date() })
    .returning();
  return row;
}

const GOOD_INPUT = {
  contentType: "blog_post" as const,
  title: "A proposed title",
  angle: "A sharp angle",
  whyNow: "Because of the signal",
  keyPoints: ["One.", "Two.", "Three."],
  suggestedChannel: "blog",
  targetLength: 700,
  audience: null,
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("proposeAndCreateBrief", () => {
  it("creates exactly one brief, linked to the resolved signals, with a non-blank body", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [signal.id] },
    });

    const result = await proposeAndCreateBrief([signal.id]);

    expect(proposeBriefForSelection).toHaveBeenCalledWith(tenant.id, [signal.id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.briefId);
    expect(rows[0].title).toBe("A proposed title");
    expect(rows[0].body).not.toBeNull();
    expect(rows[0].body?.trim().length).toBeGreaterThan(0);

    const links = await db.select().from(briefSignals).where(eq(briefSignals.briefId, result.briefId));
    expect(links.map((l) => l.signalId)).toEqual([signal.id]);
  });

  // The counts the modal reports. `listSignals` silently drops stale signals
  // and anything past its 60-day window, so what the human selected and what
  // the brief was built from are different numbers, and only this layer sees
  // both.
  it("reports what the brief was actually built from, not what was requested", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const kept = await seedSignal(tenant.id, "Survived");

    // Three ids in; the resolution kept one — as if the other two had gone
    // stale or aged out between selection and the click.
    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [kept.id] },
    });

    const result = await proposeAndCreateBrief([kept.id, crypto.randomUUID(), crypto.randomUUID()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedSignalCount).toBe(1);
    expect(result.droppedSignalCount).toBe(2);
  });

  it("counts a duplicated id once, so a repeat can't report itself as dropped", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [signal.id] },
    });

    const result = await proposeAndCreateBrief([signal.id, signal.id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedSignalCount).toBe(1);
    expect(result.droppedSignalCount).toBe(0);
  });

  it("returns a reason and creates no brief when the proposal fails, without calling createManualBrief", async () => {
    const tenant = await seedTenant();
    currentUserId = null;

    const before = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(before).toHaveLength(0);

    vi.mocked(proposeBriefForSelection).mockResolvedValue({ ok: false, error: "model timeout" });

    const result = await proposeAndCreateBrief(["whatever-id"]);

    expect(result).toEqual({ ok: false, error: "model timeout" });

    const after = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(after).toHaveLength(0);
  });
});

/**
 * The modal writes the brief BEFORE any human has read a word of it, so it is
 * a candidate awaiting a decision — not a decision. Left never-expiring (the
 * hand-written default), three exploratory clicks would leave three permanent
 * `status = "new"` rows pinned to the top of the inbox forever, since
 * `expireStaleBriefs` filters on `isNotNull(briefs.expiresAt)`.
 *
 * Only `Date` is faked: `toFake` defaults to every timer, and replacing
 * `setTimeout` under a live `pg` connection is how these tests would hang.
 */
describe("a brief the modal created", () => {
  it("carries the same TTL an agent-proposed brief does", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);
    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [signal.id] },
    });

    const before = Date.now();
    const result = await proposeAndCreateBrief([signal.id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.expiresAt).not.toBeNull();
    const ttlMs = brief.expiresAt!.getTime() - before;
    // Asserted against the shared constant, not a copy of the number: the
    // whole point is that the two paths cannot drift apart.
    expect(ttlMs).toBeGreaterThan((BRIEF_TTL_DAYS - 1) * 86_400_000);
    expect(ttlMs).toBeLessThanOrEqual((BRIEF_TTL_DAYS + 1) * 86_400_000);
  });

  it("is swept by expireStaleBriefs, while a hand-written one is not", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);
    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [signal.id] },
    });

    const fromModal = await proposeAndCreateBrief([signal.id]);
    expect(fromModal.ok).toBe(true);
    if (!fromModal.ok) return;

    // The same writer, reached the way `BriefForm` reaches it: no expiry.
    const byHand = await createManualBrief({ ...GOOD_INPUT, signalIds: [signal.id] });
    expect(byHand.ok).toBe(true);
    if (!byHand.ok) return;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + (BRIEF_TTL_DAYS + 1) * 86_400_000));

    await expireStaleBriefs({ database: db });

    const [swept] = await db.select().from(briefs).where(eq(briefs.id, fromModal.briefId));
    const [survivor] = await db.select().from(briefs).where(eq(briefs.id, byHand.briefId));
    expect(swept.status).toBe("expired");
    expect(survivor.status).toBe("new");
  });
});
