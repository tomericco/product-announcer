import { randomUUID } from "node:crypto";
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
  rankTriggers,
  MAX_SIGNALS_PER_RUN,
  type EngineWindow,
  type PromptEngineWindow,
  type RunBand,
  type TriggerInput,
  emitSignals,
} from "../../../src/lib/ai-visibility/signals";

const RUN_ID = "run-now";
const RUN_DATE = new Date("2026-03-02T09:00:00Z");

const runBand = (
  runId: string,
  hits: number,
  n = 3,
  competitorHits: Record<string, number> = {},
  ownCitations = 0
): RunBand => ({
  runId,
  hits,
  n,
  competitorHits,
  ownCitations,
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

  it("does not fire when the competitor was strong only in the newest run", () => {
    // The tenant has been absent twice, but the competitor only took the answer
    // this week. "Two consecutive runs" is a hold on BOTH sides of the rule.
    const runs = [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 1 })];
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

  it("does not fire lost_mention when the run before the two absents was only weak", () => {
    // Spec: "≥2/3 → 0/3". Falling out of a 1-of-3 showing is not losing a
    // mention we held; the third slot has to be STRONG.
    const runs = [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 1), runBand("r4", 3)];
    expect(typesOf(input({ prompts: [promptWindow({ runs })] }))).toEqual([]);
  });

  it("does not fire gained_mention when the run before the two strongs was only weak", () => {
    // Mirror image: "0/3 → ≥2/3". Climbing from 1 of 3 is not arriving from
    // absent, and the brief it would commission ("identify the moved URL") has
    // nothing to point at.
    const runs = [runBand(RUN_ID, 3), runBand("r2", 3), runBand("r3", 1), runBand("r4", 0)];
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

describe("a run with nothing to compare against", () => {
  it("emits nothing at all from one run of history, however bad it looks", () => {
    // Every two-run rule needs `runs[1]`. On a tenant's first run there is
    // none, and a single sampling of a model with ~73% repeat consistency is
    // noise — the whole reason the spec holds these rules for two runs.
    const first = promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 })] });
    expect(typesOf(input({ prompts: [first] }))).toEqual([]);
  });

  it("still reports a standing state that needs no history", () => {
    // The counterpart: the three standing-state rules are not two-run rules and
    // must not be silenced by the absence of a previous run, or a first run
    // would be blind to a positioning claim the engines are already getting
    // wrong.
    const first = promptWindow({ runs: [runBand(RUN_ID, 3)], contradictionSamples: 2 });
    expect(typesOf(input({ prompts: [first] }))).toEqual(["misdescription"]);
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

  it("does not fire when the three prompts are spread across two engines", () => {
    // "≥3 prompts" is per engine: two prompts on GPT and one on Perplexity is
    // not one competitor taking over an engine, and a brief written from it
    // would name the wrong surface.
    const onEngine = (promptId: string, engine: "openai" | "perplexity") =>
      promptWindow({
        promptId,
        promptText: `prompt ${promptId}`,
        engine,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 0 })],
      });
    const out = evaluateTriggers(
      input({
        prompts: [onEngine("p1", "openai"), onEngine("p2", "openai"), onEngine("p3", "perplexity")],
        engines: [engineWindow({ engine: "openai" }), engineWindow({ engine: "perplexity" })],
      })
    );
    expect(out.filter((c) => c.signalType === "competitor_gained")).toHaveLength(0);
  });

  it("fires once per engine when the same competitor gains on both", () => {
    const onEngine = (promptId: string, engine: "openai" | "perplexity") =>
      promptWindow({
        promptId,
        promptText: `prompt ${promptId}`,
        engine,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 0 })],
      });
    const out = evaluateTriggers(
      input({
        prompts: [
          onEngine("p1", "openai"),
          onEngine("p2", "openai"),
          onEngine("p3", "openai"),
          onEngine("p4", "perplexity"),
          onEngine("p5", "perplexity"),
          onEngine("p6", "perplexity"),
        ],
        engines: [engineWindow({ engine: "openai" }), engineWindow({ engine: "perplexity" })],
      })
    );
    const rows = out.filter((c) => c.signalType === "competitor_gained");
    expect(rows.map((c) => c.externalId).sort()).toEqual([
      `competitor_gained:c-1:openai:${isoWeekKey(RUN_DATE)}`,
      `competitor_gained:c-1:perplexity:${isoWeekKey(RUN_DATE)}`,
    ]);
  });

  it("does not fire when the previous run was not measurable at all", () => {
    // n = 0 is what a brand-new prompt looks like one run in. The old test was
    // `hits / max(1, n) < 1/3`, which reads 0/0 as "was low" and manufactures a
    // gain out of a run that measured nothing.
    const fresh = (promptId: string) =>
      promptWindow({
        promptId,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 0, 0, {})],
      });
    const out = evaluateTriggers(input({ prompts: [fresh("p1"), fresh("p2"), fresh("p3")] }));
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
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 3, 3, {}, 2), runBand("r2", 3), runBand("r3", 3), runBand("r4", 3)],
            ownCitationsWindow: 2,
            ownCitationsBefore: 0,
          }),
        ],
      })
    );
    expect(out.map((c) => c.signalType)).toContain("own_page_cited");
  });

  it("does not fire own_page_cited when the page was already cited before the window", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 3, 3, {}, 2), runBand("r2", 3), runBand("r3", 3), runBand("r4", 3)],
            ownCitationsWindow: 2,
            ownCitationsBefore: 5,
          }),
        ],
      })
    );
    expect(out.map((c) => c.signalType)).not.toContain("own_page_cited");
  });

  it("does not re-fire own_page_cited on later runs while the citation is still in the window", () => {
    // The citation landed in the PREVIOUS run. It is still inside the rolling
    // four-run window, so a window-wide test keeps firing it — once a week for
    // four weeks, each under a different ISO week key, so the dedupe index
    // cannot absorb them. "First own-URL citation on a prompt" is singular.
    const stale = promptWindow({
      runs: [runBand(RUN_ID, 3), runBand("r2", 3, 3, {}, 2), runBand("r3", 3), runBand("r4", 3)],
      ownCitationsWindow: 2,
      ownCitationsBefore: 0,
    });
    expect(typesOf(input({ prompts: [stale] }))).not.toContain("own_page_cited");
  });

  it("does not fire own_page_cited when an earlier run in the window was already cited", () => {
    const notFirst = promptWindow({
      runs: [runBand(RUN_ID, 3, 3, {}, 1), runBand("r2", 3, 3, {}, 2), runBand("r3", 3), runBand("r4", 3)],
      ownCitationsWindow: 3,
      ownCitationsBefore: 0,
    });
    expect(typesOf(input({ prompts: [notFirst] }))).not.toContain("own_page_cited");
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

  it("does not fire recommended_not_cited below the two-thirds rate", () => {
    // 7 of 12 is 58%. The spec's bar is "recommended ≥2/3".
    expect(
      typesOf(input({ prompts: [promptWindow({ nWindow: 12, recommendationsWindow: 7 })] }))
    ).not.toContain("recommended_not_cited");
  });

  it("does not fire recommended_not_cited below the measurement floor", () => {
    // 2 of 2 is 100% of a window too small to mean anything — the same floor
    // that makes `band` return null.
    expect(
      typesOf(input({ prompts: [promptWindow({ nWindow: 2, recommendationsWindow: 2 })] }))
    ).not.toContain("recommended_not_cited");
  });

  it("does not fire recommended_not_cited when the only own citation predates the window", () => {
    // Nothing in the window cites us, but a page of ours WAS cited five runs
    // ago. The rule is "own domain never cited", and telling the tenant to go
    // publish the page they already have is wrong advice.
    expect(
      typesOf(
        input({
          prompts: [
            promptWindow({
              nWindow: 12,
              recommendationsWindow: 8,
              ownCitationsWindow: 0,
              ownCitationsBefore: 3,
            }),
          ],
        })
      )
    ).not.toContain("recommended_not_cited");
  });

  it("fires own_page_cited on a first run, where every earlier run is vacuously clean", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({ runs: [runBand(RUN_ID, 3, 3, {}, 2)], ownCitationsWindow: 2, nWindow: 3 }),
        ],
      })
    );
    expect(out.map((c) => c.signalType)).toEqual(["own_page_cited"]);
    expect(out[0].payload.samples).toBe("2 of 3, one run");
  });

  it("fires misdescription at two contradicted samples, not one", () => {
    expect(typesOf(input({ prompts: [promptWindow({ contradictionSamples: 2 })] }))).toContain("misdescription");
    expect(typesOf(input({ prompts: [promptWindow({ contradictionSamples: 1 })] }))).not.toContain("misdescription");
  });

  it("counts misdescription against this run's samples, not the whole window", () => {
    // The evidence pass reads ONE run, so "2 of 12, 4 runs" would turn a solid
    // 2-of-3 pattern into a fluke in the one line the brief agent reads.
    const out = evaluateTriggers(input({ prompts: [promptWindow({ contradictionSamples: 2 })] }));
    const row = out.find((c) => c.signalType === "misdescription")!;
    expect(row.payload.samples).toBe("2 of 3, one run");
  });
});

describe("new_cited_domain", () => {
  const domain = (overrides = {}) => ({
    domain: "g2.com",
    domainClass: "review",
    rank: 3,
    citedInCurrentRun: true,
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

  it("does not fire for a domain the current run did not cite", () => {
    // Still on the four-run leaderboard, but nothing cited it this week: the
    // news broke in an earlier run and was reported then.
    expect(typesOf(input({ domains: [domain({ citedInCurrentRun: false })] }))).toEqual([]);
  });

  it("does not fire for a domain seen in an earlier run", () => {
    expect(typesOf(input({ domains: [domain({ seenBefore: true })] }))).toEqual([]);
  });

  it("does not fire for a new domain that is neither ranked nor widely cited", () => {
    expect(typesOf(input({ domains: [domain({ rank: 40, promptsTenantAbsent: 1 })] }))).toEqual([]);
  });

  it("treats the top ten as inclusive and rank eleven as outside it", () => {
    // "Enters top-10" — rank 10 is in, rank 11 needs the three-prompt arm.
    expect(typesOf(input({ domains: [domain({ rank: 10 })] }))).toEqual(["new_cited_domain"]);
    expect(typesOf(input({ domains: [domain({ rank: 11, promptsTenantAbsent: 2 })] }))).toEqual([]);
    expect(typesOf(input({ domains: [domain({ rank: 11, promptsTenantAbsent: 3 })] }))).toEqual([
      "new_cited_domain",
    ]);
  });

  it("names the absent prompts in the title only when there are any", () => {
    const absent = evaluateTriggers(input({ domains: [domain({ promptsTenantAbsent: 4 })] }));
    expect(absent[0].title).toBe("g2.com is now cited on 4 prompts where you are absent");
    const ranked = evaluateTriggers(input({ domains: [domain({ promptsTenantAbsent: 0 })] }));
    expect(ranked[0].title).toBe("g2.com is now among the most-cited sources");
  });

  it("carries the real cited url, not a synthesised homepage", () => {
    const out = evaluateTriggers(input({ domains: [domain()] }));
    expect(out[0].payload.citedUrls).toEqual([
      { url: "https://g2.com/categories/issue-tracking", domain: "g2.com", domainClass: "review" },
    ]);
  });

  it("ranks a domain cited where the tenant is absent above a merely well-ranked one", () => {
    const out = evaluateTriggers(
      input({
        domains: [
          domain({ domain: "quiet.com", rank: 1, promptsTenantAbsent: 0 }),
          domain({ domain: "loud.com", rank: 9, promptsTenantAbsent: 4 }),
        ],
      })
    );
    expect(out.map((c) => c.payload.domain)).toEqual(["loud.com", "quiet.com"]);
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

  it("emits exactly one summary per engine however many prompts fell on it", () => {
    const fell = (promptId: string) => promptWindow({ promptId, promptText: `prompt ${promptId}`, runs: lostRuns });
    const out = evaluateTriggers(
      input({
        prompts: [fell("p1"), fell("p2"), fell("p3")],
        engines: [engineWindow({ sovNow: 12, sovPrev: 30 })],
      })
    );
    // "One summary rather than per-prompt ones" — three per-prompt
    // lost_mentions collapse into one engine-wide line.
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe(`lost_mention:all:openai:${isoWeekKey(RUN_DATE)}`);
  });

  it("summarises each falling engine separately", () => {
    const out = evaluateTriggers(
      input({
        engines: [
          engineWindow({ engine: "openai", sovNow: 12, sovPrev: 30 }),
          engineWindow({ engine: "perplexity", sovNow: 5, sovPrev: 40 }),
        ],
      })
    );
    expect(out.map((c) => c.externalId).sort()).toEqual([
      `lost_mention:all:openai:${isoWeekKey(RUN_DATE)}`,
      `lost_mention:all:perplexity:${isoWeekKey(RUN_DATE)}`,
    ]);
  });

  it("lets standing-state signals through on the summarised engine", () => {
    // The summary replaces the engine's CHANGE signals. A gap a competitor has
    // owned for two runs is not a change and is the most actionable thing the
    // feature produces — it must survive.
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })] }),
        ],
        engines: [engineWindow({ sovNow: 12, sovPrev: 30 })],
      })
    );
    expect(out.map((c) => c.signalType).sort()).toEqual(["gap_vs_competitor", "lost_mention"]);
  });

  it("suppresses the cross-prompt competitor_gained on a summarised engine", () => {
    const gained = (promptId: string) =>
      promptWindow({
        promptId,
        promptText: `prompt ${promptId}`,
        runs: [runBand(RUN_ID, 1, 3, { "c-1": 3 }), runBand("r2", 1, 3, { "c-1": 0 })],
      });
    const out = evaluateTriggers(
      input({
        prompts: [gained("p1"), gained("p2"), gained("p3")],
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
    // One competitor_gained — the engine-wide summary, keyed on "all" prompts,
    // not the cross-prompt rule as well.
    expect(out).toHaveLength(1);
    expect(out[0].payload.samples).toBe("share of voice 30% to 12%");
  });

  it("is itself suppressed when the engine changed model, without unsuppressing the prompts", () => {
    // The summary IS a change signal — both forms of it — so a model version
    // change silences it too. And it still claims the engine: the per-prompt
    // change signals it replaced must not come back through the gap it leaves.
    const out = evaluateTriggers(
      input({
        prompts: [promptWindow({ runs: [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3)] })],
        engines: [
          engineWindow({
            sovNow: 12,
            sovPrev: 30,
            modelChanged: true,
            competitorSharesPrev: { "c-1": 40 },
            competitorSharesNow: { "c-1": 58 },
          }),
        ],
      })
    );
    expect(out).toEqual([]);
  });

  it("names the bigger riser, and breaks a tie on the competitor id", () => {
    const biggest = evaluateTriggers(
      input({
        engines: [
          engineWindow({
            sovNow: 8,
            sovPrev: 40,
            competitorSharesPrev: { "c-1": 30, "c-2": 30 },
            competitorSharesNow: { "c-1": 46, "c-2": 42 },
          }),
        ],
      })
    );
    expect(biggest[0].competitorId).toBe("c-1");

    const tied = evaluateTriggers(
      input({
        engines: [
          engineWindow({
            sovNow: 8,
            sovPrev: 40,
            competitorSharesPrev: { "c-2": 30, "c-1": 30 },
            competitorSharesNow: { "c-2": 46, "c-1": 46 },
          }),
        ],
      })
    );
    // Object key order puts c-2 first; the tie-break must not.
    expect(tied[0].competitorId).toBe("c-1");
  });

  it("falls back to the engine-wide line when no single competitor rose ten points", () => {
    const out = evaluateTriggers(
      input({
        engines: [
          engineWindow({
            sovNow: 12,
            sovPrev: 30,
            competitorSharesPrev: { "c-1": 35, "c-2": 35 },
            competitorSharesNow: { "c-1": 44, "c-2": 44 },
          }),
        ],
      })
    );
    expect(out[0].signalType).toBe("lost_mention");
    expect(out[0].competitorId).toBeNull();
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

  it("does NOT suppress recommended_not_cited or misdescription either", () => {
    // The other two standing states. A new model version does not make a
    // contradicted positioning claim less contradicted, and suppressing these
    // would silence the feature every time a provider ships — which is often.
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            nWindow: 12,
            recommendationsWindow: 8,
            ownCitationsWindow: 0,
            contradictionSamples: 2,
          }),
        ],
        engines: [engineWindow({ modelChanged: true })],
      })
    );
    expect(out.map((c) => c.signalType).sort()).toEqual(["misdescription", "recommended_not_cited"]);
  });

  it("does not suppress anything on a first sighting of an engine's model id", () => {
    // `modelChanged` is only true when a KNOWN previous id differs. An engine
    // added this run has no previous id, and treating that as a change would
    // silence its first run entirely.
    const out = evaluateTriggers(
      input({
        prompts: [promptWindow({ runs: [runBand(RUN_ID, 0), runBand("r2", 0), runBand("r3", 3)] })],
        engines: [engineWindow({ modelChanged: false, modelId: "gpt-5.2" })],
      })
    );
    expect(out.map((c) => c.signalType)).toEqual(["lost_mention"]);
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
            citedInCurrentRun: true,
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
            citedInCurrentRun: true,
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
        runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }, 1), runBand("r2", 0, 3, { "c-1": 3 })],
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

  it("reports every trigger that fired, not only the ten it keeps", () => {
    const prompts = Array.from({ length: 25 }, (_, i) =>
      promptWindow({
        promptId: `p${i}`,
        promptText: `prompt ${i}`,
        runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
      })
    );
    // `considered` is built from this. A number that could never exceed
    // `written` would say nothing about whether a run was noisy.
    expect(rankTriggers(input({ prompts }))).toHaveLength(25);
    expect(evaluateTriggers(input({ prompts }))).toHaveLength(MAX_SIGNALS_PER_RUN);
  });

  it("keeps the cap's order by type weight, then by evidence volume", () => {
    const gap = promptWindow({
      promptId: "p-gap",
      runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
    });
    const thinRecommendation = promptWindow({
      promptId: "p-thin",
      nWindow: 6,
      recommendationsWindow: 4,
    });
    const thickRecommendation = promptWindow({
      promptId: "p-thick",
      nWindow: 12,
      recommendationsWindow: 12,
    });
    const out = evaluateTriggers(
      input({ prompts: [thinRecommendation, thickRecommendation, gap] })
    );
    expect(out.map((c) => c.payload.promptId)).toEqual(["p-gap", "p-thick", "p-thin"]);
  });

  it("lets type weight beat evidence volume, never the other way round", () => {
    // A thin gap — one run's worth of samples — outranks a thick pile of
    // own-page citations. Materiality is what a marketer can act on this week,
    // and evidence volume only breaks ties WITHIN a type.
    const thinGap = promptWindow({
      promptId: "p-gap",
      nWindow: 3,
      runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
    });
    const thickCitation = promptWindow({
      promptId: "p-cited",
      nWindow: 30,
      ownCitationsWindow: 20,
      runs: [runBand(RUN_ID, 30, 30, {}, 20)],
    });
    const out = evaluateTriggers(input({ prompts: [thickCitation, thinGap] }));
    expect(out.map((c) => c.signalType)).toEqual(["gap_vs_competitor", "own_page_cited"]);
  });

  it("breaks a score tie on the externalId, ascending", () => {
    // Twenty-five identically material gaps: which ten survive the cap has to
    // be a property of the run, not of the order the aggregate rows were
    // scanned in, or a retry writes a different ten.
    const prompts = Array.from({ length: 25 }, (_, i) =>
      promptWindow({
        promptId: `p${i}`,
        promptText: `prompt ${i}`,
        runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
      })
    );
    const ranked = rankTriggers(input({ prompts })).map((c) => c.externalId);
    expect(ranked).toEqual([...ranked].sort((a, b) => a.localeCompare(b)));
    // …and the same ten survive whichever order the prompts arrived in.
    const backwards = evaluateTriggers(input({ prompts: [...prompts].reverse() }));
    expect(backwards.map((c) => c.externalId)).toEqual(ranked.slice(0, MAX_SIGNALS_PER_RUN));
  });

  it("gives two runs in one ISO week the same key, and next week's a different one", () => {
    const prompts = [
      promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })] }),
    ];
    // Monday and Thursday of the same ISO week: a scheduled run and a "Run
    // now" on the same standing gap must dedupe to one signal…
    const monday = evaluateTriggers(input({ prompts, runDate: new Date("2026-03-02T09:00:00Z") }));
    const thursday = evaluateTriggers(input({ prompts, runDate: new Date("2026-03-05T16:00:00Z") }));
    expect(thursday[0].externalId).toBe(monday[0].externalId);

    // …while the same standing gap next week is news again.
    const nextWeek = evaluateTriggers(input({ prompts, runDate: new Date("2026-03-09T09:00:00Z") }));
    expect(nextWeek[0].externalId).not.toBe(monday[0].externalId);
  });

  it("keys a run in the last days of December by its ISO week year", () => {
    // 2026-12-31 is a Thursday of 2026-W53; 2027-01-01 is the Friday of the
    // SAME ISO week. Keyed on the calendar year they would be two weeks apart
    // and the same standing gap would fire twice in three days.
    const prompts = [
      promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })] }),
    ];
    const dec = evaluateTriggers(input({ prompts, runDate: new Date("2026-12-31T09:00:00Z") }));
    const jan = evaluateTriggers(input({ prompts, runDate: new Date("2027-01-01T09:00:00Z") }));
    expect(dec[0].externalId).toContain(":2026-W53");
    expect(jan[0].externalId).toBe(dec[0].externalId);
  });

  it("cuts the excerpt at four hundred characters, in the column and the payload", () => {
    const long = "x".repeat(600);
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
            evidence: { excerpt: long, modelId: "gpt-5.1", citedUrls: [] },
          }),
        ],
      })
    );
    expect(out[0].excerpt).toHaveLength(400);
    expect(out[0].payload.excerpt).toHaveLength(400);
  });

  it("leaves the excerpt out of the payload entirely when there is none", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
            evidence: { excerpt: null, modelId: null, citedUrls: [] },
          }),
        ],
      })
    );
    expect(out[0].excerpt).toBeNull();
    expect("excerpt" in out[0].payload).toBe(false);
  });

  it("falls back to a placeholder name for a competitor it cannot name", () => {
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({ runs: [runBand(RUN_ID, 0, 3, { "c-9": 3 }), runBand("r2", 0, 3, { "c-9": 3 })] }),
        ],
        competitorNames: {},
      })
    );
    expect(out[0].title).toContain("A competitor");
    expect(out[0].competitorId).toBe("c-9");
  });

  it("shortens a long prompt in the title but keeps it whole in the payload", () => {
    const promptText = `${"how do i choose an issue tracker for a distributed team ".repeat(3)}?`;
    const out = evaluateTriggers(
      input({
        prompts: [
          promptWindow({
            promptText,
            runs: [runBand(RUN_ID, 0, 3, { "c-1": 3 }), runBand("r2", 0, 3, { "c-1": 3 })],
          }),
        ],
      })
    );
    expect(out[0].title).toContain("…");
    expect(out[0].title.length).toBeLessThan(promptText.length);
    expect(out[0].payload.promptText).toBe(promptText);
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
/** A second tenant, for the isolation cases. Its own name, so it drops cleanly. */
const DB_TENANT_OTHER = "AI Visibility Signals Foreign Test Tenant";

afterEach(async () => {
  await dropTenant(DB_TENANT);
  await dropTenant(DB_TENANT_OTHER);
});

const clock = (iso: string) => () => new Date(iso);

describe("emitSignals", () => {
  /**
   * Seeds a two-run history on one prompt and one engine, where a competitor
   * owns the answer and the tenant never appears — the gap_vs_competitor case.
   */
  async function seedGap(startedAts = ["2026-02-23T09:00:00Z", "2026-03-02T09:00:00Z"]) {
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
    for (const [i, startedAt] of startedAts.entries()) {
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

    return { tenant, source, rival, prompt, runIds, latestRunId: runIds[runIds.length - 1], firstRunId: runIds[0] };
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

  it("re-fires a standing gap the following week, under a new dedupe key", async () => {
    const { tenant, runIds } = await seedGap([
      "2026-02-23T09:00:00Z",
      "2026-03-02T09:00:00Z",
      "2026-03-09T09:00:00Z",
    ]);

    // Week one of the gap…
    const first = await emitSignals(runIds[1], { now: clock("2026-03-02T10:00:00Z") });
    expect(first.written).toBe(1);
    // …and the week after, still absent: the ISO week in the key is what lets
    // a standing gap resurface rather than going quiet forever.
    const second = await emitSignals(runIds[2], { now: clock("2026-03-09T10:00:00Z") });
    expect(second.written).toBe(1);

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.externalId.split(":").pop()).sort()).toEqual(["2026-W10", "2026-W11"]);
  });

  it("writes one signal for two runs in the same ISO week", async () => {
    // Monday's scheduled run and Wednesday's "Run now" are the same week's
    // news. Both are real runs with their own ids, so only the week in the
    // dedupe key stops the browser showing the gap twice.
    const { tenant, runIds } = await seedGap([
      "2026-02-23T09:00:00Z",
      "2026-03-02T09:00:00Z",
      "2026-03-04T09:00:00Z",
    ]);

    const monday = await emitSignals(runIds[1], { now: clock("2026-03-02T10:00:00Z") });
    const wednesday = await emitSignals(runIds[2], { now: clock("2026-03-04T10:00:00Z") });

    expect(monday.written).toBe(1);
    expect(wednesday.considered).toBeGreaterThan(0);
    expect(wednesday.written).toBe(0);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(1);
  });

  it("ignores another tenant's runs when it builds the window", async () => {
    const { tenant, runIds } = await seedGap();
    // A foreign run that fell between this tenant's two. Admitted to the
    // window it would take the `prev` slot, contribute n = 0 for every prompt,
    // and the two-run hold would silently never be satisfiable again.
    const other = await seedTenant(DB_TENANT_OTHER);
    await db.insert(aiVisibilityRuns).values({
      tenantId: other.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "complete",
      startedAt: new Date("2026-02-26T09:00:00Z"),
    });

    const out = await emitSignals(runIds[1], { now: clock("2026-03-02T10:00:00Z") });

    expect(out.written).toBe(1);
    expect(await emittedTypes(tenant.id)).toEqual(["gap_vs_competitor"]);
  });

  it("writes nothing at all on a tenant's very first run", async () => {
    // No history: no two-run rule can hold, and every domain the engines cited
    // is baseline rather than news. Firing `new_cited_domain` for each of them
    // would fill the whole ten-signal cap with a tenant's starting position.
    const { tenant, runIds } = await seedGap(["2026-03-02T09:00:00Z"]);

    const out = await emitSignals(runIds[0], { now: clock("2026-03-02T10:00:00Z") });

    expect(out).toEqual({ written: 0, considered: 0 });
    expect(await emittedTypes(tenant.id)).toEqual([]);
  });

  it("does not read another tenant's history as its own on a first run", async () => {
    // The foreign tenant has run for weeks and cites g2.com. If the history
    // lookup were not tenant-scoped, this tenant's first run would look like
    // it had a past — and g2.com, absent from that borrowed past, would fire
    // as a new cited domain on a run with no history at all.
    const other = await seedTenant(DB_TENANT_OTHER);
    const [otherPrompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: other.id, text: "foreign prompt", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    for (const startedAt of ["2026-02-16T09:00:00Z", "2026-02-23T09:00:00Z"]) {
      const [foreignRun] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: other.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status: "complete",
          startedAt: new Date(startedAt),
        })
        .returning();
      const [foreignSample] = await db
        .insert(aiVisibilitySamples)
        .values({
          runId: foreignRun.id,
          tenantId: other.id,
          promptId: otherPrompt.id,
          engine: "openai",
          sampleIndex: 0,
          status: "ok",
          judged: true,
          answerText: "text",
          extraction: { deterministic: { tenantMentioned: true, competitorIds: [], ownDomainCited: false } },
        })
        .returning();
      await db.insert(aiVisibilityCitations).values({
        sampleId: foreignSample.id,
        tenantId: other.id,
        runId: foreignRun.id,
        url: "https://reddit.com/r/other",
        domain: "reddit.com",
        position: 1,
        domainClass: "community",
      });
    }

    const { tenant, runIds } = await seedGap(["2026-03-02T09:00:00Z"]);
    const out = await emitSignals(runIds[0], { now: clock("2026-03-02T10:00:00Z") });

    expect(out).toEqual({ written: 0, considered: 0 });
    expect(await emittedTypes(tenant.id)).toEqual([]);
  });

  it("sees the citations of the run it is closing, which is not complete yet", async () => {
    // `emitSignals` runs inside `finalizeRun`, before the run is marked
    // complete. A leaderboard built from complete runs alone cannot see this
    // run's citations, and every domain it introduced would look a week old by
    // the time anything reported it.
    const tenant = await seedTenant(DB_TENANT);
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    const history: [startedAt: string, status: string, domain: string][] = [
      ["2026-02-23T09:00:00Z", "complete", "docs.example.com"],
      ["2026-03-02T09:00:00Z", "running", "g2.com"],
    ];
    let latestRunId = "";
    for (const [startedAt, status, domain] of history) {
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status,
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
        tenantMentions: 3,
        competitorMentions: {},
        ownCitations: 0,
        recommendations: 0,
      });
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
            answerText: "We are among the options.",
            modelId: "gpt-5.1",
            askedAt: new Date(startedAt),
            extraction: { deterministic: { tenantMentioned: true, competitorIds: [], ownDomainCited: false } },
          })
          .returning();
        await db.insert(aiVisibilityCitations).values({
          sampleId: sample.id,
          tenantId: tenant.id,
          runId: run.id,
          url: `https://${domain}/guide`,
          domain,
          position: 1,
          domainClass: "review",
        });
      }
    }

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as AiVisibilityPayload).domain).toBe("g2.com");
  });

  it("needs three distinct absent PROMPTS outside the top ten, not three absent answers", async () => {
    // The blocker this rule was written around: at three samples a prompt, one
    // prompt produces three absent ANSWERS, clears a three-prompt bar on its
    // own, and the title then says "cited on 3 prompts" about one question.
    const tenant = await seedTenant(DB_TENANT);
    const prompts = [];
    for (const text of ["best issue tracker for startups", "issue tracker alternatives"]) {
      const [prompt] = await db
        .insert(aiVisibilityPrompts)
        .values({ tenantId: tenant.id, text, intent: "discovery", origin: "generated", status: "active" })
        .returning();
      prompts.push(prompt);
    }
    // Eleven established domains, so the newcomer lands at rank twelve.
    const fillers = Array.from({ length: 11 }, (_, i) => `filler${i}.example`);

    let latestRunId = "";
    for (const [index, startedAt] of ["2026-02-23T09:00:00Z", "2026-03-02T09:00:00Z"].entries()) {
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

      for (const prompt of prompts) {
        await db.insert(aiVisibilityAggregates).values({
          runId: run.id,
          tenantId: tenant.id,
          engine: "openai",
          promptId: prompt.id,
          n: 3,
          tenantMentions: 3,
          competitorMentions: {},
          ownCitations: 0,
          recommendations: 0,
        });
        for (let s = 0; s < 3; s++) {
          // The newcomer is cited on ONE prompt, in all three of its answers,
          // and the tenant is named in none of them.
          const newcomer = index === 1 && prompt.id === prompts[0].id;
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
              answerText: "text",
              modelId: "gpt-5.1",
              askedAt: new Date(startedAt),
              extraction: {
                deterministic: { tenantMentioned: !newcomer, competitorIds: [], ownDomainCited: false },
              },
            })
            .returning();
          const domains = newcomer ? [...fillers, "newcomer.example"] : fillers;
          await db.insert(aiVisibilityCitations).values(
            domains.map((domain, position) => ({
              sampleId: sample.id,
              tenantId: tenant.id,
              runId: run.id,
              url: `https://${domain}/x`,
              domain,
              position: position + 1,
              domainClass: "other",
            }))
          );
        }
      }
    }

    const out = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
  });

  it("says nothing about a run whose aggregates were never written", async () => {
    // Aggregates are the permanent record for a run; `finalizeRun` writes them
    // before it calls this. Without them every rate is missing, and a domain
    // leaderboard on its own is not grounds for a brief.
    const tenant = await seedTenant(DB_TENANT);
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    // A previous run exists, so the first-run rule is not what is being
    // tested — but nothing in the window ever produced an aggregate row.
    await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete", startedAt: new Date("2026-02-23T09:00:00Z") });

    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete", startedAt: new Date("2026-03-02T09:00:00Z") })
      .returning();
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
          answerText: "text",
          extraction: { deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false } },
        })
        .returning();
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

    const out = await emitSignals(run.id, { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
  });

  it("reads a prompt with no row in the previous run as unmeasured, not as a zero", async () => {
    // Three prompts approved this week. Their previous run has no row for
    // them at all, which is "we did not ask", not "the competitor was absent"
    // — and reading it as the latter manufactures a competitor takeover out of
    // prompts that have only ever been asked once.
    const tenant = await seedTenant(DB_TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const [older] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete", modelIds: { openai: "gpt-5.1" }, startedAt: new Date("2026-02-23T09:00:00Z") })
      .returning();
    // An engine-level row only: the previous run existed and measured
    // something, just not these prompts.
    await db.insert(aiVisibilityAggregates).values({
      runId: older.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: null,
      n: 30,
      tenantMentions: 15,
      competitorMentions: { [rival.id]: 15 },
      ownCitations: 0,
      recommendations: 0,
    });

    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "complete", modelIds: { openai: "gpt-5.1" }, startedAt: new Date("2026-03-02T09:00:00Z") })
      .returning();
    for (const text of ["prompt one", "prompt two", "prompt three"]) {
      const [prompt] = await db
        .insert(aiVisibilityPrompts)
        .values({ tenantId: tenant.id, text, intent: "discovery", origin: "generated", status: "active" })
        .returning();
      await db.insert(aiVisibilityAggregates).values({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: prompt.id,
        n: 3,
        tenantMentions: 1,
        competitorMentions: { [rival.id]: 3 },
        ownCitations: 0,
        recommendations: 0,
      });
    }

    const out = await emitSignals(run.id, { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
  });

  it("returns zero for a run id that does not exist", async () => {
    const out = await emitSignals(randomUUID(), { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
  });

  it("quotes the answer text when the judge left no quote", async () => {
    const { tenant, latestRunId } = await seedGap();
    // A row a successful judge chunk closed out without a label: eligible,
    // unflagged, no quote. Its answer is still real evidence.
    await db
      .update(aiVisibilitySamples)
      .set({
        extraction: {
          deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false },
        },
      })
      .where(eq(aiVisibilitySamples.runId, latestRunId));

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows[0].excerpt).toBe("Rival is the strongest option (run 1).");
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

  it("does not treat an engine's first known model id as a version change", async () => {
    // The previous run recorded no model id for this engine — it was added
    // this run, or the column predates the id being captured. A first sighting
    // is not a change, and reading it as one silences the engine's first run
    // completely.
    const { tenant, latestRunId } = await seedLostMention();
    const [previous] = await db
      .select({ id: aiVisibilityRuns.id })
      .from(aiVisibilityRuns)
      .where(and(eq(aiVisibilityRuns.tenantId, tenant.id), eq(aiVisibilityRuns.startedAt, new Date("2026-02-23T09:00:00Z"))));
    await db.update(aiVisibilityRuns).set({ modelIds: {} }).where(eq(aiVisibilityRuns.id, previous.id));

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(await emittedTypes(tenant.id)).toContain("lost_mention");
  });

  it("keys the dedupe week off the run, not off when it was finalized", async () => {
    // A run finalized a fortnight late — a retry, a backfill — must reproduce
    // the same key. Deriving the week from the wall clock would make
    // idempotency depend on when the retry happened.
    const { tenant, latestRunId } = await seedGap();

    const first = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });
    const late = await emitSignals(latestRunId, { now: clock("2026-03-16T10:00:00Z") });

    expect(first.written).toBe(1);
    expect(late.written).toBe(0);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId.endsWith("2026-W10")).toBe(true);
  });

  it("quotes an eligible answer, never a flagged one", async () => {
    // A flagged row is one the judge could not verify. It is excluded from
    // every rate for that reason, and a quote pulled from it would be evidence
    // we have already decided not to trust.
    const { tenant, latestRunId } = await seedGap();
    const [firstSample] = await db
      .select({ id: aiVisibilitySamples.id })
      .from(aiVisibilitySamples)
      .where(and(eq(aiVisibilitySamples.runId, latestRunId), eq(aiVisibilitySamples.sampleIndex, 0)));
    await db
      .update(aiVisibilitySamples)
      .set({ flagged: true, answerText: "UNVERIFIED", extraction: {
        deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false },
        judged: {
          orderedBrands: [],
          level: "absent",
          framing: "not named",
          quote: "UNVERIFIED",
          positioningClaims: [],
          hallucinations: [],
          answerType: "list",
        },
      } })
      .where(eq(aiVisibilitySamples.id, firstSample.id));

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows[0].excerpt).toBe("Rival is the strongest option (run 1).");
  });

  it("treats a brand_check prompt as branded even when the flag is not set", async () => {
    // `gap_vs_competitor` is a non-brand rule. "What is Acme?" naming a
    // competitor instead of us is a different finding, and the intent is as
    // good a statement that the prompt is about us as the boolean is.
    const { tenant, prompt, latestRunId } = await seedGap();
    await db
      .update(aiVisibilityPrompts)
      .set({ intent: "brand_check", branded: false })
      .where(eq(aiVisibilityPrompts.id, prompt.id));

    const out = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(out).toEqual({ written: 0, considered: 0 });
    expect(await emittedTypes(tenant.id)).toEqual([]);
  });

  it("does not let a failed run take a slot in the window", async () => {
    // A failed run has a partial sample set by definition. Admitted to the
    // window it pushes the strong run out of the third slot and the loss the
    // tenant actually suffered goes unreported.
    const tenant = await seedTenant(DB_TENANT);
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    let latestRunId = "";
    const history: [startedAt: string, tenantMentions: number, status: string][] = [
      ["2026-02-09T09:00:00Z", 3, "complete"], // strong
      ["2026-02-16T09:00:00Z", 0, "failed"], // half a run — not evidence of anything
      ["2026-02-23T09:00:00Z", 0, "complete"],
      ["2026-03-02T09:00:00Z", 0, "complete"],
    ];
    for (const [startedAt, tenantMentions, status] of history) {
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          trigger: "scheduled",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status,
          modelIds: { openai: "gpt-5.1" },
          startedAt: new Date(startedAt),
        })
        .returning();
      if (status === "complete") latestRunId = run.id;
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

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(await emittedTypes(tenant.id)).toEqual(["lost_mention"]);
  });

  /**
   * Five weekly runs. The four newest are the window, the oldest is the window
   * before it — the only place `sovPrev` can come from. Share of voice goes
   * 50% → 10%, all of it to one competitor; the prompt underneath goes strong
   * → absent → absent, which on its own is a textbook `lost_mention`.
   *
   * `previousN` is the previous window's sample count: at the default it
   * clears `MIN_N_AGGREGATE`, and below it the move is real but unpublishable.
   */
  async function seedEngineShare({ previousN = 30, currentN = 30 } = {}) {
    const tenant = await seedTenant(DB_TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    const startedAts = [
      "2026-02-02T09:00:00Z",
      "2026-02-09T09:00:00Z",
      "2026-02-16T09:00:00Z",
      "2026-02-23T09:00:00Z",
      "2026-03-02T09:00:00Z",
    ];
    let latestRunId = "";
    for (const [index, startedAt] of startedAts.entries()) {
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

      const previousWindow = index === 0;
      await db.insert(aiVisibilityAggregates).values({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: null,
        n: previousWindow ? previousN : currentN,
        tenantMentions: previousWindow ? previousN / 2 : Math.round(currentN / 10),
        competitorMentions: {
          [rival.id]: previousWindow ? previousN / 2 : currentN - Math.round(currentN / 10),
        },
        ownCitations: 0,
        recommendations: 0,
      });
      await db.insert(aiVisibilityAggregates).values({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: prompt.id,
        n: 3,
        tenantMentions: index >= 3 ? 0 : 3,
        competitorMentions: {},
        ownCitations: 0,
        recommendations: 0,
      });
    }
    return { tenant, rival, latestRunId };
  }

  it("does not summarise a move measured below the display threshold", async () => {
    // The previous window collected 10 answers. Its 50% is not a number the
    // dashboard will show a human, so it must not silently drive a signal
    // either — and the per-prompt lost_mention comes through instead.
    const { tenant, latestRunId } = await seedEngineShare({ previousN: 10 });

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(await emittedTypes(tenant.id)).toEqual(["lost_mention"]);
    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    // The per-prompt one, not the engine-wide summary.
    expect((row.payload as AiVisibilityPayload).promptId).toBeTruthy();
  });

  it("does not summarise when THIS window is below the display threshold", async () => {
    // Five answers a run, twenty in the window. The fall is real in the data
    // and unpublishable as a number, so it must not drive a signal either.
    const { tenant, latestRunId } = await seedEngineShare({ currentN: 5 });

    await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    expect(await emittedTypes(tenant.id)).toEqual(["lost_mention"]);
    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect((row.payload as AiVisibilityPayload).promptId).toBeTruthy();
  });

  it("emits an engine-wide summary and suppresses that engine's per-prompt change signals", async () => {
    const { tenant, rival, latestRunId } = await seedEngineShare();

    const out = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });

    // "One summary rather than per-prompt ones": exactly one row, and it is
    // the engine-wide one — the per-prompt lost_mention is suppressed.
    expect(out.written).toBe(1);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(`competitor_gained:${rival.id}:openai:2026-W10`);
    expect(rows[0].competitorId).toBe(rival.id);
    expect((rows[0].payload as AiVisibilityPayload).samples).toBe("share of voice 50% to 10%");
    expect((rows[0].payload as AiVisibilityPayload).promptId).toBeUndefined();
  });

  it("emits nothing for a tenant that tracks no competitors", async () => {
    const tenant = await seedTenant(DB_TENANT);
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    let latestRunId = "";
    for (const startedAt of ["2026-02-23T09:00:00Z", "2026-03-02T09:00:00Z"]) {
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
        tenantMentions: 0,
        competitorMentions: {},
        ownCitations: 0,
        recommendations: 0,
      });
    }

    // Absent twice over, but with nobody to be absent against: `gap_vs_competitor`
    // has no subject and the rule must simply not fire, not name a competitor
    // that does not exist.
    const out = await emitSignals(latestRunId, { now: clock("2026-03-02T10:00:00Z") });
    expect(out).toEqual({ written: 0, considered: 0 });
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

  /**
   * Six weekly runs on one prompt where the tenant is always named, so nothing
   * but the finding under test can fire. `citedFrom` is the index of the first
   * run whose answers cite g2.com; `ownCitedIn` is the index of the one run
   * that cited a page of ours.
   */
  async function seedHistory(opts: { citedFrom?: number; ownCitedIn?: number } = {}) {
    const tenant = await seedTenant(DB_TENANT);
    const [source] = await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "ai_visibility", label: "AI visibility" })
      .returning();
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker for startups", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    const startedAts = [
      "2026-01-26T09:00:00Z",
      "2026-02-02T09:00:00Z",
      "2026-02-09T09:00:00Z",
      "2026-02-16T09:00:00Z",
      "2026-02-23T09:00:00Z",
      "2026-03-02T09:00:00Z",
    ];
    const runIds: string[] = [];

    for (const [index, startedAt] of startedAts.entries()) {
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

      const ownCitations = opts.ownCitedIn === index ? 3 : 0;
      await db.insert(aiVisibilityAggregates).values({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: prompt.id,
        n: 3,
        tenantMentions: 3,
        competitorMentions: {},
        ownCitations,
        recommendations: 0,
      });

      const citesG2 = opts.citedFrom !== undefined && index >= opts.citedFrom;
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
            answerText: "We are among the options.",
            modelId: "gpt-5.1",
            askedAt: new Date(startedAt),
            extraction: {
              deterministic: { tenantMentioned: true, competitorIds: [], ownDomainCited: ownCitations > 0 },
            },
          })
          .returning();
        await db.insert(aiVisibilityCitations).values({
          sampleId: sample.id,
          tenantId: tenant.id,
          runId: run.id,
          url: citesG2 ? "https://g2.com/categories/issue-tracking" : "https://docs.example.com/guide",
          domain: citesG2 ? "g2.com" : "docs.example.com",
          position: 1,
          domainClass: citesG2 ? "review" : "docs",
        });
      }
    }

    return { tenant, prompt, runIds };
  }

  async function typesWritten(tenantId: string) {
    return (await emittedTypes(tenantId)).filter(Boolean);
  }

  it("emits own_page_cited once, not once per run the citation stays in the window", async () => {
    // The citation lands in run index 4 and never repeats. Under a window-wide
    // test it re-qualifies at 4, 5, 6 and 7 — four different ISO weeks, so the
    // dedupe index absorbs none of them.
    const { tenant, runIds } = await seedHistory({ ownCitedIn: 4 });

    await emitSignals(runIds[4], { now: clock("2026-02-23T10:00:00Z") });
    await emitSignals(runIds[5], { now: clock("2026-03-02T10:00:00Z") });

    const own = (await typesWritten(tenant.id)).filter((type) => type === "own_page_cited");
    expect(own).toHaveLength(1);
  });

  it("emits new_cited_domain once for a domain, not again while it stays in the window", async () => {
    // g2.com is first cited in run index 4. It is genuinely new there and old
    // everywhere after.
    const { tenant, runIds } = await seedHistory({ citedFrom: 4 });

    await emitSignals(runIds[4], { now: clock("2026-02-23T10:00:00Z") });
    const afterFirst = (await typesWritten(tenant.id)).filter((t) => t === "new_cited_domain");
    expect(afterFirst).toHaveLength(1);

    await emitSignals(runIds[5], { now: clock("2026-03-02T10:00:00Z") });
    const afterSecond = (await typesWritten(tenant.id)).filter((t) => t === "new_cited_domain");
    expect(afterSecond).toHaveLength(1);
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
