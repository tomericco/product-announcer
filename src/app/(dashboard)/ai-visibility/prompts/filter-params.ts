import type { PersonaRef } from "@/db/schema";
import { resolvePersonaRefs } from "@/lib/workspace/personas";
import { PROMPT_INTENTS, type PromptIntent } from "@/lib/ai-visibility/types";

export type SearchParamsRecord = { [key: string]: string | string[] | undefined };

export const PROMPT_STATUS_FILTERS = ["all", "active", "paused"] as const;

/**
 * The persona filter's options AND `readPromptsFilters`' whitelist, in one
 * derivation, so they cannot drift: display names, resolved through the
 * system-persona catalog exactly as B5's generator resolves them before
 * writing `ai_visibility_prompts.persona`. A system ref's KEY
 * ("design_manager"-style) never appears — no prompt row stores it, so a
 * key-shaped option would filter the list to nothing and the whitelist
 * would reject a legitimate `?persona=Head of Design` deep link.
 *
 * Type- and function-imports only, so this stays safe on both sides of the
 * client boundary like everything else in this module.
 */
export function personaFilterOptions(
  refs: PersonaRef[],
  catalog: Parameters<typeof resolvePersonaRefs>[1]
): string[] {
  return resolvePersonaRefs(refs, catalog).map((persona) => persona.name);
}

export type PromptsFilterState = {
  intent: "all" | PromptIntent;
  persona: string;
  competitor: string;
  status: (typeof PROMPT_STATUS_FILTERS)[number];
};

/**
 * "all" for status means active AND paused, never `proposed` — unreviewed
 * proposals belong to the suggestions strip at the top of the page, where
 * they are approved as a batch. Mixing them into the list would make the
 * count badge ("28 / 30") disagree with what is on screen and offer a Switch
 * on a prompt that has never been approved.
 */
export const PROMPTS_FILTER_DEFAULTS: PromptsFilterState = {
  intent: "all",
  persona: "all",
  competitor: "all",
  status: "all",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readOption<T extends string>(
  params: SearchParamsRecord,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = single(params[name]);
  return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

/**
 * `personas` and `competitorIds` are the tenant's CURRENT ones, passed in by
 * the page. Both are whitelists, for two different reasons: a competitor id
 * reaches a uuid column and a garbage value there is a 500 with no route
 * back, and a persona that has since been deleted from the profile would
 * otherwise filter the list down to nothing with no way to tell why.
 */
export function readPromptsFilters(
  params: SearchParamsRecord,
  personas: readonly string[],
  competitorIds: readonly string[]
): PromptsFilterState {
  const competitorRaw = single(params.competitor) ?? "";
  const personaRaw = single(params.persona) ?? "";

  return {
    intent: readOption(params, "intent", ["all", ...PROMPT_INTENTS] as const, "all"),
    persona: personas.includes(personaRaw) ? personaRaw : "all",
    competitor: UUID_RE.test(competitorRaw) && competitorIds.includes(competitorRaw) ? competitorRaw : "all",
    status: readOption(params, "status", PROMPT_STATUS_FILTERS, PROMPTS_FILTER_DEFAULTS.status),
  };
}

/**
 * A NEW `URLSearchParams` built from `base` with this bar's four keys
 * replaced. Merging rather than rebuilding preserves anything else in the
 * url; a key at its default is deleted rather than written, so a
 * default-state url stays clean.
 */
export function writePromptsFilters(base: URLSearchParams, state: PromptsFilterState): URLSearchParams {
  const params = new URLSearchParams(base.toString());
  for (const name of ["intent", "persona", "competitor", "status"]) params.delete(name);
  if (state.intent !== PROMPTS_FILTER_DEFAULTS.intent) params.set("intent", state.intent);
  if (state.persona !== PROMPTS_FILTER_DEFAULTS.persona) params.set("persona", state.persona);
  if (state.competitor !== PROMPTS_FILTER_DEFAULTS.competitor) params.set("competitor", state.competitor);
  if (state.status !== PROMPTS_FILTER_DEFAULTS.status) params.set("status", state.status);
  return params;
}

export function promptsFiltersAreDefault(state: PromptsFilterState): boolean {
  return (
    state.intent === PROMPTS_FILTER_DEFAULTS.intent &&
    state.persona === PROMPTS_FILTER_DEFAULTS.persona &&
    state.competitor === PROMPTS_FILTER_DEFAULTS.competitor &&
    state.status === PROMPTS_FILTER_DEFAULTS.status
  );
}

export function toQuerySuffix(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
