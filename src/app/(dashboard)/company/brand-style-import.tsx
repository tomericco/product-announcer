"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { importBrandStyleFromUrl } from "./actions";
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
 * Re-derives the brand guidelines and industry from a public updates/changelog
 * page — the same extraction offered during onboarding, exposed on the Company
 * page. It OVERWRITES the current guidelines and industry, so it
 * confirms first (they're usually hand-tuned). The server revalidates
 * /company on success; router.refresh() re-renders the page's server
 * component with the newly derived values. Those values only reach the form
 * below because the page keys GuidelinesEditor and IndustrySelect on the
 * server value (see company/page.tsx) — without that key, React
 * would keep the existing client instances and the refresh would silently do
 * nothing to what's on screen.
 */
export function BrandStyleImport({ defaultUrl }: { defaultUrl: string }) {
  const [url, setUrl] = useState(defaultUrl);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const router = useRouter();

  // Overwrites hand-tuned brand fields, so the button opens a confirm modal
  // first; `run` only fires once the user confirms in that modal.
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
      const res = await importBrandStyleFromUrl(trimmed);
      if (res.ok) {
        setResult({ ok: true, message: "Brand guidelines updated from your updates page." });
        router.refresh();
      } else {
        setResult({ ok: false, message: "We couldn't read that page — check the URL and try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    // No border/padding here: the page renders this inside a Card, which
    // already supplies both (and its CardTitle supplies the heading this
    // component used to draw itself) -- adding them here would double-border.
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Paste your changelog or &ldquo;what&apos;s new&rdquo; URL and we&apos;ll write your guidelines from it.
        This overwrites your current guidelines.
      </p>
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
            <DialogTitle>Replace your brand guidelines?</DialogTitle>
            <DialogDescription>
              This replaces your brand guidelines and industry with what we derive from the page.
            </DialogDescription>
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
