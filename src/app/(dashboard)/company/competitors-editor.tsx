"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { addCompetitorAction, discoverSourcesAction, removeCompetitorAction } from "./actions";
import { DATE_FORMAT, SourceStatusBadge } from "./source-status";
import type { Competitor, Source } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One watched page's health: status, when it last ran successfully, whether
 * an agent-facing variant was found (the daily agent prefers it when
 * present), and its error when the last run failed. Follows the Notion/
 * Webflow integration cards' tone -- a status badge in the header slot, the
 * error surfaced as text rather than only logged -- rather than inventing a
 * new treatment for source health specifically.
 *
 * A source with no `lastRunAt` hasn't been swept yet (it was just
 * discovered); the card-level note above the competitors list is what
 * explains that its first run, once it happens, is a silent baseline.
 */
function SourceHealth({ source }: { source: Source }) {
  return (
    <li className="rounded-md border border-dashed p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-medium hover:underline"
            >
              {source.label}
            </a>
          ) : (
            <span className="truncate font-medium">{source.label}</span>
          )}
          <p className="text-muted-foreground">
            {source.agentUrl ? "Agent-facing page found" : "No agent-facing page found — reading the regular page"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground">
            {source.lastSuccessAt ? `Last ran ${DATE_FORMAT.format(source.lastSuccessAt)}` : "Not run yet"}
          </span>
          <SourceStatusBadge status={source.status} />
        </div>
      </div>
      {source.lastError && <p className="mt-1 text-destructive">{source.lastError}</p>}
    </li>
  );
}

/**
 * Renders straight off the `competitors` prop with no local copy of the list,
 * unlike PersonasEditor next door -- add and remove both revalidate `/company`
 * and call router.refresh(), which re-renders this component with the fresh
 * list from the server. Only the add-form's own inputs are local state.
 *
 * `sourcesByCompetitor` is likewise server-derived and indexed by competitor
 * id -- see the grouping comment in page.tsx for why the grouping happens
 * there rather than here.
 */
export function CompetitorsEditor({
  competitors,
  sourcesByCompetitor,
}: {
  competitors: Competitor[];
  sourcesByCompetitor: Record<string, Source[]>;
}) {
  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const router = useRouter();

  async function add() {
    const trimmed = name.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      const form = new FormData();
      form.set("name", trimmed);
      form.set("websiteUrl", websiteUrl.trim());
      const result = await addCompetitorAction(form);
      if (result.ok) {
        setName("");
        setWebsiteUrl("");
        router.refresh();
        if (result.reason === "exists") {
          toast.warning(`${trimmed} is already on your list`);
        }
      } else {
        toast.error("Enter a name first");
      }
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string) {
    setRemovingId(id);
    try {
      await removeCompetitorAction(id);
      router.refresh();
    } catch {
      toast.error("Couldn't remove that competitor — try again");
    } finally {
      setRemovingId(null);
    }
  }

  async function discover(id: string) {
    setDiscoveringId(id);
    try {
      const result = await discoverSourcesAction(id);
      if (result.ok) {
        router.refresh();
        toast.success(
          result.count
            ? `Found ${result.count} page${result.count === 1 ? "" : "s"} to watch`
            : "No changelog, blog, or release-notes pages found"
        );
      } else if (result.reason === "no-website") {
        toast.error("Add a website first");
      } else if (result.reason === "not-found") {
        toast.error("Couldn't find that competitor — try refreshing the page");
      } else {
        // "invalid-id" or any other unrecognized reason: not something the
        // shown competitor list can produce through normal use, so it's
        // treated the same as the discovery request itself failing below.
        toast.error("Couldn't search that site — try again");
      }
    } catch {
      toast.error("Couldn't search that site — try again");
    } finally {
      setDiscoveringId(null);
    }
  }

  return (
    <div className="space-y-3">
      {competitors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No competitors yet.</p>
      ) : (
        <ul className="space-y-2">
          {competitors.map((c) => {
            const sources = sourcesByCompetitor[c.id] ?? [];
            return (
              <li key={c.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    {c.websiteUrl && <p className="truncate text-xs text-muted-foreground">{c.websiteUrl}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {c.websiteUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={discoveringId === c.id}
                        onClick={() => discover(c.id)}
                      >
                        <Search className="size-4" />
                        {discoveringId === c.id ? "Searching…" : "Find pages to watch"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={removingId === c.id}
                      onClick={() => remove(c.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {sources.length > 0 && (
                  <ul className="space-y-1.5 pl-1">
                    {sources.map((source) => (
                      <SourceHealth key={source.id} source={source} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          placeholder="Competitor name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="sm:flex-1"
        />
        <Input
          type="url"
          placeholder="Website (optional)"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          className="sm:flex-1"
        />
        <Button type="button" variant="outline" onClick={add} disabled={adding || !name.trim()}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  );
}
