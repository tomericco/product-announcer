"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebflowCollection } from "./actions";
import type { WebflowCollection } from "@/lib/integrations/webflow/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function WebflowCollectionForm({
  collections,
  currentCollectionId,
}: {
  collections: WebflowCollection[];
  // Same rationale as WebflowSiteForm's currentSiteId: undefined during
  // first-time setup, populated when reused from "Change collection" so the
  // picker opens on what is actually wired up rather than defaulting to
  // whatever sorts first and silently overwriting the mapping on confirm.
  currentCollectionId?: string | null;
}) {
  const [collectionId, setCollectionId] = useState(currentCollectionId ?? collections[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  const selectedName = collections.find((c) => c.id === collectionId)?.displayName ?? "";

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    // saveWebflowCollection re-fetches the collection schema before saving,
    // so an API failure (outage, revoked token) surfaces here.
    const result = await saveWebflowCollection(formData);
    if (result.ok) {
      toast.success("Webflow collection selected");
    } else {
      toast.error(result.error);
    }
    setSubmitting(false);
  }

  if (collections.length === 0) {
    return <p className="text-sm text-muted-foreground">No collections found on this Webflow site.</p>;
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Collection</Label>
        <Select
          name="collectionId"
          value={collectionId}
          onValueChange={(value) => setCollectionId(value as string)}
        >
          <SelectTrigger>
            <SelectValue>{selectedName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {collections.map((collection) => (
              <SelectItem key={collection.id} value={collection.id}>
                <span className="flex items-center gap-2">
                  {collection.displayName}
                  {collection.id === currentCollectionId && (
                    <Badge variant="secondary" className="pointer-events-none">
                      Current
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Use this collection"}
      </Button>
    </form>
  );
}
