import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Lets one test make `linkAtomicUpdatesToPiece` fail from inside the release
 * save, which is the only way to observe whether that save is one transaction
 * or two sequential writes. Every other test delegates to the real function, so
 * this mock is inert unless `linkFailure.error` is set (cleared in `afterEach`).
 */
const linkFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../../src/lib/change-events/release-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/change-events/release-claim")>();
  return {
    ...actual,
    linkAtomicUpdatesToPiece: async (
      ...args: Parameters<typeof actual.linkAtomicUpdatesToPiece>
    ): Promise<number> => {
      if (linkFailure.error) throw linkFailure.error;
      return actual.linkAtomicUpdatesToPiece(...args);
    },
  };
});

import { db } from "../../../src/db";
import {
  tenants,
  contentPieces,
  competitors,
  companyProfiles,
  briefs,
  briefSignals,
  signals,
  atomicUpdates,
  changeEvents,
  contentImages,
} from "../../../src/db/schema";
import {
  generateDraftForPiece,
  queueGeneration,
  findNamedCompanies,
  MIN_COMPETITOR_NAME_LENGTH,
  type DraftGenerator,
  type Illustrator,
} from "../../../src/lib/briefs/draft";
import { composeBriefPrompt } from "../../../src/lib/ai/compose-prompt";
import { renderBriefBody } from "../../../src/lib/briefs/body";
import { computeReleaseDelta } from "../../../src/lib/change-events/release-deltas";
import { getOpenAtomicUpdates } from "../../../src/lib/change-events/release-claim";
import type { ReviewOutcome } from "../../../src/lib/ai/review-draft";
import { illustratePiece, type IllustrateResult } from "../../../src/lib/images/illustrate";
import { seedVisualIdentity } from "../../helpers/fixtures";

const TENANT = "Brief Draft Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  linkFailure.error = null;
  vi.restoreAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [] });
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId,
      type: "blog_post",
      title: "Scaffold title",
      body: "SCAFFOLD BODY",
      status: "brief",
      ...overrides,
    })
    .returning();
  return piece;
}

/**
 * Every content piece `generateDraftForPiece` runs on was created by
 * accepting a brief, so the real path requires a `briefs` row whose
 * `contentPieceId` points back at the piece, plus at least one cited signal
 * joined through `brief_signals` — this is what a real accepted brief looks
 * like, and it's what the earlier round of this task never seeded.
 */
async function seedPieceWithBrief(
  tenantId: string,
  pieceOverrides: Partial<typeof contentPieces.$inferInsert> = {},
  briefOverrides: Partial<typeof briefs.$inferInsert> = {}
) {
  const piece = await seedPiece(tenantId, pieceOverrides);

  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "Brief title",
      angle: "The real angle from the brief.",
      whyNow: "Because the market just shifted.",
      suggestedChannel: "blog",
      keyPoints: ["First point.", "Second point."],
      score: 0.8,
      status: "accepted",
      contentPieceId: piece.id,
      // NOT NULL, no default — omitting either gives an opaque 23502.
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...briefOverrides,
    })
    .returning();

  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "market_news",
      externalId: `evidence-${brief.id}`,
      title: "Cited signal title",
      excerpt: "Cited signal excerpt.",
      occurredAt: new Date(),
    })
    .returning();

  await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

  return { piece, brief, signal };
}

/**
 * The shipped-work half of a brief's evidence: a real atomic update, the
 * `shipped_work` signal that `syncShippedWorkSignals` derives from it, and the
 * brief_signals row citing it. This is the only shape the release fork reads —
 * it re-derives the atomic updates through this join rather than trusting any
 * id from a caller.
 *
 * `atomicUpdateTenantId` defaults to the signal's tenant; pass a different one
 * to build the cross-tenant case (a signal this tenant owns pointing at
 * somebody else's atomic update).
 */
async function seedShippedWork(args: {
  tenantId: string;
  briefId: string;
  title?: string;
  atomicUpdateTenantId?: string;
}) {
  const [atomicUpdate] = await db
    .insert(atomicUpdates)
    .values({
      tenantId: args.atomicUpdateTenantId ?? args.tenantId,
      title: args.title ?? "Shipped thing",
      summary: `Summary for ${args.title ?? "Shipped thing"}`,
      category: "new",
      size: "l",
    })
    .returning();

  const [signal] = await db
    .insert(signals)
    .values({
      tenantId: args.tenantId,
      kind: "shipped_work",
      // Mirrors syncShippedWorkSignals: the atomic update's id is the key.
      externalId: atomicUpdate.id,
      title: atomicUpdate.title,
      excerpt: atomicUpdate.summary,
      occurredAt: new Date(),
      atomicUpdateId: atomicUpdate.id,
    })
    .returning();

  await db.insert(briefSignals).values({ briefId: args.briefId, signalId: signal.id });
  return { atomicUpdate, signal };
}

const passingReview = async (draft: { title: string; body: string }): Promise<ReviewOutcome> => ({
  finalDraft: draft,
  status: "passed",
  issues: [],
});

describe("findNamedCompanies", () => {
  it("matches case-insensitively on a word boundary", () => {
    expect(findNamedCompanies("We admire Phrase a lot.", ["phrase"])).toEqual(["phrase"]);
    expect(findNamedCompanies("A PHRASE-based tool.", ["Phrase"])).toHaveLength(1);
  });

  it("does not match a name inside another word", () => {
    // The reason this function exists rather than a bare `includes`.
    expect(findNamedCompanies("A quilted jacket.", ["Lilt"])).toEqual([]);
    expect(findNamedCompanies("Deposit the cheque.", ["Posit"])).toEqual([]);
  });

  it("skips names too short to match safely", () => {
    const short = "a".repeat(MIN_COMPETITOR_NAME_LENGTH - 1);
    expect(findNamedCompanies(`${short} word here`, [short])).toEqual([]);
  });

  it("matches a name that ends in punctuation", () => {
    // \b never fires between two non-word characters (e.g. "+" and a
    // trailing space), so a plain \b...\b wrapper would silently never match
    // "C++" here — the exact worked example this function's own docstring
    // uses.
    expect(findNamedCompanies("We love C++ a lot.", ["C++"])).toEqual(["C++"]);
    expect(findNamedCompanies("We compared C++, then Rust.", ["C++"])).toEqual(["C++"]);
  });

  it("matches a name wrapped entirely in punctuation", () => {
    expect(findNamedCompanies("Use the (x) helper.", ["(x)"])).toEqual(["(x)"]);
  });
});

/**
 * The synchronous claim that runs BEFORE generation is scheduled. Its WHERE is
 * `generateDraftForPiece`'s own first three guards, and that is the point: a
 * blind pre-write would stamp a step onto a piece the generator then refuses
 * without clearing, stranding it displaying progress nothing is making.
 */
describe("queueGeneration", () => {
  it("claims a brief-status piece and marks it with the first step", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id);

    expect(await queueGeneration(piece.id, tenant.id, db)).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBe("collecting");
    // Claiming is not generating: nothing else about the piece moves.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
  });

  it("refuses another tenant's piece and leaves it unmarked", async () => {
    const tenant = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const piece = await seedPiece(other.id);

    // The id arrives from a URL. This predicate is the security boundary.
    expect(await queueGeneration(piece.id, tenant.id, db)).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
  });

  it("refuses a piece that is no longer awaiting generation", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "published" });

    // `generateDraftForPiece` would refuse this piece and return without
    // generating. Marking it here would leave a published piece displaying a
    // generation step forever.
    expect(await queueGeneration(piece.id, tenant.id, db)).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
  });

  it("refuses a piece whose body was hand-edited", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { bodyEditedAt: new Date() });

    expect(await queueGeneration(piece.id, tenant.id, db)).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
  });
});

describe("generateDraftForPiece", () => {
  /**
   * The two guards that used to return before any step existed to clear.
   * `queueGeneration` normally refuses these pieces outright, so this covers
   * the narrow case where the piece changed status between that write and
   * this read — and holds the "every exit clears the step" invariant
   * literally rather than by argument. It has been broken twice in this plan.
   */
  it("clears a pre-set step when the piece is no longer at brief", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, {
      status: "published",
      generationStep: "collecting",
    });

    const generate = vi.fn(async () => ({ title: "T", body: "B" }));
    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
    expect(after.status).toBe("published");
  });

  it("clears a pre-set step when the body was hand-edited", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, {
      bodyEditedAt: new Date(),
      generationStep: "collecting",
    });

    const generate = vi.fn(async () => ({ title: "T", body: "B" }));
    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
    expect(after.body).toBe("SCAFFOLD BODY");
  });

  it("writes the generated draft and promotes the piece to draft", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Real body.");
    expect(after.generatedAt).toBeInstanceOf(Date);
    expect(after.generationError).toBeNull();
  });

  it("sends the brief's own body and cited evidence to the generator", async () => {
    const tenant = await seedTenant();
    const { piece, brief, signal } = await seedPieceWithBrief(tenant.id, undefined, {
      angle: "A very specific angle.",
      whyNow: "A very specific reason.",
      keyPoints: ["Alpha point.", "Beta point."],
      targetLength: 500,
    });
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    // The mocked generator ignores its arguments to produce a result — this
    // is the test that actually verifies the commission handed to it is
    // assembled from the brief, not synthesized from the scaffold. This brief
    // has no stored body (nothing seeded one), so `briefBody`'s fallback
    // renders it from the fields — byte-identical to `renderBriefBody`.
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: expect.objectContaining({
          title: brief.title,
          body: renderBriefBody(brief),
          contentType: brief.contentType,
          targetLength: 500,
        }),
        evidence: [
          expect.objectContaining({
            title: signal.title,
            kind: signal.kind,
            excerpt: signal.excerpt,
          }),
        ],
      })
    );
  });

  /**
   * THE test this whole spec exists for.
   *
   * The stored body deliberately says something the fields do not. An
   * assertion that only checked "the body appears in the prompt" would pass
   * even if drafting re-rendered the commission from the fields, because for
   * an unedited brief the stored body and the rendered one are identical — the
   * difference between them is the only thing that proves a human's edit
   * actually reaches the model.
   *
   * Asserted on the composed prompt rather than on the `BriefForPrompt`
   * object, so it covers the whole chain: `draft.ts` reading the stored body
   * AND `composeBriefPrompt` embedding it. `composeBriefPrompt` is pure and
   * reaches no model; the generator itself is injected, so nothing here
   * touches the real API.
   */
  it("puts the brief's STORED body in the prompt, not its fields re-rendered", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id, undefined, {
      angle: "FIELD ANGLE, which the human replaced.",
      whyNow: "FIELD WHYNOW, which the human replaced.",
      keyPoints: ["FIELD KEYPOINT, which the human replaced."],
      body: "## Angle\nHUMAN EDITED ANGLE.\n\n## Why now\nHUMAN EDITED REASON.",
    });

    let prompt = "";
    const generate = vi.fn(async (args: Parameters<DraftGenerator>[0]) => {
      prompt = composeBriefPrompt({
        brief: args.brief,
        evidence: args.evidence,
        brandProfile: args.brandProfile,
        personas: [],
        examples: [],
      }).prompt;
      return { title: "Real title", body: "Real body." };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    expect(prompt).toContain("HUMAN EDITED ANGLE.");
    expect(prompt).toContain("HUMAN EDITED REASON.");
    // The point: the structured fields are never re-derived into the
    // commission once a body exists.
    expect(prompt).not.toContain("FIELD ANGLE");
    expect(prompt).not.toContain("FIELD WHYNOW");
    expect(prompt).not.toContain("FIELD KEYPOINT");
  });

  it("keeps the scaffold and records the reason when generation throws", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The human's decision must survive. Status stays "brief" so the Generate
    // button offers a retry, and the scaffold is still there to read.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generationError).toContain("model timeout");
    expect(after.generatedAt).toBeNull();
  });

  it("warns but keeps the draft when a competitor is named in a PRODUCT UPDATE", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "product_update" });
    const generate = vi.fn(async () => ({ title: "T", body: "As Phrase showed last week…" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Detection, not blocking. Discarding a good draft on a false positive
    // would be worse than the leak it guards against.
    expect(after.status).toBe("draft");
    expect(after.body).toContain("Phrase");
    expect(after.generationError).toContain("Phrase");
  });

  it("does NOT warn when a competitor is named in a blog post", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "blog_post" });
    const generate = vi.fn(async () => ({ title: "T", body: "As Phrase showed last week…" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Blog and social posts were allowed to name companies on 2026-08-06.
    // Warning about something the prompt explicitly permits would train the
    // reader to ignore the banner, which is worse than not showing it.
    expect(after.body).toContain("Phrase");
    expect(after.generationError).toBeNull();
  });

  it("refuses when no brief is linked to the piece", async () => {
    const tenant = await seedTenant();
    // Plain seedPiece — no accompanying briefs row, unlike every other test
    // in this suite. This is the data-integrity anomaly path: a piece should
    // never exist without the brief that produced it, and the earlier round
    // of this task silently fell back to the scaffold here instead of
    // refusing.
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    // Regression: "collecting" is written before this guard runs (it sits
    // after the three status/ownership guards but before the brief lookup),
    // so unlike those three, this refusal must explicitly clear it — a piece
    // with no linked brief must not be left permanently displaying a step
    // that is no longer running.
    expect(after.generationStep).toBeNull();
  });

  it("refuses to overwrite a body a human has edited", async () => {
    const tenant = await seedTenant();
    // Linked to a real brief (unlike the bare seedPiece used by the
    // no-linked-brief test above) so this test isolates the bodyEditedAt
    // guard specifically — without a linked brief, a broken bodyEditedAt
    // check would still return ok:false via the missing-brief guard instead,
    // masking a real regression here.
    const { piece } = await seedPieceWithBrief(tenant.id, { bodyEditedAt: new Date(), body: "HUMAN WORDS" });
    const generate = vi.fn(async () => ({ title: "T", body: "Machine words." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("HUMAN WORDS");
  });

  it("refuses to regenerate a published piece, and never calls the generator", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id, {
      status: "published",
      body: "SHIPPED BODY",
      publishedAt: new Date(),
    });
    const generate = vi.fn(async () => ({ title: "Rewritten title", body: "Rewritten body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    // The bug this guards: a published piece generated straight from a draft
    // has bodyEditedAt === null, so without a status check it sails through
    // that guard and gets silently rewritten and demoted.
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("published");
    expect(after.body).toBe("SHIPPED BODY");
    expect(after.publishedAt).not.toBeNull();
  });

  it("refuses to regenerate an archived piece, and never calls the generator", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id, { status: "archived", body: "ARCHIVED BODY" });
    const generate = vi.fn(async () => ({ title: "Rewritten title", body: "Rewritten body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("archived");
    expect(after.body).toBe("ARCHIVED BODY");
  });

  it("records an interruption marker before calling the model", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    let generationErrorDuringCall: string | null | undefined;
    const generate = vi.fn(async () => {
      // Read the row from inside the mocked generator — this is the one
      // moment that stands in for "the model call is in flight", which is
      // exactly when a marker recorded only AFTER the call would still be
      // absent.
      const [current] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
      generationErrorDuringCall = current.generationError;
      return { title: "T", body: "B" };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);
    expect(generationErrorDuringCall).toMatch(/interrupted/i);

    // And a successful run still overwrites the marker with null afterwards.
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationError).toBeNull();
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(theirs.id, mine.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    // Specifically the tenant-scoped "not found" — not the no-linked-brief
    // refusal that would ALSO fire here if the piece-level tenant predicate
    // were dropped (this piece has no brief either), which would otherwise
    // let this test pass for the wrong reason and mask a real regression.
    if (!result.ok) expect(result.error).toBe("Content piece not found.");
  });

  it("advances generationStep and clears it on success", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const seen: (string | null)[] = [];

    const generate = vi.fn(async () => {
      const [mid] = await db
        .select({ step: contentPieces.generationStep })
        .from(contentPieces)
        .where(eq(contentPieces.id, piece.id));
      seen.push(mid.step);
      return { title: "T", body: "B" };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    // Observed from inside the generator: the step in flight is "generating".
    expect(seen).toEqual(["generating"]);

    const [after] = await db
      .select({ step: contentPieces.generationStep, generatedAt: contentPieces.generatedAt })
      .from(contentPieces)
      .where(eq(contentPieces.id, piece.id));
    expect(after.step).toBeNull();
    expect(after.generatedAt).not.toBeNull();
  });

  it("clears generationStep when generation throws", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);

    const generate = vi.fn(async () => {
      throw new Error("model exploded");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);

    const [after] = await db
      .select({ step: contentPieces.generationStep, generationError: contentPieces.generationError })
      .from(contentPieces)
      .where(eq(contentPieces.id, piece.id));
    expect(after.step).toBeNull();
    expect(after.generationError).toBe("model exploded");
  });

  it("clears generationStep when the piece is refused before generating", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    await db.update(contentPieces).set({ status: "published" }).where(eq(contentPieces.id, piece.id));

    const generate = vi.fn(async () => {
      throw new Error("must not be called");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db
      .select({ step: contentPieces.generationStep })
      .from(contentPieces)
      .where(eq(contentPieces.id, piece.id));
    expect(after.step).toBeNull();
  });
});

/**
 * The release fork. `brief.contentType === "product_update"` selects the
 * release composition — NOT "the evidence is all shipped work", which would
 * give a blog post built from shipped work changelog treatment.
 *
 * Every test here injects BOTH generators and the reviewer: the release branch
 * runs generate → review → validate-links, and none of those may reach a real
 * model.
 */
describe("generateDraftForPiece — release fork", () => {
  /** A product-update piece whose brief is also a product update. */
  async function seedProductUpdate(tenantId: string) {
    return seedPieceWithBrief(tenantId, { type: "product_update" }, { contentType: "product_update" });
  }

  it("routes a product_update brief carrying shipped work through the RELEASE generator", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    // Which generator ran is the assertion — not the output.
    expect(generateRelease).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Release body.");
  });

  /**
   * The release branch is deliberately unaffected by the body. A
   * product_update brief's commission already does not steer its draft
   * (decided 2026-08-13): that fork composes from the atomic updates and their
   * non-shipped-work context, and `ReleaseDraftGenerator` has no brief
   * parameter at all. Editing the body must therefore change nothing here —
   * this pins that so a later "helpful" wiring of the body into the release
   * prompt fails loudly instead of quietly re-opening a settled decision.
   */
  it("ignores an edited body on the release branch", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedPieceWithBrief(
      tenant.id,
      { type: "product_update" },
      { contentType: "product_update", body: "## Angle\nHUMAN EDITED ANGLE." }
    );
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    expect(generateRelease).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    // Nothing the release generator receives carries the commission.
    expect(JSON.stringify(generateRelease.mock.calls[0])).not.toContain("HUMAN EDITED ANGLE");
  });

  it("falls back to the BRIEF generator for a product_update brief with no shipped work", async () => {
    const tenant = await seedTenant();
    // seedPieceWithBrief cites one market_news signal and nothing else.
    const { piece } = await seedProductUpdate(tenant.id);

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    // A manually created product-update brief citing only news is a real case:
    // it has no atomic updates to compose from, so it falls back rather than
    // erroring.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateRelease).not.toHaveBeenCalled();
  });

  it("keeps a blog_post brief on the BRIEF generator even when it cites shipped work", async () => {
    const tenant = await seedTenant();
    // seedPieceWithBrief's default contentType is blog_post.
    const { piece, brief } = await seedPieceWithBrief(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateRelease).not.toHaveBeenCalled();
  });

  it("still sends non-shipped-work evidence to the release generator as context", async () => {
    const tenant = await seedTenant();
    // `signal` here is the market_news one seedPieceWithBrief always attaches.
    const { piece, brief, signal } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    const [items, , , , evidence] = generateRelease.mock.calls[0] as unknown as [
      { id: string }[],
      unknown,
      unknown,
      unknown,
      { title: string; kind: string }[],
    ];
    // The shipped work supplies the atomic updates…
    expect(items.map((i) => i.id)).toEqual([atomicUpdate.id]);
    // …and the other evidence still reaches the prompt as context. Nothing is
    // silently dropped. The shipped-work signal is NOT repeated there — it is
    // already in `items`.
    expect(evidence.map((e) => e.title)).toEqual([signal.title]);
    expect(evidence.every((e) => e.kind !== "shipped_work")).toBe(true);
  });

  it("dates each item from its evidence, as a Date, without duplicating it", async () => {
    // The `max(coalesce(...))` aggregate in `loadShippedWorkAtomicUpdates` has
    // two traps this pins. (1) A raw `sql<>` aggregate is NOT decoded through
    // drizzle's column mapper, so the driver can hand back a STRING — the
    // template's {month}/{year} would then be computed off a string that has
    // no getUTCFullYear. (2) The leftJoin multiplies rows per change event, so
    // without the groupBy an update with two events reaches the prompt twice.
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const older = new Date("2026-07-01T00:00:00Z");
    const newest = new Date("2026-08-20T00:00:00Z");
    await db.insert(changeEvents).values([
      {
        tenantId: tenant.id,
        type: "pull_request" as const,
        provider: "github" as const,
        externalId: `pr-older-${atomicUpdate.id}`,
        atomicUpdateId: atomicUpdate.id,
        mergedAt: older,
      },
      {
        tenantId: tenant.id,
        type: "pull_request" as const,
        provider: "github" as const,
        externalId: `pr-newest-${atomicUpdate.id}`,
        atomicUpdateId: atomicUpdate.id,
        mergedAt: newest,
      },
    ]);

    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    const [items] = generateRelease.mock.calls[0] as unknown as [
      { id: string; sizeEditedAt: Date | null; latestEvidenceAt: Date | null }[],
    ];
    expect(items.map((i) => i.id)).toEqual([atomicUpdate.id]);
    expect(items[0].latestEvidenceAt).toBeInstanceOf(Date);
    expect(items[0].latestEvidenceAt?.toISOString()).toBe(newest.toISOString());
  });

  it("leaves the evidence date null when the atomic update has no dated change events", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });

    const [items] = generateRelease.mock.calls[0] as unknown as [{ latestEvidenceAt: Date | null }[]];
    expect(items[0].latestEvidenceAt).toBeNull();
  });

  it("passes the tenant's product update template to the release generator", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    // seedTenant() already wrote the profile row.
    await db
      .update(companyProfiles)
      .set({ productUpdateTemplate: "# {month} release\n\n## Highlights\n" })
      .where(eq(companyProfiles.tenantId, tenant.id));

    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });

    const call = generateRelease.mock.calls[0] as unknown as [
      unknown, unknown, unknown, unknown, unknown, string | null,
    ];
    expect(call[5]).toBe("# {month} release\n\n## Highlights\n");
  });

  it("takes atomic updates only from shipped_work signals", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);

    // A non-shipped-work signal that nonetheless carries an atomicUpdateId.
    // `atomicUpdateId` is a plain nullable FK on every signal kind, so the
    // shipped_work predicate is what keeps a manual or news signal from
    // dragging an atomic update into a composition.
    const [foreignKindUpdate] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Not shipped work", summary: "S" })
      .returning();
    const [manualSignal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "manual",
        externalId: `manual-${foreignKindUpdate.id}`,
        title: "Manual note",
        occurredAt: new Date(),
        atomicUpdateId: foreignKindUpdate.id,
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: manualSignal.id });

    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);
    expect(generateRelease).not.toHaveBeenCalled();

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreignKindUpdate.id));
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("open");
  });

  it("contributes no atomic update for a signal pointing at another tenant's atomic update", async () => {
    const tenant = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    // A signal this tenant owns whose atomicUpdateId belongs to somebody else.
    const { atomicUpdate } = await seedShippedWork({
      tenantId: tenant.id,
      briefId: brief.id,
      atomicUpdateTenantId: other.id,
    });

    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    // No composable atomic update -> the generic path, and the foreign row is
    // untouched.
    expect(generateRelease).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);

    const [foreign] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(foreign.status).toBe("open");
    expect(foreign.contentPieceId).toBeNull();
  });

  it("links its atomic updates to the EXISTING piece, and creates no second piece", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const before = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(before).toHaveLength(1);

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    // The brief path already created the piece at accept time — the release
    // branch must link to it, never claim a new one.
    const after = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(piece.id);

    const [linked] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(linked.contentPieceId).toBe(piece.id);
    // Still `open` — publish owns the transition to `released` (catch-up.ts:56).
    // The link alone is what stops the next compose run offering this work
    // again: every compose-candidate query requires BOTH `status = 'open'` and
    // `contentPieceId IS NULL`, so the piece it now belongs to is enough.
    expect(linked.status).toBe("open");
    // …which is exactly what getOpenAtomicUpdates reports.
    expect(await getOpenAtomicUpdates(tenant.id, db)).toHaveLength(0);
  });

  it("rolls the body write back when the atomic-update link fails", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    // The link and the body write must be ONE transaction. Two sequential
    // writes would leave the piece holding a generated body while its atomic
    // updates stayed open — the next compose run would then offer the same
    // shipped work and ship it twice. Failing the link is the only way to tell
    // the two shapes apart from outside.
    linkFailure.error = new Error("link failed");

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review: passingReview,
    });
    expect(result.ok).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Rolled back: no body, no promotion, nothing for the next run to trip on.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generatedAt).toBeNull();
    // The outer catch still clears the step, as every exit must.
    expect(after.generationStep).toBeNull();

    const [untouched] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(untouched.status).toBe("open");
    expect(untouched.contentPieceId).toBeNull();
  });

  it("reports no phantom catch-up on the piece it just drafted", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review: passingReview,
    });
    expect(result.ok).toBe(true);

    // composedAt was stamped at brief-accept time, BEFORE this link. Left
    // there, computeReleaseDelta's strict `updatedAt > composedAt` reads every
    // atomic update just linked here as a post-compose change — a catch-up
    // banner on a brand-new draft.
    const delta = await computeReleaseDelta(piece.id, db);
    expect(delta.count).toBe(0);
  });

  it("writes the reviewing step, which the generic path never reaches", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    let stepDuringReview: string | null | undefined;
    const review = vi.fn(async (draft: { title: string; body: string }): Promise<ReviewOutcome> => {
      const [current] = await db
        .select({ step: contentPieces.generationStep })
        .from(contentPieces)
        .where(eq(contentPieces.id, piece.id));
      stepDuringReview = current.step;
      return { finalDraft: draft, status: "failed", issues: ["Too breezy."] };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review,
    });
    expect(result.ok).toBe(true);
    expect(stepDuringReview).toBe("reviewing");

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationStep).toBeNull();
    expect(after.reviewStatus).toBe("failed");
    expect(after.reviewIssues).toEqual(["Too breezy."]);
  });

  it("leaves the atomic updates open and the piece retryable when the release generator keeps failing", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const generateRelease = vi.fn(async () => {
      throw new Error("model unavailable");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generationError).toContain("model unavailable");
    // The invariant this whole plan keeps tripping over: every exit clears it.
    expect(after.generationStep).toBeNull();

    // Nothing was consumed, so the same shipped work is still composable.
    const [untouched] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(untouched.status).toBe("open");
    expect(untouched.contentPieceId).toBeNull();
  });

  /**
   * The race the drop-don't-steal predicate creates and nothing else closed.
   * `releaseItems` is derived at the top of `generateDraftForPiece`, then the
   * function spends a full generate + review round trip — tens of seconds —
   * before the link runs. A competing writer (another accepted product_update
   * brief citing the same `shipped_work` signal, or `catch-up.ts`'s
   * `linkNewAtomicUpdates`) can claim every one of those rows in that window.
   * The link then matches nothing and returns 0.
   *
   * Stealing the row from inside the generator mock is what puts the theft
   * INSIDE that window, using the real `linkAtomicUpdatesToPiece` rather than
   * a mocked return value — the guard has to hold against the actual query's
   * `status = 'open' AND contentPieceId IS NULL` WHERE, not against a stub.
   */
  async function stealDuringGeneration(tenantId: string, atomicUpdateId: string) {
    const [thief] = await db
      .insert(contentPieces)
      .values({ tenantId, title: "Claimed first", body: "B" })
      .returning();
    await db
      .update(atomicUpdates)
      .set({ contentPieceId: thief.id })
      .where(eq(atomicUpdates.id, atomicUpdateId));
    return thief;
  }

  it("rolls back and records the real reason when the link claims ZERO atomic updates", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    let thiefId = "";
    const generateRelease = vi.fn(async () => {
      thiefId = (await stealDuringGeneration(tenant.id, atomicUpdate.id)).id;
      return { title: "Release title", body: "Release body." };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });

    // Saving anyway would leave a finished-looking product update announcing
    // shipped work it does not own — the same work announced twice — and
    // `markReleaseAtomicUpdatesReleased` would hit 0 rows at publish.
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "No changes were available to draft." });

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The whole transaction rolled back: no body, no promotion, no timestamps.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generatedAt).toBeNull();
    expect(after.reviewStatus).toBeNull();
    // The outer catch writes the REAL reason, not the interrupted-generation
    // marker that was sitting there from before the model call.
    expect(after.generationError).toBe("No changes were available to draft.");
    expect(after.generationStep).toBeNull();

    // The thief keeps what it claimed — this path drops, it never steals back.
    const [stolen] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(stolen.contentPieceId).toBe(thiefId);
    expect(stolen.status).toBe("open");
  });

  it("retries into the GENERIC branch after a lost race, rather than wedging", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const failing = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => {
        await stealDuringGeneration(tenant.id, atomicUpdate.id);
        return { title: "Release title", body: "Release body." };
      }),
      review: passingReview,
    });
    expect(failing.ok).toBe(false);

    // The piece is still "brief" with its scaffold, so the Generate button
    // works — and `loadShippedWorkAtomicUpdates` now returns [] (the row fails
    // `contentPieceId IS NULL`), so the retry takes the generic branch instead
    // of composing the same lost work again. A sane landing, not a dead end.
    const generate = vi.fn(async () => ({ title: "Brief title", body: "Brief body." }));
    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    const retry = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate,
      generateRelease,
      review: passingReview,
    });
    expect(retry.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateRelease).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Brief body.");
    expect(after.generationError).toBeNull();
    expect(after.generationStep).toBeNull();
  });

  it("saves but LOGS when only some of the atomic updates link", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate: kept } = await seedShippedWork({
      tenantId: tenant.id,
      briefId: brief.id,
      title: "Kept thing",
    });
    const { atomicUpdate: lost } = await seedShippedWork({
      tenantId: tenant.id,
      briefId: brief.id,
      title: "Lost thing",
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => {
        await stealDuringGeneration(tenant.id, lost.id);
        return { title: "Release title", body: "Release body." };
      }),
      review: passingReview,
    });

    // A partial link must NOT throw: the row that did link is legitimately
    // this piece's, and rolling back would discard a good draft over work that
    // was never ours.
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Release body.");

    const [linked] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, kept.id));
    expect(linked.contentPieceId).toBe(piece.id);

    // …but it must not be silent either: the draft announces fewer changes
    // than it was composed from, and only the log says so.
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(piece.id);
    expect(logged).toContain("only 1 of 2");
  });

  it("does not re-derive an atomic update already linked to another piece", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedProductUpdate(tenant.id);
    const { atomicUpdate } = await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    // Somebody else already composed this shipped work. The retiring API route
    // intersected its requested ids with getOpenAtomicUpdates (open AND
    // unlinked); that exclusion has to survive the move, or this draft steals
    // the atomic update out of the piece already shipping it.
    const [otherPiece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Already composed", body: "B" })
      .returning();
    await db
      .update(atomicUpdates)
      .set({ contentPieceId: otherPiece.id })
      .where(eq(atomicUpdates.id, atomicUpdate.id));

    const generateRelease = vi.fn(async () => ({ title: "Release title", body: "Release body." }));
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease,
      review: passingReview,
    });
    expect(result.ok).toBe(true);
    expect(generateRelease).not.toHaveBeenCalled();

    const [still] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdate.id));
    expect(still.contentPieceId).toBe(otherPiece.id);
    expect(still.status).toBe("open");
  });
});

/**
 * The illustration agent runs between review and save (spec 2026-08-18 §4),
 * behind `deps.illustrate`. Images block draft readiness on purpose; a failed
 * illustration pass never fails the draft.
 */
describe("generateDraftForPiece — illustrations", () => {
  const WITH_IMAGES = "# T\n\n## A\n\n![Gears](https://blob.example/g.png)\n\nBody.";

  it("writes the illustrating step, hands the reviewed body to the illustrator, and saves the spliced body", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    let stepDuring: string | null | undefined;
    let received: { title: string; body: string; contentType: string; contentPieceId: string; tenantId: string } | undefined;

    const illustrate = vi.fn(async (args: Parameters<Illustrator>[0]): Promise<IllustrateResult> => {
      received = args;
      const [current] = await db.select({ step: contentPieces.generationStep }).from(contentPieces).where(eq(contentPieces.id, piece.id));
      stepDuring = current.step;
      return { body: WITH_IMAGES, failures: 0 };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Real title", body: "# T\n\n## A\n\nBody." })),
      illustrate,
    });
    expect(result.ok).toBe(true);
    expect(stepDuring).toBe("illustrating");
    expect(received).toMatchObject({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      title: "Real title",
      body: "# T\n\n## A\n\nBody.",
      contentType: "blog_post",
    });

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe(WITH_IMAGES);
    expect(after.generationError).toBeNull();
    expect(after.generationStep).toBeNull();
  });

  it("runs the illustrator on the RELEASE branch too, on the reviewed body", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedPieceWithBrief(tenant.id, { type: "product_update" }, { contentType: "product_update" });
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const illustrate = vi.fn<Illustrator>(async () => ({ body: WITH_IMAGES, failures: 0 }));
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review: async (draft) => ({ finalDraft: { title: draft.title, body: "REVIEWED body." }, status: "passed", issues: [] }),
      illustrate,
    });
    expect(result.ok).toBe(true);
    expect(illustrate.mock.calls[0][0]).toMatchObject({ body: "REVIEWED body.", contentType: "product_update" });

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(WITH_IMAGES);
  });

  it("saves the draft with a warning, not a failure, when the illustrator throws", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => {
      throw new Error("plan call exploded");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "Plain body." })),
      illustrate,
    });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Plain body.");
    expect(after.generationError).toContain("Images could not be generated");
    expect(after.generationStep).toBeNull();
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain(piece.id);
  });

  it("does NOT warn in generationError when some renders failed — the failed-images notice owns that state", async () => {
    // A banner copy of the count would go stale the moment a Retry succeeds
    // (generationError only clears on the next body-changing save) and would
    // flag the board card as "Flagged copy" for a non-copy problem. The
    // failed rows themselves drive the live notice (Task 7).
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => ({ body: WITH_IMAGES, failures: 2 }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "B" })),
      illustrate,
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(WITH_IMAGES);
    expect(after.generationError).toBeNull();
  });

  it("keeps the competitor warning AND adds the images warning when the illustrator throws", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "product_update" });
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => {
      throw new Error("plan call exploded");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "As Phrase showed…" })),
      illustrate,
    });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationError).toContain("Phrase");
    expect(after.generationError).toContain("Images could not be generated");
    expect(errors).toHaveBeenCalled();
  });

  it("does not run the illustrator when generation itself failed", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => ({ body: "x", failures: 0 }));
    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => {
        throw new Error("model timeout");
      }),
      illustrate,
    });
    expect(illustrate).not.toHaveBeenCalled();
  });

  /**
   * The one end-to-end-ish test in this plan: the REAL `illustratePiece` and
   * the REAL `planIllustrations` post-validation and splice, with only the
   * three network seams faked. Every other test in this block stubs
   * `illustrate` wholesale, so nothing else would catch a wiring break between
   * generateDraftForPiece → illustratePiece → planIllustrations →
   * spliceImageAfterHeading → the body write. Uses the shared fixtures
   * (tests/helpers/fixtures.ts) so the "identity is ready" state is defined in
   * one place.
   */
  it("end to end: a ready tenant gets a cover row and image markdown in the SAVED body", async () => {
    const tenant = await seedTenant();
    await seedVisualIdentity(tenant.id);
    const { piece } = await seedPieceWithBrief(tenant.id);

    const rendered = "# T\n\nIntro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.";
    let uploads = 0;

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Real title", body: rendered })),
      // The real illustratePiece, with only the network seams faked.
      illustrate: (args) =>
        illustratePiece(args, {
          planIllustrations: async () => ({
            cover: { concept: "lighthouse", prompt: "P cover", altText: "A lighthouse beam" },
            body: [{ anchorHeading: "Alpha", concept: "gears", prompt: "P alpha", altText: "Gears turning" }],
          }),
          renderImage: (async () => Buffer.from("PNG")) as never,
          compressPng: async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 }),
          uploadPng: async (pathname: string) => ({
            url: `https://blob.example/${pathname}-${++uploads}`,
            pathname: `${pathname}-${uploads}`,
          }),
          deleteBlobs: async () => {},
        }),
    });

    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.generationError).toBeNull();
    expect(after.generationStep).toBeNull();
    // The body image landed under its anchor, by blob URL (spec §3).
    expect(after.body).toMatch(/## Alpha\n\n!\[Gears turning\]\(https:\/\/blob\.example\/tenants\/[^)]+\)\n\nA para\./);
    // The cover is NOT in the body (spec §3) — it is a row.
    expect(after.body).not.toContain("lighthouse");
    expect(after.body).toContain("## Beta\n\nB para.");

    const rows = await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id));
    expect(rows.map((r) => r.role).sort()).toEqual(["body", "cover"]);
    expect(rows.every((r) => r.status === "ready" && r.currentRenderId !== null)).toBe(true);
    expect(rows.find((r) => r.role === "body")!.anchorHeading).toBe("Alpha");
  });

  it("uses the real illustrator by default, which skips cleanly when the tenant has no visual identity", async () => {
    // seedTenant() writes a companyProfiles row with visualIdentity null —
    // the real `illustratePiece` returns before touching any network module.
    // This is what keeps every OTHER test in this file honest without a stub.
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "## A\n\nBody." })),
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("## A\n\nBody.");
    expect(after.generationError).toBeNull();
  });
});
