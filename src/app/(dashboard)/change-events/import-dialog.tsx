"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import {
  listImportableCommits,
  importCommits,
  listImportablePullRequests,
  importPullRequests,
  listImportableTasks,
  importTasks,
  type ImportableCommit,
  type ImportablePullRequest,
  type ImportableTask,
  type TaskSelection,
} from "./import-actions";
import type { ImportRepo } from "./actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EventMultiSelect, type PickerRow, type PickerType } from "../_components/event-multi-select";
import { DisabledHint } from "../_components/disabled-hint";

const ALL = "all";

function selectionKey(repoId: string, sha: string) {
  return `${repoId}:${sha}`;
}

function prSelectionKey(repoId: string, number: number) {
  return `${repoId}#${number}`;
}

// A date filter whose label doubles as the placeholder. Native
// <input type="date"> ignores `placeholder`, so this renders as a text input
// (showing the placeholder) while empty and unfocused, and swaps to a real
// date picker on focus or once a date is set — keeping the filter row compact
// with no floating label above.
function DateFilter({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Input
      type={value || focused ? "date" : "text"}
      className="w-40"
      placeholder={placeholder}
      aria-label={placeholder}
      value={value}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The change-event selector. Used by the change-events "Import" flow (the
 * defaults) and, with the same selector but a different CTA, by the atomic-
 * updates "New atomic update" flow (which passes its own trigger/title/labels
 * and submit actions that group the selected events into one new atomic
 * update). Everything about the selector — repo tabs, search, type dropdown,
 * After/Before, snapshot-map selection — is identical; only the CTA outcome
 * differs.
 */
export function ImportDialog({
  repos,
  trigger,
  title = "Import",
  description = "From commits, PRs, or Notion tasks.",
  commitSubmit,
  pullRequestSubmit,
  submitLabel,
  resolveErrorMessage,
  enableTasks = false,
  notionConnected = false,
}: {
  repos: ImportRepo[];
  // A ReactElement (not ReactNode) — DialogTrigger's `render` requires a single
  // element to clone the trigger behavior onto.
  trigger?: React.ReactElement;
  title?: string;
  description?: React.ReactNode;
  commitSubmit?: (selections: CommitSelection[]) => Promise<void>;
  pullRequestSubmit?: (selections: PullRequestSelection[]) => Promise<void>;
  submitLabel?: (opts: { type: PickerType; count: number; submitting: boolean }) => string;
  resolveErrorMessage?: (error: unknown) => string;
  enableTasks?: boolean;
  notionConnected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(ALL);
  const [pickerType, setPickerType] = useState<PickerType>("commit");
  const [commits, setCommits] = useState<ImportableCommit[]>([]);
  const [pullRequests, setPullRequests] = useState<ImportablePullRequest[]>([]);
  const [tasks, setTasks] = useState<ImportableTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [selectedCommits, setSelectedCommits] = useState<Map<string, CommitSelection>>(new Map());
  const [selectedPRs, setSelectedPRs] = useState<Map<string, PullRequestSelection>>(new Map());
  const [selectedTasks, setSelectedTasks] = useState<Map<string, TaskSelection>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  const repoIds = activeTab === ALL ? repos.map((r) => r.id) : [activeTab];

  const load = useCallback(async () => {
    if (pickerType !== "task" && repoIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      if (pickerType === "task") {
        const { tasks } = await listImportableTasks({
          since: after ? `${after}T00:00:00Z` : undefined,
          until: before ? `${before}T23:59:59Z` : undefined,
        });
        setTasks(tasks);
      } else if (pickerType === "pull_request") {
        const { pullRequests } = await listImportablePullRequests({
          repoIds,
          since: after ? `${after}T00:00:00Z` : undefined,
          until: before ? `${before}T23:59:59Z` : undefined,
        });
        setPullRequests(pullRequests);
      } else {
        const { commits } = await listImportableCommits({
          repoIds,
          since: after ? `${after}T00:00:00Z` : undefined,
          until: before ? `${before}T23:59:59Z` : undefined,
        });
        setCommits(commits);
      }
    } catch {
      if (pickerType === "task") {
        setTasks([]);
        setError("Couldn't load tasks. Try again.");
      } else if (pickerType === "pull_request") {
        setPullRequests([]);
        setError("Couldn't load pull requests. Try again.");
      } else {
        setCommits([]);
        setError("Couldn't load commits. Try again.");
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, after, before, pickerType]);

  useEffect(() => {
    // This is the standard fetch-on-open pattern: `load` sets a loading flag
    // before its first await, which the newer react-hooks lint rule flags as
    // "setState synchronously in an effect". It's an intentional, well-known
    // effect for kicking off data fetching keyed by dialog visibility/filters.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) load();
  }, [open, load]);

  function reset() {
    setSelectedCommits(new Map());
    setSelectedPRs(new Map());
    setSelectedTasks(new Map());
    setSearch("");
    setAfter("");
    setBefore("");
    setActiveTab(ALL);
    setPickerType("commit");
    setError(null);
  }

  // Defaults preserve the change-events "Import" behavior exactly; the
  // atomic-updates caller overrides the submit actions + labels.
  const doCommitSubmit =
    commitSubmit ??
    (async (sel: CommitSelection[]) => {
      await importCommits({ selections: sel });
    });
  const doPullRequestSubmit =
    pullRequestSubmit ??
    (async (sel: PullRequestSelection[]) => {
      await importPullRequests({ selections: sel });
    });
  const doTaskSubmit = async (sel: TaskSelection[]) => {
    await importTasks({ selections: sel });
  };
  const labelFor =
    submitLabel ??
    (({ type, count, submitting: isSubmitting }: { type: PickerType; count: number; submitting: boolean }) =>
      isSubmitting
        ? "Importing…"
        : type === "task"
          ? `Import ${count} task${count === 1 ? "" : "s"}`
          : type === "pull_request"
            ? `Import ${count} PR${count === 1 ? "" : "s"}`
            : `Import ${count} commit${count === 1 ? "" : "s"}`);
  const errorFor =
    resolveErrorMessage ??
    (() => "Import succeeded but something went wrong finishing up. It will retry automatically.");

  async function onImport() {
    const selectedCount =
      pickerType === "task" ? selectedTasks.size : pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;
    if (selectedCount === 0) return;
    setSubmitting(true);
    try {
      if (pickerType === "task") {
        await doTaskSubmit(Array.from(selectedTasks.values()));
      } else if (pickerType === "pull_request") {
        await doPullRequestSubmit(Array.from(selectedPRs.values()));
      } else {
        await doCommitSubmit(Array.from(selectedCommits.values()));
      }
      reset();
      setOpen(false);
    } catch (e) {
      // For the default import path a throw means resolution failed (the rows
      // are durably inserted and recover via the hourly sweep), so the default
      // errorFor shows a reassuring, fixed message regardless of `e`. Other
      // callers (create-atomic-update) surface the actual failure reason.
      setError(errorFor(e));
    } finally {
      setSubmitting(false);
    }
  }

  const commitRows: PickerRow[] = commits.map((c) => ({
    key: selectionKey(c.repoId, c.sha),
    title: c.message.split("\n")[0],
    meta: (
      <>
        {activeTab === ALL && <span className="font-medium text-foreground/70">{c.repoFullName} · </span>}
        {c.authorName && <>{c.authorName} · </>}
        <span className="font-mono">{c.sha.slice(0, 7)}</span>
        {c.committedAt &&
          ` · ${new Date(c.committedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`}
      </>
    ),
    externalUrl: c.url,
    locked: c.imported,
    badge: c.imported ? "Imported" : undefined,
  }));

  const prRows: PickerRow[] = pullRequests.map((pr) => ({
    key: prSelectionKey(pr.repoId, pr.number),
    title: pr.title,
    meta: (
      <>
        {activeTab === ALL && <span className="font-medium text-foreground/70">{pr.repoFullName} · </span>}
        {pr.authorName && <>{pr.authorName} · </>}
        {`#${pr.number}`}
        {pr.mergedAt &&
          ` · ${new Date(pr.mergedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`}
      </>
    ),
    externalUrl: pr.url,
    locked: pr.imported,
    badge: pr.imported ? "Imported" : undefined,
  }));

  const taskRows: PickerRow[] = tasks.map((t) => ({
    key: t.pageId,
    title: t.title || "(untitled task)",
    meta: (
      <>
        {t.status && <>{t.status} · </>}
        {t.completedAt &&
          new Date(t.completedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </>
    ),
    externalUrl: t.url || null,
    locked: t.imported,
    badge: t.imported ? "Imported" : undefined,
  }));

  const rows: PickerRow[] =
    pickerType === "task" ? taskRows : pickerType === "pull_request" ? prRows : commitRows;
  const selectedCount =
    pickerType === "task" ? selectedTasks.size : pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;
  const enabledTypes: PickerType[] = enableTasks ? ["commit", "pull_request", "task"] : ["commit", "pull_request"];

  // Nothing to import from: no watched repos, and either tasks are off or Notion
  // isn't connected. Previously this read `repos.length === 0 && !enableTasks`,
  // which left the button permanently enabled on the change-events page — that
  // page passes `enableTasks` unconditionally, so merely *offering* the tasks tab
  // was mistaken for *having* a Notion connection.
  //
  // Placed after every hook so the hook order stays unconditional. A caller that
  // supplies its own `trigger` owns its disabled state, so this only governs the
  // default one.
  const noImportSources = repos.length === 0 && !(enableTasks && notionConnected);
  if (!trigger && noImportSources) {
    return (
      <DisabledHint hint="Connect GitHub or Notion to import changes">
        <Button variant="outline" disabled>
          <Download />
          Import
        </Button>
      </DisabledHint>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          trigger ?? (
            <Button variant="outline">
              <Download />
              Import
            </Button>
          )
        }
      />
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <EventMultiSelect
          activeType={pickerType}
          onTypeChange={(t) => {
            setPickerType(t);
            setSelectedCommits(new Map());
            setSelectedPRs(new Map());
            setSelectedTasks(new Map());
          }}
          enabledTypes={enabledTypes}
          rows={rows}
          loading={loading}
          error={error}
          emptyLabel={
            pickerType === "task"
              ? notionConnected
                ? "No completed tasks found."
                : "Connect Notion to import tasks."
              : pickerType === "pull_request"
                ? "No pull requests found."
                : "No commits found."
          }
          selected={
            new Set(
              pickerType === "task"
                ? selectedTasks.keys()
                : pickerType === "pull_request"
                  ? selectedPRs.keys()
                  : selectedCommits.keys()
            )
          }
          onSelectedChange={(nextKeys) => {
            if (pickerType === "task") {
              setSelectedTasks((prev) => {
                const byKey = new Map<string, TaskSelection>();
                for (const t of tasks) {
                  byKey.set(t.pageId, { pageId: t.pageId, title: t.title, url: t.url, completedAt: t.completedAt });
                }
                const next = new Map<string, TaskSelection>();
                for (const key of nextKeys) {
                  const entry = prev.get(key) ?? byKey.get(key);
                  if (entry) next.set(key, entry);
                }
                return next;
              });
            } else if (pickerType === "pull_request") {
              setSelectedPRs((prev) => {
                const byKey = new Map<string, PullRequestSelection>();
                for (const pr of pullRequests) {
                  byKey.set(prSelectionKey(pr.repoId, pr.number), {
                    repoId: pr.repoId,
                    number: pr.number,
                    title: pr.title,
                    body: pr.body,
                    url: pr.url,
                    mergedAt: pr.mergedAt,
                  });
                }
                const next = new Map<string, PullRequestSelection>();
                for (const key of nextKeys) {
                  const entry = prev.get(key) ?? byKey.get(key);
                  if (entry) next.set(key, entry);
                }
                return next;
              });
            } else {
              setSelectedCommits((prev) => {
                const byKey = new Map<string, CommitSelection>();
                for (const c of commits) {
                  byKey.set(selectionKey(c.repoId, c.sha), {
                    repoId: c.repoId,
                    sha: c.sha,
                    message: c.message,
                    url: c.url,
                    committedAt: c.committedAt,
                  });
                }
                const next = new Map<string, CommitSelection>();
                for (const key of nextKeys) {
                  const entry = prev.get(key) ?? byKey.get(key);
                  if (entry) next.set(key, entry);
                }
                return next;
              });
            }
          }}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={
            pickerType === "task"
              ? "Search task titles…"
              : pickerType === "pull_request"
                ? "Search PR titles…"
                : "Search commit messages…"
          }
          filtersSlot={
            pickerType === "task" ? null : (
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as string)}>
                <TabsList className="h-auto max-w-full flex-wrap">
                  <TabsTrigger value={ALL}>All</TabsTrigger>
                  {repos.map((r) => (
                    <TabsTrigger key={r.id} value={r.id}>
                      {r.fullName.split("/").pop()}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )
          }
          inlineFilters={
            <>
              <DateFilter value={after} onChange={setAfter} placeholder="After" />
              <DateFilter value={before} onChange={setBefore} placeholder="Before" />
            </>
          }
          submitLabel={labelFor({ type: pickerType, count: selectedCount, submitting })}
          submitting={submitting}
          onSubmit={onImport}
          secondaryAction={
            <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
          }
        />
      </DialogContent>
    </Dialog>
  );
}
