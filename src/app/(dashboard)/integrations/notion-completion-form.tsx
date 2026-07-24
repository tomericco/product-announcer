"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveNotionCompletion } from "./notion-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Property = { id: string; name: string; options: { id: string; name: string }[] };

export function NotionCompletionForm({
  properties,
  currentStatusPropertyId,
  currentDoneValues,
}: {
  properties: Property[];
  currentStatusPropertyId?: string | null;
  currentDoneValues: string[];
}) {
  const [propertyId, setPropertyId] = useState(currentStatusPropertyId ?? properties[0]?.id ?? "");
  const [done, setDone] = useState<Set<string>>(new Set(currentDoneValues));
  const [submitting, setSubmitting] = useState(false);

  const property = properties.find((p) => p.id === propertyId);

  function toggle(value: string, checked: boolean) {
    setDone((prev) => {
      const next = new Set(prev);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    formData.set("statusPropertyId", propertyId);
    formData.set("statusPropertyName", property?.name ?? "");
    for (const value of done) formData.append("doneValues", value);
    const result = await saveNotionCompletion(formData);
    if (result.ok) toast.success("Completion mapping saved");
    else toast.error(result.error);
    setSubmitting(false);
  }

  if (properties.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This database has no status or select property to signal completion.
      </p>
    );
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Completion property</Label>
        <Select
          value={propertyId}
          onValueChange={(value) => {
            setPropertyId(value as string);
            setDone(new Set()); // done values belong to a specific property
          }}
        >
          <SelectTrigger>
            <SelectValue>{property?.name ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Values that mean “done”</Label>
        <div className="space-y-1">
          {property?.options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={done.has(option.name)}
                onChange={(event) => toggle(option.name, event.target.checked)}
              />
              {option.name}
            </label>
          ))}
        </div>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save completion mapping"}
      </Button>
    </form>
  );
}
