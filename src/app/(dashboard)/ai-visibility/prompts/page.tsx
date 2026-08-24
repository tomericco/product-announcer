import Link from "next/link";
import { ScanSearch } from "lucide-react";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { db } from "@/db";
import { systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { listCompetitors } from "@/lib/workspace/competitors";
import { MAX_ACTIVE_PROMPTS, listPrompts } from "@/lib/ai-visibility/prompts";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { effectiveEngines } from "@/lib/ai-visibility/engine-keys";
import { MIN_N_PROMPT, promptMatrix } from "@/lib/ai-visibility/metrics";
import { plannedCallsForPrompts } from "@/lib/ai-visibility/planned-calls";
import { latestRun } from "@/lib/ai-visibility/run";
import { capExceeded, capPausedMessage } from "@/lib/ai-visibility/cost";
import { GeneratePromptSetButton } from "../generate-prompt-set-button";
import { AiVisibilityOffEmptyState } from "../off-empty-state";
import { RunNowButton } from "../run-now-button";
import { personaFilterOptions, readPromptsFilters } from "./filter-params";
import { PromptsEditor, type PromptRowData } from "./prompts-editor";
import { SuggestionsSection, type ProposalRow } from "./suggestions-section";

/**
 * The prompt set: what we ask each engine on the tenant's behalf.
 *
 * `searchParams` is a Promise in Next 16 and must be awaited (see the
 * docstring on `SignalsPage`, which cites the Next doc). Filters are read
 * through `readPromptsFilters` and never parsed inline, so the page and the
 * bar cannot drift apart — the whole reason `filter-params.ts` exists.
 *
 * No test: an async Server Component whose every derivation lives in a tested
 * module beneath it (`readPromptsFilters`, `engineChipLine`, the row chrome).
 */
export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const [settings, profile, competitors, allPrompts, matrix, personaCatalog] = await Promise.all([
    getAiVisibilitySettings(tenantId),
    getOrCreateCompanyProfile(tenantId),
    listCompetitors(tenantId),
    listPrompts(tenantId, { status: ["proposed", "active", "paused"] }),
    promptMatrix(tenantId),
    db.select().from(systemPersonas),
  ]);

  // Display NAMES, resolved through the catalog — the same resolution B5
  // runs before storing `ai_visibility_prompts.persona`. Passing a system
  // ref's raw `key` here would put an option in the bar that matches zero
  // rows and make the whitelist reject the `?persona=<name>` deep link.
  const personas = personaFilterOptions(profile.userPersonas, personaCatalog);
  const filters = readPromptsFilters(
    params,
    personas,
    competitors.map((competitor) => competitor.id)
  );

  // ---- State: Off ---------------------------------------------------------
  // The spec's States table says "same" as the overview, and it is right to:
  // an editor full of live-looking Switches on a feature that is switched off
  // invites edits that will not measure anything.
  if (!settings.enabled) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <Link href="/ai-visibility" className="text-sm text-muted-foreground hover:underline">
            ← AI visibility
          </Link>
          <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Prompts</h1>
        </div>
        <AiVisibilityOffEmptyState kept="Your prompts are kept." />
      </div>
    );
  }

  const competitorName = new Map(competitors.map((competitor) => [competitor.id, competitor.name]));
  const matrixByPrompt = new Map(matrix.map((row) => [row.promptId, row]));

  const proposals: ProposalRow[] = allPrompts
    .filter((prompt) => prompt.status === "proposed")
    .map((prompt) => ({
      id: prompt.id,
      text: prompt.text,
      intent: prompt.intent as ProposalRow["intent"],
      persona: prompt.persona,
      competitorName: prompt.competitorId ? (competitorName.get(prompt.competitorId) ?? null) : null,
      flagReason: prompt.flagReason,
    }));

  const listed = allPrompts.filter((prompt) => {
    if (prompt.status === "proposed" || prompt.status === "rejected") return false;
    if (filters.status !== "all" && prompt.status !== filters.status) return false;
    if (filters.intent !== "all" && prompt.intent !== filters.intent) return false;
    if (filters.persona !== "all" && prompt.persona !== filters.persona) return false;
    if (filters.competitor !== "all" && prompt.competitorId !== filters.competitor) return false;
    return true;
  });

  const rows: PromptRowData[] = listed.map((prompt) => {
    const cells = matrixByPrompt.get(prompt.id)?.cells ?? [];
    return {
      id: prompt.id,
      text: prompt.text,
      intent: prompt.intent as PromptRowData["intent"],
      persona: prompt.persona,
      competitorName: prompt.competitorId ? (competitorName.get(prompt.competitorId) ?? null) : null,
      origin: prompt.origin as PromptRowData["origin"],
      status: prompt.status === "active" ? "active" : "paused",
      branded: prompt.branded,
      flagReason: prompt.flagReason,
      // Optimistic, and deliberately conservative when it cannot tell.
      // `deletePromptAction` re-checks against the samples table and returns
      // "has_samples", which the editor toasts — this only decides whether the
      // menu item looks available. `promptMatrix` covers ACTIVE prompts only,
      // so a paused prompt never has a row here and is treated as undeletable
      // rather than offered a Delete the server will refuse.
      deletable: prompt.status === "active" && cells.every((cell) => cell.n === 0),
      chips: cells.map((cell) => ({
        engine: cell.engine,
        named: cell.n >= MIN_N_PROMPT ? cell.hits : null,
        samples: cell.n,
      })),
    };
  });

  const activeCount = allPrompts.filter((prompt) => prompt.status === "active").length;

  /**
   * The design's activation moment: "After approval the header gains **Run
   * first audit now**" (§Screens, and user story 3 — "numbers shortly after
   * approving so that the feature does not look broken for a week").
   *
   * Offered only until the first run exists. Afterwards the overview's own
   * Run now is the control, and a second copy of it here would be two buttons
   * that spend money for the same reason on two pages. Both queries are behind
   * `activeCount > 0`, so the empty and proposals-only states pay for neither.
   */
  const neverRun = activeCount > 0 && (await latestRun(tenantId)) === null;
  // BYOK: the engines that will actually run, not everything the settings row
  // names. Both the estimate and the button's own arithmetic read this, so the
  // "Run first audit now" price is the price of the run that follows the click.
  const runEngines = await effectiveEngines(tenantId, settings.engines);
  const firstAuditCap = neverRun
    ? await capExceeded(
        tenantId,
        {
          engines: runEngines,
          samplesPerPrompt: settings.samplesPerPrompt,
          monthlyCapUsd: settings.monthlyCapUsd,
        },
        new Date()
      )
    : null;
  // Counted the way the cap gate counts it: a brand-check prompt is one call
  // per engine, not `samplesPerPrompt` of them. A flat product here would quote
  // a number the enforcement disagrees with, on the control that spends money.
  // `plannedCallsForPrompts` is that rule, shared with the overview header and
  // with the settings card's monthly estimate.
  const firstAuditCalls = plannedCallsForPrompts(
    allPrompts.filter((prompt) => prompt.status === "active"),
    { engineCount: runEngines.length, samplesPerPrompt: settings.samplesPerPrompt }
  );

  // The current query, re-serialised, so the filter bar MERGES into it rather
  // than rebuilding from empty and dropping every unrelated key.
  const baseQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const entry of value) baseQuery.append(key, entry);
    else if (value !== undefined) baseQuery.set(key, value);
  }

  // The design's "Profile changed since prompts were generated" strip, derived
  // from data already loaded. Observation only: generation stays a click,
  // because it costs a model call.
  const lastApprovedAt = allPrompts.reduce<Date | null>(
    (latest, prompt) =>
      prompt.status === "active" && prompt.approvedAt && (!latest || prompt.approvedAt > latest)
        ? prompt.approvedAt
        : latest,
    null
  );
  const newCompetitors = lastApprovedAt
    ? competitors.filter((competitor) => competitor.createdAt > lastApprovedAt).length
    : 0;
  const changes: string[] = [];
  if (newCompetitors > 0) {
    changes.push(`${newCompetitors} competitor${newCompetitors === 1 ? "" : "s"}`);
  }
  if (lastApprovedAt && profile.updatedAt > lastApprovedAt) changes.push("an updated profile");
  const profileChangedNote =
    changes.length > 0 ? `Profile changed since prompts were generated — ${changes.join(", ")}` : null;

  const missingProfile = !profile.category || !profile.positioning;
  const hasAnyPrompts = allPrompts.some(
    (prompt) => prompt.status === "active" || prompt.status === "paused"
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link href="/ai-visibility" className="text-sm text-muted-foreground hover:underline">
              ← AI visibility
            </Link>
          </div>
          <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Prompts</h1>
          <p className="text-sm text-muted-foreground">
            The questions we ask each engine on your behalf. Paused prompts keep their history but are not run.
          </p>
        </div>
        {/* Nothing to run without a key, and the overview's own no-engines
            empty state is where that is explained — a Run button here that can
            only refuse would be the second place to learn it, in the worse
            wording. */}
        {firstAuditCap && runEngines.length > 0 && (
          <RunNowButton
            label="Run first audit now"
            estimate={{
              prompts: activeCount,
              engines: runEngines.length,
              samples: settings.samplesPerPrompt,
              calls: firstAuditCalls,
              usd: firstAuditCap.estimateUsd,
            }}
            disabledReason={
              firstAuditCap.exceeded
                ? capPausedMessage(firstAuditCap.spentUsd, firstAuditCap.capUsd)
                : null
            }
            disabledTone="destructive"
          />
        )}
      </div>

      <SuggestionsSection
        // Keyed on the batch: a new set of suggestions arriving while this is
        // mounted gets fresh state rather than the previous batch's.
        key={proposals.map((proposal) => proposal.id).join(",")}
        proposals={proposals}
        profileChangedNote={profileChangedNote}
        canSuggestMore={activeCount < MAX_ACTIVE_PROMPTS && !missingProfile}
        suggestMoreReason={
          activeCount >= MAX_ACTIVE_PROMPTS
            ? `${activeCount} / ${MAX_ACTIVE_PROMPTS} limit`
            : missingProfile
              ? "Add a category and positioning on Company first."
              : null
        }
      />

      {/* Gated on the UNFILTERED set. Gating on `rows` replaced the whole page
          — filter bar included — the moment a filter matched nothing, leaving
          no on-screen way back to an unfiltered list. */}
      {!hasAnyPrompts && proposals.length === 0 ? (
        <EmptyState>
          <EmptyStateIcon>
            <ScanSearch />
          </EmptyStateIcon>
          <EmptyStateTitle>No prompts yet</EmptyStateTitle>
          <EmptyStateDescription>
            Versional drafts the questions your buyers ask from your company profile. Nothing runs until you
            approve it.
          </EmptyStateDescription>
          <EmptyStateActions>
            <GeneratePromptSetButton
              disabledReason={missingProfile ? "Add a category and positioning on Company first." : null}
            />
          </EmptyStateActions>
        </EmptyState>
      ) : (
        <PromptsEditor
          rows={rows}
          filters={filters}
          personas={personas}
          competitors={competitors.map((competitor) => ({ id: competitor.id, name: competitor.name }))}
          activeCount={activeCount}
          maxActive={MAX_ACTIVE_PROMPTS}
          baseQuery={baseQuery.toString()}
        />
      )}
    </div>
  );
}
