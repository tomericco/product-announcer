import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, changeEvents, signals } from "../../../src/db/schema";
import { readSignalEvidence } from "../../../src/lib/signals/evidence";

const TENANT = "Signal Evidence Test Tenant";
const OTHER_TENANT = "Signal Evidence Other Tenant";

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

describe("readSignalEvidence", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
  });

  it("returns the atomic update and its change events", async () => {
    const tenant = await seedTenant(TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "SAML SSO", summary: "Teams can log in with SAML." })
      .returning();
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-1",
      prTitle: "Add SAML handshake",
      externalUrl: "https://example.test/pr/1",
      atomicUpdateId: atomic.id,
    });
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "SAML SSO",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    const evidence = await readSignalEvidence(tenant.id, signal.id);

    expect(evidence).not.toBeNull();
    expect(evidence!.atomicUpdateId).toBe(atomic.id);
    expect(evidence!.title).toBe("SAML SSO");
    expect(evidence!.summary).toBe("Teams can log in with SAML.");
    expect(evidence!.hidden).toBe(false);
    expect(evidence!.events).toHaveLength(1);
    expect(evidence!.events[0].label).toBe("Add SAML handshake");
    expect(evidence!.events[0].externalUrl).toBe("https://example.test/pr/1");
  });

  it("returns null for a signal with no atomic update", async () => {
    const tenant = await seedTenant(TENANT);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://example.test/article",
        title: "Industry piece",
        occurredAt: new Date(),
      })
      .returning();

    expect(await readSignalEvidence(tenant.id, signal.id)).toBeNull();
  });

  it("refuses a signal belonging to another tenant", async () => {
    const owner = await seedTenant(TENANT);
    const stranger = await seedTenant(OTHER_TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: owner.id, title: "Private", summary: "Not yours." })
      .returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: owner.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "Private",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    // Asserted by id, not by an empty result: a query that forgot the tenant
    // filter would still return this row.
    expect(await readSignalEvidence(stranger.id, signal.id)).toBeNull();
  });

  it("returns a hidden atomic update with hidden set", async () => {
    const tenant = await seedTenant(TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden one", summary: "S", status: "hidden" })
      .returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "Hidden one",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    const evidence = await readSignalEvidence(tenant.id, signal.id);
    expect(evidence!.hidden).toBe(true);
  });
});
