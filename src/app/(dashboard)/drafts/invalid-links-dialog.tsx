"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  collectInvalidLinks,
  applyLinkFixes,
  isValidLinkTarget,
  LINK_PLACEHOLDER,
  type EditableLink,
  type LinkProblem,
} from "@/lib/ai/validate-links";

const REASON_LABEL: Record<EditableLink["reason"], string> = {
  placeholder: "Unfilled link",
  malformed: "Not a valid URL",
  unreachable: "Link didn’t respond",
};

/** The read-only context shown for a row: the link text, or the placeholder token. */
function linkContext(link: EditableLink): string {
  if (link.reason === "placeholder") return LINK_PLACEHOLDER;
  return link.text.trim() || "(no link text)";
}

/**
 * Interactive rows — one URL input per invalid link. Split out and remounted via
 * `key` on each new target so the URL drafts seed from props once (a `useState`
 * initializer) rather than syncing through an effect.
 */
function InvalidLinksForm({
  body,
  problems,
  onSave,
  onCancel,
}: {
  body: string;
  problems: LinkProblem[];
  onSave: (patchedBody: string) => Promise<void>;
  onCancel: () => void;
}) {
  const links = useMemo<EditableLink[]>(() => {
    const unreachable = problems.filter((p) => p.reason === "unreachable").map((p) => p.url);
    return collectInvalidLinks(body, unreachable);
  }, [body, problems]);

  const [urls, setUrls] = useState<string[]>(() => links.map((l) => l.url));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const invalid = urls.map((u) => !isValidLinkTarget(u.trim()));

  async function save() {
    setTouched(true);
    if (invalid.some(Boolean)) return;
    const fixes = links.map((link, i) => ({ ...link, url: urls[i].trim() }));
    setSaving(true);
    try {
      // On success the parent closes the modal (unmounting this form), so there
      // is no trailing setState; only reset the busy flag if the save failed.
      await onSave(applyLinkFixes(body, fixes));
    } catch {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="size-5 text-destructive" />
          Fix links before publishing
        </DialogTitle>
        <DialogDescription>
          {links.length === 1 ? "This link isn’t valid" : "These links aren’t valid"}. Add a working
          URL for {links.length === 1 ? "it" : "each"}, then save.
        </DialogDescription>
      </DialogHeader>

      <ul className="space-y-3 overflow-y-auto">
        {links.map((link, i) => (
          <li key={`${link.start}-${link.reason}`} className="space-y-1.5 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{linkContext(link)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{REASON_LABEL[link.reason]}</span>
            </div>
            <input
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={urls[i] ?? ""}
              onChange={(e) => setUrls((prev) => prev.map((u, j) => (j === i ? e.target.value : u)))}
              aria-invalid={touched && invalid[i]}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
            />
            {touched && invalid[i] && (
              <p className="text-xs text-destructive">Enter a valid URL (http, https, or mailto).</p>
            )}
          </li>
        ))}
      </ul>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={saving || links.length === 0}>
          {saving ? "Saving…" : "Save links"}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Publish-time error modal. Lists every invalid link in the draft with its
 * display text (read-only) and a URL input, so the author can fix them and save
 * without leaving the modal. `onSave` receives the patched body and persists it;
 * open state is derived from `target` by the parent.
 */
export function InvalidLinksDialog({
  target,
  onSave,
  onOpenChange,
}: {
  target: { body: string; problems: LinkProblem[] } | null;
  onSave: (patchedBody: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 sm:max-w-lg">
        {target && (
          <InvalidLinksForm
            key={target.body}
            body={target.body}
            problems={target.problems}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
