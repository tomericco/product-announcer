import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, signals } from "../../src/db/schema";

const TENANT = "Signals Actions Test Tenant";
let currentTenantId = "";

// requireSession() returns a NextAuth Session — tenantId lives under `user`,
// per src/types/next-auth.d.ts. Mirror that shape, matching the pattern in
// tests/app/briefs-actions.test.ts and tests/app/change-events-actions.test.ts.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { addSignal, deleteSignals } from "../../src/app/(dashboard)/signals/actions";
import { revalidatePath } from "next/cache";

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

describe("addSignal", () => {
  it("writes a manual signal under the session's tenant and revalidates /signals", async () => {
    const tenant = await seedTenant();

    const result = await addSignal({ title: "A competitor webinar", url: "https://example.com/webinar" });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("manual");
    expect(rows[0].title).toBe("A competitor webinar");
    expect(revalidatePath).toHaveBeenCalledWith("/signals");
  });

  it("reports a duplicate url as a readable message, not a crash, and does not revalidate", async () => {
    await seedTenant();
    await addSignal({ title: "First", url: "https://example.com/a" });
    vi.mocked(revalidatePath).mockClear();

    const second = await addSignal({ title: "Second", url: "https://example.com/a/" });

    expect(second).toEqual({ ok: false, error: "You already have a signal for this link." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a blank title and does not revalidate", async () => {
    await seedTenant();

    const result = await addSignal({ title: "   " });

    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("scopes the write to the calling tenant only", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();

    await addSignal({ title: "Mine" });

    const theirs = await db.select().from(signals).where(eq(signals.tenantId, other.id));
    expect(theirs).toHaveLength(0);
    const rows = await db.select().from(signals).where(eq(signals.tenantId, mine.id));
    expect(rows).toHaveLength(1);
  });
});

describe("deleteSignals", () => {
  it("deletes the given signals under the session's tenant and revalidates /signals", async () => {
    const tenant = await seedTenant();
    const added = await addSignal({ title: "To delete", url: "https://example.com/x" });
    vi.mocked(revalidatePath).mockClear();
    if (!added.ok) throw new Error("setup failed");

    const result = await deleteSignals([added.id]);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(await db.select().from(signals).where(eq(signals.tenantId, tenant.id))).toHaveLength(0);
    expect(revalidatePath).toHaveBeenCalledWith("/signals");
  });

  it("does not delete another tenant's signal, and does not revalidate on a no-op", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const otherTenantId = other.id;
    currentTenantId = otherTenantId;
    const theirs = await addSignal({ title: "Theirs" });
    if (!theirs.ok) throw new Error("setup failed");

    currentTenantId = mine.id;
    vi.mocked(revalidatePath).mockClear();
    const result = await deleteSignals([theirs.id]);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(await db.select().from(signals).where(eq(signals.tenantId, otherTenantId))).toHaveLength(1);
  });

  it("refuses an empty selection and does not revalidate", async () => {
    await seedTenant();
    vi.mocked(revalidatePath).mockClear();

    const result = await deleteSignals([]);

    expect(result).toEqual({ ok: false, error: "No signals selected." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
