"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebflowCollection } from "./actions";
import type { WebflowCollection } from "@/lib/integrations/webflow/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function WebflowCollectionForm({ collections }: { collections: WebflowCollection[] }) {
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  const selectedName = collections.find((c) => c.id === collectionId)?.displayName ?? "";

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      await saveWebflowCollection(formData);
      toast.success("Webflow collection selected");
    } catch (error) {
      // saveWebflowCollection re-fetches the collection schema before saving,
      // so an API failure (outage, revoked token) surfaces here.
      toast.error(error instanceof Error ? error.message : "Could not save the selected collection");
    } finally {
      setSubmitting(false);
    }
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
                {collection.displayName}
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
