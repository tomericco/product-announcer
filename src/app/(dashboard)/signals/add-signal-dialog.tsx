"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { addSignal } from "./actions";
import type { ManualSignalInput } from "@/lib/signals/manual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Local YYYY-MM-DD, not `toISOString().slice(0, 10)` — that reads UTC, which
// on the west side of midnight would pre-fill "yesterday" for someone who,
// by their own clock, is entering something that happened today.
function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The add-signal form: for the competitor post, webinar, or talk the agents
 * missed. Only `title` is required — `url`, `excerpt`, and the date are all
 * optional, matching `ManualSignalInput`. The date field is pre-filled with
 * today (per the spec's "defaults to today") but stays editable and can be
 * cleared, in which case `createManualSignal` applies its own `new Date()`
 * default at write time.
 *
 * Submits straight to the `addSignal` server action — no client-side
 * dedupe check — and surfaces `{ ok: false }` inline. The duplicate-URL case
 * is the one most users hit, and `createManualSignal` already phrases it as
 * "You already have a signal for this link," so it reads as an ordinary
 * validation message rather than a crash; this form doesn't need to special-
 * case it further.
 */
export function AddSignalDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [date, setDate] = useState(todayLocalDate());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTitle("");
    setUrl("");
    setExcerpt("");
    setDate(todayLocalDate());
    setError(null);
    setSubmitting(false);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    const input: ManualSignalInput = {
      title: trimmedTitle,
      url: url.trim() || null,
      excerpt: excerpt.trim() || null,
      occurredAt: date ? new Date(`${date}T00:00:00.000Z`) : null,
    };

    const result = await addSignal(input);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    reset();
    setOpen(false);
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
          <Button variant="outline">
            <Plus />
            Add signal
          </Button>
        }
      />
      <DialogContent className="flex flex-col gap-5 p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a signal</DialogTitle>
          <DialogDescription>
            Record a competitor post, webinar, or talk the agents missed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signal-title">Title</Label>
            <Input
              id="signal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What happened"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signal-url">URL</Label>
            <Input
              id="signal-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signal-excerpt">Excerpt</Label>
            <Textarea
              id="signal-excerpt"
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
              rows={3}
              placeholder="A sentence or two of context"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signal-date">Date</Label>
            <Input id="signal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? "Adding…" : "Add signal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
