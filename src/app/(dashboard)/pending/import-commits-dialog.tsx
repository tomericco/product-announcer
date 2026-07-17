"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { listImportableCommits, importCommits, type ImportableCommit } from "./actions";
import type { CommitSelection } from "@/lib/change-items/import-commits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ImportRepo = { id: string; fullName: string; watchedBranch: string };

const ALL = "all";

function selectionKey(repoId: string, sha: string) {
  return `${repoId}:${sha}`;
}

export function ImportCommitsDialog({ repos }: { repos: ImportRepo[] }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(ALL);
  const [commits, setCommits] = useState<ImportableCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [selected, setSelected] = useState<Map<string, CommitSelection>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  const repoIds = activeTab === ALL ? repos.map((r) => r.id) : [activeTab];

  const load = useCallback(async () => {
    if (repoIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const { commits } = await listImportableCommits({
        repoIds,
        since: after ? `${after}T00:00:00Z` : undefined,
        until: before ? `${before}T23:59:59Z` : undefined,
      });
      setCommits(commits);
    } catch {
      setCommits([]);
      setError("Couldn't load commits. Try again.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, after, before]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function reset() {
    setSelected(new Map());
    setSearch("");
    setAfter("");
    setBefore("");
    setActiveTab(ALL);
    setError(null);
  }

  function toggle(commit: ImportableCommit) {
    const key = selectionKey(commit.repoId, commit.sha);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else
        next.set(key, {
          repoId: commit.repoId,
          sha: commit.sha,
          message: commit.message,
          url: commit.url,
          committedAt: commit.committedAt,
        });
      return next;
    });
  }

  async function onImport() {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      await importCommits({ selections: Array.from(selected.values()) });
      reset();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  const query = search.trim().toLowerCase();
  const visible = query
    ? commits.filter((c) => c.message.toLowerCase().includes(query))
    : commits;
  const selectable = visible.filter((c) => !c.imported);
  const allSelected =
    selectable.length > 0 && selectable.every((c) => selected.has(selectionKey(c.repoId, c.sha)));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allSelected) {
        for (const c of selectable) next.delete(selectionKey(c.repoId, c.sha));
      } else {
        for (const c of selectable)
          next.set(selectionKey(c.repoId, c.sha), {
            repoId: c.repoId,
            sha: c.sha,
            message: c.message,
            url: c.url,
            committedAt: c.committedAt,
          });
      }
      return next;
    });
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
          <Button variant="outline" disabled={repos.length === 0}>
            <Download />
            Import commits
          </Button>
        }
      />
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import commits</DialogTitle>
        </DialogHeader>

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

        <div className="flex flex-wrap items-end gap-2">
          <Input
            className="min-w-48 flex-1"
            placeholder="Search commit messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="space-y-1">
            <Label htmlFor="before" className="text-xs text-muted-foreground">
              Before
            </Label>
            <Input id="before" type="date" className="w-40" value={before} onChange={(e) => setBefore(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="after" className="text-xs text-muted-foreground">
              After
            </Label>
            <Input id="after" type="date" className="w-40" value={after} onChange={(e) => setAfter(e.target.value)} />
          </div>
        </div>

        <div className="h-80 overflow-y-auto rounded-lg border border-border">
          <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-border bg-background px-4 py-2.5 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={allSelected}
              disabled={selectable.length === 0}
              onChange={toggleAll}
            />
            Select all{selectable.length > 0 ? ` (${selectable.length})` : ""}
          </label>
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading commits…</p>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : visible.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No commits found.</p>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((commit) => {
                const key = selectionKey(commit.repoId, commit.sha);
                const checked = commit.imported || selected.has(key);
                return (
                  <li key={key}>
                    <label
                      className={
                        "flex cursor-pointer items-start gap-3 px-4 py-3.5 text-sm hover:bg-muted/50" +
                        (commit.imported ? " cursor-not-allowed opacity-60" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 rounded border-input"
                        checked={checked}
                        disabled={commit.imported}
                        onChange={() => toggle(commit)}
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block truncate font-medium">{commit.message.split("\n")[0]}</span>
                        <span className="block text-xs text-muted-foreground">
                          {activeTab === ALL && (
                            <span className="font-medium text-foreground/70">{commit.repoFullName} · </span>
                          )}
                          {commit.authorName && <>{commit.authorName} · </>}
                          <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                          {commit.committedAt &&
                            ` · ${new Date(commit.committedAt).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}`}
                        </span>
                      </span>
                      {commit.imported && (
                        <Badge variant="secondary" className="shrink-0 self-center">
                          Imported
                        </Badge>
                      )}
                      <a
                        href={commit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Open commit on GitHub"
                        title="Open on GitHub"
                        className="shrink-0 self-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">{selected.size} selected</span>
          <div className="flex gap-2">
            <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
            <Button type="button" onClick={onImport} disabled={selected.size === 0 || submitting}>
              {submitting ? "Importing…" : `Import ${selected.size} commit${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
