import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "../../../src/db/schema";
import {
  extractDeterministic,
  loadBrandTargets,
  extractSample,
  MAX_MENTION_CHARS,
  type BrandTarget,
} from "../../../src/lib/ai-visibility/extract";
import { seedTenant, dropTenant, seedCompanyProfile } from "../../helpers/fixtures";

const TENANT = "AI Visibility Extract Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

const brand = (name: string, isTenant: boolean, aliases = [name]): BrandTarget => ({
  brandId: isTenant ? "tenant" : `c-${name}`,
  name,
  aliases,
  isTenant,
});

// URL stripping and prompt-echo stripping are `aliases.ts`'s, tested there.
// What these tests pin is that `extractDeterministic` actually routes through
// them — the cases below would all pass a naive `answerText.includes(name)`.

describe("extractDeterministic", () => {
  const brands = [brand("Acme", true, ["Acme", "Acme Inc"]), brand("Rival", false), brand("Beta", false)];

  it("finds the tenant and each competitor named in the body", () => {
    const out = extractDeterministic({
      answerText: "Acme Inc is fast; Rival is more configurable.",
      promptText: "best issue tracker",
      ownDomain: "acme.com",
      brands,
      citations: [],
    });
    expect(out.tenantMentioned).toBe(true);
    expect(out.competitorIds).toEqual(["c-Rival"]);
  });

  it("does not count a brand that appears only in the echoed prompt", () => {
    const out = extractDeterministic({
      answerText: "What is Acme? Acme is not something I can verify. Rival is well known.",
      promptText: "What is Acme?",
      ownDomain: "acme.com",
      brands,
      citations: [],
    });
    // The echoed question is stripped; the second sentence still names Acme.
    expect(out.tenantMentioned).toBe(true);

    const onlyEchoed = extractDeterministic({
      answerText: "What is Acme? I have no information on that product. Rival is well known.",
      promptText: "What is Acme?",
      ownDomain: "acme.com",
      brands,
      citations: [],
    });
    expect(onlyEchoed.tenantMentioned).toBe(false);
    expect(onlyEchoed.competitorIds).toEqual(["c-Rival"]);
  });

  it("does not count a brand that appears only inside a URL", () => {
    const out = extractDeterministic({
      answerText: "Read https://blog.example.com/rival-vs-beta for a comparison.",
      promptText: "compare trackers",
      ownDomain: "acme.com",
      brands,
      citations: [],
    });
    expect(out.competitorIds).toEqual([]);
  });

  it("counts one mention per brand per sample however many times it appears", () => {
    const out = extractDeterministic({
      answerText: "Rival, Rival, and Rival again.",
      promptText: "x",
      ownDomain: "acme.com",
      brands,
      citations: [],
    });
    expect(out.competitorIds).toEqual(["c-Rival"]);
  });

  it("marks an own-domain citation by registrable domain, including subdomains", () => {
    const out = extractDeterministic({
      answerText: "no brands here",
      promptText: "x",
      ownDomain: "acme.com",
      brands,
      citations: [{ url: "https://docs.acme.com/guide" }, { url: "https://rival.com/x" }],
    });
    expect(out.ownDomainCited).toBe(true);
  });

  it("is false for own-domain citation when the tenant has no website", () => {
    const out = extractDeterministic({
      answerText: "x",
      promptText: "x",
      ownDomain: null,
      brands,
      citations: [{ url: "https://acme.com/x" }],
    });
    expect(out.ownDomainCited).toBe(false);
  });

  it("reads a bounded prefix of the answer, and prepares it once for every brand", () => {
    // The strip regexes are quadratic on dotted input and `answerText` is
    // third-party text of whatever length an engine felt like returning, so
    // without a bound the cost of one sample is the engine's choice, not ours —
    // paid synchronously inside a slice with 359 other samples to get through.
    const filler = "a.b.c.d.e.f.g.h. ".repeat(2000);
    expect(filler.length).toBeGreaterThan(MAX_MENTION_CHARS);

    const within = extractDeterministic({
      answerText: `Acme is the pick. ${filler}`,
      promptText: "best issue tracker",
      ownDomain: null,
      brands,
      citations: [],
    });
    expect(within.tenantMentioned).toBe(true);

    const beyond = extractDeterministic({
      answerText: `${filler}Acme is the pick.`,
      promptText: "best issue tracker",
      ownDomain: null,
      brands,
      citations: [],
    });
    expect(beyond.tenantMentioned).toBe(false);
  });
});

describe("loadBrandTargets", () => {
  it("returns the tenant plus every competitor, with the tenant's own domain", async () => {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://www.acme.com" });
    const [rival] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" })
      .returning();

    const loaded = await loadBrandTargets(tenant.id);

    expect(loaded.ownDomain).toBe("acme.com");
    expect(loaded.brands.find((b) => b.isTenant)?.name).toBe(TENANT);
    expect(loaded.brands.find((b) => b.brandId === rival.id)?.name).toBe("Rival");
    expect(loaded.competitorByDomain).toEqual({ "rival.com": rival.id });
  });

  it("omits a competitor with no website from the domain map without dropping its aliases", async () => {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://acme.com" });
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Nameless", websiteUrl: null });

    const loaded = await loadBrandTargets(tenant.id);

    expect(loaded.competitorByDomain).toEqual({});
    expect(loaded.brands.some((b) => b.name === "Nameless")).toBe(true);
  });
});

describe("extractSample", () => {
  async function seedSample(answerText: string, citations: { url: string; position: number }[]) {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://acme.com" });
    const [rival] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" })
      .returning();
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "manual", engines: ["openai"], samplesPerPrompt: 3 })
      .returning();
    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        status: "ok",
        answerText,
        raw: { citations },
      })
      .returning();
    return { tenant, rival, run, sample, citations };
  }

  it("writes the deterministic block and one citation row per cited URL", async () => {
    const { tenant, rival, run, sample } = await seedSample(
      `${TENANT} and Rival are the usual picks.`,
      [
        { url: "https://acme.com/pricing", position: 1 },
        { url: "https://rival.com/compare", position: 2 },
        { url: "https://g2.com/categories/issue-tracking", position: 3 },
      ]
    );

    await extractSample(sample.id);

    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    expect(updated.extraction?.deterministic).toEqual({
      tenantMentioned: true,
      competitorIds: [rival.id],
      ownDomainCited: true,
    });

    const rows = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.tenantId === tenant.id && r.runId === run.id)).toBe(true);
    expect(rows.map((r) => r.domain).sort()).toEqual(["acme.com", "g2.com", "rival.com"]);
    expect(rows.find((r) => r.domain === "acme.com")?.domainClass).toBe("own");
    expect(rows.find((r) => r.domain === "rival.com")?.competitorId).toBe(rival.id);
    expect(rows.find((r) => r.domain === "acme.com")?.position).toBe(1);
  });

  it("is idempotent: re-extracting does not duplicate citation rows", async () => {
    const { sample } = await seedSample("Rival is popular.", [{ url: "https://rival.com/x", position: 1 }]);

    await extractSample(sample.id);
    await extractSample(sample.id);

    const rows = await db.select().from(aiVisibilityCitations).where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(rows).toHaveLength(1);
  });

  it("resolves a Gemini grounding redirect before classifying, and stores the real page", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const { rival, sample } = await seedSample("Rival is popular.", [{ url: redirect, position: 1 }]);
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://rival.com/compare" } })
    );

    await extractSample(sample.id, { fetchImpl: fetchImpl as never });

    // Only the redirector touched the network, and the row carries the target,
    // not the vertexaisearch handle — a naive pass would have stored
    // google.com / other and made Gemini's citation metrics permanently zero.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(row.url).toBe("https://rival.com/compare");
    expect(row.domain).toBe("rival.com");
    expect(row.domainClass).toBe("competitor");
    expect(row.competitorId).toBe(rival.id);
  });

  it("counts a redirect that resolves to the tenant's own domain as an own citation", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/DeF456";
    const { sample } = await seedSample("no brands here", [
      { url: redirect, position: 1 },
      { url: redirect, position: 2 },
    ]);
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://acme.com/pricing" } })
    );

    await extractSample(sample.id, { fetchImpl: fetchImpl as never });

    // Cached per URL: two citations of the same handle cost one network hop.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    expect(updated.extraction?.deterministic.ownDomainCited).toBe(true);
    const rows = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.domain === "acme.com" && r.domainClass === "own")).toBe(true);
  });

  it("skips URLs it cannot reduce to a registrable domain rather than throwing", async () => {
    const { sample } = await seedSample("Rival is popular.", [
      { url: "not a url", position: 1 },
      { url: "https://rival.com/x", position: 2 },
    ]);

    await extractSample(sample.id);

    const rows = await db.select().from(aiVisibilityCitations).where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(rows.map((r) => r.domain)).toEqual(["rival.com"]);
  });

  it("does nothing for a sample with no answer text", async () => {
    const { sample } = await seedSample("", []);
    await db.update(aiVisibilitySamples).set({ status: "error", answerText: null }).where(eq(aiVisibilitySamples.id, sample.id));

    await extractSample(sample.id);

    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    expect(updated.extraction).toBeNull();
  });
});

describe("extractSample re-entry and injected context", () => {
  async function seedSample(answerText: string, citations: unknown[]) {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://acme.com" });
    await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" });
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "manual", engines: ["openai"], samplesPerPrompt: 3 })
      .returning();
    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        status: "ok",
        answerText,
        raw: { citations },
      })
      .returning();
    return { tenant, sample };
  }

  it("keeps a judge label already paid for when the sample is re-extracted", async () => {
    const { sample } = await seedSample(`${TENANT} and Rival are the usual picks.`, [
      { url: "https://rival.com/compare", position: 1 },
    ]);
    await extractSample(sample.id);

    // What the row looks like after the judge has run: a `judged` block and an
    // agreement flag alongside the deterministic one.
    const [afterFirst] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    await db
      .update(aiVisibilitySamples)
      .set({
        judged: true,
        extraction: {
          ...afterFirst.extraction!,
          judged: {
            orderedBrands: ["Rival"],
            level: "described",
            framing: "listed second",
            quote: "Rival are the usual picks",
            positioningClaims: [],
            hallucinations: [],
            answerType: "list",
          },
          agreementFlag: "d_only",
        },
      })
      .where(eq(aiVisibilitySamples.id, sample.id));

    // The operator "re-extract after an alias fix" path.
    await extractSample(sample.id);

    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    // Re-extraction rewrites the deterministic half only. Clobbering the whole
    // object would throw away a judge call that has already been billed, and
    // nothing re-runs the judge for a run that has finished.
    expect(updated.extraction?.judged?.level).toBe("described");
    expect(updated.extraction?.agreementFlag).toBe("d_only");
    expect(updated.extraction?.deterministic.tenantMentioned).toBe(true);
  });

  it("uses the brand context it is handed instead of re-reading the tenant's rows", async () => {
    const { sample } = await seedSample("Nobody here is called Rival. Zephyr is the pick.", []);

    await extractSample(sample.id, {
      brandContext: {
        brands: [{ brandId: "c-zephyr", name: "Zephyr", aliases: ["Zephyr"], isTenant: false }],
        ownDomain: null,
        competitorByDomain: {},
      },
    });

    // `runSlice` loads this once per slice rather than three tables per sample.
    // If the injection were ignored the row would name Rival, which is in the
    // database, and not Zephyr, which is only in the context.
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id));
    expect(updated.extraction?.deterministic).toEqual({
      tenantMentioned: false,
      competitorIds: ["c-zephyr"],
      ownDomainCited: false,
    });
  });

  it("falls back to list order when a citation carries no usable position", async () => {
    const { sample } = await seedSample("Rival is popular.", [
      { url: "https://rival.com/a" },
      { url: "https://g2.com/b", position: "second" },
      { url: "https://acme.com/c", position: 9 },
    ]);

    await extractSample(sample.id);

    // Position is a signal — the leaderboard reads order off it — and the
    // column is a NOT NULL smallint, so a missing or non-numeric value has to
    // become something rather than blow up the whole sample's extraction.
    const rows = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.sampleId, sample.id));
    expect(rows.find((r) => r.domain === "rival.com")?.position).toBe(1);
    expect(rows.find((r) => r.domain === "g2.com")?.position).toBe(2);
    expect(rows.find((r) => r.domain === "acme.com")?.position).toBe(9);
  });
});
