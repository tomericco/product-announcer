"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { importBrandStyleFromUrl } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const router = useRouter();

  async function run() {
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    if (
      !window.confirm(
        "This replaces your tone, industry, do/don't, and style summary with values derived from the page. Continue?"
      )
    ) {
      return;
    }

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
        Paste your changelog or &ldquo;what&apos;s new&rdquo; URL and we&apos;ll re-derive the fields below. This
        overwrites your current brand style.
      </p>
      <div className="flex gap-2">
        <Input
          type="url"
          placeholder="https://yourproduct.com/changelog"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1"
        />
        <Button type="button" variant="outline" onClick={run} disabled={loading || !url.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {loading ? "Analyzing…" : "Re-analyze"}
        </Button>
      </div>
      {result && (
        <p className={result.ok ? "text-xs text-emerald-600" : "text-xs text-muted-foreground"}>{result.message}</p>
      )}
    </div>
  );
}
