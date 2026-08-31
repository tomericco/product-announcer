"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { importBrandStyleFromUrl, importProductUpdateTemplateFromUrl } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Re-derives one thing from a public updates/changelog page.
 *
 * ONE component, two kinds. The two analyses read the same page and answer
 * different questions — how the company sounds, and what shape its updates
 * take — and each lives inside the card for the field it writes, so a person
 * re-runs the one they are looking at. They were a single call and a single
 * button until 2026-08-31; coupling them meant iterating on the template (the
 * less reliable of the two) overwrote hand-tuned guidelines every attempt.
 *
 * Both seed their URL from `updatesPageUrl` and both write it back, since it
 * records where the company's updates live rather than belonging to either
 * analysis.
 *
 * Each overwrites a field people hand-tune, so the button opens a confirm
 * modal first. The server revalidates /company on success; `router.refresh()`
 * re-renders the page's server component with the new value. That value only
 * reaches the editor below because the page keys it on the server value (see
 * company/page.tsx) — without that key React keeps the existing client
 * instance and the refresh silently changes nothing on screen.
 */
type ImportKind = "guidelines" | "template";

const COPY: Record<
  ImportKind,
  {
    hint: string;
    confirmTitle: string;
    confirmBody: string;
    success: string;
    /**
     * Shown when the page was read fine but the analysis produced nothing.
     * Worth its own message rather than folding into the fetch failure: for the
     * template especially this is a normal, actionable outcome — the page has
     * no consistent structure to copy — and telling someone to check their URL
     * would send them hunting for a better one that does not exist.
     */
    empty: string;
  }
> = {
  guidelines: {
    hint: "Paste your changelog or “what’s new” URL and we’ll write your guidelines from it. This overwrites your current guidelines.",
    confirmTitle: "Replace your brand guidelines?",
    confirmBody: "This replaces your brand guidelines and industry with what we derive from the page. Your product update template is not affected.",
    success: "Brand guidelines updated from your updates page.",
    empty: "We read the page but couldn’t infer a voice from it. Your guidelines are unchanged.",
  },
  template: {
    hint: "Derive the structure your updates follow — headings, section order, sign-off — from the same page. This overwrites your current template.",
    confirmTitle: "Replace your product update template?",
    confirmBody: "This replaces your template with the structure we derive from the page. Your brand guidelines are not affected.",
    success: "Product update template updated from your updates page.",
    empty: "We read the page but couldn’t find a consistent structure to copy. Your template is unchanged.",
  },
};

export function UpdatesPageImport({ kind, defaultUrl }: { kind: ImportKind; defaultUrl: string }) {
  const [url, setUrl] = useState(defaultUrl);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const router = useRouter();
  const copy = COPY[kind];

  function requestRun() {
    if (!url.trim() || loading) return;
    setConfirmOpen(true);
  }

  async function run() {
    setConfirmOpen(false);
    const trimmed = url.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setResult(null);
    try {
      const res =
        kind === "guidelines"
          ? await importBrandStyleFromUrl(trimmed)
          : await importProductUpdateTemplateFromUrl(trimmed);
      if (res.ok) {
        setResult({ ok: true, message: copy.success });
        router.refresh();
      } else if (res.reason === "analysis-empty") {
        setResult({ ok: false, message: copy.empty });
      } else {
        setResult({ ok: false, message: "We couldn’t read that page — check the URL and try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    // No border/padding here: the page renders this inside a Card, which
    // already supplies both.
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{copy.hint}</p>
      <div className="flex gap-2">
        <Input
          type="url"
          placeholder="https://yourproduct.com/changelog"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1"
        />
        <Button type="button" variant="outline" onClick={requestRun} disabled={loading || !url.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {loading ? "Analyzing…" : "Re-analyze"}
        </Button>
      </div>
      {result && (
        <p className={result.ok ? "text-xs text-emerald-600" : "text-xs text-muted-foreground"}>{result.message}</p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{copy.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={run}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
