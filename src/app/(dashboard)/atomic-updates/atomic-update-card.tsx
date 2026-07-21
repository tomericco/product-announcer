"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editAtomicUpdate, type AtomicUpdateRow } from "./actions";
import { CategoryBadge } from "./page";

export function AtomicUpdateCard({ row }: { row: AtomicUpdateRow }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [summary, setSummary] = useState(row.summary);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        await editAtomicUpdate(row.id, { title, summary });
        setEditing(false);
        toast.success("Atomic update saved");
      } catch (error) {
        // Server actions reject with an opaque digest in production; surface
        // what we can rather than leaving the form silently stuck.
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  return (
    <div className="rounded-lg border p-4">
      {editing ? (
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setTitle(row.title);
                setSummary(row.summary);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{row.title}</h2>
            <CategoryBadge category={row.category} />
          </div>
          <p className="text-sm text-muted-foreground">{row.summary}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {row.eventCount} {row.eventCount === 1 ? "change" : "changes"}
            </span>
            {/* Signals to the user why this one stopped auto-updating. */}
            {row.summaryEditedAt && <span>Edited</span>}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
