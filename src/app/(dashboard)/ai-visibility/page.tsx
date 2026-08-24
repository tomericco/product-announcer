import type { ReactNode } from "react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { listCompetitors } from "@/lib/workspace/competitors";
import { getAiVisibilitySettings, getAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { effectiveEngines } from "@/lib/ai-visibility/engine-keys";
import { listPrompts, runnablePrompts } from "@/lib/ai-visibility/prompts";
import { plannedCallsForPrompts } from "@/lib/ai-visibility/planned-calls";
import { latestRun, runIsStalled } from "@/lib/ai-visibility/run";
import { nextScheduledRun } from "@/lib/ai-visibility/cadence";
import { preflightRun } from "@/lib/ai-visibility/preflight";
import {
  brandMentionTotal,
  engineHistory,
  engineMetrics,
  measuredEngines,
  promptMatrix,
  runEngineHealth,
} from "@/lib/ai-visibility/metrics";
import { citedDomains, everSignalledDomains } from "@/lib/ai-visibility/cited-domains";
import { capExceeded, capPausedMessage } from "@/lib/ai-visibility/cost";
import { scrubSecrets } from "@/lib/ai-visibility/scrub";
import { listSignals } from "@/lib/signals/query";
import type { EngineId, WindowCounts } from "@/lib/ai-visibility/types";
import { DATE_FORMAT } from "../company/source-status";
import { CitedDomainsTable } from "./cited-domains-table";
import { CompetitorBars, type BrandShare } from "./competitor-bars";
import { ENGINE_LABEL, ENGINE_ORDER, ENGINE_NAME } from "./engine-labels";
import { ratePct } from "./format";
import { GeneratePromptSetButton } from "./generate-prompt-set-button";
import { AiVisibilityOffEmptyState } from "./off-empty-state";
import { OverviewCards, type EngineTile } from "./overview-cards";
import { PromptMatrix, type MatrixRow } from "./prompt-matrix";
import { RunControls } from "./run-controls";
import { RunNowButton, type RunEstimate } from "./run-now-button";
import type { TrendSeries } from "./trend-points";
import { VisibilityTrend } from "./visibility-trend";

const DAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Milliseconds in a day, for the whole-day difference below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Next scan in 3 days" — the line under "Run now" when nothing is blocking a
 * run and none is in flight.
 *
 * Whole UTC DAYS apart, not `(tick - now) / DAY_MS` rounded: the cron fires at
 * 09:00 UTC, so a reader at 23:00 on Sunday is 10 hours from Monday's tick, and
 * "in 0 days" or "in 1 day" both come out of the elapsed arithmetic depending
 * on rounding. Calendar days are what "in 3 days" means to the person reading
 * it, and the schedule is a calendar schedule.
 *
 * `null` when there is no next scan to name — `cadence: "off"`, or a cadence
 * whose next tick is past the horizon. The caller writes the off case, which
 * has a different sentence and a different remedy.
 */
function nextScanNoteFor(next: Date | null, now: Date): string | null {
  if (!next) return null;

  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfNext = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
  const days = Math.round((startOfNext - startOfToday) / DAY_MS);

  if (days <= 0) return "Next scan later today";
  if (days === 1) return "Next scan tomorrow";
  return `Next scan in ${days} days`;
}

/**
 * The page title and its trust badge — every branch's, including the main one.
 *
 * It takes CHILDREN rather than the one line the early branches happen to
 * need. The data under the title differs per branch (the Off and No-prompts
 * branches deliberately load none of it), but the title, the badge and the
 * tooltip copy do not, and the previous split had them written out twice —
 * verbatim, tooltip sentence included — so a wording fix could land on one
 * copy and not the other.
 */
function Header({ children }: { children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {/* The only font-heading on this page. */}
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">AI visibility</h1>
        <TooltipProvider>
          <Tooltip>
            {/* A button, not a span: this is the page's single trust cue,
                and a non-focusable trigger puts it out of reach of anyone
                navigating by keyboard. */}
            <TooltipTrigger render={<button type="button" className="inline-flex" />}>
              <Badge variant="outline">API-observed</Badge>
            </TooltipTrigger>
            <TooltipContent>
              Measured through each engine&apos;s API with web search on — a close proxy for what a buyer sees in
              the consumer app, not the same thing.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {children}
    </div>
  );
}

/** One brand's share of every tracked-brand mention in a window, 0..100. */
function sharePct(mentions: number, total: number): number {
  return total === 0 ? 0 : (mentions / total) * 100;
}

/**
 * The weekly read. Nine states, and the ones that matter most are the honest
 * ones: an engine below n >= 30 says "Collecting baseline", a failed engine
 * shows "–" rather than a zero, and a run stopped by the cost cap says so in
 * the destructive tone with a route to Settings. A dashboard that renders a
 * confident number over thin data is the failure mode this whole design is
 * arranged against.
 *
 * An async Server Component with no props: it needs neither `params` nor
 * `searchParams` (both Promises in Next 16), and `requireSession()` is what
 * keeps it dynamic.
 */
export default async function AiVisibilityPage() {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const [settings, profile] = await Promise.all([
    getAiVisibilitySettings(tenantId),
    getOrCreateCompanyProfile(tenantId),
  ]);

  // ---- State: Off ---------------------------------------------------------
  if (!settings.enabled) {
    return (
      <div className="space-y-4">
        <Header />
        <AiVisibilityOffEmptyState kept="Anything already measured is kept." />
      </div>
    );
  }

  // ---- The BYOK gate -------------------------------------------------------
  //
  // `effectiveEngines` is what a run will actually sample, and it does not fall
  // back to all three when the intersection is empty. On ship day it is empty
  // for EVERY existing tenant: three engines named on the settings row and zero
  // keys. So this page must never render as though a run were possible.
  //
  // But "cannot run" and "has nothing to show" are two different states, and
  // the page used to collapse them — it returned the empty state below before
  // loading any metrics, so a tenant who removed their last key, or whose only
  // key auto-failed, or who paused ChatGPT for a month (Decision 5's own
  // example) lost the tiles, the trend, the matrix and the cited domains for
  // measurements they had already paid for. The copy said "Anything already
  // measured is kept" while offering no route to any of it.
  //
  // So: what will RUN and what has been MEASURED are read separately, and the
  // page shows the second while explaining the first.
  const [runEngines, measured] = await Promise.all([
    effectiveEngines(tenantId, settings.engines),
    measuredEngines(tenantId),
  ]);
  // Nothing will run, and the tenant is not being told to wait for something —
  // this is the state the whole page is about, and every section below reads it.
  const runBlocked = runEngines.length === 0;

  // ---- State: No engines connected, and nothing measured either ------------
  //
  // The genuinely empty case: ship day, and any tenant who has never had a key.
  // There is no history to fall through to, so the one thing worth saying is
  // what is missing.
  //
  // Placed after the Off state and before the prompt states on purpose. Without
  // keys, approving prompts buys nothing, so pointing someone at the prompt
  // review first would be sending them down a path that dead-ends.
  if (runBlocked && measured.length === 0) {
    return (
      <div className="space-y-4">
        <Header />
        <EmptyState>
          <EmptyStateIcon>
            <ScanSearch />
          </EmptyStateIcon>
          <EmptyStateTitle>No AI engines connected</EmptyStateTitle>
          <EmptyStateDescription>
            Engine answers are collected with your own provider keys, billed to your accounts rather
            than ours, so nothing runs until at least one key is connected. Anything already measured
            is kept.
          </EmptyStateDescription>
          <EmptyStateActions>
            {/* A styled Link, not `Button render={<Link/>}`: Base UI's Button
                stamps role="button" on whatever it renders, and this only
                navigates. */}
            <Link href="/settings#ai-engines" className={buttonVariants()}>
              Connect an engine
            </Link>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  const prompts = await listPrompts(tenantId, { status: ["proposed", "active", "paused"] });
  const activePrompts = prompts.filter((prompt) => prompt.status === "active");
  const proposals = prompts.filter((prompt) => prompt.status === "proposed");

  // ---- State: No prompts (and: proposals waiting) --------------------------
  if (activePrompts.length === 0) {
    // Generation reads category + positioning; without them it would draft
    // from nothing, so the control is disabled with the reason and a route.
    const missing = !profile.category || !profile.positioning;
    return (
      <div className="space-y-4">
        <Header />
        <EmptyState>
          <EmptyStateIcon>
            <ScanSearch />
          </EmptyStateIcon>
          <EmptyStateTitle>No prompts yet</EmptyStateTitle>
          <EmptyStateDescription>
            {proposals.length > 0
              ? `${proposals.length} drafted prompts are waiting for review — none of them run until you approve them.`
              : "Versional drafts the questions your buyers ask from your company profile. Nothing runs until you approve it."}
          </EmptyStateDescription>
          <EmptyStateActions>
            {proposals.length > 0 ? (
              <Link href="/ai-visibility/prompts" className={buttonVariants()}>
                Review {proposals.length} prompts
              </Link>
            ) : (
              <GeneratePromptSetButton
                disabledReason={missing ? "Add a category and positioning on Company first." : null}
              />
            )}
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  // One clock for the whole render, so the cap gate and anything else
  // time-dependent agree with each other.
  const now = new Date();

  const [lastRun, aiVisibilitySource, readiness, cap] = await Promise.all([
    latestRun(tenantId),
    // The sweep gates on `sources.lastRunAt`, not on the run row's
    // `startedAt`, so the "next scan" line reads the same column the schedule
    // does. A run that was planned but never recorded against the source would
    // otherwise move the sentence without moving the schedule.
    getAiVisibilitySource(tenantId),
    // Everything a run needs that is not the run itself. The same function
    // `planRun` refuses on, so the sentence under a disabled button and the
    // refusal a click would get are one computation — see `preflight.ts`.
    preflightRun(tenantId),
    capExceeded(
      tenantId,
      {
        // The engines that will actually run, so the gate, the estimate and the
        // tiles are all reading the same list. Quoting a three-engine price to
        // a tenant with one key would be wrong on the one screen whose job is
        // to be checkable about money.
        engines: runEngines,
        samplesPerPrompt: settings.samplesPerPrompt,
        monthlyCapUsd: settings.monthlyCapUsd,
      },
      now
    ),
  ]);

  // A run "in flight" is just the latest one not yet finished — there is one
  // per tenant at a time by construction, so this needs no second query.
  const inFlight = lastRun && (lastRun.status === "pending" || lastRun.status === "running") ? lastRun : null;
  // In flight, but nothing has been written to it for `STALL_AFTER_MS` and no
  // driver holds the lease: whoever was driving spent its budget with work
  // left, or died. Until "Resume" existed the only thing that picked such a run
  // back up was tomorrow's 09:00 UTC sweep — so this state looked exactly like
  // a working run for up to a day, while every attempt to start a new one was
  // refused with "A run is already in progress."
  const stalled = inFlight !== null && runIsStalled(inFlight, now);

  // ---- State: Paused by cap ------------------------------------------------
  // Read off the RUN, not off the source badge: `sources.status` has no
  // `paused` value, so a cap pause there is indistinguishable from an engine
  // outage. A paused run carries the sentence itself on `run.error`, which is
  // preferred over composing a second wording of the same fact.
  const cappedRun = lastRun?.status === "paused_by_cap" ? lastRun : null;
  // The live, actionable state: spend plus the next run would cross the cap.
  // Destructive, with a route to Settings.
  const capBlocking = cap.exceeded
    ? (cappedRun?.error ?? capPausedMessage(cap.spentUsd, cap.capUsd))
    : null;
  // A cap pause the calendar has already resolved. Muted and DATED, never the
  // error tone: quoting this month's spend figure over a pause that happened
  // in a month that has ended reads as a live problem and is not one.
  const capResolvedNote =
    !cap.exceeded && cappedRun
      ? `The ${DATE_FORMAT.format(cappedRun.startedAt)} run stopped at the $${cap.capUsd.toFixed(
          2
        )} monthly cap. Runs have resumed.`
      : null;

  // `capExceeded` has already split brand-check prompts (one sample per engine)
  // from the rest, so its estimate is the one the gate itself used. Recomputing
  // it here with a flat `prompts × engines × samples` would quote the human a
  // number the enforcement disagrees with — always higher, and higher on the
  // one screen whose job is to be trusted about money. `plannedCallsForPrompts`
  // is that split, written once.
  // The prompts a run will ACTUALLY ask. Lowering `MAX_ACTIVE_PROMPTS` does
  // not deactivate anything, so a tenant seeded under the old ceiling still
  // has more active rows than `planRun` will take — and quoting a price for
  // rows that will not be asked is exactly the kind of wrong this line must
  // not be. `listPrompts` already returns `RUNNABLE_ORDER`, so this is the
  // same slice the planner and `capExceeded` take.
  const runnable = runnablePrompts(activePrompts);

  const plannedCalls = plannedCallsForPrompts(runnable, {
    engineCount: runEngines.length,
    samplesPerPrompt: settings.samplesPerPrompt,
  });

  // Both gates the design names, in the order it names them. `runNowAction`
  // re-checks each one — this is the visible reason, not the enforcement.
  // `exceeded`, not `reached`: the pre-run gate is spend PLUS the next run's
  // estimate, which is the number that decides whether starting is allowed. A
  // run the cap paused LAST month does not disable the button this month.
  // Two different states, two different sentences. A reader looking at a
  // stalled run had no way at all to tell it from a working one, which is half
  // of what made the 24-hour freeze feel like a bug in the numbers rather than
  // a run waiting for a driver.
  const runningLine = inFlight
    ? stalled
      ? `Stalled at ${inFlight.completedCalls} / ${inFlight.plannedCalls} calls — resume to finish it`
      : `Running… ${inFlight.completedCalls} / ${inFlight.plannedCalls} calls`
    : null;
  // Not ready, in preflight's own words. Its blocks are ordered — a missing key
  // first, then the judge, then a brand nothing can be matched against — so the
  // first one is the thing to fix first, and it outranks the cap for the same
  // reason it always did: a key is missing before a budget is.
  //
  // The sentence is preflight's rather than this file's on purpose. It used to
  // be written out here AND enforced in `planRun`, which is two copies of one
  // rule; now the disabled button quotes the refusal a click would actually
  // get.
  const blockedReason = readiness.blocks[0]?.message ?? null;
  const runDisabledReason = runningLine ?? blockedReason ?? capBlocking;

  // What the schedule will do next, for the line under "Run now". Only the
  // schedule: a run in flight, a missing key and the cap each occupy that same
  // slot with a more immediate sentence, and `RunControls` decides between them
  // — this is the fallback it falls back TO.
  //
  // The off case is written here rather than left as a null, because "no line
  // at all" and "nothing is scheduled" look identical on screen and are not the
  // same fact: the second one is a setting somebody chose and can change.
  const nextScanNote =
    settings.cadence === "off"
      ? "No scheduled scans — cadence is off"
      : nextScanNoteFor(nextScheduledRun(settings, aiVisibilitySource?.lastRunAt ?? null, now), now);

  // One estimate object for both places a run can be started from — the header
  // and the No-run-yet empty state — so the two can never quote different
  // money for the same click.
  const runEstimate: RunEstimate = {
    prompts: runnable.length,
    engines: runEngines.length,
    samples: settings.samplesPerPrompt,
    calls: plannedCalls,
    // The gate's own number, not a second computation of it.
    usd: cap.estimateUsd,
  };

  // The engines with a key, in display order — not everything the settings row
  // names. An engine nobody is paying for gets no tile, no series and no matrix
  // column: a permanent "Collecting baseline" for something that will never
  // collect anything reads as broken rather than as unused.
  //
  // Unless nothing is keyed at all, in which case that rule would hide the
  // whole page. A tenant who cannot run is shown what they already have —
  // that is the difference between a paused measurement and a deleted one, and
  // the banner above the tiles is where the pause is explained.
  const shownEngines = ENGINE_ORDER.filter((engine) =>
    (runBlocked ? measured : runEngines).includes(engine)
  );

  const [engineCuts, matrix, domains, competitors, health, tenantRows] = await Promise.all([
    engineMetrics(tenantId),
    promptMatrix(tenantId),
    citedDomains(tenantId, { runs: 12, limit: 15 }),
    listCompetitors(tenantId),
    lastRun ? runEngineHealth(tenantId, lastRun.id) : Promise.resolve([]),
    db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)),
  ]);

  // The raw counts come back WITH the rates, from the same read.
  //
  // `engineMetrics` already queries every one of these cuts to compute the
  // tiles; the page used to re-issue the pooled cut and one per engine — eight
  // more queries on the critical path — purely because it needs
  // `competitorMentions`, which the collapsed `EngineMetrics` row does not
  // carry.
  const allMetrics = engineCuts.metrics;
  const pooledCounts = engineCuts.counts.all;
  // Per-engine cuts for the benchmark card's PreviewCard breakdown.
  const perEngineCounts = shownEngines.map((engine) => ({ engine, counts: engineCuts.counts[engine] }));

  // One series per tile, in the same order the tiles render, so a tile and its
  // sparkline can never be mismatched.
  //
  // The pooled series only when there is something to pool. With ONE engine
  // enabled the pooled cut IS that engine's cut, so appending "all"
  // unconditionally printed the same numbers twice, side by side, under two
  // different names.
  const seriesKeys: (EngineId | "all")[] =
    shownEngines.length > 1 ? [...shownEngines, "all"] : [...shownEngines];
  const series = await Promise.all(seriesKeys.map((key) => engineHistory(tenantId, key)));

  const tenantName = tenantRows[0]?.name ?? "You";

  // An engine that ERRORED is a coverage failure worth reporting; a refusal is
  // an answer that declined to search, which the spec keeps as a coverage gap
  // excluded from rates rather than as an engine failure.
  //
  // Per (prompt, engine), not per engine: the spec asks for "–" on THOSE
  // cells, and stamping the whole column erased 21 good readings to report 9
  // bad ones. `erroredPromptIds` is the same fact `erroredPrompts` counts.
  const failedCells = new Set(
    health.flatMap((row) => row.erroredPromptIds.map((promptId) => `${promptId} ${row.engine}`))
  );
  const healthByEngine = new Map(health.map((row) => [row.engine, row]));

  const metricsByEngine = new Map(allMetrics.map((row) => [row.engine, row]));
  const pooled = metricsByEngine.get("all")!;

  /**
   * The trend chart's series — MENTION rate, one line per tile, same order.
   *
   * `engineHistory` returns `sovPct` from the same counts for a share surface
   * that wants a history, and this is deliberately not it: adding a competitor
   * in week 6 steps every share down at once, and on a twelve-run trend that
   * step is a settings change wearing the costume of a visibility change.
   * Mention rate has one denominator and matches what the tiles headline.
   */
  /**
   * The trend card's description — what the reader meets BEFORE the picture.
   *
   * It sits here rather than in the chart's own figcaption because the chart is
   * now the page's first section: the hero/backdrop hierarchy has to be stated
   * above the lines, not under them. The figcaption keeps the sentence that
   * needs the data (how many runs the span covers) and nothing else, so the
   * pooling note is written once.
   *
   * Conditional for the same reason `seriesKeys` is: a one-engine tenant has no
   * pooled line, and explaining one they cannot see is noise.
   */
  const trendDescription =
    seriesKeys.length > 1
      ? "How often the engines named you, run by run. The bold line pools every sample from every engine rather than averaging the three rates; each engine is drawn behind it."
      : "How often the engine named you, run by run.";

  const trendSeries: TrendSeries[] = seriesKeys.map((key, index) => ({
    key,
    name: key === "all" ? "All engines" : ENGINE_NAME[key],
    points: series[index].map((point) => ({
      runId: point.runId,
      label: DATE_FORMAT.format(new Date(point.runDate)),
      rate: point.mentionPct,
    })),
  }));

  const tiles: EngineTile[] = seriesKeys.map((key, index) => {
    const history = series[index];
    // The model-change note is the ONE annotation kept from the sparklines the
    // chart replaces, and it stays HERE, beside the engine it happened to.
    // Ticking it on the chart would put up to 36 labelled dots on three
    // backdrop lines, and the hero can carry none of them anyway: `modelId` is
    // null for "all" by construction, because three engines do not share a
    // model and inventing one would be a false mark.
    const latest = history.at(-1);
    const previous = history.at(-2);
    const latestChange =
      latest && previous && latest.modelId && latest.modelId !== previous.modelId ? latest.modelId : null;

    const engineHealth = key === "all" ? undefined : healthByEngine.get(key);
    // `lastError` is now composed by the engine clients from a closed set of
    // codes and our own sentences, so it carries no provider body text —
    // `scrubSecrets` here is for the rows written BEFORE that was true. Every
    // sample stored up to this change holds `openai 401: Incorrect API key
    // provided: sk-…99vW`, and those rows are still what the last-run tiles
    // read. Nothing backfills them; this is what keeps them off the screen.
    const failureNote =
      engineHealth && engineHealth.erroredPrompts > 0
        ? `${ENGINE_LABEL[engineHealth.engine]} failed on ${engineHealth.erroredPrompts} prompts${
            engineHealth.lastError ? ` — ${scrubSecrets(engineHealth.lastError)}` : ""
          }`
        : null;

    return {
      engine: key,
      // The SHORT name. `ENGINE_LABEL` is ~180px of methodology in a card
      // header that truncates at about half that, so the only part a reader
      // ever saw was the part "GPT" already says; the "API-observed" badge in
      // the header carries the proxy caveat once, with the tooltip that
      // explains it. The full name is still what the card's `title`, the
      // sparkline's accessible name and the failure note below use.
      label: key === "all" ? "All engines" : ENGINE_NAME[key],
      // Pooled, not averaged: `engineMetrics` returns the "all" row summed over
      // samples, and averaging three rates would weight a 12-sample engine like
      // an 84-sample one.
      metrics: metricsByEngine.get(key)!,
      failureNote,
      modelChangeNote: latestChange ? `Model changed to ${latestChange} this run` : null,
    };
  });

  // Brand shares are computed here rather than queried: `windowCounts` gives
  // the counts, and a share is one brand's mentions over every tracked brand's.
  // A competitor with no mentions still gets a row at 0 — a missing bar reads
  // as "not tracked".
  const pooledTotal = brandMentionTotal(pooledCounts);
  const enginePerBrand = (counts: WindowCounts, mentions: number) =>
    brandMentionTotal(counts) === 0 ? null : sharePct(mentions, brandMentionTotal(counts));

  /**
   * Mentions belonging to brands this card can NAME — us plus the competitors
   * still on the profile.
   *
   * `competitorMentions` is keyed by competitor id and keeps counting a
   * competitor after it is deleted (the history of what engines said while we
   * tracked them is deliberately not erased), so the named rows can sum to
   * less than the denominator. Without the remainder row below, the bars would
   * quietly disagree with the headline tile and the missing slice would have
   * no name — which is exactly why `brandMentionTotal` is exported.
   */
  const accountedIn = (counts: WindowCounts) =>
    counts.tenantMentions +
    competitors.reduce((sum, competitor) => sum + (counts.competitorMentions[competitor.id] ?? 0), 0);

  const namedShares: BrandShare[] = [
    {
      brandId: "tenant",
      name: tenantName,
      isTenant: true,
      mentions: pooledCounts.tenantMentions,
      sharePct: sharePct(pooledCounts.tenantMentions, pooledTotal),
      perEngine: perEngineCounts.map(({ engine, counts }) => ({
        engine,
        sharePct: enginePerBrand(counts, counts.tenantMentions),
      })),
    },
    ...competitors.map((competitor) => ({
      brandId: competitor.id,
      name: competitor.name,
      isTenant: false,
      mentions: pooledCounts.competitorMentions[competitor.id] ?? 0,
      sharePct: sharePct(pooledCounts.competitorMentions[competitor.id] ?? 0, pooledTotal),
      perEngine: perEngineCounts.map(({ engine, counts }) => ({
        engine,
        sharePct: enginePerBrand(counts, counts.competitorMentions[competitor.id] ?? 0),
      })),
    })),
  ];

  const remainder = pooledTotal - accountedIn(pooledCounts);
  const brandShares: BrandShare[] =
    remainder > 0
      ? [
          ...namedShares,
          {
            brandId: "other",
            name: "Other tracked brands",
            isTenant: false,
            mentions: remainder,
            sharePct: sharePct(remainder, pooledTotal),
            perEngine: perEngineCounts.map(({ engine, counts }) => {
              const engineRemainder = brandMentionTotal(counts) - accountedIn(counts);
              return {
                engine,
                sharePct: engineRemainder > 0 ? enginePerBrand(counts, engineRemainder) : null,
              };
            }),
          },
        ]
      : namedShares;

  /**
   * The benchmark obeys the SAME two display rules as the tiles above it, read
   * off the pooled row the tiles themselves use.
   *
   * Without this the card contradicted the page: at n = 12 every tile said
   * "Collecting baseline" while the bars underneath printed a confident
   * "You · 62%", and with nobody named at all every brand drew "· 0%" —
   * a share computed from a denominator of zero, which is the precise
   * zero-versus-unknown conflation this feature exists to prevent.
   */
  const benchmark: "baseline" | "none-named" | "ready" =
    pooled.mentionRate === null ? "baseline" : pooledTotal === 0 ? "none-named" : "ready";

  // `promptMatrix` is deliberately un-thresholded — applying MIN_N_PROMPT and
  // rendering "–" below it is `cellReading`'s job, which also has to tell a
  // thin cut apart from an engine that could not be asked at all.
  const matrixRows: MatrixRow[] = matrix.map((row) => ({
    promptId: row.promptId,
    text: row.text,
    branded: row.branded,
    // `shownEngines`, not every engine: a switched-off engine has no tile, and
    // a column of dashes for one is read as broken rather than unused.
    cells: Object.fromEntries(
      shownEngines.map((engine) => {
        const cell = row.cells.find((entry) => entry.engine === engine);
        return [
          engine,
          {
            named: cell ? cell.hits : null,
            samples: cell ? cell.n : 0,
            failed: failedCells.has(`${row.promptId} ${engine}`),
            // The other half of the cell: `hits` counts only us, so without
            // this a prompt where three rivals were named and we were not
            // rendered exactly like one where the engine named nobody.
            competitors: cell ? cell.competitorsNamed : 0,
          },
        ];
      })
    ) as MatrixRow["cells"],
  }));

  // Joined to the `new_cited_domain` signal that makes "Propose brief"
  // resolvable: a link with no signal id lands on an empty /briefs/new and
  // drops the evidence silently.
  //
  // The second query answers a different question, which is why it is not the
  // same one narrowed: `listSignals` is bounded by the 60-day window, and a row
  // with no id inside it has either lost a signal or never had one. Those two
  // need opposite sentences, and only an unwindowed read can tell them apart.
  const [domainSignals, everSignalled] = await Promise.all([
    listSignals(tenantId, { kind: "ai_visibility" }),
    everSignalledDomains(tenantId),
  ]);
  const signalByDomain = new Map(
    domainSignals
      .filter((signal) => signal.payload?.signalType === "new_cited_domain" && signal.payload.domain)
      .map((signal) => [signal.payload!.domain as string, signal.id])
  );

  // Pooled citation rate, stated once, where its denominator is already the
  // subject: a "searched" answer is a grounded one, the cut this table's own
  // "% of searched answers" column divides by (ungrounded-answers design,
  // decision 5). `citationRate` is null on its OWN floor, independently of the
  // mention floor — an engine can answer plenty and search on too few of them
  // to report where it got its answers — so the null branch says that in words
  // rather than leaving a dash.
  const citationLine =
    pooled.citationRate === null
      ? "A searched answer is one the engine ran a web search for; too few of them yet to say how often they cite a page of yours."
      : `A searched answer is one the engine ran a web search for — ${ratePct(
          pooled.citationRate
        )} of them cited a page of yours.`;

  const citedDomainRows = domains.map((row) => ({
    domain: row.domain,
    citations: row.citations,
    answerSharePct: row.answerShare,
    engines: row.engines,
    domainClass: row.domainClass,
    signalId: signalByDomain.get(row.domain) ?? null,
    everSignalled: everSignalled.has(row.domain),
  }));

  // An in-flight run is NOT "Last run": its `completedCalls` and `costUsd` are
  // a partial tally that keeps moving, and printing them under that label
  // reports a half-finished run as a finished one. The spec's Running state
  // belongs here, in the muted header, rather than only as destructive text
  // under the disabled button.
  //
  // "calls", not "answers". `completedCalls` counts every call the run made,
  // errors included; the tiles two hundred pixels below say "84 answers read"
  // about `n`, which is eligible samples after errors, refusals and brand-check
  // prompts are excluded. Two different numbers under one word, on the surface
  // whose whole claim is that you can check its arithmetic.
  //
  // In flight, this line is EMPTY rather than a second copy of "Running… 41 /
  // 270 calls". The run cluster in the top-right owns that sentence now and
  // keeps its counter moving; a server-rendered twin beside it would freeze at
  // whatever the count was when the page was requested, and two numbers for one
  // run — one live, one stuck — is worse than one.
  const lastRunLine = inFlight
    ? null
    : lastRun
    ? lastRun.status === "failed"
      ? `Last run ${DATE_FORMAT.format(lastRun.startedAt)} — failed`
      : // A stopped run is not a failure and not a whole run either. It gets
        // its own word, with the counts it did buy, because those counts ARE
        // in every number below — a line that read like an ordinary "Last run"
        // would leave the operator wondering why the window looks thin.
        lastRun.status === "cancelled"
      ? `Last run ${DATE_FORMAT.format(lastRun.startedAt)} — stopped · ${lastRun.completedCalls} calls · $${lastRun.costUsd.toFixed(2)}`
      : `Last run ${DATE_FORMAT.format(lastRun.startedAt)} · ${lastRun.completedCalls} calls · $${lastRun.costUsd.toFixed(2)}`
    : "No run yet";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header>
          {lastRunLine && <p className="text-sm text-muted-foreground">{lastRunLine}</p>}
          {/* The two routes out of this page, which it otherwise had none of:
              every existing link to the prompt set and to the signals these
              runs produce lives inside an early-return branch, so the normal
              state — the one anyone reads weekly — was a dead end. The signal
              link is the feature's own claim (gap → signal → brief) made
              walkable. */}
          <p className="text-sm text-muted-foreground">
            <Link href="/ai-visibility/prompts" className="underline underline-offset-2 hover:text-foreground">
              {activePrompts.length} {activePrompts.length === 1 ? "prompt" : "prompts"}
            </Link>{" "}
            ·{" "}
            <Link
              href="/signals?kind=ai_visibility"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Signals from these runs
            </Link>
          </p>
          {capBlocking && (
            <p className="text-sm text-destructive">
              {capBlocking}{" "}
              <Link href="/settings#ai-visibility" className="underline underline-offset-2">
                Raise it in Settings
              </Link>
              , or wait for next month.
            </p>
          )}
          {/* Dated and muted: a pause the calendar already resolved is history,
              not an error, and the error tone over a spend figure from a month
              that has ended reads as a live problem. */}
          {capResolvedNote && <p className="text-sm text-muted-foreground">{capResolvedNote}</p>}
        </Header>
        {/* Stop sits beside Run now, never instead of it: while a run is in
            flight Run now is the disabled control carrying "Running… 41 / 270
            calls", and that line is the context the Stop button needs to be
            read against. It appears only in flight — there is nothing to stop
            otherwise, and a permanently disabled Stop would be noise.

            A client component, and the only one on this page: the counter in
            that line has to move while the run runs, and everything else here
            is still computed above and passed in. The server's reading is the
            seed and the authority — see the comment on `RunControls`. */}
        <RunControls
          initialProgress={{
            inFlight: inFlight !== null,
            stalled,
            completedCalls: inFlight?.completedCalls ?? 0,
            plannedCalls: inFlight?.plannedCalls ?? 0,
          }}
          estimate={runEstimate}
          blockedReason={blockedReason}
          capBlocking={capBlocking}
          nextScanNote={nextScanNote}
          // Warnings only. Blocks are already the sentence under the button,
          // and a disabled button opens no dialog to list them in.
          warnings={readiness.items.filter((item) => item.level === "warn")}
        />
      </div>

      {/* ---- The run-blocked banner ----------------------------------------
          Above everything, and NOT instead of it. The numbers below are real
          and were paid for; what has stopped is the collecting of new ones, so
          the banner says which of those two it is and dates the last run in the
          header line right above it.

          Not an EmptyState: nothing here is empty. A Card in the destructive
          border, carrying the one control that fixes it. */}
      {runBlocked && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle>Measuring is paused — no engine key connected</CardTitle>
            <CardDescription>
              Engine answers are collected with your own provider keys, billed to your accounts rather
              than ours, so nothing new is collected until at least one key is connected. Everything
              below was measured while a key was connected, and it is kept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* A styled Link, not `Button render={<Link/>}`: Base UI's Button
                stamps role="button" on whatever it renders, and this only
                navigates. */}
            <Link href="/settings#ai-engines" className={buttonVariants()}>
              Connect an engine
            </Link>
          </CardContent>
        </Card>
      )}

      {lastRun === null ? (
        // ---- State: No run yet ----------------------------------------------
        // One empty state naming the next scheduled run, rather than three
        // empty tables that look broken.
        <EmptyState>
          <EmptyStateIcon>
            <ScanSearch />
          </EmptyStateIcon>
          <EmptyStateTitle>No run yet</EmptyStateTitle>
          <EmptyStateDescription>
            {settings.cadence === "off"
              ? "Scheduled runs are off. Run it now, or set a cadence in Settings."
              : // Guarded rather than trusted: `getAiVisibilitySettings` clamps
                // dayOfWeek to 0..6, but "First audit undefined" is a bad way to
                // find out that ever stopped being true.
                `First audit ${DAY_LABEL[settings.dayOfWeek] ?? "on the scheduled day"} — or run it now.`}
          </EmptyStateDescription>
          {/* "or run it now" pointed at a button in the opposite corner of the
              page. Same control, same dialog, same estimate — put where the
              sentence that offers it is, and labelled as the first audit,
              because that is what a run is when there has never been one. */}
          <EmptyStateActions>
            <RunNowButton
              label="Run first audit now"
              estimate={runEstimate}
              disabledReason={runDisabledReason}
              disabledTone={runningLine ? "muted" : "destructive"}
              warnings={readiness.items.filter((item) => item.level === "warn")}
            />
          </EmptyStateActions>
        </EmptyState>
      ) : (
        <>
          {/* Row 1 — the TREND, and the first thing on the page.
              Direction is the question a weekly reader opens this page with,
              and it was answered below the fold by a chart with no heading of
              its own. Titled like every other section here — a Card, because
              an untitled figure floating above four cards reads as a banner
              rather than as a section — and the title names the metric,
              because this page carries several rates and a bare "Trend" would
              not say which one the line is.

              The four 64px sparklines this replaces drew the same metric over
              the same window four times, all pinned to the same 0..100 domain
              with both axes hidden. Four objects, one fact, and none of them
              readable enough to answer "which way is this going". */}
          <Card>
            <CardHeader>
              <CardTitle>Mention rate per run</CardTitle>
              <CardDescription>{trendDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <VisibilityTrend series={trendSeries} />
            </CardContent>
          </Card>

          {/* Row 2 — the engines the tenant runs, plus the pooled "All engines"
              when there is more than one to pool. An engine switched off gets
              no tile: one permanently reading "Collecting baseline" for
              something nobody is paying for is noise, not honesty.

              The chart above is the TREND; these tiles are the LEVEL, and they
              are deliberately un-carded as a row of small cards rather than a
              titled section — the chart's title already names the metric they
              headline. */}
          <OverviewCards tiles={tiles} />

          {/* Row 3 — the gap-hunting grid, promoted above the benchmark.
              This is the row that does job 2 in the design ("find the gaps that
              are worth content"), and it is the only row on the page a reader
              can act on without leaving it. It sat fourth, under two cards that
              answer "how are we doing" — which job 1 has already answered in
              the tiles above. */}
          <Card>
            <CardHeader>
              <CardTitle>Prompts by engine</CardTitle>
              <CardDescription>
                Where each engine names you, and where it names your rivals instead — gaps sort first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {matrixRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No prompts have produced an answer yet.</p>
              ) : (
                <PromptMatrix rows={matrixRows} engines={shownEngines} />
              )}
            </CardContent>
          </Card>

          {/* Row 4 — the competitor benchmark. */}
          <Card>
            <CardHeader>
              <CardTitle>Competitor benchmark</CardTitle>
              <CardDescription>
                Share of every mention of a tracked brand, over the last four runs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {benchmark === "baseline" ? (
                <p className="text-sm text-muted-foreground">
                  Collecting baseline — n = {pooled.n} answers. Shares appear once there are enough.
                </p>
              ) : benchmark === "none-named" ? (
                <p className="text-sm">
                  No brands named in any answer — not ours, not a competitor&apos;s. n = {pooled.n} answers.
                </p>
              ) : (
                <CompetitorBars rows={brandShares} n={pooled.n} />
              )}
            </CardContent>
          </Card>

          {/* Row 5 — where the answers come from. Twelve runs, not four: a
              domain cited once a quarter still belongs on this list, and the
              description says which span it covers.

              The description is also the one place citation rate is stated. It
              belongs HERE and nowhere else: its denominator is grounded answers,
              the same "searched answers" this table's own column divides by, so
              the phrase gets defined once against the number it describes. On
              the tiles it was an unexplained "Cited 18%" sitting beside three
              metrics measured over a different denominator — and an unexplained
              "Cited —" whenever the engines had searched too little to say. */}
          <Card>
            <CardHeader>
              <CardTitle>Cited sources</CardTitle>
              <CardDescription>
                The domains these engines cited over the last 12 runs. {citationLine}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {citedDomainRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No citations recorded yet.</p>
              ) : (
                <CitedDomainsTable rows={citedDomainRows} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
