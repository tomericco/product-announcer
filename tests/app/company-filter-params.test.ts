import { describe, it, expect } from "vitest";
import {
  ATOMIC_UPDATES_DEFAULTS,
  ATOMIC_UPDATE_CATEGORIES,
  ATOMIC_UPDATE_SIZES,
  CHANGE_EVENTS_DEFAULTS,
  CHANGE_EVENT_ASSIGNMENTS,
  CHANGE_EVENT_PROVIDERS,
  CHANGE_EVENT_TYPES,
  atomicUpdatesFiltersAreDefault,
  changeEventsFiltersAreDefault,
  filterParamKey,
  readAtomicUpdatesFilters,
  readChangeEventsFilters,
  writeAtomicUpdatesFilters,
  writeChangeEventsFilters,
  type AtomicUpdatesFilterState,
  type ChangeEventsFilterState,
  type SearchParamsRecord,
} from "../../src/app/(dashboard)/company/filter-params";

/**
 * The contract nothing covered before, and which two reviews therefore
 * missed: the key a filter BAR writes must be the key its SECTION reads.
 *
 * The bug this pins down: the bars derived keys by bare concatenation
 * (`${prefix}${name}` → "cetype", "ceprovider", "ceshowHidden",
 * "aucategory", "ausize", "aushowHidden") while the sections read camelCase
 * ("ceType", "ceProvider", "ceShowHidden", "auCategory", "auSize",
 * "auShowHidden"). Query keys are case-sensitive, so all six controls were
 * no-ops — the URL changed, the section parsed `undefined`, and the list came
 * back identical. It was invisible rather than merely annoying, because
 * "Show hidden" on the atomic-updates section is the ONLY way to list a
 * hidden atomic update (`listAtomicUpdates` is `status='open'` without it) and
 * therefore the only entry point to Unhide anywhere in the product; likewise
 * a change event detached by "Remove event from this update" lands at
 * `status='excluded'`, which `listChangeEvents` hides unless `showHidden`.
 */

/** Renders written params back into the shape a Server Component receives. */
function asSearchParams(params: URLSearchParams): SearchParamsRecord {
  const record: SearchParamsRecord = {};
  for (const [key, value] of params.entries()) record[key] = value;
  return record;
}

function changeEventStates(): ChangeEventsFilterState[] {
  const states: ChangeEventsFilterState[] = [];
  for (const type of CHANGE_EVENT_TYPES) {
    for (const provider of CHANGE_EVENT_PROVIDERS) {
      for (const assignment of CHANGE_EVENT_ASSIGNMENTS) {
        for (const showHidden of [false, true]) {
          states.push({ type, provider, assignment, showHidden });
        }
      }
    }
  }
  return states;
}

function atomicUpdateStates(): AtomicUpdatesFilterState[] {
  const states: AtomicUpdatesFilterState[] = [];
  for (const category of ATOMIC_UPDATE_CATEGORIES) {
    for (const size of ATOMIC_UPDATE_SIZES) {
      for (const showHidden of [false, true]) {
        states.push({ category, size, showHidden });
      }
    }
  }
  return states;
}

describe("filterParamKey", () => {
  it("camelCases the name under its prefix", () => {
    expect(filterParamKey("ce", "type")).toBe("ceType");
    expect(filterParamKey("ce", "showHidden")).toBe("ceShowHidden");
    expect(filterParamKey("au", "category")).toBe("auCategory");
  });

  it("passes the bare name through when there is no prefix", () => {
    expect(filterParamKey("", "type")).toBe("type");
  });
});

describe("change-events filter params", () => {
  it("round-trips every combination the bar can produce", () => {
    for (const state of changeEventStates()) {
      const written = writeChangeEventsFilters(new URLSearchParams(), state);
      expect(readChangeEventsFilters(asSearchParams(written))).toEqual(state);
    }
  });

  it("writes the exact literal keys the section reads", () => {
    const written = writeChangeEventsFilters(new URLSearchParams(), {
      type: "commit",
      provider: "notion",
      assignment: "all",
      showHidden: true,
    });
    expect(written.get("ceType")).toBe("commit");
    expect(written.get("ceProvider")).toBe("notion");
    expect(written.get("ceAssignment")).toBe("all");
    expect(written.get("ceShowHidden")).toBe("1");

    // …and the reader picks up those same literal keys when they arrive by
    // hand (a bookmarked url), not just ones it wrote itself.
    expect(
      readChangeEventsFilters({
        ceType: "commit",
        ceProvider: "notion",
        ceAssignment: "all",
        ceShowHidden: "1",
      })
    ).toEqual({ type: "commit", provider: "notion", assignment: "all", showHidden: true });
  });

  it("opens as the ungrouped queue when nothing is in the url", () => {
    expect(readChangeEventsFilters({})).toEqual(CHANGE_EVENTS_DEFAULTS);
    expect(CHANGE_EVENTS_DEFAULTS.assignment).toBe("unassigned");
  });

  it("drops a malformed value back to its default instead of passing it to the query", () => {
    expect(
      readChangeEventsFilters({ ceType: "'; drop table change_events; --", ceProvider: "bogus" })
    ).toEqual(CHANGE_EVENTS_DEFAULTS);
  });

  it("takes the first value of a repeated param", () => {
    expect(readChangeEventsFilters({ ceType: ["commit", "task"] }).type).toBe("commit");
  });

  it("writes no keys at all for the default state", () => {
    const written = writeChangeEventsFilters(new URLSearchParams(), CHANGE_EVENTS_DEFAULTS);
    expect(written.toString()).toBe("");
    expect(changeEventsFiltersAreDefault(CHANGE_EVENTS_DEFAULTS)).toBe(true);
  });

  it("preserves the other section's params, and clears only its own", () => {
    // Both sections share one url, so a push from either bar must merge
    // rather than rebuild — otherwise changing a change-events filter would
    // silently reset the atomic-updates ledger's own filters.
    const base = new URLSearchParams("auCategory=fix&auShowHidden=1&ceType=task");
    const written = writeChangeEventsFilters(base, CHANGE_EVENTS_DEFAULTS);
    expect(written.get("auCategory")).toBe("fix");
    expect(written.get("auShowHidden")).toBe("1");
    expect(written.get("ceType")).toBeNull();
  });
});

describe("atomic-updates filter params", () => {
  it("round-trips every combination the bar can produce", () => {
    for (const state of atomicUpdateStates()) {
      const written = writeAtomicUpdatesFilters(new URLSearchParams(), state);
      expect(readAtomicUpdatesFilters(asSearchParams(written))).toEqual(state);
    }
  });

  it("writes the exact literal keys the section reads", () => {
    const written = writeAtomicUpdatesFilters(new URLSearchParams(), {
      category: "fix",
      size: "xl",
      showHidden: true,
    });
    expect(written.get("auCategory")).toBe("fix");
    expect(written.get("auSize")).toBe("xl");
    expect(written.get("auShowHidden")).toBe("1");

    expect(readAtomicUpdatesFilters({ auCategory: "fix", auSize: "xl", auShowHidden: "1" })).toEqual({
      category: "fix",
      size: "xl",
      showHidden: true,
    });
  });

  it("reaches hidden updates — the only entry point to Unhide", () => {
    const written = writeAtomicUpdatesFilters(new URLSearchParams(), {
      ...ATOMIC_UPDATES_DEFAULTS,
      showHidden: true,
    });
    expect(readAtomicUpdatesFilters(asSearchParams(written)).showHidden).toBe(true);
  });

  it("drops a malformed value back to its default", () => {
    expect(readAtomicUpdatesFilters({ auCategory: "bogus", auSize: "xxl" })).toEqual(
      ATOMIC_UPDATES_DEFAULTS
    );
    expect(atomicUpdatesFiltersAreDefault(readAtomicUpdatesFilters({}))).toBe(true);
  });

  it("preserves the other section's params, and clears only its own", () => {
    const base = new URLSearchParams("ceType=task&auSize=l");
    const written = writeAtomicUpdatesFilters(base, ATOMIC_UPDATES_DEFAULTS);
    expect(written.get("ceType")).toBe("task");
    expect(written.get("auSize")).toBeNull();
  });
});

describe("the two sections' key spaces", () => {
  it("do not collide, including on the shared showHidden concept", () => {
    const ce = writeChangeEventsFilters(new URLSearchParams(), {
      type: "task",
      provider: "github",
      assignment: "assigned",
      showHidden: true,
    });
    const both = writeAtomicUpdatesFilters(ce, { category: "new", size: "s", showHidden: false });

    // The change-events section still sees its own values untouched…
    expect(readChangeEventsFilters(asSearchParams(both))).toEqual({
      type: "task",
      provider: "github",
      assignment: "assigned",
      showHidden: true,
    });
    // …while the atomic-updates section reads its own, opposite, showHidden.
    expect(readAtomicUpdatesFilters(asSearchParams(both))).toEqual({
      category: "new",
      size: "s",
      showHidden: false,
    });
  });
});
