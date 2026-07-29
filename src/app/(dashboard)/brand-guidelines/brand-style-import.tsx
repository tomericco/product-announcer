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
 * Re-derives the brand-style fields from a public updates/changelog page — the
 * same extraction offered during onboarding, exposed in Settings. It OVERWRITES
 * the current brand fields, so it confirms first (Settings usually holds
 * hand-tuned values). The server revalidates /settings on success; router.refresh
 * pulls the freshly-derived fields into the form below.
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
        setResult({ ok: true, message: "Brand style updated from your updates page." });
        router.refresh();
      } else {
        setResult({ ok: false, message: "We couldn't read that page — check the URL and try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">Derive from your updates page</p>
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
            <DialogTitle>Replace your brand style?</DialogTitle>
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
