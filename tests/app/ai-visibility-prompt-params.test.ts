import { describe, it, expect } from "vitest";
import { PROMPT_INTENTS } from "../../src/lib/ai-visibility/types";
import {
  PROMPTS_FILTER_DEFAULTS,
  PROMPT_STATUS_FILTERS,
  personaFilterOptions,
  promptsFiltersAreDefault,
  readPromptsFilters,
  writePromptsFilters,
  type PromptsFilterState,
  type SearchParamsRecord,
} from "../../src/app/(dashboard)/ai-visibility/prompts/filter-params";

const PERSONAS = ["Head of Design", "Localization manager"];
const COMPETITOR_IDS = ["11111111-1111-4111-8111-111111111111"];

function asSearchParams(params: URLSearchParams): SearchParamsRecord {
  const record: SearchParamsRecord = {};
  for (const [key, value] of params.entries()) record[key] = value;
  return record;
}

function everyState(): PromptsFilterState[] {
  const states: PromptsFilterState[] = [];
  for (const intent of ["all", ...PROMPT_INTENTS] as PromptsFilterState["intent"][]) {
    for (const persona of ["all", ...PERSONAS]) {
      for (const competitor of ["all", ...COMPETITOR_IDS]) {
        for (const status of PROMPT_STATUS_FILTERS) {
          states.push({ intent, persona, competitor, status });
        }
      }
    }
  }
  return states;
}

describe("prompts filter params", () => {
  it("round-trips every combination the bar can produce", () => {
    for (const state of everyState()) {
      const written = writePromptsFilters(new URLSearchParams(), state);
      expect(readPromptsFilters(asSearchParams(written), PERSONAS, COMPETITOR_IDS)).toEqual(state);
    }
  });

  it("writes the exact literal keys the page reads", () => {
    const written = writePromptsFilters(new URLSearchParams(), {
      intent: "comparison",
      persona: "Head of Design",
      competitor: COMPETITOR_IDS[0],
      status: "paused",
    });
    expect(written.get("intent")).toBe("comparison");
    expect(written.get("persona")).toBe("Head of Design");
    expect(written.get("competitor")).toBe(COMPETITOR_IDS[0]);
    expect(written.get("status")).toBe("paused");

    expect(
      readPromptsFilters(
        { intent: "comparison", persona: "Head of Design", competitor: COMPETITOR_IDS[0], status: "paused" },
        PERSONAS,
        COMPETITOR_IDS
      )
    ).toEqual({
      intent: "comparison",
      persona: "Head of Design",
      competitor: COMPETITOR_IDS[0],
      status: "paused",
    });
  });

  it("writes no keys at all for the default state", () => {
    const written = writePromptsFilters(new URLSearchParams(), PROMPTS_FILTER_DEFAULTS);
    expect(written.toString()).toBe("");
    expect(promptsFiltersAreDefault(PROMPTS_FILTER_DEFAULTS)).toBe(true);
  });

  it("drops a malformed intent or status back to its default", () => {
    expect(
      readPromptsFilters(
        { intent: "'; drop table ai_visibility_prompts; --", status: "deleted" },
        PERSONAS,
        COMPETITOR_IDS
      )
    ).toEqual(PROMPTS_FILTER_DEFAULTS);
  });

  it("drops a competitor id that is not one of this tenant's, rather than sending it to Postgres", () => {
    // The one filter value that reaches a uuid-typed column. A non-uuid there
    // raises 22P02 inside the Server Component and turns the page into a hard
    // error with no way back to "Clear filters" — the exact failure
    // `parseCompetitorId` in lib/signals/params.ts documents.
    expect(readPromptsFilters({ competitor: "not-a-uuid" }, PERSONAS, COMPETITOR_IDS).competitor).toBe("all");
    expect(
      readPromptsFilters({ competitor: "22222222-2222-4222-8222-222222222222" }, PERSONAS, COMPETITOR_IDS)
        .competitor
    ).toBe("all");
  });

  it("drops a persona the profile no longer has, so a deleted persona cannot empty the list forever", () => {
    expect(readPromptsFilters({ persona: "Retired persona" }, PERSONAS, COMPETITOR_IDS).persona).toBe("all");
  });

  it("builds the persona whitelist from display NAMES — a system persona ref resolves through the catalog", () => {
    // `ai_visibility_prompts.persona` stores the RESOLVED display name (B5
    // runs `resolvePersonaRefs` before writing), so the filter must offer
    // and accept names. Offering the system key would produce an option
    // that matches zero rows and a whitelist that rejects the deep link
    // `?persona=Head of Design`.
    const options = personaFilterOptions(
      [
        { type: "system", key: "design_manager" },
        { type: "custom", name: "Indie developer", brief: "ships alone" },
      ],
      [{ key: "design_manager", name: "Head of Design", brief: "runs the design org" }]
    );

    expect(options).toEqual(["Head of Design", "Indie developer"]);
    expect(readPromptsFilters({ persona: "Head of Design" }, options, COMPETITOR_IDS).persona).toBe(
      "Head of Design"
    );
    // The raw system key is never a stored value, so it is never a filter.
    expect(readPromptsFilters({ persona: "design_manager" }, options, COMPETITOR_IDS).persona).toBe("all");
  });

  it("takes the first value of a repeated param", () => {
    expect(readPromptsFilters({ intent: ["pricing", "how_to"] }, PERSONAS, COMPETITOR_IDS).intent).toBe(
      "pricing"
    );
  });

  it("preserves an unrelated param, so a deep link keeps its other keys", () => {
    const base = new URLSearchParams("highlight=p1");
    const written = writePromptsFilters(base, { ...PROMPTS_FILTER_DEFAULTS, status: "paused" });
    expect(written.get("highlight")).toBe("p1");
    expect(written.get("status")).toBe("paused");
  });
});
