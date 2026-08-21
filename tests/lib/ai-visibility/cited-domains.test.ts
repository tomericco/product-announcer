import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "../../../src/db/schema";
import { citedDomains } from "../../../src/lib/ai-visibility/cited-domains";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Cited Domains Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function fixture() {
  const tenant = await seedTenant(TENANT);
  const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
  const [prompt] = await db
    .insert(aiVisibilityPrompts)
    .values({ tenantId: tenant.id, text: "best tracker", intent: "discovery", origin: "generated", status: "active" })
    .returning();
  const [branded] = await db
    .insert(aiVisibilityPrompts)
    .values({ tenantId: tenant.id, text: "what is us", intent: "brand_check", origin: "generated", status: "active", branded: true })
    .returning();
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete", startedAt: new Date("2026-03-01T09:00:00Z") })
    .returning();
  return { tenant, rival, prompt, branded, run };
}

async function answer(a: {
  tenantId: string;
  runId: string;
  promptId: string;
  engine: string;
  sampleIndex: number;
  tenantMentioned: boolean;
  status?: string;
  flagged?: boolean;
  domains: { domain: string; domainClass: string; competitorId?: string | null }[];
}) {
  const [sample] = await db
    .insert(aiVisibilitySamples)
    .values({
      runId: a.runId,
      tenantId: a.tenantId,
      promptId: a.promptId,
      engine: a.engine,
      sampleIndex: a.sampleIndex,
      status: a.status ?? "ok",
      flagged: a.flagged ?? false,
      judged: true,
      answerText: "text",
      extraction: { deterministic: { tenantMentioned: a.tenantMentioned, competitorIds: [], ownDomainCited: false } },
    })
    .returning();
  if (a.domains.length > 0) {
    await db.insert(aiVisibilityCitations).values(
      a.domains.map((d, i) => ({
        sampleId: sample.id,
        tenantId: a.tenantId,
        runId: a.runId,
        url: `https://${d.domain}/p${i}`,
        domain: d.domain,
        position: i + 1,
        domainClass: d.domainClass,
        competitorId: d.competitorId ?? null,
      }))
    );
  }
  return sample;
}

describe("citedDomains", () => {
  it("counts citations, distinct answers and share of eligible answers", async () => {
    const { tenant, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }, { domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, tenantMentioned: true, domains: [] });

    const rows = await citedDomains(tenant.id, {});

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "g2.com", domainClass: "review", citations: 3, answers: 2 });
    // Two of three eligible answers cited it.
    expect(rows[0].answerShare).toBeCloseTo((2 / 3) * 100, 4);
  });

  it("lists the engines that cited a domain, in engine order", async () => {
    const { tenant, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "perplexity", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });

    const rows = await citedDomains(tenant.id, {});
    expect(rows[0].engines).toEqual(["openai", "perplexity"]);
  });

  it("reports where the tenant was absent from the citing answers", async () => {
    const { tenant, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: false, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: false, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, tenantMentioned: true, domains: [{ domain: "docs.example.com", domainClass: "docs" }] });

    const rows = await citedDomains(tenant.id, {});
    const g2 = rows.find((r) => r.domain === "g2.com")!;
    expect(g2.tenantAbsentAnswers).toBe(2);
    expect(g2.tenantAbsent).toBe(true);
    const docs = rows.find((r) => r.domain === "docs.example.com")!;
    expect(docs.tenantAbsentAnswers).toBe(0);
    expect(docs.tenantAbsent).toBe(false);
  });

  it("carries the competitor id through for competitor-owned domains", async () => {
    const { tenant, rival, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "rival.com", domainClass: "competitor", competitorId: rival.id }] });

    const rows = await citedDomains(tenant.id, {});
    expect(rows[0].competitorId).toBe(rival.id);
  });

  it("uses the same eligibility cut as the aggregates", async () => {
    const { tenant, run, prompt, branded } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "keep.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, status: "error", tenantMentioned: true, domains: [{ domain: "drop-errored.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, flagged: true, tenantMentioned: true, domains: [{ domain: "drop-flagged.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: branded.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "drop-branded.com", domainClass: "publisher" }] });

    const rows = await citedDomains(tenant.id, {});
    expect(rows.map((r) => r.domain)).toEqual(["keep.com"]);
  });

  it("narrows to one prompt when asked, and rebases the share on that prompt's answers", async () => {
    const { tenant, run, prompt } = await fixture();
    const [other] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "other prompt", intent: "comparison", origin: "generated", status: "active" })
      .returning();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: other.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "elsewhere.com", domainClass: "publisher" }] });

    const rows = await citedDomains(tenant.id, { promptId: prompt.id });
    expect(rows.map((r) => r.domain)).toEqual(["g2.com"]);
    expect(rows[0].answerShare).toBeCloseTo(100, 4);
  });

  it("orders by distinct answers descending and honours the limit", async () => {
    const { tenant, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "a.com", domainClass: "publisher" }, { domain: "b.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: true, domains: [{ domain: "a.com", domainClass: "publisher" }] });

    const rows = await citedDomains(tenant.id, { limit: 1 });
    expect(rows.map((r) => r.domain)).toEqual(["a.com"]);
  });

  it("picks one domainClass deterministically when the citation rows disagree", async () => {
    const { tenant, rival, run, prompt } = await fixture();
    // The same domain classified differently in different runs — which happens
    // whenever a site is added to the competitor list mid-window.
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "shift.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: true, domains: [{ domain: "shift.com", domainClass: "publisher" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, tenantMentioned: true, domains: [{ domain: "shift.com", domainClass: "competitor", competitorId: rival.id }] });

    const rows = await citedDomains(tenant.id, {});
    // Most frequent wins, and the answer is the same on every call.
    expect(rows[0].domainClass).toBe("publisher");
    expect((await citedDomains(tenant.id, {}))[0].domainClass).toBe("publisher");
    // The competitor id still carries through — a known id beats a null.
    expect(rows[0].competitorId).toBe(rival.id);
  });

  it("breaks a domainClass tie the same way every time", async () => {
    const { tenant, run, prompt } = await fixture();
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "tied.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: true, domains: [{ domain: "tied.com", domainClass: "docs" }] });

    // One each; alphabetical decides, so it is stable rather than scan-ordered.
    expect((await citedDomains(tenant.id, {}))[0].domainClass).toBe("docs");
    expect((await citedDomains(tenant.id, {}))[0].domainClass).toBe("docs");
  });

  it("is empty, not an error, when the tenant has never run", async () => {
    const tenant = await seedTenant(TENANT);
    expect(await citedDomains(tenant.id, {})).toEqual([]);
  });
});

/** A second run for the same tenant, so the rolling window has an edge. */
async function seedRun(tenantId: string, startedAt: string, status = "complete") {
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({
      tenantId,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status,
      startedAt: new Date(startedAt),
    })
    .returning();
  return run;
}

describe("the citedDomains window", () => {
  /** One eligible answer per run, each citing a domain named after its run. */
  async function fiveRuns() {
    const { tenant, prompt } = await fixture();
    const runs = [];
    for (let i = 1; i <= 5; i++) {
      const run = await seedRun(tenant.id, `2026-04-0${i}T09:00:00Z`);
      await answer({
        tenantId: tenant.id,
        runId: run.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        tenantMentioned: true,
        domains: [{ domain: `run${i}.com`, domainClass: "publisher" }],
      });
      runs.push(run);
    }
    return { tenant, prompt, runs };
  }

  it("covers the last four complete runs by default", async () => {
    const { tenant } = await fiveRuns();
    const rows = await citedDomains(tenant.id, {});
    // `fixture()` seeds a March run with no samples, so the five April runs are
    // the only ones with data: the oldest of them falls out of the window.
    expect(rows.map((r) => r.domain).sort()).toEqual(["run2.com", "run3.com", "run4.com", "run5.com"]);
  });

  it("widens when the caller asks for a longer span", async () => {
    const { tenant } = await fiveRuns();
    // The overview asks for 12 so a domain cited once a quarter still appears.
    const rows = await citedDomains(tenant.id, { runs: 12 });
    expect(rows.map((r) => r.domain).sort()).toEqual([
      "run1.com", "run2.com", "run3.com", "run4.com", "run5.com",
    ]);
    // Each of the five answers is its own denominator entry.
    expect(rows[0].answerShare).toBeCloseTo(20, 6);
  });

  it("ignores runs that never completed, and does not let them take a window slot", async () => {
    const { tenant, prompt } = await fixture();
    for (const [day, status] of [["01", "complete"], ["02", "running"], ["03", "failed"], ["04", "paused_by_cap"]] as const) {
      const run = await seedRun(tenant.id, `2026-04-${day}T09:00:00Z`, status);
      await answer({
        tenantId: tenant.id,
        runId: run.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        tenantMentioned: true,
        domains: [{ domain: `${status}.com`, domainClass: "publisher" }],
      });
    }

    const rows = await citedDomains(tenant.id, {});
    expect(rows.map((r) => r.domain)).toEqual(["complete.com"]);
    expect(rows[0].answerShare).toBeCloseTo(100, 6);
  });
});

describe("citedDomains answer share arithmetic", () => {
  it("divides distinct citing answers by every eligible answer, counting repeats only in `citations`", async () => {
    const { tenant, run, prompt } = await fixture();
    // Four eligible answers. g2 is cited by three of them (twice in one), and
    // blog is cited by one.
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }, { domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }, { domain: "blog.example.com", domainClass: "publisher" }] });
    // An eligible answer citing nothing still sits in the denominator.
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "perplexity", sampleIndex: 0, tenantMentioned: true, domains: [] });

    const rows = await citedDomains(tenant.id, {});
    const g2 = rows.find((r) => r.domain === "g2.com")!;
    expect(g2.citations).toBe(4);
    expect(g2.answers).toBe(3);
    expect(g2.answerShare).toBeCloseTo(75, 6);

    const blog = rows.find((r) => r.domain === "blog.example.com")!;
    expect(blog.citations).toBe(1);
    expect(blog.answers).toBe(1);
    expect(blog.answerShare).toBeCloseTo(25, 6);
    // Ordering is by distinct answers, so the share column reads downwards.
    expect(rows.map((r) => r.domain)).toEqual(["g2.com", "blog.example.com"]);
  });
});

describe("citedDomains default limit", () => {
  it("stops at twenty-five rows when the caller names no limit", async () => {
    const { tenant, run, prompt } = await fixture();
    const domains = Array.from({ length: 26 }, (_, i) => ({
      domain: `d${String(i + 1).padStart(2, "0")}.com`,
      domainClass: "publisher",
    }));
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains });

    const rows = await citedDomains(tenant.id, {});
    expect(rows).toHaveLength(25);
    // All 26 tie on answers and citations, so the alphabetical tiebreak decides
    // which one is cut — and it is the same one on every call.
    expect(rows.map((r) => r.domain)).not.toContain("d26.com");
    expect((await citedDomains(tenant.id, {})).map((r) => r.domain)).toEqual(rows.map((r) => r.domain));
  });
});

describe("citedDomains tenant scoping", () => {
  it("returns nothing for a foreign tenant, even with a real promptId in hand", async () => {
    const { tenant, run, prompt } = await fixture();
    const other = await seedTenant(TENANT);
    await answer({ tenantId: tenant.id, runId: run.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, tenantMentioned: true, domains: [{ domain: "g2.com", domainClass: "review" }] });

    expect(await citedDomains(tenant.id, {})).toHaveLength(1);
    expect(await citedDomains(other.id, {})).toEqual([]);
    expect(await citedDomains(other.id, { promptId: prompt.id })).toEqual([]);
    expect(await citedDomains(other.id, { runs: 12 })).toEqual([]);
  });
});
