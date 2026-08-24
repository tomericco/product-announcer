import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, companyProfiles, competitors, tenants } from "@/db/schema";
import { buildAliases } from "@/lib/ai-visibility/aliases";
import { effectiveEngines } from "@/lib/ai-visibility/engine-keys";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { toRegistrableDomain } from "@/lib/ai-visibility/domains";

/**
 * Everything a run needs that is not the run itself, checked BEFORE the money.
 *
 * The gates `planRun` already had — off, no key, no prompts, one at a time,
 * under the cap — all answer "may this run start". These answer a different
 * question: "will this run produce anything worth what it costs". Every one of
 * them was a real way to spend a tenant's engine budget and get nothing back:
 *
 *  - a judge with no credential leaves the run `running` FOREVER, and because
 *    `planRun` refuses `run_in_flight`, that wedges every future run for the
 *    workspace behind a run that can never finish;
 *  - a brand the extractor cannot build an alias for makes every answer read as
 *    "not mentioned", so the dashboard reports a confident 0% — a
 *    misconfiguration wearing the costume of a finding, which is the exact
 *    failure this feature's design is arranged against;
 *  - no competitors, or no website, cost the run its benchmark and its
 *    own-citation split without stopping it.
 *
 * ONE function, three consumers, on the rule this codebase already applies to
 * the cost cap: the sentence the operator reads and the condition the code
 * enforces are the same computation, so they cannot drift. `planRun` refuses on
 * the blocks, the /ai-visibility Run-now dialog lists all of it before the
 * click, and the sweep writes the first block onto `sources.lastError` so a
 * scheduled run that refused says why instead of sitting green and silent.
 */

export type PreflightLevel = "block" | "warn";

export type PreflightCheckId =
  | "engine_keys"
  | "judge"
  | "brand_name"
  | "own_domain"
  | "competitors"
  | "profile_stale";

export type PreflightItem = {
  id: PreflightCheckId;
  level: PreflightLevel;
  /** One sentence in the product's voice, rendered verbatim on two surfaces. */
  message: string;
  /**
   * Where to go and fix it, or `null` when there is nothing the tenant can do —
   * a missing judge credential is ours, and offering a link to a page that
   * cannot resolve it would be worse than offering none.
   */
  fix: { label: string; href: string } | null;
};

export type PreflightResult = {
  /** Failing checks only, blocks before warnings. An empty array is a ready workspace. */
  items: PreflightItem[];
  /** The blocking subset, in the same order — what `planRun` refuses on. */
  blocks: PreflightItem[];
  blocked: boolean;
};

export type PreflightDeps = {
  database?: typeof defaultDb;
  /**
   * Whether the answer judge can be called at all.
   *
   * Injected by tests; production asks the environment. Deliberately a
   * CONFIGURATION check rather than a live probe: a probe would cost a model
   * call on every run and on every render of the Run-now dialog, and the
   * failure it would catch beyond this one — a key that is present but revoked
   * — is rarer than the one it would introduce, which is a dialog that cannot
   * open because a provider is having a bad minute.
   */
  judgeConfigured?: () => boolean;
};

/**
 * The credential `judge.ts` will use.
 *
 * `resolveModel` calls `anthropic()` from `@ai-sdk/anthropic` whatever
 * `AI_VISIBILITY_JUDGE_MODEL` names — the spec selects a MODEL, not a provider
 * — so this one variable is the judge's whole configuration.
 */
function judgeIsConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
}

/** Declaration order is display order; blocks are partitioned out below. */
const ORDER: PreflightCheckId[] = [
  "engine_keys",
  "judge",
  "brand_name",
  "own_domain",
  "competitors",
  "profile_stale",
];

export async function preflightRun(
  tenantId: string,
  deps: PreflightDeps = {}
): Promise<PreflightResult> {
  const database = deps.database ?? defaultDb;
  const judgeOk = (deps.judgeConfigured ?? judgeIsConfigured)();

  const settings = await getAiVisibilitySettings(tenantId, database);

  const [engines, tenantRows, profileRows, competitorRows, promptRows] = await Promise.all([
    effectiveEngines(tenantId, settings.engines, database),
    database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    database
      .select({ websiteUrl: companyProfiles.websiteUrl, updatedAt: companyProfiles.updatedAt })
      .from(companyProfiles)
      .where(eq(companyProfiles.tenantId, tenantId))
      .limit(1),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(competitors)
      .where(eq(competitors.tenantId, tenantId)),
    // Only the timestamp, and only from ACTIVE prompts: the staleness question
    // is "was the profile edited after the prompts a run will ask were
    // approved", and a proposed prompt is not one a run will ask.
    database
      .select({ approvedAt: sql<Date | null>`max(${aiVisibilityPrompts.approvedAt})` })
      .from(aiVisibilityPrompts)
      .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active"))),
  ]);

  const found = new Map<PreflightCheckId, PreflightItem>();
  const fail = (item: PreflightItem) => found.set(item.id, item);

  if (engines.length === 0) {
    fail({
      id: "engine_keys",
      level: "block",
      message: "No engine key is connected, so a run has nothing to ask with.",
      fix: { label: "Connect an engine", href: "/settings#ai-engines" },
    });
  }

  if (!judgeOk) {
    fail({
      id: "judge",
      level: "block",
      // Says what it costs, not just what is missing: this refusal is the one
      // that reads as arbitrary otherwise, because nothing on the tenant's own
      // side is wrong.
      message:
        "Answer grading is not configured, so a run would buy every engine answer and then never finish.",
      fix: null,
    });
  }

  // `buildAliases`, not a hand-rolled emptiness test: it is the function
  // extraction actually uses, and it drops anything under two characters. A
  // one-letter workspace name therefore passes every "is it set" check ever
  // written and still matches nothing in any answer.
  const brandName = tenantRows[0]?.name ?? "";
  if (buildAliases(brandName).length === 0) {
    fail({
      id: "brand_name",
      level: "block",
      message:
        "Your workspace name is too short to look for in an answer, so every engine would read as not mentioning you.",
      fix: { label: "Name the workspace", href: "/settings" },
    });
  }

  // Parsed, not merely present: `loadBrandTargets` runs the same conversion and
  // keeps `ownDomain: null` when it fails, so a website nobody can turn into a
  // domain buys exactly as little as no website at all.
  const websiteUrl = profileRows[0]?.websiteUrl ?? null;
  if (!websiteUrl || !toRegistrableDomain(websiteUrl)) {
    fail({
      id: "own_domain",
      level: "warn",
      message:
        "No company website on file, so citations of your own site cannot be told apart from anyone else's.",
      fix: { label: "Add your website", href: "/company#company-context" },
    });
  }

  if ((competitorRows[0]?.count ?? 0) === 0) {
    fail({
      id: "competitors",
      level: "warn",
      message: "No competitors, so this run measures your mention rate but cannot benchmark it.",
      fix: { label: "Add competitors", href: "/company#competitors" },
    });
  }

  // Derived exactly as the /company card and the prompts page derive it, and
  // deliberately NOT a count of profile edits: `companyProfiles.updatedAt`
  // moves for a dozen unrelated writes, so this reports "worth a look", never
  // "these prompts are wrong".
  const lastApprovedAt = promptRows[0]?.approvedAt ?? null;
  const profileUpdatedAt = profileRows[0]?.updatedAt ?? null;
  if (lastApprovedAt && profileUpdatedAt && new Date(profileUpdatedAt) > new Date(lastApprovedAt)) {
    fail({
      id: "profile_stale",
      level: "warn",
      message:
        "Your company profile changed after these prompts were approved — this run measures the older positioning.",
      fix: { label: "Review prompts", href: "/ai-visibility/prompts" },
    });
  }

  const items = ORDER.map((id) => found.get(id)).filter((item): item is PreflightItem => item !== undefined);
  const blocks = items.filter((item) => item.level === "block");
  // Sorted rather than filtered in place so the two orders cannot disagree:
  // whatever `items` puts first among the blocks is what `planRun` refuses with
  // and what the header shows.
  const ordered = [...blocks, ...items.filter((item) => item.level === "warn")];

  return { items: ordered, blocks, blocked: blocks.length > 0 };
}
