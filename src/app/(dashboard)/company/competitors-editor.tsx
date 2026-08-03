"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { addCompetitorAction, removeCompetitorAction } from "./actions";
import type { Competitor } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Renders straight off the `competitors` prop with no local copy of the list,
 * unlike PersonasEditor next door -- add and remove both revalidate `/company`
 * and call router.refresh(), which re-renders this component with the fresh
 * list from the server. Only the add-form's own inputs are local state.
 */
export function CompetitorsEditor({ competitors }: { competitors: Competitor[] }) {
  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
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

  return (
    <div className="space-y-3">
      {competitors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No competitors yet.</p>
      ) : (
        <ul className="space-y-2">
          {competitors.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.name}</p>
                {c.websiteUrl && <p className="truncate text-xs text-muted-foreground">{c.websiteUrl}</p>}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={removingId === c.id}
                onClick={() => remove(c.id)}
              >
                Remove
              </Button>
            </li>
          ))}
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
