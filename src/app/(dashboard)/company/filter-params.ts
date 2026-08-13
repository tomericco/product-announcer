/**
 * The query-param contract for the Company page's two pipeline sections.
 *
 * Both sections live on the SAME url (`/company`), so each one's filters must
 * be namespaced or they collide — both use "showHidden" as a concept, and both
 * would otherwise fight over it. That namespacing is the whole reason this
 * module exists as a module: the filter bar (a client component) WRITES the
 * keys and the section (a Server Component) READS them back, and when each
 * side derived its own key names independently they silently drifted — the
 * bars emitted `cetype`/`ceprovider`/`ceshowHidden` while the sections read
 * `ceType`/`ceProvider`/`ceShowHidden`. Query keys are case-sensitive, so
 * every control on both sections was a no-op: the URL changed, the section
 * parsed `undefined`, the list came back identical and the Select snapped
 * back to its old value. Nothing failed loudly, and no test covered the seam.
 *
 * So the seam is now one place. `writeChangeEventsFilters` and
 * `readChangeEventsFilters` (and their atomic-update twins) are inverses of
 * each other by construction, and `tests/app/company-filter-params.test.ts`
 * asserts the round trip directly.
 *
 * Deliberately a plain module with no "use client" and no `db` import: it is
 * imported by both a client component and a server component, so it must be
 * safe in either bundle. (Note it must NOT live inside a "use client" file:
 * a Server Component importing from one gets client *references*, not the
 * functions themselves.)
 */

export type SearchParamsRecord = { [key: string]: string | string[] | undefined };

export const CHANGE_EVENTS_PREFIX = "ce";
export const ATOMIC_UPDATES_PREFIX = "au";

/**
 * The one key derivation both sides share. camelCases the name under the
 * prefix — `("ce", "showHidden")` → `"ceShowHidden"` — so the keys read like
 * the props they carry instead of the all-lowercase run that bare
 * concatenation produced.
 */
export function filterParamKey(prefix: string, name: string): string {
  if (!prefix) return name;
  return `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readOption<T extends string>(
  params: SearchParamsRecord,
  prefix: string,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = single(params[filterParamKey(prefix, name)]);
  return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

export const CHANGE_EVENT_TYPES = ["all", "commit", "pull_request", "task"] as const;
export const CHANGE_EVENT_PROVIDERS = ["all", "github", "notion"] as const;
export const CHANGE_EVENT_ASSIGNMENTS = ["all", "assigned", "unassigned"] as const;

export type ChangeEventsFilterState = {
  type: (typeof CHANGE_EVENT_TYPES)[number];
  provider: (typeof CHANGE_EVENT_PROVIDERS)[number];
  assignment: (typeof CHANGE_EVENT_ASSIGNMENTS)[number];
  showHidden: boolean;
};

/**
 * `assignment` defaults to "unassigned", not "all": the section opens as the
 * ungrouped queue (the design doc's framing, and the state that matters —
 * an ungrouped event has no atomic update, so no signal, so no drawer, so
 * nowhere else to be reached from). The filter is still offered, because
 * bulk delete and bulk reassign over GROUPED events exist nowhere else once
 * the standalone tab is gone.
 */
export const CHANGE_EVENTS_DEFAULTS: ChangeEventsFilterState = {
  type: "all",
  provider: "all",
  assignment: "unassigned",
  showHidden: false,
};

export function readChangeEventsFilters(
  params: SearchParamsRecord,
  prefix: string = CHANGE_EVENTS_PREFIX
): ChangeEventsFilterState {
  return {
    type: readOption(params, prefix, "type", CHANGE_EVENT_TYPES, CHANGE_EVENTS_DEFAULTS.type),
    provider: readOption(params, prefix, "provider", CHANGE_EVENT_PROVIDERS, CHANGE_EVENTS_DEFAULTS.provider),
    assignment: readOption(
      params,
      prefix,
      "assignment",
      CHANGE_EVENT_ASSIGNMENTS,
      CHANGE_EVENTS_DEFAULTS.assignment
    ),
    showHidden: single(params[filterParamKey(prefix, "showHidden")]) === "1",
  };
}

/**
 * Returns a NEW `URLSearchParams` built from `base` with this section's keys
 * replaced by `state`. Merging against the caller's current params (rather
 * than starting empty) is what preserves the OTHER section's filters across a
 * push; a key at its default value is deleted rather than written, so a
 * default-state url stays clean.
 */
export function writeChangeEventsFilters(
  base: URLSearchParams,
  state: ChangeEventsFilterState,
  prefix: string = CHANGE_EVENTS_PREFIX
): URLSearchParams {
  const params = new URLSearchParams(base.toString());
  for (const name of ["type", "provider", "assignment", "showHidden"]) {
    params.delete(filterParamKey(prefix, name));
  }
  if (state.type !== CHANGE_EVENTS_DEFAULTS.type) params.set(filterParamKey(prefix, "type"), state.type);
  if (state.provider !== CHANGE_EVENTS_DEFAULTS.provider) {
    params.set(filterParamKey(prefix, "provider"), state.provider);
  }
  if (state.assignment !== CHANGE_EVENTS_DEFAULTS.assignment) {
    params.set(filterParamKey(prefix, "assignment"), state.assignment);
  }
  if (state.showHidden !== CHANGE_EVENTS_DEFAULTS.showHidden) {
    params.set(filterParamKey(prefix, "showHidden"), "1");
  }
  return params;
}

export function changeEventsFiltersAreDefault(state: ChangeEventsFilterState): boolean {
  return (
    state.type === CHANGE_EVENTS_DEFAULTS.type &&
    state.provider === CHANGE_EVENTS_DEFAULTS.provider &&
    state.assignment === CHANGE_EVENTS_DEFAULTS.assignment &&
    state.showHidden === CHANGE_EVENTS_DEFAULTS.showHidden
  );
}

// ---------------------------------------------------------------------------
// Atomic updates
// ---------------------------------------------------------------------------

export const ATOMIC_UPDATE_CATEGORIES = ["all", "new", "improvement", "fix", "announcement"] as const;
export const ATOMIC_UPDATE_SIZES = ["all", "s", "m", "l", "xl"] as const;

export type AtomicUpdatesFilterState = {
  category: (typeof ATOMIC_UPDATE_CATEGORIES)[number];
  size: (typeof ATOMIC_UPDATE_SIZES)[number];
  showHidden: boolean;
};

export const ATOMIC_UPDATES_DEFAULTS: AtomicUpdatesFilterState = {
  category: "all",
  size: "all",
  showHidden: false,
};

export function readAtomicUpdatesFilters(
  params: SearchParamsRecord,
  prefix: string = ATOMIC_UPDATES_PREFIX
): AtomicUpdatesFilterState {
  return {
    category: readOption(
      params,
      prefix,
      "category",
      ATOMIC_UPDATE_CATEGORIES,
      ATOMIC_UPDATES_DEFAULTS.category
    ),
    size: readOption(params, prefix, "size", ATOMIC_UPDATE_SIZES, ATOMIC_UPDATES_DEFAULTS.size),
    showHidden: single(params[filterParamKey(prefix, "showHidden")]) === "1",
  };
}

export function writeAtomicUpdatesFilters(
  base: URLSearchParams,
  state: AtomicUpdatesFilterState,
  prefix: string = ATOMIC_UPDATES_PREFIX
): URLSearchParams {
  const params = new URLSearchParams(base.toString());
  for (const name of ["category", "size", "showHidden"]) {
    params.delete(filterParamKey(prefix, name));
  }
  if (state.category !== ATOMIC_UPDATES_DEFAULTS.category) {
    params.set(filterParamKey(prefix, "category"), state.category);
  }
  if (state.size !== ATOMIC_UPDATES_DEFAULTS.size) params.set(filterParamKey(prefix, "size"), state.size);
  if (state.showHidden !== ATOMIC_UPDATES_DEFAULTS.showHidden) {
    params.set(filterParamKey(prefix, "showHidden"), "1");
  }
  return params;
}

export function atomicUpdatesFiltersAreDefault(state: AtomicUpdatesFilterState): boolean {
  return (
    state.category === ATOMIC_UPDATES_DEFAULTS.category &&
    state.size === ATOMIC_UPDATES_DEFAULTS.size &&
    state.showHidden === ATOMIC_UPDATES_DEFAULTS.showHidden
  );
}

/**
 * Builds the `?…` suffix for a push, or "" when nothing is set. Kept here so
 * both bars navigate identically.
 */
export function toQuerySuffix(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
