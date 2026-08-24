import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  companyProfiles,
  competitors,
  tenants,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilitySamples,
} from "@/db/schema";
import { buildAliases, mentionHaystack, mentionsBrandIn } from "@/lib/ai-visibility/aliases";
import {
  classifyDomain,
  isRedirector,
  resolveRedirect,
  toRegistrableDomain,
} from "@/lib/ai-visibility/domains";
import type { SampleExtraction } from "@/lib/ai-visibility/types";

export type BrandTarget = { brandId: string; name: string; aliases: string[]; isTenant: boolean };

export type BrandContext = {
  brands: BrandTarget[];
  ownDomain: string | null;
  /** domain -> competitorId, for the citation rows' FK. */
  competitorByDomain: Record<string, string>;
};

/**
 * Ceiling on how much of an answer the mention pass reads.
 *
 * The strip regexes are quadratic on dotted input, and `answerText` is
 * third-party text of whatever length an engine felt like returning — so
 * without a bound the cost of one sample is set by the engine, not by us, and
 * it is paid synchronously inside a slice that has 359 other samples to get
 * through. 16k characters is roughly 4,000 words: far past any real engine
 * answer, and a brand named only after it was not the answer's subject.
 */
export const MAX_MENTION_CHARS = 16_000;

/**
 * The deterministic half of extraction — the arbiter for "mentioned".
 *
 * One mention per brand per sample (design §"Metrics"), so this returns
 * booleans and a de-duplicated id list, never counts.
 */
export function extractDeterministic(a: {
  answerText: string;
  promptText: string;
  ownDomain: string | null;
  brands: BrandTarget[];
  citations: { url: string }[];
}): SampleExtraction["deterministic"] {
  let tenantMentioned = false;
  const competitorIds: string[] = [];
  // Built ONCE, not once per brand: stripping the prompt echo and the URLs is
  // the expensive half of a mention check and it produces the same haystack
  // every iteration. `mentionHaystack` lives in `aliases.ts` beside the matcher
  // that consumes it, so this module and that one cannot drift into two
  // different definitions of "mentioned".
  const haystack = mentionHaystack(a.answerText.slice(0, MAX_MENTION_CHARS), a.promptText);
  for (const brand of a.brands) {
    if (!mentionsBrandIn(haystack, brand.aliases)) continue;
    if (brand.isTenant) tenantMentioned = true;
    else if (!competitorIds.includes(brand.brandId)) competitorIds.push(brand.brandId);
  }

  const ownDomainCited =
    a.ownDomain !== null &&
    a.citations.some((c) => {
      const domain = toRegistrableDomain(c.url);
      return domain !== null && domain === a.ownDomain;
    });

  return { tenantMentioned, competitorIds, ownDomainCited };
}

/**
 * Every brand this tenant tracks, plus the domains needed to classify citations.
 *
 * The tenant's own "brand id" is the string `"tenant"` rather than a uuid: the
 * tenant is not a row in `competitors`, and `SampleExtraction.deterministic`
 * keeps it in a separate boolean anyway, so nothing joins on it.
 */
export async function loadBrandTargets(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<BrandContext> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database
    .select({ websiteUrl: companyProfiles.websiteUrl })
    .from(companyProfiles)
    .where(eq(companyProfiles.tenantId, tenantId));
  const rivals = await database
    .select({ id: competitors.id, name: competitors.name, websiteUrl: competitors.websiteUrl })
    .from(competitors)
    .where(eq(competitors.tenantId, tenantId));

  const ownDomain = profile?.websiteUrl ? toRegistrableDomain(profile.websiteUrl) : null;

  const brands: BrandTarget[] = [];
  if (tenant?.name) {
    brands.push({ brandId: "tenant", name: tenant.name, aliases: buildAliases(tenant.name), isTenant: true });
  }
  for (const rival of rivals) {
    brands.push({ brandId: rival.id, name: rival.name, aliases: buildAliases(rival.name), isTenant: false });
  }

  // A competitor with no website still gets aliases — it can be named in an
  // answer without ever being cited. It just cannot own a cited domain.
  const competitorByDomain: Record<string, string> = {};
  for (const rival of rivals) {
    const domain = rival.websiteUrl ? toRegistrableDomain(rival.websiteUrl) : null;
    if (domain) competitorByDomain[domain] = rival.id;
  }

  return { brands, ownDomain, competitorByDomain };
}

/** The citation list `runSlice` stored alongside the engine's own payload. */
function citationsFromRaw(raw: unknown): { url: string; position: number }[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { citations?: unknown }).citations;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is { url: string; position: number } =>
      typeof c === "object" && c !== null && typeof (c as { url?: unknown }).url === "string"
    )
    .map((c, i) => ({ url: c.url, position: Number.isFinite(c.position) ? c.position : i + 1 }));
}

/**
 * Sees through redirector URLs before any domain work.
 *
 * Gemini's grounding citations are `vertexaisearch.cloud.google.com/...`
 * handles (see C5); without this hop every one of them reduces to
 * `google.com`, classifies as `other`, and Gemini's citation rate is
 * permanently zero. Only known redirector hosts touch the network
 * (`isRedirector`), resolution is cached per URL — `runSlice` shares one
 * cache across the whole slice — and a failed hop falls back to the
 * redirector URL itself, which `resolveRedirect` already guarantees.
 */
async function resolveCitations(
  citations: { url: string; position: number }[],
  fetchImpl: typeof fetch | undefined,
  cache: Map<string, string>
): Promise<{ url: string; position: number }[]> {
  const out: { url: string; position: number }[] = [];
  for (const citation of citations) {
    if (!isRedirector(citation.url)) {
      out.push(citation);
      continue;
    }
    let resolved = cache.get(citation.url);
    if (resolved === undefined) {
      resolved = await resolveRedirect(citation.url, fetchImpl);
      cache.set(citation.url, resolved);
    }
    out.push({ url: resolved, position: citation.position });
  }
  return out;
}

export type ExtractSampleDeps = {
  database?: typeof defaultDb;
  /** Redirect resolution's network seam; tests stub the 302 hop here. */
  fetchImpl?: typeof fetch;
  /**
   * Injected by `runSlice`, which loads it ONCE per slice — extraction needs
   * the same aliases for every row, and a 270-call run re-reading three
   * tables per sample would be ~1,400 identical queries. The standalone
   * default re-reads, so an operator can re-extract after an alias fix.
   */
  brandContext?: BrandContext;
  /** Shared across a slice so one redirector URL costs one network hop. */
  redirectCache?: Map<string, string>;
};

/**
 * Runs deterministic extraction for one stored sample and persists its citations.
 *
 * Idempotent by construction: it deletes this sample's citation rows before
 * inserting, so re-extracting after an alias fix cannot double the leaderboard.
 * A sample with no answer (errored, refused) is left completely alone — its
 * `extraction` stays null, which is what the aggregate's eligibility rule
 * already excludes. Redirector citations are resolved to their target URL
 * before storage, so the citation rows and `ownDomainCited` describe the real
 * page, never the redirector.
 */
export async function extractSample(
  sampleId: string,
  deps: ExtractSampleDeps = {}
): Promise<void> {
  const database = deps.database ?? defaultDb;

  const [row] = await database
    .select({
      id: aiVisibilitySamples.id,
      tenantId: aiVisibilitySamples.tenantId,
      runId: aiVisibilitySamples.runId,
      status: aiVisibilitySamples.status,
      answerText: aiVisibilitySamples.answerText,
      raw: aiVisibilitySamples.raw,
      extraction: aiVisibilitySamples.extraction,
      promptText: aiVisibilityPrompts.text,
    })
    .from(aiVisibilitySamples)
    .innerJoin(aiVisibilityPrompts, eq(aiVisibilitySamples.promptId, aiVisibilityPrompts.id))
    .where(eq(aiVisibilitySamples.id, sampleId));

  if (!row || row.status !== "ok" || !row.answerText) return;

  const { brands, ownDomain, competitorByDomain } =
    deps.brandContext ?? (await loadBrandTargets(row.tenantId, database));
  // Resolved BEFORE `extractDeterministic` and before the citation rows are
  // built, so `ownDomainCited` and the leaderboard both see the real pages.
  const citations = await resolveCitations(
    citationsFromRaw(row.raw),
    deps.fetchImpl,
    deps.redirectCache ?? new Map()
  );

  const deterministic = extractDeterministic({
    answerText: row.answerText,
    promptText: row.promptText,
    ownDomain,
    brands,
    citations,
  });

  await database
    .update(aiVisibilitySamples)
    // Preserves any judged block already present, so re-extraction after a fix
    // does not throw away a judge call that was already paid for.
    .set({ extraction: { ...(row.extraction ?? {}), deterministic } })
    .where(eq(aiVisibilitySamples.id, row.id));

  await database.delete(aiVisibilityCitations).where(eq(aiVisibilityCitations.sampleId, row.id));

  const competitorDomains = Object.keys(competitorByDomain);
  const rows: (typeof aiVisibilityCitations.$inferInsert)[] = [];
  for (const citation of citations) {
    const domain = toRegistrableDomain(citation.url);
    // A URL we cannot reduce tells us nothing and would poison the leaderboard
    // with a junk row. Dropped, not stored raw.
    if (!domain) continue;
    rows.push({
      sampleId: row.id,
      tenantId: row.tenantId,
      runId: row.runId,
      url: citation.url,
      domain,
      position: citation.position,
      domainClass: classifyDomain(domain, { ownDomain, competitorDomains }),
      // `classifyDomain` answers "which kind of domain is this"; it does not
      // know which competitor row owns it. Resolved here from the same map that
      // decided the class, so the two can never disagree.
      competitorId: competitorByDomain[domain] ?? null,
    });
  }
  if (rows.length > 0) await database.insert(aiVisibilityCitations).values(rows);
}
