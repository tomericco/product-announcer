"use client";

import { useState } from "react";
import { toast } from "sonner";
import { fetchWebflowCollections } from "./actions";
import { WebflowCollectionForm } from "./webflow-collection-form";
import type { WebflowCollection } from "@/lib/integrations/webflow/client";
import { Button } from "@/components/ui/button";

// Same rationale as WebflowChangeSite: re-shows the existing
// WebflowCollectionForm on demand instead of forcing a full disconnect.
// Saving runs saveWebflowCollection, which already re-suggests the mapping
// for the newly picked collection.
export function WebflowChangeCollection({
  currentCollectionId,
  currentCollectionName,
}: {
  currentCollectionId: string;
  currentCollectionName: string | null;
}) {
  const [collections, setCollections] = useState<WebflowCollection[] | null>(null);
  const [loading, setLoading] = useState(false);

  if (collections) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Choose a different collection.</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCollections(null)}>
            Cancel
          </Button>
        </div>
        {/* Pre-select the collection this tenant is actually connected to —
            not whatever sorts first — so confirming without changing
            anything can't overwrite the hand-tuned field mapping. */}
        <WebflowCollectionForm collections={collections} currentCollectionId={currentCollectionId} />
      </div>
    );
  }

  async function loadCollections() {
    setLoading(true);
    try {
      setCollections(await fetchWebflowCollections());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Webflow collections");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        Collection: <span className="font-medium text-foreground">{currentCollectionName ?? "—"}</span>
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={loadCollections} disabled={loading}>
        {loading ? "Loading…" : "Change collection"}
      </Button>
    </div>
  );
}
