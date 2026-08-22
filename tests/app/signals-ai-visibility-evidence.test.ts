import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { competitors, companyProfiles, signals } from "../../src/db/schema";
import type { AiVisibilityPayload } from "../../src/lib/ai-visibility/types";
import { seedTenant, dropTenant } from "../helpers/fixtures";

/**
 * `loadAiVisibilityEvidence` — the read behind the Evidence dialog on
 * /signals. It is the only place in Phase I where a browser-supplied id
 * reaches a query, so the scoping is the point of most of this file: the id is
 * untrusted, and the tenant, the kind and the 60-day window all have to be in
 * the WHERE clause rather than in a caller's guard.
 */
const TENANT = "AI Visibility Evidence Action Test Tenant";
const OTHER_TENANT = "AI Visibility Evidence Action Test Tenant (Other)";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

import { loadAiVisibilityEvidence } from "../../src/app/(dashboard)/signals/ai-visibility-actions";

const PAYLOAD: AiVisibilityPayload = {
  signalType: "gap_vs_competitor",
  promptId: "11111111-1111-4111-8111-111111111111",
  promptText: "best localization tools for design teams",
  engine: "openai",
  engineLabel: "GPT-5.x API + web search",
  modelId: "gpt-5.2-2026-07-01",
  runId: "22222222-2222-4222-8222-222222222222",
  runDate: "2026-08-17T00:00:00.000Z",
  samples: "0 of 3, two runs",
  excerpt: "For design teams, Lokalise and Phrase are the usual choices.",
  citedUrls: [
    { url: "https://g2.com/categories/localization", domain: "g2.com", domainClass: "review" },
    { url: "https://lokalise.com/blog/x", domain: "lokalise.com", domainClass: "competitor" },
  ],
};

let counter = 0;

async function seedSignal(
  tenantId: string,
  overrides: Partial<typeof signals.$inferInsert> = {}
) {
  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "ai_visibility",
      // Unique per row: `externalId` is the idempotency key, and two rows in
      // one test would otherwise be indistinguishable.
      externalId: `ai-visibility-evidence-${counter++}`,
      title: "Absent from 'best localization tools' on ChatGPT",
      occurredAt: new Date("2026-08-17T00:00:00.000Z"),
      payload: PAYLOAD,
      ...overrides,
    })
    .returning();
  return signal;
}

beforeEach(() => {
  counter = 0;
});

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
});

describe("loadAiVisibilityEvidence", () => {
  it("returns the whole methodology line off the signal's own payload", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id);

    const view = await loadAiVisibilityEvidence(signal.id);

    expect(view).not.toBeNull();
    expect(view!.promptId).toBe(PAYLOAD.promptId);
    expect(view!.promptText).toBe("best localization tools for design teams");
    expect(view!.engineLabel).toBe("GPT-5.x API + web search");
    expect(view!.modelId).toBe("gpt-5.2-2026-07-01");
    // Pinned locale + UTC, so the dialog reads the same on every machine.
    expect(view!.runDateLabel).toBe("Aug 17, 2026");
    expect(view!.samples).toBe("0 of 3, two runs");
    expect(view!.excerpt).toBe("For design teams, Lokalise and Phrase are the usual choices.");
    expect(view!.citedUrls.map((citation) => citation.domain)).toEqual(["g2.com", "lokalise.com"]);
  });

  it("returns null for another tenant's signal id, undistinguished from one that does not exist", async () => {
    // The id comes from the browser. Without the tenant in the WHERE clause
    // this hands one workspace the excerpt, the model id and the cited pages
    // of another's measurement.
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    const theirs = await seedSignal(other.id);
    currentTenantId = tenant.id;

    expect(await loadAiVisibilityEvidence(theirs.id)).toBeNull();
    expect(await loadAiVisibilityEvidence("33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("returns null for an id that is not a uuid, instead of throwing Postgres 22P02", async () => {
    // The argument is client input whatever TypeScript says, and it goes
    // straight into a comparison against a `uuid` column: without the guard the
    // dialog gets an exception where every other miss gets the empty state.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await loadAiVisibilityEvidence("not-a-uuid")).toBeNull();
    expect(await loadAiVisibilityEvidence("")).toBeNull();
    expect(await loadAiVisibilityEvidence("1; drop table signals")).toBeNull();
    expect(await loadAiVisibilityEvidence(undefined as unknown as string)).toBeNull();
  });

  it("returns null for a signal that has aged out of the browser's 60-day window", async () => {
    // Deliberate, not a bug to widen the read for: a signal old enough to have
    // fallen out of /signals has evidence nobody should still be acting on,
    // and the dialog's "may have aged out" copy is this arm speaking.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const aged = await seedSignal(tenant.id, {
      createdAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000),
    });

    expect(await loadAiVisibilityEvidence(aged.id)).toBeNull();
  });

  it("still opens for a signal just inside the window", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const fresh = await seedSignal(tenant.id, {
      createdAt: new Date(Date.now() - 59 * 24 * 60 * 60 * 1000),
    });

    expect(await loadAiVisibilityEvidence(fresh.id)).not.toBeNull();
  });

  it("opens for a stale signal — the browser shows those, so its Evidence button must work", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const stale = await seedSignal(tenant.id, { status: "stale" });

    expect(await loadAiVisibilityEvidence(stale.id)).not.toBeNull();
  });

  it("returns null for a signal of another kind, even one that happens to carry a payload", async () => {
    // `payload` is a jsonb column on every signal, not just this kind. The
    // kind has to be in the WHERE clause, or a competitor_move row that ever
    // grows a payload starts opening this dialog.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const news = await seedSignal(tenant.id, { kind: "market_news" });

    expect(await loadAiVisibilityEvidence(news.id)).toBeNull();
  });

  it("returns null for an ai_visibility signal with no payload rather than an empty shell", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const bare = await seedSignal(tenant.id, { payload: null });

    expect(await loadAiVisibilityEvidence(bare.id)).toBeNull();
  });

  it("highlights the tenant's NAME, never the company profile's category", async () => {
    // `profile.category` is the market ("Issue tracking software"). Marking
    // that as "you" while never marking the actual brand is the exact wrong
    // highlight, and it is the mistake this read is written to avoid.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await db
      .insert(companyProfiles)
      .values({ tenantId: tenant.id, topics: [], category: "Localization software" });
    const signal = await seedSignal(tenant.id);

    const view = await loadAiVisibilityEvidence(signal.id);

    const tenantAliases = view!.aliases.filter((alias) => alias.kind === "tenant");
    expect(tenantAliases.length).toBeGreaterThan(0);
    expect(tenantAliases.every((alias) => alias.label === TENANT)).toBe(true);
    expect(view!.aliases.some((alias) => alias.name === "Localization software")).toBe(false);
  });

  it("carries an alias for every competitor, labelled with the competitor's own name", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await db
      .insert(competitors)
      .values([
        { tenantId: tenant.id, name: "Lokalise" },
        { tenantId: tenant.id, name: "Phrase" },
      ]);
    const signal = await seedSignal(tenant.id);

    const view = await loadAiVisibilityEvidence(signal.id);

    const competitorLabels = new Set(
      view!.aliases.filter((alias) => alias.kind === "competitor").map((alias) => alias.label)
    );
    expect(competitorLabels).toEqual(new Set(["Lokalise", "Phrase"]));
  });

  it("does not carry another tenant's competitors into this tenant's highlight", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    await db.insert(competitors).values({ tenantId: other.id, name: "Somebody Else Ltd" });
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id);

    const view = await loadAiVisibilityEvidence(signal.id);

    expect(view!.aliases.some((alias) => alias.label === "Somebody Else Ltd")).toBe(false);
  });

  it("falls back readably for an engine-level payload that names no prompt", async () => {
    // Engine-summary and new_cited_domain signals carry no promptId, no
    // promptText and no engineLabel. The dialog still has to say something,
    // and "All engines" plus the signal's own title is that something.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id, {
      title: "A new domain is being cited across engines",
      payload: {
        signalType: "new_cited_domain",
        runId: PAYLOAD.runId,
        runDate: PAYLOAD.runDate,
        samples: "4 of 12",
      },
    });

    const view = await loadAiVisibilityEvidence(signal.id);

    expect(view!.promptId).toBeNull();
    expect(view!.promptText).toBe("A new domain is being cited across engines");
    expect(view!.engineLabel).toBe("All engines");
    expect(view!.modelId).toBeNull();
    expect(view!.excerpt).toBeNull();
    expect(view!.citedUrls).toEqual([]);
  });

  it("writes nothing — this is a read, and a dialog open must not create a row", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id);
    const before = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));

    await loadAiVisibilityEvidence(signal.id);

    const after = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(after).toHaveLength(before.length);
    expect(after[0].payload).toEqual(before[0].payload);
  });
});
