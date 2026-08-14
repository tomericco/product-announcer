import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs } from "../../src/db/schema";

// Unique to this file. The suite runs against one shared Postgres and
// `dropTenant`-style teardown deletes BY NAME, so a name shared with another
// file would have the two files deleting each other's fixtures mid-run.
const TENANT = "Save Brief Body Test Tenant";
const OTHER_TENANT = "Save Brief Body Other Tenant";
let currentTenantId = "";

// requireSession() returns a NextAuth Session — tenantId lives under `user`,
// per src/types/next-auth.d.ts. Mirror that shape, not a flat one.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveBriefBody } from "../../src/app/(dashboard)/briefs/[briefId]/actions";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
  currentTenantId = "";
  vi.clearAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function seedBrief(tenantId: string, overrides: Partial<typeof briefs.$inferInsert> = {}) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "How localization breaks design systems",
      angle: "Most teams discover it too late",
      whyNow: "Two competitors shipped multilingual tooling this month",
      suggestedChannel: "blog",
      keyPoints: ["Point one", "Point two"],
      score: 0.8,
      lastEvidenceAt: new Date(),
      body: "## Angle\nStored body from the seed.",
      ...overrides,
    })
    .returning();
  return brief;
}

async function rowFor(briefId: string) {
  const [row] = await db.select().from(briefs).where(eq(briefs.id, briefId));
  return row;
}

describe("saveBriefBody", () => {
  it("writes the body and stamps editedAt", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);
    // Nothing wrote this column before this spec — the whole point of stamping
    // it is that "has a human touched this brief?" becomes answerable.
    expect(brief.editedAt).toBeNull();

    const result = await saveBriefBody({ briefId: brief.id, body: "## Angle\nA human wrote this." });

    expect(result).toEqual({ ok: true });
    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nA human wrote this.");
    expect(row.editedAt).not.toBeNull();
  });

  it("writes the title when one is supplied", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    const result = await saveBriefBody({
      briefId: brief.id,
      title: "  A retitled brief  ",
      body: "## Angle\nBody.",
    });

    expect(result).toEqual({ ok: true });
    const row = await rowFor(brief.id);
    expect(row.title).toBe("A retitled brief");
  });

  it("leaves the title alone when none is supplied", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    await saveBriefBody({ briefId: brief.id, body: "## Angle\nBody." });

    const row = await rowFor(brief.id);
    expect(row.title).toBe("How localization breaks design systems");
  });

  it("refuses a blank title rather than storing one", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    const result = await saveBriefBody({ briefId: brief.id, title: "   ", body: "## Angle\nBody." });

    expect(result.ok).toBe(false);
    const row = await rowFor(brief.id);
    expect(row.title).toBe("How localization breaks design systems");
    expect(row.editedAt).toBeNull();
  });
});

// The security boundary. `briefId` arrives from a URL and is untrusted, and
// briefs carry a company's unpublished content strategy.
//
// Asserted BY ID — re-reading the victim's row and proving it is untouched —
// not by "the action returned an error". An action that silently no-ops for
// its own tenant would also return an error here, and a where-clause that
// dropped `tenantId` would still return `{ ok: false }` from the not-found
// read while the UPDATE below it wrote across tenants.
describe("saveBriefBody tenant scoping", () => {
  it("refuses another tenant's brief and leaves that brief's row untouched", async () => {
    const victim = await seedTenant(OTHER_TENANT);
    const attacker = await seedTenant(TENANT);
    const brief = await seedBrief(victim.id, { body: "## Angle\nThe victim's commission." });

    currentTenantId = attacker.id;
    const result = await saveBriefBody({
      briefId: brief.id,
      title: "Hijacked title",
      body: "## Angle\nHijacked body.",
    });

    // BY ID first, deliberately: the row assertions must be the ones that
    // fire when the scoping is gone. Asserting the result shape first would
    // shadow them, and "it returned an error" is exactly the weak claim this
    // test is not allowed to rest on.
    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nThe victim's commission.");
    expect(row.title).toBe("How localization breaks design systems");
    expect(row.editedAt).toBeNull();

    expect(result).toEqual({ ok: false, error: "Brief not found." });
  });
});

// The spec makes an accepted or dismissed brief read-only, and the SERVER is
// the boundary, not the UI: the editor route renders those read-only, but a
// stale tab or a crafted request must not edit a brief whose draft has
// already been generated and silently diverge the two.
describe("saveBriefBody decided-brief gate", () => {
  it("refuses an accepted brief and leaves its body untouched", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, {
      status: "accepted",
      body: "## Angle\nThe accepted commission.",
    });

    const result = await saveBriefBody({ briefId: brief.id, body: "## Angle\nEdited after accept." });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/accepted/i);

    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nThe accepted commission.");
    expect(row.editedAt).toBeNull();
  });

  it("refuses a dismissed brief and leaves its body untouched", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, {
      status: "dismissed",
      body: "## Angle\nThe dismissed commission.",
    });

    const result = await saveBriefBody({ briefId: brief.id, body: "## Angle\nEdited after dismiss." });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dismissed/i);

    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nThe dismissed commission.");
    expect(row.editedAt).toBeNull();
  });

  it("still accepts a new brief, so the gate isn't refusing everything", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, { status: "new" });

    expect(await saveBriefBody({ briefId: brief.id, body: "## Angle\nEdited." })).toEqual({ ok: true });
  });
});

// The carried defect from Task 3. An empty stored body is "" and NOT null, so
// `briefBody`'s fallback does not fire; `composeBriefPrompt` then drops it via
// `.filter(Boolean)` and the model receives a commission with no prose at all,
// with nothing anywhere reporting a problem. Refused at the writer — see the
// comment in the action for why that beats teaching `briefBody` to treat ""
// as null.
describe("saveBriefBody empty-body gate", () => {
  it("refuses an empty body and leaves the stored one in place", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, { body: "## Angle\nReal prose." });

    const result = await saveBriefBody({ briefId: brief.id, body: "" });

    expect(result.ok).toBe(false);
    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nReal prose.");
    expect(row.editedAt).toBeNull();
  });

  it("refuses a whitespace-only body too", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, { body: "## Angle\nReal prose." });

    const result = await saveBriefBody({ briefId: brief.id, body: "   \n\t  \n" });

    expect(result.ok).toBe(false);
    const row = await rowFor(brief.id);
    expect(row.body).toBe("## Angle\nReal prose.");
    expect(row.editedAt).toBeNull();
  });

  it("never lets a stored brief body reach the prompt as nothing at all", async () => {
    // The end the guard exists for, stated as the invariant rather than as a
    // property of one call: whatever `saveBriefBody` accepts must survive
    // `composeBriefPrompt`'s `.filter(Boolean)`. This fails if the guard is
    // removed AND `briefBody` is not taught to treat "" as null — i.e. it
    // pins the requirement, not the chosen implementation of it.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    await saveBriefBody({ briefId: brief.id, body: "   " });

    const row = await rowFor(brief.id);
    const { briefBody } = await import("../../src/lib/briefs/body");
    expect(briefBody(row).trim().length).toBeGreaterThan(0);
  });
});
