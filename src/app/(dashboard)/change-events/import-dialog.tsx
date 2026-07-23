"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import {
  listImportableCommits,
  importCommits,
  listImportablePullRequests,
  importPullRequests,
  type ImportableCommit,
  type ImportablePullRequest,
} from "./import-actions";
import type { ImportRepo } from "./actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EventMultiSelect, type PickerRow, type PickerType } from "../_components/event-multi-select";

const ALL = "all";

function selectionKey(repoId: string, sha: string) {
  return `${repoId}:${sha}`;
}

function prSelectionKey(repoId: string, number: number) {
  return `${repoId}#${number}`;
}

export function ImportDialog({ repos }: { repos: ImportRepo[] }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(ALL);
  const [pickerType, setPickerType] = useState<PickerType>("commit");
  const [commits, setCommits] = useState<ImportableCommit[]>([]);
  const [pullRequests, setPullRequests] = useState<ImportablePullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [selectedCommits, setSelectedCommits] = useState<Map<string, CommitSelection>>(new Map());
  const [selectedPRs, setSelectedPRs] = useState<Map<string, PullRequestSelection>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  const repoIds = activeTab === ALL ? repos.map((r) => r.id) : [activeTab];

  const load = useCallback(async () => {
    if (repoIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      if (pickerType === "pull_request") {
        const { pullRequests } = await listImportablePullRequests({ repoIds });
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
      if (pickerType === "pull_request") {
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
    setSearch("");
    setAfter("");
    setBefore("");
    setActiveTab(ALL);
    setPickerType("commit");
    setError(null);
  }

  async function onImport() {
    const selectedCount = pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;
    if (selectedCount === 0) return;
    setSubmitting(true);
    try {
      if (pickerType === "pull_request") {
        await importPullRequests({ selections: Array.from(selectedPRs.values()) });
      } else {
        await importCommits({ selections: Array.from(selectedCommits.values()) });
      }
      reset();
      setOpen(false);
    } catch {
      // The commits/PRs themselves are durably inserted before the resolver
      // runs, so a throw here means resolution failed, not the import — the
      // rows recover via the hourly sweep. Still, the user must see that
      // something went wrong rather than the dialog silently sitting open.
      setError("Import succeeded but something went wrong finishing up. It will retry automatically.");
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

  const rows: PickerRow[] = pickerType === "pull_request" ? prRows : commitRows;
  const selectedCount = pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;

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
          <Button variant="outline" disabled={repos.length === 0}>
            <Download />
            Import
          </Button>
        }
      />
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          {/* Commits and PRs are the sources this dialog supports so far;
              Notion-task import will follow into the same flow. */}
          <DialogDescription>From commits or PRs for now — Notion tasks are next.</DialogDescription>
        </DialogHeader>

        <EventMultiSelect
          activeType={pickerType}
          onTypeChange={(t) => {
            setPickerType(t);
            setSelectedCommits(new Map());
            setSelectedPRs(new Map());
          }}
          enabledTypes={["commit", "pull_request"]}
          rows={rows}
          loading={loading}
          error={error}
          emptyLabel={pickerType === "pull_request" ? "No pull requests found." : "No commits found."}
          selected={new Set(pickerType === "pull_request" ? selectedPRs.keys() : selectedCommits.keys())}
          onSelectedChange={(nextKeys) => {
            if (pickerType === "pull_request") {
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
          searchPlaceholder={pickerType === "pull_request" ? "Search PR titles…" : "Search commit messages…"}
          filtersSlot={
            <>
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

              {pickerType === "commit" && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="after" className="text-xs text-muted-foreground">
                      After
                    </Label>
                    <Input
                      id="after"
                      type="date"
                      className="w-40"
                      value={after}
                      onChange={(e) => setAfter(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="before" className="text-xs text-muted-foreground">
                      Before
                    </Label>
                    <Input
                      id="before"
                      type="date"
                      className="w-40"
                      value={before}
                      onChange={(e) => setBefore(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </>
          }
          submitLabel={
            submitting
              ? "Importing…"
              : pickerType === "pull_request"
                ? `Import ${selectedCount} PR${selectedCount === 1 ? "" : "s"}`
                : `Import ${selectedCount} commit${selectedCount === 1 ? "" : "s"}`
          }
          submitting={submitting}
          onSubmit={onImport}
        />

        <DialogFooter className="items-center sm:justify-end">
          <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
