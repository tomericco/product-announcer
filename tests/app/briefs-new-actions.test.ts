import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";
import { renderBriefBody, EMPTY_BRIEF_BODY_ERROR } from "../../src/lib/briefs/body";

const TENANT = "New Brief Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createManualBrief } from "../../src/app/(dashboard)/briefs/new/actions";

afterEach(async () => {
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

const FORM = {
  contentType: "blog_post" as const,
  title: "A title",
  angle: "An angle",
  whyNow: "Because",
  keyPoints: ["One.", "Two.", "Three."],
  suggestedChannel: "blog",
  targetLength: 700,
  audience: null,
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("createManualBrief", () => {
  it("saves a manual brief that never expires, with its evidence attached", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    const result = await createManualBrief({ ...FORM, signalIds: [signal.id] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.origin).toBe("manual");
    expect(brief.status).toBe("new");
    // A hand-written brief is a decision, not a proposal awaiting one.
    expect(brief.expiresAt).toBeNull();
    expect(brief.lastEvidenceAt).toBeInstanceOf(Date);
    // The proposal produces a rationale for its score; dropping it on save
    // would silently discard something the model wrote.
    expect(brief.scoreRationale).toBe("Strong evidence, clear angle.");

    const links = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    expect(links.map((l) => l.signalId)).toEqual([signal.id]);
  });

  // The expiry is opt-in so the hand-written path keeps "never expires" by
  // construction — but the option has to actually reach the row, or the modal
  // path's fix is a no-op.
  it("stores an expiry when one is asked for, and still defaults to never when it isn't", async () => {
    await seedTenant();
    currentUserId = null;
    const when = new Date(Date.now() + 3 * 86_400_000);

    const withExpiry = await createManualBrief({ ...FORM, signalIds: [], expiresAt: when });
    expect(withExpiry.ok).toBe(true);
    if (!withExpiry.ok) return;
    const [expiring] = await db.select().from(briefs).where(eq(briefs.id, withExpiry.briefId));
    expect(expiring.expiresAt?.getTime()).toBe(when.getTime());

    // An explicit null and an omitted field must mean the same thing — the
    // field crosses a Server Action boundary, where `undefined` is not
    // reliably preserved.
    const explicitNull = await createManualBrief({ ...FORM, signalIds: [], expiresAt: null });
    expect(explicitNull.ok).toBe(true);
    if (!explicitNull.ok) return;
    const [never] = await db.select().from(briefs).where(eq(briefs.id, explicitNull.briefId));
    expect(never.expiresAt).toBeNull();
  });

  it("stores a rendered body equal to renderBriefBody of its own fields", async () => {
    await seedTenant();
    currentUserId = null;

    const result = await createManualBrief({ ...FORM, signalIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.body).not.toBeNull();
    expect(brief.body).toBe(
      renderBriefBody({
        angle: brief.angle,
        whyNow: brief.whyNow,
        keyPoints: brief.keyPoints,
        audience: brief.audience,
      })
    );
  });

  it("refuses a signal belonging to another tenant and writes nothing", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedSignal(other.id, "Theirs");

    // The ids come from a form field and are user-supplied. Attaching another
    // tenant's signal would leak its title into this tenant's brief and into
    // every draft generated from it.
    const result = await createManualBrief({ ...FORM, signalIds: [theirs.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, mine.id))).toHaveLength(0);
  });

  /**
   * The test above ("stores a rendered body equal to renderBriefBody of its own
   * fields") cannot catch this: with every rendered field blank both sides of
   * that assertion are "", and `"" === ""` passes happily. So the invariant has
   * to be stated as "what is stored survives the prompt", not as "what is
   * stored equals what the renderer returned".
   *
   * Only `title` is validated — so a caller on the rendered path (a proposal
   * whose model returned a title and blank sections) is reachable, and
   * `renderBriefBody` returns "" for it. "" is not null, so `briefBody`'s
   * fallback never fires and `composeBriefPrompt`'s `.filter(Boolean)` drops
   * it: the model would get a commission with no prose at all, silently.
   */
  it("refuses a brief whose body would render empty, and writes nothing", async () => {
    const tenant = await seedTenant();

    const result = await createManualBrief({
      ...FORM,
      angle: "   ",
      whyNow: "",
      keyPoints: [],
      audience: null,
      signalIds: [],
    });

    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id))).toHaveLength(0);
  });

  it("never lets a created brief's body reach the prompt as nothing at all", async () => {
    // The end the guard exists for, stated as the invariant rather than as a
    // property of one call — the same pinning `briefs-save-body.test.ts` uses
    // for the sibling writer. Fails if the guard is removed, whether the
    // regression stores "" or stores null (the fallback renders "" for these
    // fields too, which is why refusing is the only coherent answer).
    const tenant = await seedTenant();

    await createManualBrief({ ...FORM, angle: " ", whyNow: " ", keyPoints: [], audience: " ", signalIds: [] });

    const rows = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    const { briefBody } = await import("../../src/lib/briefs/body");
    for (const row of rows) {
      expect(briefBody(row).trim().length).toBeGreaterThan(0);
    }
  });

  it("still saves a brief with only some sections filled in", async () => {
    // The gate refuses "nothing at all", not "not everything" — a brief with an
    // angle and no why-now is a legitimate commission and must still save.
    await seedTenant();
    const result = await createManualBrief({
      ...FORM,
      whyNow: "",
      keyPoints: [],
      audience: null,
      signalIds: [],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a blank title", async () => {
    const tenant = await seedTenant();
    const signal = await seedSignal(tenant.id);
    const result = await createManualBrief({ ...FORM, title: "  ", signalIds: [signal.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id))).toHaveLength(0);
  });

  it("saves a brief with no signals at all", async () => {
    await seedTenant();
    // The degradation path: the proposal failed, the human wrote it themselves,
    // and they may not have selected anything. That must still save.
    const result = await createManualBrief({ ...FORM, signalIds: [] });
    expect(result.ok).toBe(true);
  });

  describe("with an explicit body (the markdown editor path)", () => {
    it("stores that body verbatim, not the fields rendered", async () => {
      await seedTenant();
      const handWritten = "# Not what renderBriefBody would produce\n\nFree-form prose.";

      const result = await createManualBrief({ ...FORM, body: handWritten, signalIds: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
      expect(brief.body).toBe(handWritten);
      // Proof it wasn't rendered from the fields: FORM's fields render to
      // something else entirely, and that is not what got stored.
      expect(brief.body).not.toBe(
        renderBriefBody({
          angle: FORM.angle,
          whyNow: FORM.whyNow,
          keyPoints: FORM.keyPoints,
          audience: FORM.audience,
        })
      );
    });

    it("is refused when blank/whitespace-only, exactly as a rendered blank body is", async () => {
      const tenant = await seedTenant();

      const result = await createManualBrief({ ...FORM, body: "   \n\t  ", signalIds: [] });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(EMPTY_BRIEF_BODY_ERROR);
      expect(await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id))).toHaveLength(0);
    });

    it("leaves the omitted-body path unchanged: it still renders from fields", async () => {
      // Not a new assertion so much as a check that adding the optional
      // `body` parameter didn't disturb the existing default — the suite's
      // "stores a rendered body equal to renderBriefBody of its own fields"
      // test above already covers this input by input, this just states it
      // once more, explicitly, next to the explicit-body tests.
      await seedTenant();

      const result = await createManualBrief({ ...FORM, signalIds: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
      expect(brief.body).toBe(
        renderBriefBody({
          angle: brief.angle,
          whyNow: brief.whyNow,
          keyPoints: brief.keyPoints,
          audience: brief.audience,
        })
      );
    });
  });
});
