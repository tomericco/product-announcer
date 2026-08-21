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
import { MIN_N_PROMPT, promptMatrix } from "@/lib/ai-visibility/metrics";
import { GeneratePromptSetButton } from "../generate-prompt-set-button";
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

  // `getAiVisibilitySettings` is deliberately NOT read here: nothing on this
  // page depends on cadence, engines or the cap, and a prompt set is editable
  // whether or not measurement is switched on.
  const [profile, competitors, allPrompts, matrix, personaCatalog] = await Promise.all([
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
      </div>

      <SuggestionsSection
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

      {rows.length === 0 && proposals.length === 0 ? (
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
        />
      )}
    </div>
  );
}
