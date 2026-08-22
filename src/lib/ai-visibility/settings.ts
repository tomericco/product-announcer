import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilitySettings, sources, type Source } from "@/db/schema";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";
import { isCapPausedError, monthToDateSpendUsd } from "@/lib/ai-visibility/cost";
import {
  roundUsd,
  MIN_MONTHLY_CAP_USD,
  MAX_MONTHLY_CAP_USD,
} from "@/lib/ai-visibility/money";

export const CADENCES = ["weekly", "fortnightly", "off"] as const;
export type Cadence = (typeof CADENCES)[number];

/** 3 is the floor at which "0 of 3" and "3 of 3" mean anything (spec, Decisions log). */
export const SAMPLE_CHOICES = [1, 3, 5] as const;
export type SamplesPerPrompt = (typeof SAMPLE_CHOICES)[number];

// Defined in `money.ts` so the /settings form can import them without
// reaching `@/db`; re-exported here because this is where callers expect them.
export { MIN_MONTHLY_CAP_USD, MAX_MONTHLY_CAP_USD };

export type AiVisibilitySettingsValues = {
  enabled: boolean;
  cadence: Cadence;
  /** 0 = Sunday, UTC. */
  dayOfWeek: number;
  engines: EngineId[];
  samplesPerPrompt: SamplesPerPrompt;
  monthlyCapUsd: number;
};

export type SettingsField = "cadence" | "dayOfWeek" | "engines" | "samplesPerPrompt" | "monthlyCapUsd";

export type SaveSettingsResult =
  | { ok: true; settings: AiVisibilitySettingsValues }
  | { ok: false; error: SettingsField };

/**
 * What a tenant with no row gets. Mirrors the column defaults in
 * `ai_visibility_settings`; if you change one, change both — `getAiVisibilitySettings`
 * must answer the same thing before and after the first save.
 */
export const DEFAULT_AI_VISIBILITY_SETTINGS: AiVisibilitySettingsValues = {
  enabled: false,
  cadence: "weekly",
  dayOfWeek: 1,
  engines: [...ENGINE_IDS],
  samplesPerPrompt: 3,
  monthlyCapUsd: 20,
};

function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Reads a row back through the same vocabulary the writer enforces.
 *
 * Deliberately forgiving in one direction only: a value the column holds but
 * the code no longer recognises — an engine we dropped, a cadence from a
 * hand-edited row — is coerced to the default rather than thrown on. The
 * settings page must render, and a run must be able to decide what to do,
 * even for a row nobody in this deployment ever wrote.
 */
export async function getAiVisibilitySettings(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<AiVisibilitySettingsValues> {
  const [row] = await database
    .select()
    .from(aiVisibilitySettings)
    .where(eq(aiVisibilitySettings.tenantId, tenantId))
    .limit(1);

  return normalizeSettingsRow(row);
}

/**
 * One row's worth of coercion, shared by the single-tenant read above and the
 * batch read below, so the sweep cannot end up gating on a different reading of
 * the same row than the settings card renders.
 */
function normalizeSettingsRow(
  row: typeof aiVisibilitySettings.$inferSelect | undefined
): AiVisibilitySettingsValues {
  // Fresh arrays every call: the defaults object is module-scoped, and a
  // caller who sorted or spliced the engines list would corrupt every later
  // read in the same process.
  if (!row) return { ...DEFAULT_AI_VISIBILITY_SETTINGS, engines: [...ENGINE_IDS] };

  const cadence = (CADENCES as readonly string[]).includes(row.cadence)
    ? (row.cadence as Cadence)
    : DEFAULT_AI_VISIBILITY_SETTINGS.cadence;
  const samples = (SAMPLE_CHOICES as readonly number[]).includes(row.samplesPerPrompt)
    ? (row.samplesPerPrompt as SamplesPerPrompt)
    : DEFAULT_AI_VISIBILITY_SETTINGS.samplesPerPrompt;
  const dayOfWeek =
    Number.isInteger(row.dayOfWeek) && row.dayOfWeek >= 0 && row.dayOfWeek <= 6
      ? row.dayOfWeek
      : DEFAULT_AI_VISIBILITY_SETTINGS.dayOfWeek;

  // Filtering can empty the list — a row written when we supported an engine we
  // have since dropped. `saveAiVisibilitySettings` refuses to write an empty
  // list precisely because an enabled feature with zero engines plans zero
  // calls behind a green badge, so the read must not hand one back either:
  // read and write have to agree on what a legal row is.
  // Deduped for the same reason the write path dedupes: a row holding
  // ["openai","openai"] would make `planRun` plan that engine's calls twice.
  const filtered = [...new Set(row.engines.filter(isEngineId))];
  const engines = filtered.length > 0 ? filtered : [...ENGINE_IDS];

  // Clamped like its neighbours, and rounded because the column is float4 —
  // see `roundUsd`. Without the rounding a cap saved as 20.10 reads back as
  // 20.100000381469727 and shows up in the settings field that way.
  const monthlyCapUsd = Number.isFinite(row.monthlyCapUsd)
    ? Math.min(MAX_MONTHLY_CAP_USD, Math.max(MIN_MONTHLY_CAP_USD, roundUsd(row.monthlyCapUsd)))
    : DEFAULT_AI_VISIBILITY_SETTINGS.monthlyCapUsd;

  return {
    enabled: row.enabled,
    cadence,
    dayOfWeek,
    engines,
    samplesPerPrompt: samples,
    monthlyCapUsd,
  };
}

/**
 * The same read, for many tenants in one round trip.
 *
 * The cron sweep needs every candidate tenant's cadence BEFORE it can divide
 * the tick's budget — it has to know how many sources will actually do work,
 * not how many rows exist. Doing that with `getAiVisibilitySettings` per tenant
 * is one round trip per tenant spent before any work starts, on the one path
 * where the whole point is that time is scarce.
 *
 * A tenant with no row is present in the map with the defaults, which have
 * `enabled: false` — absence of a row is a real state, not a missing key the
 * caller has to remember to handle.
 */
export async function getAiVisibilitySettingsForTenants(
  tenantIds: string[],
  database: typeof defaultDb = defaultDb
): Promise<Map<string, AiVisibilitySettingsValues>> {
  const unique = [...new Set(tenantIds)];
  const byTenant = new Map<string, AiVisibilitySettingsValues>();
  if (unique.length === 0) return byTenant;

  const rows = await database
    .select()
    .from(aiVisibilitySettings)
    .where(inArray(aiVisibilitySettings.tenantId, unique));

  const found = new Map(rows.map((row) => [row.tenantId, row]));
  for (const tenantId of unique) {
    byTenant.set(tenantId, normalizeSettingsRow(found.get(tenantId)));
  }
  return byTenant;
}

/** Accepts a number or the numeric string a form field submits. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Persists the four settings the /settings card owns.
 *
 * Takes `unknown` and validates by hand, like every other write in this repo
 * that sits behind a Server Action: the caller's argument is client input
 * whatever TypeScript says about it.
 *
 * Does NOT write `enabled`. That switch lives on the /company card and goes
 * through `setAiVisibilityEnabled`, which also flips the source row — saving
 * the settings form must never be able to silently turn the feature on or off.
 *
 * `engines` must be a NON-EMPTY subset of `ENGINE_IDS`. An empty array would
 * leave an enabled feature silently measuring nothing — every run would plan
 * zero calls behind a green badge. "Stop running" is spelled `cadence: "off"`
 * or the /company switch, both of which say so in the UI.
 */
export async function saveAiVisibilitySettings(
  tenantId: string,
  input: unknown,
  database: typeof defaultDb = defaultDb,
  // Injected so the cap-pause recovery below can be tested against a fixed
  // month rather than whatever month the suite happens to run in.
  now: () => Date = () => new Date()
): Promise<SaveSettingsResult> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const cadence = raw.cadence;
  if (typeof cadence !== "string" || !(CADENCES as readonly string[]).includes(cadence)) {
    return { ok: false, error: "cadence" };
  }

  const dayOfWeek = toNumber(raw.dayOfWeek);
  if (dayOfWeek === null || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, error: "dayOfWeek" };
  }

  if (!Array.isArray(raw.engines)) return { ok: false, error: "engines" };
  const engines: EngineId[] = [];
  for (const entry of raw.engines) {
    if (typeof entry !== "string" || !isEngineId(entry)) return { ok: false, error: "engines" };
    if (!engines.includes(entry)) engines.push(entry);
  }
  // Non-empty, not merely a subset: an enabled feature with zero engines
  // would plan zero calls behind a green badge. See the function comment.
  if (engines.length === 0) return { ok: false, error: "engines" };

  const samples = toNumber(raw.samplesPerPrompt);
  if (samples === null || !(SAMPLE_CHOICES as readonly number[]).includes(samples)) {
    return { ok: false, error: "samplesPerPrompt" };
  }

  const cap = toNumber(raw.monthlyCapUsd);
  if (cap === null || cap < MIN_MONTHLY_CAP_USD || cap > MAX_MONTHLY_CAP_USD) {
    return { ok: false, error: "monthlyCapUsd" };
  }

  const values = {
    cadence,
    dayOfWeek,
    engines,
    samplesPerPrompt: samples as SamplesPerPrompt,
    // Rounded on the way in so the value we store, return, and later read back
    // through `getAiVisibilitySettings` are the same number. Without it a cap
    // saved as 20.999 renders as 20.999 now and 21 on the next load.
    monthlyCapUsd: roundUsd(cap),
  };

  const [row] = await database
    .insert(aiVisibilitySettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({
      target: aiVisibilitySettings.tenantId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  // Raising the cap is the documented way out of a cap pause, so it has to be
  // the thing that clears the red badge. Without this the source keeps reading
  // "Paused — monthly cap reached" until the next run finishes or the /company
  // switch is toggled off and on — i.e. the user does the one action the error
  // asks for and nothing on screen changes.
  await clearCapPauseIfResolved(tenantId, values.monthlyCapUsd, now(), database);

  return {
    ok: true,
    settings: {
      enabled: row.enabled,
      cadence: values.cadence as Cadence,
      dayOfWeek: values.dayOfWeek,
      engines: values.engines,
      samplesPerPrompt: values.samplesPerPrompt,
      monthlyCapUsd: values.monthlyCapUsd,
    },
  };
}

/**
 * Un-reds the source when the new cap is above what the month has already
 * spent.
 *
 * Deliberately narrow on two axes. It only touches a source whose `lastError`
 * IS the cap pause — an engine outage or a judge failure is a real failure and
 * must survive a settings save. And it only clears when the new cap actually
 * leaves headroom: raising $20 to $21 after spending $24 changes nothing, so
 * the badge should keep saying so.
 *
 * The `paused_by_cap` run itself is left alone. It is finished history, it does
 * not block a new run (only `pending`/`running` do), and the next run is what
 * writes the next chapter of the health block.
 */
async function clearCapPauseIfResolved(
  tenantId: string,
  capUsd: number,
  now: Date,
  database: typeof defaultDb
): Promise<void> {
  const [source] = await database
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "ai_visibility")))
    .limit(1);
  if (!source || source.status !== "failing" || !isCapPausedError(source.lastError)) return;

  const spentUsd = await monthToDateSpendUsd(tenantId, now, database);
  if (spentUsd >= capUsd) return;

  await database
    .update(sources)
    .set({ status: "active", lastError: null })
    .where(eq(sources.id, source.id));
}

export const AI_VISIBILITY_SOURCE_LABEL = "AI visibility";

/**
 * The one `sources` row this feature reports its health on, so
 * `SourceStatusBadge`, `lastRunAt` and `lastError` work on /company exactly as
 * they do for news and competitor pages.
 *
 * It has no URL — there is no page to poll — which puts it on the null-url
 * half of the `sources` table. Identity therefore comes from
 * `sources_tenant_type_null_url_unique` (tenant + type, where url IS NULL),
 * the same partial index `setNewsWatching` conflicts on. `onConflictDoUpdate`
 * rather than `onConflictDoNothing` so a row always comes back to return.
 */
export async function ensureAiVisibilitySource(
  tenantId: string,
  database: typeof defaultDb = defaultDb,
  // Applied to both halves of the upsert, so a caller that wants to create the
  // row AND set its health does it in one statement rather than an insert
  // followed by an update that can fail on its own.
  overrides: Partial<Pick<typeof sources.$inferInsert, "status" | "lastError">> = {}
): Promise<Source> {
  const [row] = await database
    .insert(sources)
    .values({
      tenantId,
      type: "ai_visibility",
      url: null,
      label: AI_VISIBILITY_SOURCE_LABEL,
      ...overrides,
    })
    .onConflictDoUpdate({
      target: [sources.tenantId, sources.type],
      targetWhere: sql`${sources.url} IS NULL`,
      // `label` alone is a no-op whose only job is to make the statement
      // RETURNING-able when there are no overrides.
      set: { label: AI_VISIBILITY_SOURCE_LABEL, ...overrides },
    })
    .returning();
  return row;
}

/**
 * The feature's source row, if one exists yet — a READ, in `getNewsSource`'s
 * shape, for the /company card's health block.
 *
 * Deliberately not `ensureAiVisibilitySource`. Creating the row on a page
 * render defaults its status to `active`, which is the badge and (before the
 * switch was seeded from the settings row) the toggle both reporting a feature
 * as on that `sweep.ts` will never run, and it drops every tenant who has ever
 * loaded /company into the sweep's candidate set. The row is created by the
 * two paths that mean something — `setAiVisibilityEnabled` and `planRun`.
 */
export async function getAiVisibilitySource(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Source | null> {
  const [source] = await database
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "ai_visibility")))
    .limit(1);
  return source ?? null;
}

/**
 * The /company switch. Writes both halves of "is this feature on": the
 * settings row the sweep gates on, and the source row the badge reads.
 *
 * Disabling never deletes: history, `lastRunAt` and `lastError` all survive so
 * a tenant who turns it back on has their prompts and their sparklines intact.
 */
export async function setAiVisibilityEnabled(
  tenantId: string,
  enabled: boolean,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database
    .insert(aiVisibilitySettings)
    .values({ tenantId, enabled })
    .onConflictDoUpdate({
      target: aiVisibilitySettings.tenantId,
      // Only `enabled`. Everything else on this row belongs to the settings
      // card, and toggling the feature must not reset a tenant's cadence.
      set: { enabled, updatedAt: new Date() },
    });

  // One statement, not an upsert followed by an update: a failure between the
  // two would leave `settings.enabled = true` beside a `disabled` source row,
  // and the badge would contradict the switch until someone toggled it again.
  // Same shape as `setNewsWatching`.
  await ensureAiVisibilitySource(tenantId, database, {
    status: enabled ? "active" : "disabled",
    // Enabling clears the stale complaint — the common path is reading
    // "Paused — monthly cap reached", raising the cap, and re-toggling.
    // Disabling leaves it: that is exactly when an operator needs to see
    // the last failure.
    ...(enabled ? { lastError: null } : {}),
  });
}
