"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PROMPT_INTENTS, type EngineId, type PromptIntent } from "@/lib/ai-visibility/types";
import { ENGINE_ORDER, ENGINE_SHORT } from "../engine-labels";
import { deletePromptAction, savePromptAction, togglePromptAction } from "../actions";
import {
  PROMPTS_FILTER_DEFAULTS,
  PROMPT_STATUS_FILTERS,
  promptsFiltersAreDefault,
  toQuerySuffix,
  writePromptsFilters,
  type PromptsFilterState,
} from "./filter-params";

export type PromptRowData = {
  id: string;
  text: string;
  intent: PromptIntent;
  persona: string | null;
  competitorName: string | null;
  origin: "generated" | "user";
  status: "active" | "paused";
  branded: boolean;
  flagReason: string | null;
  deletable: boolean;
  chips: { engine: EngineId; named: number | null; samples: number }[];
};

/** Exported so the suggestions section and the detail page share one map. */
export const INTENT_LABEL: Record<PromptIntent, string> = {
  discovery: "Discovery",
  comparison: "Comparison",
  alternatives: "Alternatives",
  how_to: "How-to",
  brand_check: "Brand check",
  pricing: "Pricing",
};

const STATUS_LABEL: Record<(typeof PROMPT_STATUS_FILTERS)[number], string> = {
  all: "Active and paused",
  active: "Active",
  paused: "Paused",
};

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * "GPT 2/3 · Pplx 0/3 · Gem 3/3 · Claude 1/3" — the per-engine counts on a
 * row, in the fixed engine order so two rows can be compared by eye. An
 * engine with nothing usable reads "–", never "0/0", which would claim we
 * asked and were not named.
 */
export function engineChipLine(chips: PromptRowData["chips"]): string {
  const byEngine = new Map(chips.map((chip) => [chip.engine, chip]));
  return ENGINE_ORDER.filter((engine) => byEngine.has(engine))
    .map((engine) => {
      const chip = byEngine.get(engine)!;
      const value = chip.named === null || chip.samples === 0 ? "–" : `${chip.named}/${chip.samples}`;
      return `${ENGINE_SHORT[engine]} ${value}`;
    })
    .join(" · ");
}

export function PromptsEditor({
  rows,
  filters,
  personas,
  competitors,
  activeCount,
  maxActive,
  baseQuery = "",
}: {
  rows: PromptRowData[];
  filters: PromptsFilterState;
  personas: string[];
  competitors: { id: string; name: string }[];
  activeCount: number;
  maxActive: number;
  /**
   * The page's current query string, so a filter change MERGES into it rather
   * than rebuilding it. `writePromptsFilters` documents and its test pins that
   * merge behaviour precisely so an unrelated key (a `?highlight=` deep link)
   * survives touching a Select — rebuilding from an empty `URLSearchParams`
   * throws it away. Passed as a prop rather than read from
   * `useSearchParams()`, keeping this component's rule intact: filter values
   * come from props, never from the hook.
   */
  baseQuery?: string;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [addText, setAddText] = useState("");
  const [addIntent, setAddIntent] = useState<PromptIntent>("discovery");
  const [pending, startTransition] = useTransition();

  const atCap = activeCount >= maxActive;
  const capReason = `${activeCount} / ${maxActive} limit`;

  function push(next: Partial<PromptsFilterState>) {
    const merged = { ...filters, ...next };
    router.push(
      `/ai-visibility/prompts${toQuerySuffix(writePromptsFilters(new URLSearchParams(baseQuery), merged))}`
    );
  }

  function toggle(row: PromptRowData) {
    startTransition(async () => {
      const result = await togglePromptAction(row.id, row.status !== "active");
      if (result.ok) router.refresh();
      else toast.error(result.error);
    });
  }

  function save(promptId: string | null, text: string, intent: PromptIntent) {
    const form = new FormData();
    if (promptId) form.set("promptId", promptId);
    form.set("text", text);
    form.set("intent", intent);
    startTransition(async () => {
      const result = await savePromptAction(form);
      if (result.ok) {
        setEditingId(null);
        setAddText("");
        router.refresh();
        toast.success(result.superseded ? "New prompt created — the old one is paused" : "Prompt added");
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove(promptId: string) {
    startTransition(async () => {
      const result = await deletePromptAction(promptId);
      if (result.ok) router.refresh();
      else toast.error(result.error);
    });
  }

  const intentOptions = [
    { value: "all", label: "All intents" },
    ...PROMPT_INTENTS.map((intent) => ({ value: intent, label: INTENT_LABEL[intent] })),
  ];
  const personaOptions = [
    { value: "all", label: "All personas" },
    ...personas.map((persona) => ({ value: persona, label: persona })),
  ];
  const competitorOptions = [
    { value: "all", label: "All competitors" },
    ...competitors.map((competitor) => ({ value: competitor.id, label: competitor.name })),
  ];
  const statusOptions = PROMPT_STATUS_FILTERS.map((status) => ({ value: status, label: STATUS_LABEL[status] }));

  return (
    <div className="space-y-4">
      {/* Filter bar: values as props, never useSearchParams; every change
          pushes a url and the Server Component page re-queries. The cap badge
          lives here rather than on the page, so the count and the controls it
          governs cannot be rendered apart from each other. */}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary">
          {activeCount} / {maxActive}
        </Badge>

        <Select
          value={filters.intent}
          onValueChange={(value) => push({ intent: value as PromptsFilterState["intent"] })}
        >
          <SelectTrigger className="w-40" aria-label="Intent">
            <SelectValue>{labelFor(intentOptions, filters.intent)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {intentOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {personas.length > 0 && (
          <Select value={filters.persona} onValueChange={(value) => push({ persona: value as string })}>
            <SelectTrigger className="w-44" aria-label="Persona">
              <SelectValue>{labelFor(personaOptions, filters.persona)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {personaOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {competitors.length > 0 && (
          <Select value={filters.competitor} onValueChange={(value) => push({ competitor: value as string })}>
            <SelectTrigger className="w-44" aria-label="Competitor">
              <SelectValue>{labelFor(competitorOptions, filters.competitor)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {competitorOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={filters.status}
          onValueChange={(value) => push({ status: value as PromptsFilterState["status"] })}
        >
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue>{labelFor(statusOptions, filters.status)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!promptsFiltersAreDefault(filters) && (
          <Button variant="ghost" size="sm" onClick={() => push(PROMPTS_FILTER_DEFAULTS)}>
            Clear filters
          </Button>
        )}
      </div>

      {/* An empty RESULT, not an empty prompt set — the filter bar above stays
          on screen, which is the only way back. */}
      {rows.length === 0 && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No prompts match these filters.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <div
              data-prompt-row
              className={cn(
                "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3",
                // Paused keeps its history and stays legible — the same
                // treatment a stale SignalRow gets, for the same reason.
                row.status === "paused" && "dashed-outline border-transparent opacity-85"
              )}
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                {editingId === row.id ? (
                  <div className="space-y-2">
                    <Input value={draftText} aria-label="Prompt text" onChange={(e) => setDraftText(e.target.value)} />
                    <p className="text-xs text-muted-foreground">
                      Saving creates a new prompt and pauses this one — its history stays on the old wording.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={pending} onClick={() => save(row.id, draftText, row.intent)}>
                        Save as a new prompt
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Link href={`/ai-visibility/prompts/${row.id}`} className="font-medium hover:underline">
                    {row.text}
                  </Link>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{INTENT_LABEL[row.intent]}</Badge>
                  {row.persona && <Badge variant="outline">{row.persona}</Badge>}
                  {row.competitorName && <Badge variant="outline">{row.competitorName}</Badge>}
                  {row.branded && <Badge variant="outline">Brand check</Badge>}
                  {row.origin === "user" && <Badge variant="outline">Yours</Badge>}
                </div>

                <p className="text-xs text-muted-foreground tabular-nums">{engineChipLine(row.chips)}</p>
                {/* Flagged, never auto-paused: the badge suggests, the human
                    decides. Destructive because it is a defect in the
                    measurement, and this system has no amber. */}
                {row.flagReason && <p className="text-xs text-destructive">{row.flagReason}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Label>
                  <Switch
                    checked={row.status === "active"}
                    disabled={pending}
                    aria-label={`Run ${row.text}`}
                    onCheckedChange={() => toggle(row)}
                  />
                </Label>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${row.text}`} />}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingId(row.id);
                        setDraftText(row.text);
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    {/* Disabled with its reason rather than absent, so "why can
                        I not delete this" is answered where it is asked. */}
                    {row.deletable ? (
                      <DropdownMenuItem variant="destructive" onClick={() => remove(row.id)}>
                        Delete
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem disabled aria-disabled="true" className="flex-col items-start gap-0.5">
                        <span>Delete</span>
                        <span className="text-xs text-muted-foreground">
                          This prompt has run — pause it instead, so its history stays.
                        </span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Add row, shaped like the competitors editor's. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          placeholder="Add a question a buyer would ask"
          aria-label="New prompt"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          className="sm:flex-1"
        />
        <Select value={addIntent} onValueChange={(value) => setAddIntent(value as PromptIntent)}>
          <SelectTrigger className="w-40" aria-label="New prompt intent">
            <SelectValue>{INTENT_LABEL[addIntent]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PROMPT_INTENTS.map((intent) => (
              <SelectItem key={intent} value={intent}>
                {INTENT_LABEL[intent]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={atCap || pending || !addText.trim()}
          onClick={() => save(null, addText.trim(), addIntent)}
        >
          <Plus className="size-4" />
          Add prompt
        </Button>
      </div>
      {atCap && <p className="text-xs text-muted-foreground">{capReason}</p>}
    </div>
  );
}
