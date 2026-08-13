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

    // A bare null check: this covers the ordinary case where the signal AND
    // its atomic update both belong to the other tenant, but it does not pin
    // either individual guard — either guard alone already stops this case.
    // See the two tests below for fixtures that isolate one guard at a time.
    expect(await readSignalEvidence(stranger.id, signal.id)).toBeNull();
  });

  it("refuses a signal owned by another tenant even when it points at this tenant's own atomic update", async () => {
    const tenantA = await seedTenant(TENANT);
    const tenantB = await seedTenant(OTHER_TENANT);
    const [atomicOwnedByA] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenantA.id, title: "A's update", summary: "S" })
      .returning();
    // Nothing at the DB level enforces that a signal's atomicUpdateId points
    // at an atomic update owned by the same tenant, so this cross-wiring is
    // constructible: a signal owned by B, wired to A's atomic update.
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenantB.id,
        kind: "shipped_work",
        externalId: atomicOwnedByA.id,
        title: "A's update",
        occurredAt: new Date(),
        atomicUpdateId: atomicOwnedByA.id,
      })
      .returning();

    // Queried as tenant A: the atomic update genuinely is A's, so the
    // atomic-update guard alone would let this through. Only the signal
    // lookup's own tenant guard keeps this null.
    expect(await readSignalEvidence(tenantA.id, signal.id)).toBeNull();
  });

  it("refuses a signal whose atomic update belongs to another tenant, even though the signal is this tenant's own", async () => {
    const tenantA = await seedTenant(TENANT);
    const tenantB = await seedTenant(OTHER_TENANT);
    const [atomicOwnedByB] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenantB.id, title: "B's update", summary: "S" })
      .returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenantA.id,
        kind: "shipped_work",
        externalId: atomicOwnedByB.id,
        title: "B's update",
        occurredAt: new Date(),
        atomicUpdateId: atomicOwnedByB.id,
      })
      .returning();

    // Queried as tenant A: the signal lookup alone would pass (it's A's own
    // signal), so only the atomic-update guard stops B's data from leaking to
    // A — the serious direction, since this is the query that actually
    // returns the sensitive fields.
    expect(await readSignalEvidence(tenantA.id, signal.id)).toBeNull();
  });

  it("excludes a change event belonging to another tenant, even if it shares the atomicUpdateId", async () => {
    const tenantA = await seedTenant(TENANT);
    const tenantB = await seedTenant(OTHER_TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenantA.id, title: "SAML SSO", summary: "S" })
      .returning();
    await db.insert(changeEvents).values({
      tenantId: tenantA.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-own",
      prTitle: "Own event",
      atomicUpdateId: atomic.id,
    });
    // Cross-tenant event sharing the same atomicUpdateId — again, nothing at
    // the DB level prevents this from being seeded.
    await db.insert(changeEvents).values({
      tenantId: tenantB.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-cross-tenant",
      prTitle: "Should not appear",
      atomicUpdateId: atomic.id,
    });
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenantA.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "SAML SSO",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    const evidence = await readSignalEvidence(tenantA.id, signal.id);
    expect(evidence!.events).toHaveLength(1);
    expect(evidence!.events[0].label).toBe("Own event");
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
    expect(evidence!.editable).toBe(false);
  });

  // The drawer opens on rows `listAtomicUpdates` deliberately excludes:
  // `syncShippedWorkSignals` leaves the signal in place once its atomic
  // update is released, and this read applies no status filter. Every
  // curation mutation behind the drawer is guarded on `status='open'`, so the
  // drawer needs to know which of those rows it may offer a Save on — without
  // this flag, editing a released update rewrote the title while the
  // size/category half of the same Save came back `{ok:false}` and toasted a
  // failure.
  it("marks an open atomic update editable and a released one not", async () => {
    const tenant = await seedTenant(TENANT);
    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open one", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released one", summary: "S", status: "released" })
      .returning();
    const inserted = await db
      .insert(signals)
      .values([
        {
          tenantId: tenant.id,
          kind: "shipped_work" as const,
          externalId: open.id,
          title: "Open one",
          occurredAt: new Date(),
          atomicUpdateId: open.id,
        },
        {
          tenantId: tenant.id,
          kind: "shipped_work" as const,
          externalId: released.id,
          title: "Released one",
          occurredAt: new Date(),
          atomicUpdateId: released.id,
        },
      ])
      .returning();

    const openEvidence = await readSignalEvidence(tenant.id, inserted[0].id);
    const releasedEvidence = await readSignalEvidence(tenant.id, inserted[1].id);

    expect(openEvidence!.editable).toBe(true);
    expect(releasedEvidence!.editable).toBe(false);
    // Not the same thing as hidden — a released update is reachable and
    // readable, just frozen.
    expect(releasedEvidence!.hidden).toBe(false);
  });
});
