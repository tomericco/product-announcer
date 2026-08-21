import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  competitors,
  signals,
  aiVisibilityAggregates,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  sources,
} from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import type { AiVisibilityPayload, SampleExtraction } from "../../../src/lib/ai-visibility/types";
import {
  band,
  isoWeekKey,
  evaluateTriggers,
  MAX_SIGNALS_PER_RUN,
  type EngineWindow,
  type PromptEngineWindow,
  type RunBand,
  type TriggerInput,
  emitSignals,
} from "../../../src/lib/ai-visibility/signals";

const RUN_ID = "run-now";
const RUN_DATE = new Date("2026-03-02T09:00:00Z");

const runBand = (runId: string, hits: number, n = 3, competitorHits: Record<string, number> = {}): RunBand => ({
  runId,
  hits,
  n,
  competitorHits,
});

function promptWindow(overrides: Partial<PromptEngineWindow> = {}): PromptEngineWindow {
  return {
    promptId: "p1",
    promptText: "best issue tracker for startups",
    branded: false,
    engine: "openai",
    runs: [runBand(RUN_ID, 3), runBand("r2", 3), runBand("r3", 3), runBand("r4", 3)],
    nWindow: 12,
    recommendationsWindow: 0,
    ownCitationsWindow: 0,
    ownCitationsBefore: 0,
    contradictionSamples: 0,
    evidence: { excerpt: "Rival is strongest.", modelId: "gpt-5.1", citedUrls: [] },
    ...overrides,
  };
}

function engineWindow(overrides: Partial<EngineWindow> = {}): EngineWindow {
  return {
    engine: "openai",
    sovNow: 30,
    sovPrev: 30,
    competitorSharesNow: {},
    competitorSharesPrev: {},
    modelChanged: false,
    modelId: "gpt-5.1",
    ...overrides,
  };
}

function input(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    runId: RUN_ID,
    runDate: RUN_DATE,
    prompts: [],
    engines: [engineWindow()],
    domains: [],
    competitorNames: { "c-1": "Rival", "c-2": "Beta" },
    engineLabels: { openai: "GPT-5.x API + web search", perplexity: "Perplexity Sonar API" },
    ...overrides,
  };
}

const typesOf = (input: TriggerInput) => evaluateTriggers(input).map((c) => c.signalType);

describe("band", () => {
  it("is null below the per-prompt measurement floor", () => {
    expect(band(0, 2)).toBeNull();
    expect(band(1, 0)).toBeNull();
  });

  it("splits absent, weak and strong at 0 and two thirds", () => {
    expect(band(0, 3)).toBe("absent");
    expect(band(1, 3)).toBe("weak");
    expect(band(2, 3)).toBe("strong");
    expect(band(3, 3)).toBe("strong");
    expect(band(8, 12)).toBe("strong");
    expect(band(7, 12)).toBe("weak");
  });
});

describe("isoWeekKey", () => {
  it("formats as ISO year and zero-padded week", () => {
    expect(isoWeekKey(new Date("2026-03-02T09:00:00Z"))).toMatch(/^2026-W\d{2}$/);
  });

  it("uses the ISO week year at a year boundary, not the calendar year", () => {
    // 2026-12-31 is a Thursday, ISO week 53 of 2026.
    expect(isoWeekKey(new Date("2026-12-31T00:00:00Z"))).toBe("2026-W53");
  });

  it("derives the week from the UTC date, not the process timezone", () => {
    // 2026-03-01T23:30Z is still Sunday of W09 in UTC. In any timezone east
    // of UTC the local date is already Monday of W10 — a timezone-dependent
    // implementation (date-fns getISOWeek) would give a different dedupe key
    // on a dev laptop than on the UTC server.
    expect(isoWeekKey(new Date("2026-03-01T23:30:00Z"))).toBe("2026-W09");
    expect(isoWeekKey(new Date("2026-03-02T00:30:00Z"))).toBe("2026-W10");
  });
});

describe("gap_vs_competitor", () => {
  const gapRuns = [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 2 })];

  it("fires when a competitor is strong and we are absent for two consecutive runs", () => {
    const out = evaluateTriggers(input({ prompts: [promptWindow({ runs: gapRuns })] }));
    expect(out.map((c) => c.signalType)).toEqual(["gap_vs_competitor"]);
    expect(out[0].competitorId).toBe("c-1");
    expect(out[0].title).toContain("Rival");
    expect(out[0].payload.samples).toBe("0 of 3, two runs");
    expect(out[0].payload.promptId).toBe("p1");
    expect(out[0].payload.engine).toBe("openai");
  });

  it("does not fire on a single run of noise", () => {
    const runs = [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 2, 3, { "c-1": 3 })];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).not.toContain("gap_vs_competitor");
  });

  it("does not fire on a branded prompt", () => {
    expect(
      typesOf(input({ prompts: [promptWindow({ runs: gapRuns, branded: true })] }))
    ).not.toContain("gap_vs_competitor");
  });

  it("does not fire when the competitor is only weak", () => {
    const runs = [runBand(RUN_ID, 0, 3, { "c-1": 1 }), runBand("r2", 0, 3, { "c-1": 1 })];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).not.toContain("gap_vs_competitor");
  });

  it("names the competitor with the most mentions this run when several qualify", () => {
    const runs = [
      runBand(RUN_ID, 0, 3, { "c-1": 2, "c-2": 3 }),
      runBand("r2", 0, 3, { "c-1": 3, "c-2": 3 }),
    ];
    const out = evaluateTriggers(input({ prompts: [promptWindow({ runs })] }));
    expect(out[0].competitorId).toBe("c-2");
  });
});

describe("lost_mention and gained_mention", () => {
  it("fires lost_mention on strong -> absent held for two runs", () => {
    const runs = [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3), runBand("r4", 3)];
    const out = evaluateTriggers(input({ prompts: [promptWindow({ runs })] }));
    expect(out.map((c) => c.signalType)).toEqual(["lost_mention"]);
    expect(out[0].payload.samples).toBe("0 of 3, two runs");
  });

  it("does not fire lost_mention when only the newest run dropped", () => {
    const runs = [runBand(RUN_ID, 0), runBand("r2", 3), runBand("r3", 3)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).not.toContain("lost_mention");
  });

  it("fires gained_mention on absent -> strong held for two runs", () => {
    const runs = [runBand(RUN_ID, 3), runBand("r2", 2), runBand("r3", 0), runBand("r4", 0)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).toEqual(["gained_mention"]);
  });

  it("does not fire gained_mention when the previous run was only weak", () => {
    // Spec: 0/3 → ≥2/3 held TWO consecutive runs. 3/3 after 1/3 after 0/3 is
    // one strong run, not two.
    const runs = [runBand(RUN_ID, 3), runBand("r2", 1), runBand("r3", 0), runBand("r4", 0)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).toEqual([]);
  });

  it("does not fire either when there is no prior run to compare against", () => {
    const runs = [runBand(RUN_ID, 0), runBand("r2", 0)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).toEqual([]);
  });

  it("does not fire when a run is below the measurement floor", () => {
    const runs = [runBand(RUN_ID, 0, 1), runBand("r2", 0, 1), runBand("r3", 3, 3)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).toEqual([]);
  });
});

describe("competitor_gained across prompts", () => {
  const gained = (promptId: string) =>
    promptWindow({
      promptId,
      promptText: `prompt ${promptId}`,
      runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 0 })],
    });

  it("fires once per competitor and engine at three prompts", () => {
    const out = evaluateTriggers(input({ prompts: [gained("p1"), gained("p2"), gained("p3")] }));
    const rows = out.filter((c) => c.signalType === "competitor_gained");
    expect(rows).toHaveLength(1);
    expect(rows[0].competitorId).toBe("c-1");
    expect(rows[0].title).toContain("3 prompts");
    expect(rows[0].payload.promptId).toBeUndefined();
  });

  it("does not fire at two prompts", () => {
    const out = evaluateTriggers(input({ prompts: [gained("p1"), gained("p2")] }));
    expect(out.filter((c) => c.signalType === "competitor_gained")).toHaveLength(0);
  });

  it("does not fire when the competitor was already above a third", () => {
    const already = (promptId: string) =>
      promptWindow({
        promptId,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 2 })],
      });
    const out = evaluateTriggers(input({ prompts: [already("p1"), already("p2"), already("p3")] }));
    expect(out.filter((c) => c.signalType === "competitor_gained")).toHaveLength(0);
  });

  it("gives two competitors gaining on one engine distinct dedupe keys", () => {
    const gainedFor = (promptId: string, competitorId: string) =>
      promptWindow({
        promptId,
        promptText: `prompt ${promptId}`,
        runs: [runBand(RUN_ID, 1, 3, { [competitorId]: 3 }), runBand("r2", 1, 3, { [competitorId]: 0 })],
      });
    const out = evaluateTriggers(
      input({
        prompts: [
          gainedFor("p1", "c-1"),
          gainedFor("p2", "c-1"),
          gainedFor("p3", "c-1"),
          gainedFor("p4", "c-2"),
          gainedFor("p5", "c-2"),
          gainedFor("p6", "c-2"),
        ],
      })
    );
    const rows = out.filter((c) => c.signalType === "competitor_gained");
    // Under the contract's literal `all` fallback both would share
    // `competitor_gained:all:openai:<week>` and the insert would silently
    // drop one of them.
    expect(rows).toHaveLength(2);
    expect(rows.map((c) => c.externalId).sort()).toEqual([
      `competitor_gained:c-1:openai:${isoWeekKey(RUN_DATE)}`,
      `competitor_gained:c-2:openai:${isoWeekKey(RUN_DATE)}`,
    ]);
  });
});

describe("own_page_cited, recommended_not_cited, misdescription", () => {
  it("fires own_page_cited on the first own citation for a prompt", () => {
    const out = evaluateTriggers(
      input({ prompts: [promptWindow({ ownCitationsWindow: 2, ownCitationsBefore: 0 })] })
    );
    expect(out.map((c) => c.signalType)).toContain("own_page_cited");
  });

  it("does not fire own_page_cited when the page was already cited before the window", () => {
    const out = evaluateTriggers(
      input({ prompts: [promptWindow({ ownCitationsWindow: 2, ownCitationsBefore: 5 })] })
    );
    expect(out.map((c) => c.signalType)).not.toContain("own_page_cited");
  });

  it("fires recommended_not_cited when recommended two thirds of the time with no own citation", () => {
    const out = evaluateTriggers(
      input({ prompts: [promptWindow({ nWindow: 12, recommendationsWindow: 8, ownCitationsWindow: 0 })] })
    );
    expect(out.map((c) => c.signalType)).toContain("recommended_not_cited");
  });

  it("does not fire recommended_not_cited when an own page is already cited", () => {
    const out = evaluateTriggers(
      input({ prompts: [promptWindow({ nWindow: 12, recommendationsWindow: 8, ownCitationsWindow: 1, ownCitationsBefore: 1 })] })
    );
    expect(out.map((c) => c.signalType)).not.toContain("recommended_not_cited");
  });

  it("fires misdescription at two contradicted samples, not one", () => {
    expect(typesOf(input({ prompts: [promptWindow({ contradictionSamples: 2 })] }))).toContain("misdescription");
    expect(typesOf(input({ prompts: [promptWindow({ contradictionSamples: 1 })] }))).not.toContain("misdescription");
  });
});

describe("new_cited_domain", () => {
  const domain = (overrides = {}) => ({
    domain: "g2.com",
    domainClass: "review",
    rank: 3,
    seenBefore: false,
    promptsTenantAbsent: 0,
    engines: ["openai" as const],
    sampleUrl: "https://g2.com/categories/issue-tracking",
    ...overrides,
  });

  it("fires for a new domain inside the top ten", () => {
    const out = evaluateTriggers(input({ domains: [domain()] }));
    expect(out.map((c) => c.signalType)).toEqual(["new_cited_domain"]);
    expect(out[0].payload.domain).toBe("g2.com");
  });

  it("fires for a new domain outside the top ten cited on three absent prompts", () => {
    expect(typesOf(input({ domains: [domain({ rank: 40, promptsTenantAbsent: 3 })] }))).toEqual([
      "new_cited_domain",
    ]);
  });

  it("does not fire for a domain seen in an earlier run", () => {
    expect(typesOf(input({ domains: [domain({ seenBefore: true })] }))).toEqual([]);
  });

  it("does not fire for a new domain that is neither ranked nor widely cited", () => {
    expect(typesOf(input({ domains: [domain({ rank: 40, promptsTenantAbsent: 1 })] }))).toEqual([]);
  });
});

describe("engine-level share-of-voice summary", () => {
  const lostRuns = [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3)];

  it("emits one lost_mention summary and suppresses per-prompt change signals on that engine", () => {
    const out = evaluateTriggers(
      input({
        prompts: [promptWindow({ runs: lostRuns })],
        engines: [engineWindow({ sovNow: 12, sovPrev: 30 })],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].signalType).toBe("lost_mention");
    expect(out[0].payload.promptId).toBeUndefined();
    expect(out[0].title).toContain("18");
  });

  it("emits competitor_gained instead when a competitor took the share", () => {
    const out = evaluateTriggers(
      input({
        engines: [
          engineWindow({
            sovNow: 12,
            sovPrev: 30,
            competitorSharesPrev: { "c-1": 40 },
            competitorSharesNow: { "c-1": 58 },
          }),
        ],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].signalType).toBe("competitor_gained");
    expect(out[0].competitorId).toBe("c-1");
  });

  it("does not fire below the ten point threshold, and lets per-prompt signals through", () => {
    const out = evaluateTriggers(
      input({
        prompts: [promptWindow({ runs: lostRuns })],
        engines: [engineWindow({ sovNow: 25, sovPrev: 30 })],
      })
    );
    expect(out.map((c) => c.signalType)).toEqual(["lost_mention"]);
    expect(out[0].payload.promptId).toBe("p1");
  });

  it("does not fire on a rise — the per-prompt gained_mention rule owns gains", () => {
    const out = evaluateTriggers(input({ engines: [engineWindow({ sovNow: 45, sovPrev: 30 })] }));
    expect(out).toHaveLength(0);
  });

  it("does not fire when either window was below the display threshold", () => {
    const out = evaluateTriggers(input({ engines: [engineWindow({ sovNow: 12, sovPrev: null })] }));
    expect(out).toHaveLength(0);
  });
});

describe("model-version-change suppression", () => {
  it("suppresses change signals for the changed engine only", () => {
    const changed = promptWindow({
      engine: "openai",
      runs: [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3)],
    });
    const unchanged = promptWindow({
      promptId: "p2",
      engine: "perplexity",
      runs: [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3)],
    });

    const out = evaluateTriggers(
      input({
        prompts: [changed, unchanged],
        engines: [
          engineWindow({ engine: "openai", modelChanged: true }),
          engineWindow({ engine: "perplexity", modelChanged: false }),
        ],
      })
    );

    expect(out).toHaveLength(1);
    expect(out[0].payload.engine).toBe("perplexity");
  });

  it("does NOT suppress standing-state signals for the changed engine", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })] }),
        ],
        engines: [engineWindow({ modelChanged: true })],
      })
    );
    expect(out.map((c) => c.signalType)).toEqual(["gap_vs_competitor"]);
  });

  it("suppresses gained_mention and own_page_cited on the changed engine too", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 3), runBand("r2", 2), runBand("r3", 0), runBand("r4", 0)],
            ownCitationsWindow: 2,
            ownCitationsBefore: 0,
          }),
        ],
        engines: [engineWindow({ modelChanged: true })],
      })
    );
    expect(out).toEqual([]);
  });

  it("suppresses the cross-prompt competitor_gained on the changed engine", () => {
    const gained = (promptId: string) =>
      promptWindow({
        promptId,
        promptText: `prompt ${promptId}`,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 0 })],
      });
    const out = evaluateTriggers(
      input({
        prompts: [gained("p1"), gained("p2"), gained("p3")],
        engines: [engineWindow({ modelChanged: true })],
      })
    );
    expect(out.map((c) => c.signalType)).not.toContain("competitor_gained");
  });

  it("suppresses new_cited_domain on a run where any engine that cited it changed model", () => {
    const out = evaluateTriggers(
      input({
        domains: [
          {
            domain: "g2.com",
            domainClass: "review",
            rank: 1,
            seenBefore: false,
            promptsTenantAbsent: 5,
            engines: ["openai"],
            sampleUrl: "https://g2.com/x",
          },
        ],
        engines: [engineWindow({ modelChanged: true })],
      })
    );
    expect(out).toHaveLength(0);
  });
});

describe("dedupe key and materiality cap", () => {
  it("builds the contract's externalId scheme", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })] }),
        ],
      })
    );
    expect(out[0].externalId).toBe(`gap_vs_competitor:p1:openai:${isoWeekKey(RUN_DATE)}`);
  });

  it("puts the subject in the middle slot: domain, riser competitor, or 'all' only when there is none", () => {
    const domainOut = evaluateTriggers(
      input({
        domains: [
          {
            domain: "g2.com",
            domainClass: "review",
            rank: 1,
            seenBefore: false,
            promptsTenantAbsent: 5,
            engines: ["openai"],
            sampleUrl: "https://g2.com/x",
          },
        ],
      })
    );
    expect(domainOut[0].externalId).toBe(`new_cited_domain:g2.com:all:${isoWeekKey(RUN_DATE)}`);

    // A riser summary is keyed by the competitor who took the share…
    const riserOut = evaluateTriggers(
      input({
        engines: [
          engineWindow({
            sovNow: 12,
            sovPrev: 30,
            competitorSharesPrev: { "c-1": 40 },
            competitorSharesNow: { "c-1": 58 },
          }),
        ],
      })
    );
    expect(riserOut[0].externalId).toBe(`competitor_gained:c-1:openai:${isoWeekKey(RUN_DATE)}`);

    // …and only the genuinely subject-less engine-wide fall keeps "all".
    const engineOut = evaluateTriggers(input({ engines: [engineWindow({ sovNow: 5, sovPrev: 30 })] }));
    expect(engineOut[0].externalId).toBe(`lost_mention:all:openai:${isoWeekKey(RUN_DATE)}`);
  });

  it("caps at ten and keeps the most material, deterministically", () => {
    const prompts = Array.from({ length: 25 }, (_, i) =>
      promptWindow({
        promptId: `p${i}`,
        promptText: `prompt ${i}`,
        // Both a gap (weight 100) and a first own citation (weight 55).
        runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
        ownCitationsWindow: 1,
        ownCitationsBefore: 0,
      })
    );

    const first = evaluateTriggers(input({ prompts }));
    const second = evaluateTriggers(input({ prompts }));

    expect(first).toHaveLength(MAX_SIGNALS_PER_RUN);
    expect(first.every((c) => c.signalType === "gap_vs_competitor")).toBe(true);
    expect(first.map((c) => c.externalId)).toEqual(second.map((c) => c.externalId));
  });

  it("carries the evidence payload the dialog renders", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
            evidence: {
              excerpt: "Rival is the strongest option.",
              modelId: "gpt-5.1",
              citedUrls: [{ url: "https://g2.com/x", domain: "g2.com", domainClass: "review" }],
            },
          }),
        ],
      })
    );

    expect(out[0].payload).toMatchObject({
      signalType: "gap_vs_competitor",
      promptText: "best issue tracker for startups",
      engineLabel: "GPT-5.x API + web search",
      modelId: "gpt-5.1",
      runId: RUN_ID,
      runDate: RUN_DATE.toISOString(),
      competitorId: "c-1",
    });
    expect(out[0].payload.citedUrls).toHaveLength(1);
    expect(out[0].excerpt).toBe("Rival is the strongest option.");
  });
});

const DB_TENANT = "AI Visibility Signals Test Tenant";

afterEach(async () => {
  await dropTenant(DB_TENANT);
});

const clock = (iso: string) => () => new Date(iso);

describe("emitSignals", () => {
  /**
   * Seeds a two-run history on one prompt and one engine, where a competitor
   * owns the answer and the tenant never appears — the gap_vs_competitor case.
   */
  async function seedGap() {
    const tenant = await seedTenant(DB_TENANT);
    const [source] = await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "ai_visibility", label: "AI visibility" })
      .returning();
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    const runIds: string[] = [];
    for (const [i, startedAt] of ["2026-02-23T09:00:00Z", "2026-03-02T09:00:00Z"].entries()) {
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          sourceId: source.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status: "complete",
          modelIds: { openai: "gpt-5.1" },
          startedAt: new Date(startedAt),
        })
        .returning();
      runIds.push(run.id);

      await db.insert(aiVisibilityAggregates).values([
        {
          runId: run.id,
          tenantId: tenant.id,
          engine: "openai",
          promptId: null,
          n: 3,
          tenantMentions: 0,
          competitorMentions: { [rival.id]: 3 },
          ownCitations: 0,
          recommendations: 0,
        },
        {
          runId: run.id,
          tenantId: tenant.id,
          engine: "openai",
          promptId: prompt.id,
          n: 3,
          tenantMentions: 0,
          competitorMentions: { [rival.id]: 3 },
          ownCitations: 0,
          recommendations: 0,
        },
      ]);

      const extraction: SampleExtraction = {
        deterministic: { tenantMentioned: false, competitorIds: [rival.id], ownDomainCited: false },
        judged: {
          orderedBrands: ["Rival"],
          level: "absent",
          framing: "not named",
          quote: `Rival is the strongest option (run ${i}).`,
          positioningClaims: [],
          hallucinations: [],
          answerType: "list",
        },
      };
      for (let s = 0; s < 3; s++) {
        const [sample] = await db
          .insert(aiVisibilitySamples)
          .values({
            runId: run.id,
            tenantId: tenant.id,
            promptId: prompt.id,
            engine: "openai",
            sampleIndex: s,
            status: "ok",
            judged: true,
            answerText: `Rival is the strongest option (run ${i}).`,
            modelId: "gpt-5.1",
            askedAt: new Date(startedAt),
            extraction,
          })
          .returning();
        if (s === 0) {
          await db.insert(aiVisibilityCitations).values({
            sampleId: sample.id,
            tenantId: tenant.id,
            runId: run.id,
            url: "https://g2.com/categories/issue-tracking",
            domain: "g2.com",
            position: 1,
            domainClass: "review",
          });
        }
      }
    }

    return { tenant, source, rival, prompt, latestRunId: runIds[1], firstRunId: runIds[0] };
  }

  it("writes an ai_visibility signal with a real title, excerpt and payload", async () => {
    const { tenant, source, rival, prompt, latestRunId } = await seedGap();

    const out = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(out.written).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));

    const gap = rows.find((r) => (r.payload as AiVisibilityPayload).signalType === "gap_vs_competitor")!;
    expect(gap.title).toContain("Rival");
    expect(gap.title).toContain("best issue tracker");
    expect(gap.excerpt).toContain("Rival is the strongest option");
    expect(gap.competitorId).toBe(rival.id);
    expect(gap.sourceId).toBe(source.id);
    expect(gap.occurredAt.toISOString()).toBe("2026-03-02T09:00:00.000Z");
    expect(gap.externalId).toMatch(new RegExp(`^gap_vs_competitor:${prompt.id}:openai:\\d{4}-W\\d{2}$`));

    const payload = gap.payload as AiVisibilityPayload;
    expect(payload).toMatchObject({
      signalType: "gap_vs_competitor",
      promptId: prompt.id,
      promptText: "best issue tracker for startups",
      engine: "openai",
      modelId: "gpt-5.1",
      runId: latestRunId,
      samples: "0 of 3, two runs",
      competitorId: rival.id,
    });
    expect(payload.engineLabel).toBeTruthy();
    expect(payload.citedUrls?.[0]?.domain).toBe("g2.com");
  });

  it("is idempotent within the week — re-emitting writes nothing new", async () => {
    const { tenant, latestRunId } = await seedGap();

    const first = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });
    const second = await emitSignals(latestRunId, { now: clock("2026-03-02T11:00:00Z") });

    expect(second.written).toBe(0);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(first.written);
  });

  it("writes nothing when the run's own aggregates show no trigger", async () => {
    const tenant = await seedTenant(DB_TENANT);
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete" })
      .returning();

    const out = await emitSignals(run.id, { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
  });

  /**
   * Seeds a THREE-run history — strong, then absent, then absent — on one
   * prompt and one engine, every run on model gpt-5.1. The newest two absents
   * after a strong run are exactly `lost_mention`'s trigger (it needs
   * `runs[2]` strong, so a two-run history can never fire it and any
   * suppression assertion on one would pass vacuously). This history is the
   * discriminator for the run.modelIds → `EngineWindow.modelChanged` seam:
   * the signal fires from it unless the newest run's model id differs.
   */
  async function seedLostMention() {
    const tenant = await seedTenant(DB_TENANT);
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    let latestRunId = "";
    const history: [startedAt: string, tenantMentions: number][] = [
      ["2026-02-16T09:00:00Z", 3], // strong
      ["2026-02-23T09:00:00Z", 0], // absent
      ["2026-03-02T09:00:00Z", 0], // absent — held two runs
    ];
    for (const [startedAt, tenantMentions] of history) {
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status: "complete",
          modelIds: { openai: "gpt-5.1" },
          startedAt: new Date(startedAt),
        })
        .returning();
      latestRunId = run.id;
      await db.insert(aiVisibilityAggregates).values({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: prompt.id,
        n: 3,
        tenantMentions,
        competitorMentions: {},
        ownCitations: 0,
        recommendations: 0,
      });
    }
    return { tenant, latestRunId };
  }

  async function emittedTypes(tenantId: string) {
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "ai_visibility")));
    return rows.map((r) => (r.payload as AiVisibilityPayload).signalType);
  }

  it("emits lost_mention from a strong -> absent -> absent history when the model did not change", async () => {
    const { tenant, latestRunId } = await seedLostMention();

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    // The control for the suppression case below: the SAME history fires when
    // the newest run kept its model id.
    expect(await emittedTypes(tenant.id)).toContain("lost_mention");
  });

  it("suppresses change signals for an engine whose model id changed this run", async () => {
    const { tenant, latestRunId } = await seedLostMention();
    await db
      .update(aiVisibilityRuns)
      .set({ modelIds: { openai: "gpt-5.2" } })
      .where(eq(aiVisibilityRuns.id, latestRunId));

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(await emittedTypes(tenant.id)).not.toContain("lost_mention");
  });

  it("never writes more than the per-run cap", async () => {
    const tenant = await seedTenant(DB_TENANT);
    const [source] = await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "ai_visibility", label: "AI visibility" })
      .returning();
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();

    const prompts = [];
    for (let i = 0; i < 25; i++) {
      const [prompt] = await db
        .insert(aiVisibilityPrompts)
        .values({ tenantId: tenant.id, text: `prompt number ${i}`, intent: "discovery", origin: "generated", status: "active" })
        .returning();
      prompts.push(prompt);
    }

    let latest = "";
    for (const startedAt of ["2026-02-23T09:00:00Z", "2026-03-02T09:00:00Z"]) {
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          sourceId: source.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status: "complete",
          modelIds: { openai: "gpt-5.1" },
          startedAt: new Date(startedAt),
        })
        .returning();
      latest = run.id;
      await db.insert(aiVisibilityAggregates).values(
        prompts.map((prompt) => ({
          runId: run.id,
          tenantId: tenant.id,
          engine: "openai",
          promptId: prompt.id,
          n: 3,
          tenantMentions: 0,
          competitorMentions: { [rival.id]: 3 },
          ownCitations: 0,
          recommendations: 0,
        }))
      );
    }

    const out = await emitSignals(latest, { now: clock("2026-03-02T10:00:00Z") });
    expect(out.considered).toBeGreaterThan(MAX_SIGNALS_PER_RUN);
    expect(out.written).toBe(MAX_SIGNALS_PER_RUN);
  });
});
