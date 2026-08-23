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
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { listPrompts } from "@/lib/ai-visibility/prompts";
import { latestRun } from "@/lib/ai-visibility/run";
import {
  brandMentionTotal,
  engineHistory,
  engineMetrics,
  promptMatrix,
  runEngineHealth,
  windowCounts,
} from "@/lib/ai-visibility/metrics";
import { citedDomains, everSignalledDomains } from "@/lib/ai-visibility/cited-domains";
import { capExceeded, capPausedMessage } from "@/lib/ai-visibility/cost";
import { listSignals } from "@/lib/signals/query";
import type { EngineId, WindowCounts } from "@/lib/ai-visibility/types";
import { DATE_FORMAT } from "../company/source-status";
import { CitedDomainsTable } from "./cited-domains-table";
import { CompetitorBars, type BrandShare } from "./competitor-bars";
import { ENGINE_LABEL, ENGINE_ORDER } from "./engine-labels";
import { GeneratePromptSetButton } from "./generate-prompt-set-button";
import { OverviewCards, type EngineTile } from "./overview-cards";
import { PromptMatrix, type MatrixRow } from "./prompt-matrix";
import { RunNowButton, type RunEstimate } from "./run-now-button";
import type { RatePoint } from "./sparkline-points";

const DAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * The page title and its trust badge, shared by the Off and No-prompts
 * branches. The full header (last-run line, cap warning, Run now) is inline
 * in the main return instead of going through this, because every one of
 * those parts needs data the early branches deliberately never load.
 */
function Header({ lastRunLine }: { lastRunLine: string | null }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
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
      {lastRunLine && <p className="text-sm text-muted-foreground">{lastRunLine}</p>}
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
        <Header lastRunLine={null} />
        <EmptyState>
          <EmptyStateIcon>
            <ScanSearch />
          </EmptyStateIcon>
          <EmptyStateTitle>AI visibility is off</EmptyStateTitle>
          <EmptyStateDescription>
            Turn it on in Company to start measuring how often engines name you. Anything already measured is
            kept.
          </EmptyStateDescription>
          <EmptyStateActions>
            {/* A styled Link, not `Button render={<Link/>}`: Base UI's Button
                stamps role="button" on whatever it renders, and this only
                navigates. */}
            <Link href="/company#ai-visibility" className={buttonVariants({ variant: "outline" })}>
              Open Company
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
        <Header lastRunLine={null} />
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

  const [lastRun, cap] = await Promise.all([
    latestRun(tenantId),
    capExceeded(
      tenantId,
      {
        engines: settings.engines,
        samplesPerPrompt: settings.samplesPerPrompt,
        monthlyCapUsd: settings.monthlyCapUsd,
      },
      now
    ),
  ]);

  // A run "in flight" is just the latest one not yet finished — there is one
  // per tenant at a time by construction, so this needs no second query.
  const inFlight = lastRun && (lastRun.status === "pending" || lastRun.status === "running") ? lastRun : null;

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
  // one screen whose job is to be trusted about money.
  const brandedPrompts = activePrompts.filter((prompt) => prompt.intent === "brand_check").length;
  const plannedCalls =
    (activePrompts.length - brandedPrompts) * settings.engines.length * settings.samplesPerPrompt +
    brandedPrompts * settings.engines.length;

  // Both gates the design names, in the order it names them. `runNowAction`
  // re-checks each one — this is the visible reason, not the enforcement.
  // `exceeded`, not `reached`: the pre-run gate is spend PLUS the next run's
  // estimate, which is the number that decides whether starting is allowed. A
  // run the cap paused LAST month does not disable the button this month.
  const runningLine = inFlight
    ? `Running… ${inFlight.completedCalls} / ${inFlight.plannedCalls} calls`
    : null;
  const runDisabledReason = runningLine ?? capBlocking;

  // One estimate object for both places a run can be started from — the header
  // and the No-run-yet empty state — so the two can never quote different
  // money for the same click.
  const runEstimate: RunEstimate = {
    prompts: activePrompts.length,
    engines: settings.engines.length,
    samples: settings.samplesPerPrompt,
    calls: plannedCalls,
    // The gate's own number, not a second computation of it.
    usd: cap.estimateUsd,
  };

  const shownEngines = ENGINE_ORDER.filter((engine) => settings.engines.includes(engine));

  const [allMetrics, matrix, domains, competitors, health, pooledCounts, tenantRows] = await Promise.all([
    engineMetrics(tenantId),
    promptMatrix(tenantId),
    citedDomains(tenantId, { runs: 12, limit: 15 }),
    listCompetitors(tenantId),
    lastRun ? runEngineHealth(tenantId, lastRun.id) : Promise.resolve([]),
    windowCounts(tenantId, {}),
    db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)),
  ]);

  // One series per shown engine plus the pooled one, in the same order the
  // tiles render, so a tile and its sparkline can never be mismatched.
  const seriesKeys: (EngineId | "all")[] = [...shownEngines, "all"];
  const series = await Promise.all(seriesKeys.map((key) => engineHistory(tenantId, key)));

  // Per-engine cuts for the benchmark card's PreviewCard breakdown.
  const perEngineCounts = await Promise.all(
    shownEngines.map(async (engine) => ({ engine, counts: await windowCounts(tenantId, { engine }) }))
  );

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

  const tiles: EngineTile[] = seriesKeys.map((key, index) => {
    const history = series[index];
    // Both the note and the tick come from the SAME comparison, so a tile can
    // never claim a model change its own sparkline does not show.
    const points: RatePoint[] = history.map((point, pointIndex) => ({
      runId: point.runId,
      label: DATE_FORMAT.format(new Date(point.runDate)),
      // Mention rate, matching the tile's headline. `engineHistory` returns
      // `sovPct` from the same counts for a share surface that wants a history;
      // plotting it under a mention-rate number would make the tile argue with
      // its own chart.
      rate: point.mentionPct,
      modelChange:
        pointIndex > 0 && point.modelId && point.modelId !== history[pointIndex - 1].modelId
          ? point.modelId
          : null,
      publishedLabel: null,
    }));
    const latestChange = points.length > 0 ? points[points.length - 1].modelChange : null;

    const engineHealth = key === "all" ? undefined : healthByEngine.get(key);
    const failureNote =
      engineHealth && engineHealth.erroredPrompts > 0
        ? `${ENGINE_LABEL[engineHealth.engine]} failed on ${engineHealth.erroredPrompts} prompts${
            engineHealth.lastError ? ` — ${engineHealth.lastError}` : ""
          }`
        : null;

    return {
      engine: key,
      label: key === "all" ? "All engines" : ENGINE_LABEL[key],
      // Pooled, not averaged: `engineMetrics` returns the "all" row summed over
      // samples, and averaging three rates would weight a 12-sample engine like
      // an 84-sample one.
      metrics: metricsByEngine.get(key)!,
      points,
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
  const lastRunLine = runningLine
    ? runningLine
    : lastRun
    ? lastRun.status === "failed"
      ? `Last run ${DATE_FORMAT.format(lastRun.startedAt)} — failed`
      : `Last run ${DATE_FORMAT.format(lastRun.startedAt)} · ${lastRun.completedCalls} answers · $${lastRun.costUsd.toFixed(2)}`
    : "No run yet";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {/* The only font-heading on this page. */}
            <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">AI visibility</h1>
            <TooltipProvider>
              <Tooltip>
                {/* A button, not a span — see the note in `Header`. */}
                <TooltipTrigger render={<button type="button" className="inline-flex" />}>
                  <Badge variant="outline">API-observed</Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Measured through each engine&apos;s API with web search on — a close proxy for what a buyer
                  sees in the consumer app, not the same thing.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-sm text-muted-foreground">{lastRunLine}</p>
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
        </div>
        <RunNowButton
          estimate={runEstimate}
          disabledReason={runDisabledReason}
          disabledTone={runningLine ? "muted" : "destructive"}
        />
      </div>

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
            />
          </EmptyStateActions>
        </EmptyState>
      ) : (
        <>
          {/* Row 1 — the engines the tenant runs, plus the pooled "All engines".
              An engine switched off gets no tile: one permanently reading
              "Collecting baseline" for something nobody is paying for is
              noise, not honesty. */}
          <OverviewCards tiles={tiles} />

          {/* Row 2 — the competitor benchmark. */}
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

          {/* Row 3 — where the answers come from. Twelve runs, not four: a
              domain cited once a quarter still belongs on this list, and the
              description says which span it covers. */}
          <Card>
            <CardHeader>
              <CardTitle>Cited sources</CardTitle>
              <CardDescription>
                The domains these engines cited over the last 12 runs. Two thirds of brand recommendations cite
                no page of the brand&apos;s own — these are the pages that answered instead.
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

          {/* Row 4 — the gap-hunting grid. */}
          <Card>
            <CardHeader>
              <CardTitle>Prompts by engine</CardTitle>
              <CardDescription>
                How many of the last answers named you, per prompt and engine, and how many tracked competitors
                were named in them. Gaps — rivals named, you absent — sort first. A cell opens that prompt on
                that engine.
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
        </>
      )}
    </div>
  );
}
